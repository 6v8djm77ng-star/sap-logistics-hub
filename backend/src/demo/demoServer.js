/**
 * Demo Server - standalone Express app that serves realistic demo data.
 *
 * Runs with NO database and NO SAP. Perfect for:
 *   - Showing the system to stakeholders
 *   - UI development without infrastructure
 *   - Training and onboarding
 *
 * Start: node src/demo/demoServer.js
 */
import express from 'express';
import http from 'http';
import path from 'path';
import fsSync from 'fs';
import cors from 'cors';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { sendPasswordResetEmail } from '../services/passwordEmails.js';
import * as financialReader from '../services/sap/financialReader.js';
import { Server as SocketServer } from 'socket.io';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import bidiFactory from 'bidi-js';
import 'dotenv/config';
import * as data from './demoData.js';
import { startSimulation } from './liveSimulation.js';
import * as sapBridge from './sapBridge.js';
import * as store from './persistentStore.js';
import { SCREENS, ROLE_CODES } from './screenRegistry.js';
import { evaluatePlanForOrder, hebrewDayFromDate } from './orderPlanEval.js';
import { previewSelectedOrders, enrichConflict } from './previewSelectedOrders.js';
import { createIdempotencyCache, idempotencyMiddleware } from './idempotency.js';
import agentsRouter from '../routes/agents.js';

// Phase 2 v2 — module-level Idempotency-Key cache shared by the
// from-selected-orders endpoint and its /preview sibling. In-memory only;
// 10-minute TTL is set inside createIdempotencyCache. Survives within a
// single PM2 process and is wiped on reload, which is fine for this window.
const idempotencyCache = createIdempotencyCache();

// Initialize persistent store
store.load();
// Phase 4a: idempotent migration — adds MustChangePassword/PasswordResetReason/
// ProfileCompleted to existing users and backfills moti's email.
try {
  const result = store.migrateUsersPhase4a();
  if (result.updated) console.log(`[migration] Phase 4a updated ${result.updated} users`);
} catch (err) {
  console.warn('[migration] Phase 4a failed:', err.message);
}

let sapLive = false;
sapBridge.isAvailable().then((ok) => {
  sapLive = ok;
  if (ok) {
    console.log('\n✓ Connected to REAL SAP - showing live customer/order data\n');
  } else {
    console.log('\n⚠ SAP not reachable - using demo data only\n');
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DEMO_PORT || 4000;
// CRITICAL: never hard-code a JWT secret. Pull from .env. If missing in
// production we refuse to start to prevent accidentally signing tokens with
// a known string.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET missing or too short. Set a 64-char random value in .env.');
  } else {
    console.warn('⚠  JWT_SECRET is short or missing - OK for dev, FIX before going live.');
  }
}

const app = express();
const server = http.createServer(app);

// (2026-05-30) Trust the first proxy hop so req.ip / X-Forwarded-For
// reflects the real client IP behind Tailscale Funnel (or any single
// reverse proxy). Without this:
//   - express-rate-limit warns ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and
//     measures by the proxy IP (so all mobile clients share one bucket)
//   - audit log writes show the proxy IP instead of the real user
// `1` = trust ONE proxy in front. Tailscale Funnel is one hop. Bump if
// we later add Cloudflare/nginx in front.
app.set('trust proxy', 1);

// Wave A security follow-up — explicit CORS allow-list from CORS_ORIGINS env.
// Without this, any origin on the public internet could call our API once it
// found a valid token. Same-origin requests (no Origin header — curl, mobile
// native, server-to-server) stay allowed.
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:4000')
  .split(',').map((o) => o.trim()).filter(Boolean);

const corsOriginCheck = (origin, cb) => {
  if (!origin) return cb(null, true);
  if (allowedOrigins.includes(origin)) return cb(null, true);
  console.warn(`[CORS] blocked origin: ${origin}`);
  return cb(new Error('Origin not allowed by CORS'));
};

const io = new SocketServer(server, {
  cors: { origin: corsOriginCheck, credentials: true },
});

app.use(cors({
  origin: corsOriginCheck,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Rate limiter on /api/* - protects SAP and our process from abuse / accidental loops.
// 200 req/min per IP is generous for human use, blocks runaway scripts.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי בקשות - נסה שוב בעוד דקה' },
});
app.use('/api/', apiLimiter);

// Stricter limit for login - 10 attempts per 5 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 10,
  message: { error: 'יותר מדי ניסיונות התחברות - נסה שוב בעוד 5 דקות' },
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/driver-login', loginLimiter);
app.use('/api/auth/picker-login', loginLimiter);

// Phase 4b — separate, tighter rate limit on the password-reset flow.
// Forgot endpoint: 5 / 15 min so a leaked email list can't be sprayed.
// Reset-with-token endpoint: 10 / 15 min to bound brute-force attempts.
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'יותר מדי בקשות איפוס. נסה שוב בעוד 15 דקות.' },
});
const resetWithTokenLimiter = rateLimit({
  windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות איפוס. נסה שוב בעוד 15 דקות.' },
});
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth/reset-password-with-token', resetWithTokenLimiter);

// Phase 4b — periodic cleanup of expired/used reset tokens. Keeps the
// store small and prevents stale entries lingering after restart.
setInterval(() => {
  try {
    const removed = store.cleanupExpiredResetTokens();
    if (removed) console.log(`[reset-tokens] cleaned ${removed} expired/used entries`);
  } catch (err) {
    console.warn('[reset-tokens] cleanup failed:', err.message);
  }
}, 10 * 60 * 1000).unref();

// Simple logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path}`);
  next();
});

// =====================================================================
// EMERGENCY MITIGATION (Wave A) — added 2026-05-10
// Closes anonymous public-internet exposure of admin / customer / driver /
// SAP-write CRUD on this demoServer. See docs/architecture-review/
// emergency-mitigation-plan.md and external-reachability-report.md.
// Inert under future server.js cutover (server.js has its own auth chain
// via middleware/auth.js).
// Rollback: git revert <wave-a-sha>; pm2 restart sap-logistics
// =====================================================================
// Verify the JWT AND reject if the subject has logged out after the token
// was issued (per-sub revocation, not per-jti). Returns the payload or
// throws — callers should map the error to 401.
function verifyToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (store.isSubRevoked(payload.sub, payload.iat)) {
    const err = new Error('Session revoked');
    err.code = 'TOKEN_REVOKED';
    throw err;
  }
  return payload;
}

function requireAuthBasic(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = verifyToken(auth.slice(7));
    return next();
  } catch (err) {
    const code = err.code === 'TOKEN_REVOKED' ? 'TOKEN_REVOKED' : undefined;
    return res.status(401).json({ error: err.message || 'Invalid or expired token', code });
  }
}

function adminOnly(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = verifyToken(auth.slice(7));
    if (payload.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    req.user = payload;
    return next();
  } catch (err) {
    const code = err.code === 'TOKEN_REVOKED' ? 'TOKEN_REVOKED' : undefined;
    return res.status(401).json({ error: err.message || 'Invalid or expired token', code });
  }
}

// QC Control (P1, 2026-05-26): allow ADMIN + QC_CONTROLLER to reach the
// post-picking quality-control screen and its endpoints. P3+ will mount
// /api/qc/* routes behind this gate. PLANNER is intentionally excluded —
// QC must be done by a separate role from the one who plans the runs.
function qcControllerOnly(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = verifyToken(auth.slice(7));
    if (payload.role !== 'ADMIN' && payload.role !== 'QC_CONTROLLER') {
      return res.status(403).json({ error: 'QC_CONTROLLER or ADMIN role required' });
    }
    req.user = payload;
    return next();
  } catch (err) {
    const code = err.code === 'TOKEN_REVOKED' ? 'TOKEN_REVOKED' : undefined;
    return res.status(401).json({ error: err.message || 'Invalid or expired token', code });
  }
}

// Zod schemas for every auth endpoint. Reject unknown / malformed payloads
// at the front door instead of trusting `req.body.x` to be a string.
const LoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});
const CodeLoginSchema = z.object({
  code: z.string().min(1).max(50),
  pin: z.string().min(0).max(20).optional(),
});
const SetPinSchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, 'PIN חייב להיות 4-8 ספרות'),
});

function parseBody(schema, body, res) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues?.[0];
    res.status(400).json({
      error: issue?.message || 'נתוני קלט לא תקינים',
      code: 'BAD_INPUT',
      path: issue?.path?.join('.') || null,
    });
    return null;
  }
  return parsed.data;
}

// Auth endpoints - now use persistent store
app.post('/api/auth/login', async (req, res) => {
  const data = parseBody(LoginSchema, req.body, res);
  if (!data) return;
  const user = await store.verifyUserPassword(data.username, data.password);
  if (!user) {
    store.recordAudit({
      action: 'login.failure',
      actorName: data.username,
      success: false,
      ip: req.ip,
      details: { username: data.username },
    });
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }
  store.updateLastLogin(user.UserId);
  store.recordAudit({
    action: 'login.success',
    actorSub: user.UserId,
    actorName: user.FullName,
    targetUserId: user.UserId,
    targetUsername: user.Username,
    ip: req.ip,
  });
  const token = jwt.sign(
    { sub: user.UserId, username: user.Username, role: user.Role, name: user.FullName },
    JWT_SECRET,
    { expiresIn: '8h' },
  );
  // Admit this new token through any pending revocation cutoff for this user.
  // Older tokens (lower iat) stay blocked; this one (the legitimate fresh
  // login) is good to go.
  const decoded = jwt.decode(token);
  if (decoded?.iat) store.admitFreshToken(user.UserId, decoded.iat);
  res.json({
    token,
    user: {
      id: user.UserId,
      username: user.Username,
      name: user.FullName,
      email: user.Email || '',
      phone: user.Phone || '',
      role: user.Role,
      mustChangePassword: !!user.MustChangePassword,
      passwordResetReason: user.PasswordResetReason || null,
      profileCompleted: user.ProfileCompleted !== false,
    },
  });
});

// Driver login — code + optional PIN. Drivers that have a PinHash MUST send
// the matching PIN; drivers that don't have one yet keep the legacy
// code-only flow but the response carries mustSetPin so the mobile UI can
// force PIN setup on first login. Token is 12h (one shift), not 30d.
app.post('/api/auth/driver-login', (req, res) => {
  const data = parseBody(CodeLoginSchema, req.body, res);
  if (!data) return;
  const { code, pin } = data;
  const driver = store.getDrivers().find((d) => d.Code === code);
  if (!driver) return res.status(401).json({ error: 'קוד נהג או סיסמה שגויים' });
  const pinCheck = store.verifyDriverPin(driver, pin);
  if (pinCheck === false) {
    return res.status(401).json({ error: 'PIN שגוי', code: 'BAD_PIN' });
  }
  // pinCheck === null  → no PIN configured, allow legacy login but force
  //                       setup on the client side.
  // pinCheck === true  → PIN matched, allow.
  const mustSetPin = pinCheck === null;
  const token = jwt.sign(
    { sub: `driver-${driver.DriverId}`, driverId: driver.DriverId, role: 'DRIVER', name: driver.FullName },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
  res.json({
    token,
    mustSetPin,
    driver: { id: driver.DriverId, code: driver.Code, name: driver.FullName, phone: driver.Phone },
  });
});

// Picker login — same dual flow as driver-login. Token shrunk from 30d to 12h
// (a warehouse shift) so a leaked handheld doesn't keep API access for a
// month.
app.post('/api/auth/picker-login', (req, res) => {
  const data = parseBody(CodeLoginSchema, req.body, res);
  if (!data) return;
  const { code, pin } = data;
  const picker = store.getPickerByCode(code);
  if (!picker || !picker.IsActive) {
    return res.status(401).json({ error: 'קוד מלקט שגוי או לא פעיל' });
  }
  const pinCheck = store.verifyPickerPin(picker, pin);
  if (pinCheck === false) {
    return res.status(401).json({ error: 'PIN שגוי', code: 'BAD_PIN' });
  }
  const mustSetPin = pinCheck === null;
  const token = jwt.sign(
    {
      sub: `picker-${picker.PickerId}`,
      pickerId: picker.PickerId,
      // Reuse the existing WAREHOUSE role so all the picking endpoints accept it
      role: 'WAREHOUSE',
      name: picker.FullName,
      pickerCode: picker.Code,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({
    token,
    mustSetPin,
    picker: { id: picker.PickerId, code: picker.Code, name: picker.FullName, phone: picker.Phone },
  });
});

// Set / rotate the PIN. Auth: the picker / driver must already hold a valid
// JWT for THIS picker / driver — i.e. you can only change your own PIN.
app.post('/api/auth/picker-set-pin', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try { payload = jwt.verify(auth.slice(7), JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (!payload.pickerId) return res.status(403).json({ error: 'Only pickers can set a picker PIN' });
  const data = parseBody(SetPinSchema, req.body, res);
  if (!data) return;
  try {
    const ok = store.setPickerPin(payload.pickerId, data.pin);
    if (!ok) return res.status(404).json({ error: 'Picker not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});
app.post('/api/auth/driver-set-pin', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  let payload;
  try { payload = jwt.verify(auth.slice(7), JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  if (!payload.driverId) return res.status(403).json({ error: 'Only drivers can set a driver PIN' });
  const data = parseBody(SetPinSchema, req.body, res);
  if (!data) return;
  try {
    const ok = store.setDriverPin(payload.driverId, data.pin);
    if (!ok) return res.status(404).json({ error: 'Driver not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// Admin-only: unlock a picker / driver who forgot their PIN. Clears
// PinHash so the next login goes through the legacy code-only path and
// the client forces a fresh PIN setup via mustSetPin=true.
app.post('/api/pickers/:id/clear-pin', adminOnly, (req, res) => {
  const ok = store.clearPickerPin(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Picker not found' });
  res.json({ ok: true });
});
app.post('/api/drivers/:id/clear-pin', adminOnly, (req, res) => {
  const ok = store.clearDriverPin(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Driver not found' });
  res.json({ ok: true });
});

// Pickers CRUD - mirrors drivers. Wave A: any authenticated user may read,
// only ADMIN may mutate. Registered above the global Wave A block, so the
// gate is applied inline here.
app.get('/api/pickers', requireAuthBasic, (_req, res) => {
  res.json({ pickers: store.getPickers() });
});
app.post('/api/pickers', adminOnly, (req, res) => {
  try {
    const newPicker = store.addPicker(req.body);
    res.status(201).json(newPicker);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch('/api/pickers/:id', adminOnly, (req, res) => {
  const updated = store.updatePicker(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Picker not found' });
  res.json(updated);
});
app.delete('/api/pickers/:id', adminOnly, (req, res) => {
  const ok = store.deletePicker(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Picker not found' });
  res.json({ ok: true });
});

// Picker Task Inbox (2026-05-22): the per-picker queue for the upcoming
// /picker/tasks page. Returns only PENDING/IN_PROGRESS/PENDING_QC waves
// assigned to this picker, with denormalised zone + line aggregates so
// the page can render cards in one round-trip. MVP doesn't scope it to
// the picker's own id; when PIN-login adoption grows, a sibling
// /api/picker/me/waves can derive pickerId from the JWT instead.
//
// Auth note (2026-05-23): inline requireAuthBasic is REQUIRED here.
// The route is registered ~340 lines before the global
// app.use('/api/pickers', requireAuthBasic) inside WAVE_A_SENSITIVE_
// PREFIXES — Express middleware applies only to routes registered
// AFTER it, so without the inline gate this endpoint leaked picker
// waves to anyone with the URL. Caught by the external audit on
// commit 36e13d4. Every other /api/pickers/* handler registered
// before that gate already had an inline adminOnly or requireAuthBasic.
app.get('/api/pickers/:pickerId/assigned-waves', requireAuthBasic, (req, res) => {
  const raw = req.params.pickerId;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid pickerId', code: 'INVALID_PICKER' });
  }
  const waves = store.listAssignedWavesForPicker(id);
  if (waves === null) {
    return res.status(404).json({ error: 'מלקט לא נמצא או לא פעיל', code: 'PICKER_NOT_FOUND' });
  }
  res.json({ pickerId: id, waves });
});

// Per-zone-picker-assignment (2026-05-21): list of pickers available for
// assignment in the SendToPicking modal. Distinct from /api/pickers above
// (warehouse handhelds), and intentionally at a different path so
// PickersPage keeps working untouched. Source is now store.pickers (see
// bba4441) — the response carries PickerId in the userId field.
//
// Role gate widened on 2026-05-22 to include WAREHOUSE: PickerTasksPage
// (the /picker/tasks inbox a picker opens on their handheld) renders
// the same dropdown so the picker can confirm who they are and switch
// if needed. With a WAREHOUSE picker-login token, that page was 403'ing
// and the dropdown stayed empty — see smoke run on f5fd22b. ADMIN and
// PLANNER remain allowed for the SendToPicking modal use-case.
const PICKABLE_USERS_ROLES = new Set(['ADMIN', 'PLANNER', 'WAREHOUSE']);
app.get('/api/pickable-users', requireAuthBasic, (req, res) => {
  if (!PICKABLE_USERS_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'ADMIN, PLANNER or WAREHOUSE role required' });
  }
  res.json({ pickers: store.getPickableUsers() });
});

// Short-id → JWT lookup table (in-memory). Stays valid until restart.
// We use this to give the user a SHORT link that's easy to click on chat apps.
const mobileShortLinks = new Map();
function makeShortId() {
  // 8 chars, URL-safe
  return Array.from({ length: 8 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
}

// Generate a 30-day mobile-install token for the *currently authenticated* user.
// Returns a SHORT URL + QR code so the user can text it to themselves easily.
app.post('/api/auth/mobile-link', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    const longToken = jwt.sign(
      {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
        name: payload.name,
      },
      JWT_SECRET,
      // Wave A: reduced TTL 30d → 1h (mobile-link is meant for immediate scan).
      { expiresIn: '1h' }
    );
    // Store short id → token mapping
    let shortId;
    do { shortId = makeShortId(); } while (mobileShortLinks.has(shortId));
    mobileShortLinks.set(shortId, {
      token: longToken,
      createdAt: Date.now(),
      user: payload.username,
    });

    // Build the public URL the QR will encode. Priority order
    // (rewritten 2026-05-27 — old log-scan was unreliable because every
    // cloudflared respawn either wrote to a different log path or didn't
    // log at all, leaving the file stale for days):
    //
    //   1. PUBLIC_URL env var (set by admin if they have a stable domain)
    //   2. Last trycloudflare URL in CORS_ORIGINS — admin MUST add the
    //      tunnel URL there for the tunnel to work at all, so the trailing
    //      entry is by construction the current production tunnel
    //   3. Live probe of cloudflared metrics endpoints — scan ports
    //      20241-20260 for /quicktunnel, then cross-check the returned
    //      hostname against CORS_ORIGINS so a stale cloudflared process
    //      can't win over the active one
    //   4. cf-tunnel-error.log scan (legacy fallback)
    //   5. LAN IP (works only inside the office)
    //   6. Whatever host the request came on (last resort)
    let publicBase = process.env.PUBLIC_URL || null;

    // Helper — extract trycloudflare URLs from the CORS allowlist.
    const corsTunnels = (process.env.CORS_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .filter((o) => /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(o));

    // (2) Last entry in CORS_ORIGINS is the active tunnel by convention.
    if (!publicBase && corsTunnels.length > 0) {
      publicBase = corsTunnels[corsTunnels.length - 1];
    }

    // (3) Live probe — only useful if (2) found nothing (admin forgot to
    // add the tunnel URL to CORS) OR multiple cloudflareds are running
    // and the allowlist contains a stale URL whose process is dead.
    if (!publicBase) {
      try {
        for (let port = 20241; port <= 20260; port++) {
          // 250ms per port × 20 ports = 5s worst case. Acceptable for a
          // one-shot mobile-link generation; not on a hot path.
          const probe = await fetch(`http://127.0.0.1:${port}/quicktunnel`, {
            signal: AbortSignal.timeout(250),
          }).then((r) => r.ok ? r.json() : null).catch(() => null);
          if (probe?.hostname) {
            const candidate = `https://${probe.hostname}`;
            // If CORS allowlist is non-empty, only accept probes that
            // match it — prevents the QR from pointing at a tunnel the
            // backend would block on CORS anyway.
            if (corsTunnels.length === 0 || corsTunnels.includes(candidate)) {
              publicBase = candidate;
              break;
            }
          }
        }
      } catch {}
    }

    // (4) Legacy log scan — kept as a last-ditch fallback for environments
    // where neither CORS nor metrics-probe yields anything.
    if (!publicBase) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const cfLog = path.resolve(
          __dirname, '..', '..', 'logs', 'cf-tunnel-error.log'
        );
        if (fs.existsSync(cfLog)) {
          const txt = fs.readFileSync(cfLog, 'utf8');
          const matches = txt.match(/https:\/\/[a-z-]+\.trycloudflare\.com/g);
          if (matches && matches.length) publicBase = matches[matches.length - 1];
        }
      } catch {}
    }
    if (!publicBase) {
      const os = await import('os');
      let lanIp = null;
      for (const arr of Object.values(os.networkInterfaces() || {})) {
        for (const i of arr || []) {
          if (i.family === 'IPv4' && !i.internal && i.address.startsWith('192.168.')) {
            lanIp = i.address; break;
          }
        }
        if (lanIp) break;
      }
      const reqHost = req.get('host') || `localhost:${PORT}`;
      const host = (lanIp && reqHost.startsWith('localhost')) ? `${lanIp}:${PORT}` : reqHost;
      publicBase = `${req.protocol || 'http'}://${host}`;
    }
    const shortUrl = `${publicBase}/m/admin/${shortId}`;

    // Generate QR as data URL
    const QRCode = (await import('qrcode')).default;
    const qrDataUrl = await QRCode.toDataURL(shortUrl, { width: 320, margin: 1 });

    res.json({
      shortUrl,
      shortId,
      qr: qrDataUrl,
      expiresIn: '30 days',
      user: { name: payload.name, role: payload.role },
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token: ' + err.message });
  }
});

// Wave A security follow-up — mobile-link entries carry a createdAt and
// the underlying JWT has a 1h TTL, but nothing was enforcing the 1h on
// the *map entry itself*. A stale entry that lingered after a server
// restart could in theory leak. Now we check createdAt+1h on every
// resolve and sweep periodically.
const SHORT_LINK_TTL_MS = 60 * 60 * 1000;
function isShortLinkExpired(entry) {
  if (!entry?.createdAt) return false;
  return Date.now() - entry.createdAt > SHORT_LINK_TTL_MS;
}
setInterval(() => {
  for (const [shortId, entry] of mobileShortLinks.entries()) {
    if (isShortLinkExpired(entry)) mobileShortLinks.delete(shortId);
  }
}, 5 * 60 * 1000).unref();

// Resolve a short id → JWT, then redirect-style: respond with the token in body.
app.get('/api/auth/mobile-link/:shortId', (req, res) => {
  const entry = mobileShortLinks.get(req.params.shortId);
  if (!entry) return res.status(404).json({ error: 'Short link not found or expired' });
  if (isShortLinkExpired(entry)) {
    mobileShortLinks.delete(req.params.shortId);
    return res.status(410).json({ error: 'Short link expired' });
  }
  res.json({ token: entry.token });
});

app.get('/api/auth/me', (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(auth.slice(7));
      // Phase 4a — pull live user record so mustChangePassword and
      // profileCompleted reflect the latest state, not what was true when
      // the token was signed.
      const user = payload.sub != null ? store.getUserById(payload.sub) : null;
      const enriched = user ? {
        ...payload,
        email: user.Email || '',
        phone: user.Phone || '',
        mustChangePassword: !!user.MustChangePassword,
        passwordResetReason: user.PasswordResetReason || null,
        profileCompleted: user.ProfileCompleted !== false,
        // (2026-05-28) Role permissions — the frontend uses this to
        // filter sidebar items and to guard direct-URL navigation. '*'
        // means "all screens". For unknown roles returns []; ADMIN
        // always gets ['*'] from the default seed.
        allowedScreens: store.getAllowedScreensForRole(payload.role) || [],
      } : payload;
      return res.json({ user: enriched });
    } catch {}
  }
  res.status(401).json({ error: 'Not authenticated' });
});

// Phase 4b — forgot-password. Always returns 200 with a generic message,
// even if the email isn't in the system, to avoid leaking which addresses
// are valid (account enumeration). When a match exists, a single-use
// 30-min reset token is recorded and the link is emailed (or logged when
// SMTP isn't configured).
const ForgotPasswordSchema = z.object({
  email: z.string().trim().email('כתובת מייל לא תקינה').max(200),
});
app.post('/api/auth/forgot-password', async (req, res) => {
  const data = parseBody(ForgotPasswordSchema, req.body, res);
  if (!data) return;
  const user = store.getUserByEmail(data.email);
  // Always succeed from the client's point of view — even if no user.
  // We still log the lookup attempt to the audit trail (success=false on
  // misses) so an admin can spot enumeration sweeps.
  if (!user) {
    store.recordAudit({
      action: 'password.reset.requested',
      success: false, ip: req.ip,
      details: { email: data.email, reason: 'no_match' },
    });
    return res.json({ ok: true, message: 'אם הכתובת קיימת במערכת, נשלח אליה קישור איפוס.' });
  }
  // Generate a 32-byte URL-safe token. Plain only ever exists in this
  // request scope + the outgoing email body. Storage holds bcrypt hash.
  const plainToken = randomBytes(32).toString('base64url');
  store.recordPasswordResetToken(user.UserId, plainToken);
  // Build the absolute reset URL. Same logic as mobile-link: prefer
  // PUBLIC_URL, then the latest Cloudflare tunnel, then the request host.
  let publicBase = process.env.PUBLIC_URL || null;
  if (!publicBase) {
    try {
      const cfLog = path.resolve(__dirname, '..', '..', 'logs', 'cf-tunnel-error.log');
      if (fsSync.existsSync(cfLog)) {
        const txt = fsSync.readFileSync(cfLog, 'utf8');
        const matches = txt.match(/https:\/\/[a-z-]+\.trycloudflare\.com/g);
        if (matches?.length) publicBase = matches[matches.length - 1];
      }
    } catch {}
  }
  if (!publicBase) {
    publicBase = `${req.protocol || 'http'}://${req.get('host') || `localhost:${PORT}`}`;
  }
  const resetLink = `${publicBase}/reset-password?token=${encodeURIComponent(plainToken)}`;
  const emailResult = await sendPasswordResetEmail({
    toEmail: user.Email,
    userName: user.FullName,
    resetLink,
  });
  store.recordAudit({
    action: 'password.reset.requested',
    targetUserId: user.UserId, targetUsername: user.Username,
    success: true, ip: req.ip,
    details: { emailMode: emailResult.mode },
  });
  res.json({
    ok: true,
    message: 'אם הכתובת קיימת במערכת, נשלח אליה קישור איפוס.',
    // Dev-aid only: when SMTP is in log-only mode AND the env explicitly
    // opts in, echo the link back so the admin can grab it from the UI.
    // Off by default; flip RETURN_RESET_LINK_IN_RESPONSE=true to enable.
    ...(emailResult.mode === 'log' && process.env.RETURN_RESET_LINK_IN_RESPONSE === 'true'
      ? { _devResetLink: resetLink } : {}),
  });
});

// Phase 4b — consume reset token + set new password. Token verified by
// bcrypt against the store; single-use; clears MustChangePassword and
// revokes every outstanding token for the user. Anti-enumeration: an
// invalid / expired / used token returns the same 400 body regardless of
// which case fired.
const ResetWithTokenSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(200),
});
app.post('/api/auth/reset-password-with-token', async (req, res) => {
  const data = parseBody(ResetWithTokenSchema, req.body, res);
  if (!data) return;
  const strength = validatePasswordStrength(data.newPassword);
  if (!strength.ok) return res.status(400).json({ error: strength.error, code: strength.code });
  const userId = store.consumePasswordResetToken(data.token);
  if (!userId) {
    store.recordAudit({
      action: 'password.reset.consume',
      success: false, ip: req.ip,
      details: { reason: 'invalid_or_expired_token' },
    });
    return res.status(400).json({
      error: 'קישור האיפוס לא תקין, פג תוקף או כבר נוצל. בקש קישור חדש.',
      code: 'INVALID_RESET_TOKEN',
    });
  }
  const user = store.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
  // Don't let the user reset back to the SAME password they currently have.
  const sameAsCurrent = await store.isCurrentPassword(userId, data.newPassword);
  if (sameAsCurrent) {
    return res.status(400).json({
      error: 'הסיסמה החדשה זהה לסיסמה הקיימת. בחר/י סיסמה שונה.',
      code: 'PWD_SAME_AS_OLD',
    });
  }
  // Self-service reset → clear MustChangePassword (the rotation itself
  // is the rotation, no need to force another one).
  await store.setUserPassword(userId, data.newPassword);
  store.logoutSub(userId);
  store.recordAudit({
    action: 'password.change.forgot_token',
    actorSub: userId, actorName: user.FullName,
    targetUserId: userId, targetUsername: user.Username,
    success: true, ip: req.ip,
  });
  res.json({ ok: true, username: user.Username });
});

// Invalidates all outstanding tokens for the caller's subject. Subsequent
// requests with any token issued before this moment return 401 TOKEN_REVOKED.
// Pickers / drivers also pass through here.
app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    store.logoutSub(payload.sub);
    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Reject weak new passwords. The old rule was length>=4 which let a user
// rotate to "abcd". Current rules: at least 10 chars, contains a letter
// AND a digit AND a non-alphanumeric. Returns the specific failure so
// the UI can show a meaningful hint.
function validatePasswordStrength(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 10) {
    return { ok: false, error: 'סיסמה חדשה חייבת להכיל לפחות 10 תווים', code: 'PWD_TOO_SHORT' };
  }
  if (!/[A-Za-z֐-׿]/.test(pwd)) {
    return { ok: false, error: 'סיסמה חייבת להכיל לפחות אות אחת', code: 'PWD_NO_LETTER' };
  }
  if (!/\d/.test(pwd)) {
    return { ok: false, error: 'סיסמה חייבת להכיל לפחות ספרה אחת', code: 'PWD_NO_DIGIT' };
  }
  if (!/[^A-Za-z0-9֐-׿]/.test(pwd)) {
    return { ok: false, error: 'סיסמה חייבת להכיל לפחות תו מיוחד אחד (!@#$ וכו׳)', code: 'PWD_NO_SPECIAL' };
  }
  return { ok: true };
}

app.post('/api/users/me/change-password', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = verifyToken(auth.slice(7));
    const { oldPassword, newPassword } = req.body || {};
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) return res.status(400).json({ error: strength.error, code: strength.code });
    const user = store.getUserById(payload.sub);
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא' });
    const ok = await store.verifyUserPassword(user.Username, oldPassword);
    if (!ok) {
      store.recordAudit({
        action: 'password.change.self', actorSub: user.UserId, actorName: user.FullName,
        targetUserId: user.UserId, success: false, ip: req.ip,
        details: { reason: 'wrong_old_password' },
      });
      return res.status(401).json({ error: 'סיסמה קיימת שגויה' });
    }
    // Phase 4a — refuse rotating to the same password the user just typed.
    if (oldPassword === newPassword) {
      return res.status(400).json({
        error: 'הסיסמה החדשה זהה לסיסמה הנוכחית. בחר סיסמה שונה.',
        code: 'PWD_SAME_AS_OLD',
      });
    }
    await store.setUserPassword(user.UserId, newPassword); // clears MustChangePassword
    // Revoke all earlier tokens for this user so the password rotation
    // actually kicks unauthorized sessions out.
    store.logoutSub(user.UserId);
    store.recordAudit({
      action: 'password.change.self', actorSub: user.UserId, actorName: user.FullName,
      targetUserId: user.UserId, success: true, ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// =====================================================================
// WAVE A FULL GATE — 2026-05-13
// Closes anonymous access to all sensitive /api routes registered below
// this block. Public endpoints already registered above this point keep
// their own per-handler checks:
//   - /api/auth/{login,driver-login,picker-login}   (passwordless or rate-limited)
//   - /api/auth/mobile-link/:shortId                 (short-id → token lookup)
//   - /api/auth/me, /api/users/me/change-password    (verify token inline)
// Public endpoints registered AFTER this block:
//   - /health                                         (top-level, not under /api)
//   - /api/public/track/:token                        (customer tracking by signed token)
// =====================================================================
const WAVE_A_SENSITIVE_PREFIXES = [
  '/api/orders', '/api/runs', '/api/run-orders', '/api/stops',
  '/api/picking', '/api/returns', '/api/reports', '/api/analytics',
  '/api/failures', '/api/davo-mix', '/api/addresses', '/api/tracking',
  '/api/cod', '/api/notify', '/api/delivery-notes', '/api/invoices',
  '/api/documents', '/api/driver', '/api/customers', '/api/customer-profiles',
  '/api/drivers', '/api/zones', '/api/pickers', '/api/audit', '/api/sap',
  '/api/system',
];
for (const prefix of WAVE_A_SENSITIVE_PREFIXES) {
  app.use(prefix, requireAuthBasic);
}
// /api/users — admin-only for CRUD; /me/* paths (own profile) stay user-scoped.
app.use('/api/users', (req, res, next) => {
  if (req.path === '/me' || req.path.startsWith('/me/')) {
    return requireAuthBasic(req, res, next);
  }
  return adminOnly(req, res, next);
});
app.use('/api/settings', adminOnly);
app.use('/api/demo', adminOnly);
// /api/sap/write is further restricted below (existing line); /api/sap above
// already required auth — this adds the admin role check.
app.use('/api/sap/write', adminOnly);

// Health
app.get('/health', async (_req, res) => {
  const payload = {
    ok: true, time: new Date().toISOString(),
    mode: sapLive ? 'DEMO+SAP' : 'DEMO',
    sapConnected: sapLive,
  };
  if (sapLive) {
    try {
      const stats = await sapBridge.getOverallStats();
      payload.checks = {
        logisticsDb: { ok: false, note: 'Using in-memory demo data' },
        sapSqlA: { ok: true, stats: stats.companyA },
        sapSqlB: { ok: true, stats: stats.companyB },
      };
    } catch (err) {
      payload.checks = { error: err.message };
    }
  } else {
    payload.checks = {
      logisticsDb: { ok: true, latencyMs: 3, note: 'Demo mode - in-memory' },
      sap: { ok: false, note: 'Not configured' },
    };
  }
  res.json(payload);
});

// Zones - full CRUD
app.get('/api/zones', (_req, res) => res.json({ zones: store.getZones() }));
app.get('/api/zones/suggest', (req, res) => {
  const zone = store.suggestZoneForCity(req.query.city || '');
  res.json({ zone: zone || null });
});

// Cities and their assigned zones (for the drag & drop UI)
app.get('/api/zones/cities', (_req, res) => {
  res.json({ cities: store.listCitiesWithZones() });
});

// Customer document policies (delivery note vs invoice)
// Returns: parent groups (chains only) with branches collapsed + current policy.
// By default individual customers (single-branch) are excluded — they get the
// default doc type (INVOICE) automatically and don't need configuration.
// Pass ?includeIndividuals=true to see them too.
//
// Wave A mitigation: all /api/customers/* routes require any valid Bearer token.
app.use('/api/customers', requireAuthBasic);
app.get('/api/customers/policies', async (req, res) => {
  try {
    const policies = store.listCustomerDocPolicies();
    const includeIndividuals = req.query.includeIndividuals === 'true';
    if (!sapLive) {
      return res.json({
        groups: [],
        policies,
        warning: 'SAP לא מחובר - לא ניתן להציג לקוחות',
      });
    }
    const customers = await sapBridge.getAllCustomers();
    // Group by parent name across BOTH companies
    const byParent = new Map();
    for (const c of customers) {
      const parent = store.parentNameOf(c.CardName);
      if (!byParent.has(parent)) {
        byParent.set(parent, {
          parentName: parent,
          branches: [],
          companies: new Set(),
          totalOpenOrders: 0,
        });
      }
      const g = byParent.get(parent);
      g.branches.push({
        cardCode: c.CardCode,
        cardName: c.CardName,
        city: c.City,
        phone: c.Phone1,
        companyCode: c.CompanyCode,
        companyName: c.CompanyName,
        openOrders: Number(c.OpenOrders || 0),
      });
      g.companies.add(c.CompanyCode);
      g.totalOpenOrders += Number(c.OpenOrders || 0);
    }
    const allGroups = Array.from(byParent.values())
      .map((g) => ({
        ...g,
        companies: Array.from(g.companies),
        branchCount: g.branches.length,
        docType: policies[g.parentName] || store.DEFAULT_DOC_TYPE,
        isExplicit: !!policies[g.parentName],
      }));

    const totalCustomers = allGroups.length;
    const chains = allGroups.filter((g) => g.branchCount > 1);
    const individuals = allGroups.filter((g) => g.branchCount === 1);

    const groups = (includeIndividuals ? allGroups : chains)
      .sort((a, b) => b.totalOpenOrders - a.totalOpenOrders || a.parentName.localeCompare(b.parentName, 'he'));

    res.json({
      groups,
      policies,
      defaultDocType: store.DEFAULT_DOC_TYPE,
      counts: {
        total: totalCustomers,
        chains: chains.length,
        individuals: individuals.length,
      },
    });
  } catch (err) {
    console.error('[customer-policies]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update policy for a parent (chain) name
app.patch('/api/customers/policies/:parentName', (req, res) => {
  const parentName = decodeURIComponent(req.params.parentName);
  const docType = req.body?.docType || null; // null = remove override
  const ok = store.setCustomerDocPolicy(parentName, docType);
  if (!ok) return res.status(400).json({ error: 'Invalid parent name or doc type' });
  res.json({ ok: true, parentName, docType });
});

// SAP Service Layer write-back: push Delivery Notes / Invoices to SAP.
// SAFETY: defaults to DRY-RUN. Set SAP_WRITE_ENABLED=true in .env to actually write.
app.get('/api/sap/writer/status', async (_req, res) => {
  const { getWriterStatus } = await import('./sapWriter.js');
  res.json(getWriterStatus());
});

// Wave A mitigation: SAP write endpoints require ADMIN even though
// SAP_WRITE_ENABLED is currently UNSET. Belt-and-suspenders for the day
// the env flag flips.
app.use('/api/sap/write', adminOnly);
app.post('/api/sap/write/delivery-note/:id', async (req, res) => {
  try {
    const { writeDeliveryNote } = await import('./sapWriter.js');
    const dn = (store.load().deliveryNotes || []).find(
      (d) => d.DeliveryNoteId === Number(req.params.id)
    );
    if (!dn) return res.status(404).json({ error: 'Delivery note not found' });
    const result = await writeDeliveryNote(dn, { dryRun: req.body?.dryRun !== false });
    if (result.ok && result.sapDocEntry) {
      dn.SapDeliveryDocEntry = result.sapDocEntry;
      dn.SapDeliveryDocNum = result.sapDocNum;
      dn.Status = result.dryRun ? 'PENDING_EXPORT' : 'CONFIRMED';
      dn.SentToSapAt = new Date().toISOString();
      if (!result.dryRun) dn.ConfirmedAt = new Date().toISOString();
      store.save?.();
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sap/write/invoice/:id', async (req, res) => {
  try {
    const { writeInvoice } = await import('./sapWriter.js');
    const inv = (store.load().invoices || []).find(
      (i) => i.InvoiceId === Number(req.params.id)
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const dn = (store.load().deliveryNotes || []).find(
      (d) => d.DeliveryNoteId === inv.DeliveryNoteId
    );
    const result = await writeInvoice(inv, dn, { dryRun: req.body?.dryRun !== false });
    if (result.ok && result.sapDocEntry) {
      inv.SapInvoiceDocEntry = result.sapDocEntry;
      inv.SapInvoiceDocNum = result.sapDocNum;
      inv.Status = result.dryRun ? 'PENDING_EXPORT' : 'CONFIRMED';
      inv.SentToSapAt = new Date().toISOString();
      if (!result.dryRun) inv.ConfirmedAt = new Date().toISOString();
      store.save?.();
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Truck loading plan - LIFO order based on delivery sequence + per-stop volume.
app.get('/api/runs/:id/loading-plan', async (req, res) => {
  try {
    const { computeStopVolumes, planLoadingOrder, utilisationPercent } =
      await import('./loadingPlanner.js');
    const runId = Number(req.params.id);
    const details = store.getRunDetails(runId);
    if (!details) return res.status(404).json({ error: 'Run not found' });

    // Pull line items per order from SAP if available
    let ordersWithLines = [];
    if (sapLive) {
      try {
        const orderRefs = (details.orders || details.runOrders || []).map((o) => ({
          companyCode: o.CompanyCode || o.SapCompanyCode,
          docEntry: o.SapDocEntry,
        }));
        const lines = await sapBridge.getBulkOrderLines(orderRefs);
        // Group lines by stop via runOrders
        const stopByDoc = new Map();
        for (const o of (details.runOrders || details.orders || [])) {
          stopByDoc.set(`${o.CompanyCode || o.SapCompanyCode}:${o.SapDocEntry}`, o.StopId);
        }
        const grouped = new Map();
        for (const ln of lines) {
          const stopId = stopByDoc.get(`${ln.CompanyCode}:${ln.DocEntry}`);
          if (!stopId) continue;
          if (!grouped.has(stopId)) grouped.set(stopId, { StopId: stopId, lines: [] });
          grouped.get(stopId).lines.push(ln);
        }
        ordersWithLines = Array.from(grouped.values());
      } catch (e) {
        console.warn('[loading-plan] SAP lines fetch failed:', e.message);
      }
    }

    const stopVols = computeStopVolumes(details.stops || [], ordersWithLines);
    const enrichedStops = (details.stops || []).map((s) => {
      const v = stopVols.find((x) => x.stop.StopId === s.StopId);
      return { ...s, volumeL: v?.volumeL || 0, lineCount: v?.lineCount || 0 };
    });
    const loadingPlan = planLoadingOrder(enrichedStops);
    const utilisation = utilisationPercent(loadingPlan, Number(req.query.capacityL || 12000));

    res.json({
      runId,
      capacityL: Number(req.query.capacityL || 12000),
      utilisation,
      totalVolumeL: loadingPlan.reduce((s, x) => s + x.volumeL, 0),
      plan: loadingPlan,
      hint: 'LIFO: טען ראשון את עצירה אחרונה. הסידור בהתאם.',
    });
  } catch (err) {
    console.error('[loading-plan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Road-distance route optimization - reorders stops in a run for minimum
// driving distance using a self-hosted OSRM instance.
//
// Hard requirement: OSRM_BASE_URL must point to a running OSRM (see
// infra/osrm/). Without it the endpoint returns 422 and does NOT touch
// StopOrder — silently falling back to haversine would mislead the
// operator into trusting bad geometry.
app.post('/api/runs/:id/optimize', async (req, res) => {
  try {
    // Gate before any work — fail fast and visibly.
    if (!process.env.OSRM_BASE_URL) {
      return res.status(422).json({
        error: 'אופטימיזציית כביש דורשת OSRM_BASE_URL',
        code: 'MISSING_OSRM_URL',
        hint: 'הגדר OSRM_BASE_URL ב-backend/.env (ראה .env.example) והפעל מחדש את השרת. ראה גם infra/osrm/README.md להפעלת ה-container המקומי.',
      });
    }

    const { optimizeRoute, OsrmConfigError, OsrmApiError } =
      await import('./routeOptimizer.js');
    const { resolveStopLatLng } = await import('./cityCoords.js');
    const runId = Number(req.params.id);
    const details = store.getRunDetails(runId);
    if (!details) return res.status(404).json({ error: 'Run not found' });

    // Coordinates: prefer stored Latitude/Longitude, fall back to the
    // city-centroid geocoder for stops without exact coords. Google's
    // Distance Matrix then computes real driving distance between those
    // points (city centroid → city centroid is still a road route, not a
    // straight line).
    const allStops = (details.stops || []);
    const resolved = allStops
      .map((s) => {
        const r = resolveStopLatLng(s);
        return r ? { id: s.StopId, lat: r.lat, lng: r.lng, source: r.source, city: s.City } : null;
      })
      .filter(Boolean);

    if (resolved.length < 2) {
      return res.status(400).json({
        error: 'דרושות לפחות 2 עצירות עם מיקום (מאוחסן או עיר מזוהה) כדי לבצע אופטימיזציה',
        totalStops: allStops.length,
        eligibleStops: resolved.length,
        unresolvedCities: allStops
          .filter((s) => !resolveStopLatLng(s))
          .map((s) => s.City || '(ללא עיר)'),
      });
    }

    // Run the optimizer. Any failure here aborts BEFORE StopOrder is touched.
    let result;
    try {
      result = await optimizeRoute(
        resolved.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng })),
        req.body?.start
          ? { start: { lat: Number(req.body.start.lat), lng: Number(req.body.start.lng) } }
          : undefined
      );
    } catch (err) {
      // Distinguish config error (URL missing — shouldn't happen here since
      // we gated above, but kept defensively) from upstream API failure.
      if (err instanceof OsrmConfigError) {
        return res.status(422).json({
          error: err.message,
          code: 'MISSING_OSRM_URL',
        });
      }
      if (err instanceof OsrmApiError) {
        // OSRM runs locally — no secrets in the URL, safe to log fully.
        console.error('[optimize] OSRM failed:', err.message);
        return res.status(502).json({
          error: 'OSRM נכשל - לא בוצע שינוי בסדר העצירות',
          code: 'OSRM_API_FAILED',
          detail: err.message,
          upstreamStatus: err.upstreamStatus || null,
        });
      }
      throw err;
    }

    // Tag whether we used stored coords or the city-centroid fallback so the
    // operator knows if the result is exact or based on city centers.
    const usedFallback = resolved.some((s) => s.source === 'city');
    result.coordSource = usedFallback ? 'city-centroid' : 'stored';

    // StopOrder is only mutated AFTER the optimizer succeeded.
    if (req.body?.apply) {
      const ordered = result.order;
      for (let i = 0; i < ordered.length; i++) {
        store.updateStop(ordered[i].id, { stopOrder: i + 1 });
      }
    }

    res.json({
      runId,
      optimizedOrder: result.order.map((s) => s.id),
      totalKm: result.totalKm,
      source: result.source, // always 'osrm' now
      coordSource: result.coordSource,
      applied: !!req.body?.apply,
    });
  } catch (err) {
    console.error('[optimize] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Stock prediction - estimates which items will run out, based on the
// current open-order demand vs current available stock.
// (Doesn't yet use historical sales rate - that requires more SQL queries.)
// ----------------------------------------------------------------------------
app.get('/api/analytics/stock-prediction', async (_req, res) => {
  try {
    if (!sapLive) return res.json({ items: [], warning: 'SAP not connected' });

    // 1. Get all open order lines
    const allOrders = await sapBridge.getOpenOrdersFlat({ limit: 500 }).catch(() => []);
    const refs = allOrders.map((o) => ({ companyCode: o.CompanyCode, docEntry: o.DocEntry }));
    const lines = await sapBridge.getBulkOrderLines(refs).catch(() => []);

    // 2. Aggregate demand per item per company
    const demand = new Map(); // 'A:itemcode' -> { itemCode, itemName, qty, openOrderCount }
    for (const ln of lines) {
      const k = `${ln.CompanyCode}:${ln.ItemCode}`;
      if (!demand.has(k)) {
        demand.set(k, {
          companyCode: ln.CompanyCode,
          itemCode: ln.ItemCode,
          itemName: ln.ItemName,
          demandQty: 0,
          orderCount: 0,
          customers: new Set(),
        });
      }
      const d = demand.get(k);
      d.demandQty += Number(ln.OpenQty || ln.Quantity || 0);
      d.orderCount += 1;
      if (ln.CardName) d.customers.add(ln.CardName);
    }

    // 3. Pull stock per item (chunked)
    const allStocks = new Map();
    for (const code of ['A', 'B']) {
      const codes = [...new Set(
        Array.from(demand.values())
          .filter((d) => d.companyCode === code)
          .map((d) => d.itemCode)
      )];
      for (let i = 0; i < codes.length; i += 200) {
        const batch = codes.slice(i, i + 200);
        const stocks = await sapBridge.getItemsStock(code, batch).catch(() => []);
        for (const s of stocks) {
          const k = `${code}:${s.ItemCode}`;
          if (!allStocks.has(k)) allStocks.set(k, 0);
          allStocks.set(k, allStocks.get(k) + Number(s.Available || 0));
        }
      }
    }

    // 4. Build prediction
    const items = [];
    for (const d of demand.values()) {
      const stock = allStocks.get(`${d.companyCode}:${d.itemCode}`) || 0;
      const shortage = d.demandQty - stock;
      const ratio = stock > 0 ? d.demandQty / stock : Infinity;
      let level = 'ok';
      if (shortage > 0) level = 'shortage';
      else if (ratio >= 0.8) level = 'critical';
      else if (ratio >= 0.5) level = 'warn';
      items.push({
        companyCode: d.companyCode,
        itemCode: d.itemCode,
        itemName: d.itemName,
        currentStock: stock,
        openDemand: d.demandQty,
        shortage: Math.max(0, shortage),
        ratio: Math.round(ratio * 100) / 100,
        orderCount: d.orderCount,
        customerCount: d.customers.size,
        level,
      });
    }
    // Order by: shortage first, then critical, then warn, by shortage qty descending
    const levelRank = { shortage: 4, critical: 3, warn: 2, ok: 1 };
    items.sort((a, b) =>
      levelRank[b.level] - levelRank[a.level] || b.shortage - a.shortage || b.openDemand - a.openDemand
    );

    res.json({
      items,
      summary: {
        total: items.length,
        shortage: items.filter((i) => i.level === 'shortage').length,
        critical: items.filter((i) => i.level === 'critical').length,
        warn: items.filter((i) => i.level === 'warn').length,
        ok: items.filter((i) => i.level === 'ok').length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Anomaly detection - flags unusual orders by comparing each new order to
// the customer's historical pattern. Returns suspicious items + reasons.
// ----------------------------------------------------------------------------
app.get('/api/analytics/anomalies', async (_req, res) => {
  try {
    if (!sapLive) return res.json({ anomalies: [], warning: 'SAP not connected' });

    const orders = await sapBridge.getOpenOrdersFlat({ limit: 500 }).catch(() => []);

    // 1. Build per-customer baseline (avg order value, avg lines)
    const baseline = new Map();
    for (const o of orders) {
      const k = String(o.CardCode || o.CardName || '').trim();
      if (!k) continue;
      if (!baseline.has(k)) {
        baseline.set(k, { sums: 0, count: 0, max: 0, lineSums: 0, parent: store.parentNameOf(o.CardName) });
      }
      const b = baseline.get(k);
      b.sums += Number(o.DocTotal || 0);
      b.count += 1;
      if (Number(o.DocTotal || 0) > b.max) b.max = Number(o.DocTotal || 0);
      b.lineSums += Number(o.LinesCount || 0);
    }

    // 2. Compute global outlier threshold (top 5% by value)
    const allTotals = orders.map((o) => Number(o.DocTotal || 0)).sort((a, b) => a - b);
    const p95 = allTotals[Math.floor(allTotals.length * 0.95)] || 0;

    // 3. Flag each order against its baseline + global threshold
    const anomalies = [];
    for (const o of orders) {
      const reasons = [];
      const total = Number(o.DocTotal || 0);
      const k = String(o.CardCode || o.CardName || '').trim();
      const b = baseline.get(k);

      // Reason A: order is in top 5% globally
      if (total >= p95 && p95 > 0) {
        reasons.push({
          type: 'high_value',
          severity: 'medium',
          msg: `הזמנה גבוהה מאוד (${Math.round(total).toLocaleString('he-IL')}₪) - מעל ה-95% של כל ההזמנות`,
        });
      }

      // Reason B: order is 3× the customer's average
      if (b && b.count >= 2) {
        const avg = b.sums / b.count;
        if (avg > 0 && total > avg * 3) {
          reasons.push({
            type: 'spike',
            severity: 'high',
            msg: `פי ${(total / avg).toFixed(1)} מהממוצע של הלקוח (${Math.round(avg).toLocaleString('he-IL')}₪)`,
          });
        }
      }

      // Reason C: very small order (under 200₪) — might be a pricing error
      if (total > 0 && total < 200) {
        reasons.push({
          type: 'low_value',
          severity: 'low',
          msg: `הזמנה קטנה מאוד (${Math.round(total)}₪) - בדוק שלא חסרים פריטים`,
        });
      }

      // Reason D: many lines (>30) - likely a bulk import or error
      if (Number(o.LinesCount || 0) > 30) {
        reasons.push({
          type: 'many_lines',
          severity: 'medium',
          msg: `${o.LinesCount} שורות - הרבה מאוד פריטים בהזמנה אחת`,
        });
      }

      // Reason E: missing address
      if (!o.ShipToAddress && !o.CustCity) {
        reasons.push({
          type: 'no_address',
          severity: 'high',
          msg: 'אין כתובת משלוח - הזמנה לא ניתנת להפצה',
        });
      }

      if (reasons.length > 0) {
        anomalies.push({
          companyCode: o.CompanyCode,
          docEntry: o.DocEntry,
          docNum: o.DocNum,
          cardCode: o.CardCode,
          cardName: o.CardName,
          city: o.CustCity,
          docTotal: total,
          linesCount: Number(o.LinesCount || 0),
          reasons,
          maxSeverity:
            reasons.some((r) => r.severity === 'high') ? 'high' :
            reasons.some((r) => r.severity === 'medium') ? 'medium' : 'low',
        });
      }
    }

    // Sort by severity, then by total descending
    const sevRank = { high: 3, medium: 2, low: 1 };
    anomalies.sort((a, b) =>
      sevRank[b.maxSeverity] - sevRank[a.maxSeverity] || b.docTotal - a.docTotal
    );

    res.json({
      anomalies,
      summary: {
        total: anomalies.length,
        high: anomalies.filter((a) => a.maxSeverity === 'high').length,
        medium: anomalies.filter((a) => a.maxSeverity === 'medium').length,
        low: anomalies.filter((a) => a.maxSeverity === 'low').length,
      },
      thresholds: { p95Total: p95, lowValue: 200 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Customer profitability analytics
//   - Revenue per chain (last N days, from open + delivered orders)
//   - Cost estimate (driver time × stops, fuel × distance, packaging)
//   - Margin = revenue − cost
// Used by management to spot unprofitable customers.
// ----------------------------------------------------------------------------

// ============================================================================
// MTD vs Prior-Year-MTD sales comparison
// Source of truth: OINV.DocDate (actual invoices, not open orders).
// On 2026-05-14 returns: current = 2026-05-01 → 2026-05-14, prior = 2025-05-01
// → 2025-05-14. Feb 29 → Feb 28 clip for non-leap years. Auth via Wave A
// gate on /api/analytics/* (requireAuthBasic).
// ----------------------------------------------------------------------------
function mtdYoYWindowsForToday(today = new Date()) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const currentStart = new Date(Date.UTC(y, m, 1));
  const currentEnd = new Date(Date.UTC(y, m, d));
  // Clip to last day of the prior-year same month (handles Feb 29 → Feb 28).
  const priorMonthLastDay = new Date(Date.UTC(y - 1, m + 1, 0)).getUTCDate();
  const priorStart = new Date(Date.UTC(y - 1, m, 1));
  const priorEnd = new Date(Date.UTC(y - 1, m, Math.min(d, priorMonthLastDay)));
  const monthName = currentStart.toLocaleDateString('he-IL', { month: 'long', timeZone: 'UTC' });
  return {
    current: { from: fmt(currentStart), to: fmt(currentEnd), label: `${monthName} ${y} (1-${d})` },
    prior:   { from: fmt(priorStart),   to: fmt(priorEnd),   label: `${monthName} ${y - 1} (1-${Math.min(d, priorMonthLastDay)})` },
  };
}

function aggregateDailyRows(rows) {
  // rows from getDailySales: [{ DocDate, CompanyCode, OrderCount, Revenue, AvgOrderValue }]
  // We re-aggregate to one totals object + per-company totals. We deliberately
  // recompute avg from revenue/count rather than averaging AvgOrderValue,
  // because averaging daily averages double-weights light days.
  const byCompany = new Map(); // CompanyCode -> { revenue, invoiceCount }
  let totalRevenue = 0;
  let totalCount = 0;
  for (const r of rows || []) {
    const rev = Number(r.Revenue || 0);
    const cnt = Number(r.OrderCount || 0);
    totalRevenue += rev;
    totalCount += cnt;
    const code = String(r.CompanyCode || '');
    if (!byCompany.has(code)) byCompany.set(code, { revenue: 0, invoiceCount: 0 });
    const c = byCompany.get(code);
    c.revenue += rev;
    c.invoiceCount += cnt;
  }
  const safeAvg = (rev, cnt) => (cnt > 0 ? rev / cnt : 0);
  const total = {
    revenue: totalRevenue,
    invoiceCount: totalCount,
    avgInvoiceValue: safeAvg(totalRevenue, totalCount),
  };
  const companyTotals = (code) => {
    const c = byCompany.get(code) || { revenue: 0, invoiceCount: 0 };
    return { revenue: c.revenue, invoiceCount: c.invoiceCount, avgInvoiceValue: safeAvg(c.revenue, c.invoiceCount) };
  };
  return { total, byCompany: { A: companyTotals('A'), B: companyTotals('B') } };
}

function deltaOf(current, prior) {
  // pct is null when prior=0 — avoids dividing by zero and lets the UI show
  // a neutral marker instead of fake "+∞%".
  const mk = (curV, priorV) => {
    const abs = curV - priorV;
    const pct = priorV !== 0 ? (abs / priorV) * 100 : null;
    return { abs, pct };
  };
  return {
    revenue:         mk(current.revenue,         prior.revenue),
    invoiceCount:    mk(current.invoiceCount,    prior.invoiceCount),
    avgInvoiceValue: mk(current.avgInvoiceValue, prior.avgInvoiceValue),
  };
}

app.get('/api/analytics/sales-mtd-yoy', async (_req, res) => {
  try {
    const { current: curW, prior: prW } = mtdYoYWindowsForToday();
    if (!sapLive) {
      // 200 with a warning so the UI can still render the period labels and
      // a zero-row table — same behaviour as customer-profitability.
      const empty = { revenue: 0, invoiceCount: 0, avgInvoiceValue: 0 };
      return res.json({
        currentPeriod: curW, priorPeriod: prW,
        totals: { current: empty, prior: empty, delta: deltaOf(empty, empty) },
        byCompany: [
          { companyCode: 'A', companyName: 'OIG',   current: empty, prior: empty, delta: deltaOf(empty, empty) },
          { companyCode: 'B', companyName: 'UNICO', current: empty, prior: empty, delta: deltaOf(empty, empty) },
        ],
        source: 'OINV.DocDate',
        warnings: ['SAP not connected'],
      });
    }
    const [curRows, prRows] = await Promise.all([
      financialReader.getDailySales({ fromDate: curW.from, toDate: curW.to }),
      financialReader.getDailySales({ fromDate: prW.from, toDate: prW.to }),
    ]);
    const cur = aggregateDailyRows(curRows);
    const pr  = aggregateDailyRows(prRows);
    res.json({
      currentPeriod: curW,
      priorPeriod: prW,
      totals: {
        current: cur.total,
        prior:   pr.total,
        delta:   deltaOf(cur.total, pr.total),
      },
      byCompany: [
        { companyCode: 'A', companyName: 'OIG',
          current: cur.byCompany.A, prior: pr.byCompany.A,
          delta: deltaOf(cur.byCompany.A, pr.byCompany.A) },
        { companyCode: 'B', companyName: 'UNICO',
          current: cur.byCompany.B, prior: pr.byCompany.B,
          delta: deltaOf(cur.byCompany.B, pr.byCompany.B) },
      ],
      source: 'OINV.DocDate',
      warnings: [],
    });
  } catch (err) {
    console.error('[sales-mtd-yoy] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/customer-profitability', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days || 90)));

    if (!sapLive) {
      return res.json({ customers: [], warning: 'SAP not connected' });
    }

    // Pull last N days of sales orders (delivered + open)
    const allOrders = await sapBridge.getOpenOrdersFlat({ limit: 500 }).catch(() => []);

    // Group by parent customer name across both companies
    const byParent = new Map();
    for (const o of allOrders) {
      const parent = store.parentNameOf(o.CardName);
      if (!byParent.has(parent)) {
        byParent.set(parent, {
          parentName: parent,
          revenue: 0,
          orderCount: 0,
          companies: new Set(),
          cities: new Set(),
        });
      }
      const e = byParent.get(parent);
      e.revenue += Number(o.DocTotal || 0);
      e.orderCount += 1;
      e.companies.add(o.CompanyCode);
      if (o.CustCity) e.cities.add(o.CustCity);
    }

    // Estimate delivery cost per order:
    //   - Driver: 25 min/stop × 80₪/hr = 33₪
    //   - Fuel: ~10₪/stop avg
    //   - Packaging/admin: ~5₪/stop
    // Total: ~48₪ cost per stop.
    const COST_PER_STOP = 48;

    const list = Array.from(byParent.values()).map((e) => {
      const cost = e.orderCount * COST_PER_STOP;
      const margin = e.revenue - cost;
      const marginPct = e.revenue > 0 ? margin / e.revenue : 0;
      return {
        parentName: e.parentName,
        revenue: Math.round(e.revenue),
        cost: Math.round(cost),
        margin: Math.round(margin),
        marginPct: Math.round(marginPct * 100) / 100,
        avgOrderValue: Math.round(e.revenue / Math.max(1, e.orderCount)),
        orderCount: e.orderCount,
        companies: Array.from(e.companies),
        citiesCount: e.cities.size,
        // Health flag for the UI
        rank: marginPct >= 0.6 ? 'A' :
              marginPct >= 0.4 ? 'B' :
              marginPct >= 0.2 ? 'C' :
              marginPct >= 0   ? 'D' : 'F',
      };
    });
    list.sort((a, b) => b.margin - a.margin);
    res.json({
      customers: list,
      assumptions: { costPerStop: COST_PER_STOP },
      totalRevenue: list.reduce((s, x) => s + x.revenue, 0),
      totalCost: list.reduce((s, x) => s + x.cost, 0),
      totalMargin: list.reduce((s, x) => s + x.margin, 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force-include an excluded order into a route (manual override of auto-plan filters).
// Body: { runDate?, runId? } - either a specific run id, or we'll auto-find/create one.
app.post('/api/runs/force-include', async (req, res) => {
  try {
    if (!sapLive) return res.status(400).json({ error: 'SAP לא מחובר' });
    const { companyCode, docEntry, runDate, runId } = req.body || {};
    if (!companyCode || !docEntry) return res.status(400).json({ error: 'חסר companyCode / docEntry' });
    const dateToUse = runDate || new Date().toISOString().slice(0, 10);

    // Fetch the order so we know the customer + city
    const orders = await sapBridge.getOpenOrdersFlat({ limit: 500 });
    const ord = orders.find((o) => o.CompanyCode === companyCode && Number(o.DocEntry) === Number(docEntry));
    if (!ord) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    // Find the city
    const addrParts = (ord.ShipToAddress || '').split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
    const city = addrParts[addrParts.length - 1] || ord.CustCity || '';
    const street = addrParts.length > 1 ? addrParts[0] : '';
    const zone = store.suggestZoneForCity(city);

    // Find or create target run
    let targetRun = null;
    if (runId) {
      targetRun = (store.load().runs || []).find((r) => r.RunId === Number(runId));
    } else if (zone) {
      targetRun = store.getRuns().find((r) => r.RunDate === dateToUse && r.ZoneId === zone.ZoneId);
    }
    if (!targetRun) {
      targetRun = store.addRun({
        runDate: dateToUse,
        zoneId: zone?.ZoneId || null,
        driverId: null,
        status: 'OPEN',
        notes: `שיוך ידני - ${ord.CardName}`,
      });
    }

    // Create stop + add the order
    const newStop = store.addStop(targetRun.RunId, {
      street: street || ord.CardName,
      buildingNumber: '',
      city,
      branchName: ord.CardName,
      contactPhone: ord.CustPhone,
    });
    const newOrder = store.addOrderToStop(newStop.StopId, {
      companyCode: ord.CompanyCode,
      docEntry: ord.DocEntry,
      docNum: ord.DocNum,
      cardCode: ord.CardCode,
      cardName: ord.CardName,
      total: ord.DocTotal,
      linesCount: ord.LinesCount,
    });

    io.emit('run:updated', { runId: targetRun.RunId });
    res.json({
      ok: true,
      run: targetRun,
      stop: newStop,
      runOrder: newOrder,
      manuallyForced: true,
    });
  } catch (err) {
    console.error('[force-include]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manager approval to depart (gate between LOADED and IN_TRANSIT)
app.post('/api/runs/:id/approve-departure', (req, res) => {
  const auth = req.headers.authorization;
  let approvedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { approvedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  const result = store.approveRunDeparture(req.params.id, {
    approvedBy,
    notes: req.body?.notes,
    checklist: req.body?.checklist,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  io.emit('run:departure-approved', { runId: Number(req.params.id) });
  res.json(result);
});

app.post('/api/runs/:id/cancel-departure', (req, res) => {
  const auth = req.headers.authorization;
  let rejectedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { rejectedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  const result = store.cancelDepartureApproval(req.params.id, {
    rejectedBy,
    reason: req.body?.reason,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  io.emit('run:departure-cancelled', { runId: Number(req.params.id) });
  res.json(result);
});

// Per-line actual delivery + damage report (used inside POD)
app.post('/api/stops/:id/line-deliveries', (req, res) => {
  const auth = req.headers.authorization;
  let recordedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { recordedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  const result = store.recordLineDeliveries(
    req.params.id,
    req.body?.items || [],
    { recordedBy }
  );
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.get('/api/stops/:id/line-deliveries', (req, res) => {
  res.json({
    deliveries: store.getLineDeliveriesForStop(req.params.id),
    summary: store.summariseStopDeliveryIssues(req.params.id),
  });
});

// Cash on Delivery (COD) - driver records collected money per stop
app.get('/api/cod', (req, res) => {
  const records = store.listCodCollections(req.query.runDate);
  res.json({ records, count: records.length });
});

app.post('/api/cod', (req, res) => {
  try {
    const rec = store.recordCodCollection(req.body);
    res.status(201).json(rec);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/cod/:id/deposit', (req, res) => {
  const rec = store.markCodDeposited(req.params.id, req.body?.depositedBy || 'office');
  if (!rec) return res.status(404).json({ error: 'COD record not found' });
  res.json(rec);
});

app.get('/api/cod/driver/:driverId/summary', (req, res) => {
  const summary = store.summariseCodForDriver(req.params.driverId, req.query.runDate);
  res.json(summary);
});

// Driver performance & leaderboard (smart route learning)
app.get('/api/analytics/driver-performance', (_req, res) => {
  const stats = store.getDriverPerformance();
  const drivers = store.getDrivers();
  const enriched = stats.map((s) => {
    const drv = drivers.find((d) => d.DriverId === s.DriverId);
    return {
      ...s,
      DriverName: drv?.FullName || `Driver ${s.DriverId}`,
      SuccessRate: s.TotalStops > 0 ? s.Delivered / s.TotalStops : 0,
    };
  });
  res.json({ stats: enriched });
});

app.get('/api/analytics/suggest-drivers/:zoneCode', (req, res) => {
  const drivers = store.getDrivers();
  const suggestions = store.suggestDriversForZone(req.params.zoneCode).map((s) => {
    const drv = drivers.find((d) => d.DriverId === s.DriverId);
    return { ...s, DriverName: drv?.FullName || `Driver ${s.DriverId}` };
  });
  res.json({ suggestions });
});

// Customer business hours (delivery windows)
app.get('/api/customers/hours', (_req, res) => {
  res.json({
    hours: store.listCustomerHours(),
    defaults: store.getDefaultBusinessHours(),
  });
});
app.get('/api/customers/hours/:parentName', (req, res) => {
  const parentName = decodeURIComponent(req.params.parentName);
  const hours = store.resolveHoursForCardName(parentName);
  res.json({ parentName, hours });
});
app.patch('/api/customers/hours/:parentName', (req, res) => {
  const parentName = decodeURIComponent(req.params.parentName);
  const ok = store.setCustomerHours(parentName, req.body?.hours || null);
  if (!ok) return res.status(400).json({ error: 'Invalid parent name' });
  res.json({ ok: true, parentName });
});

// Bulk update — useful when applying a default to many parents at once
app.post('/api/customers/policies/bulk', (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  let count = 0;
  for (const { parentName, docType } of updates) {
    if (store.setCustomerDocPolicy(parentName, docType)) count++;
  }
  res.json({ ok: true, updated: count });
});
app.patch('/api/zones/cities/:city', (req, res) => {
  const city = decodeURIComponent(req.params.city);
  const zoneCode = req.body?.zoneCode || null;
  const ok = store.setCityZone(city, zoneCode);
  if (!ok) return res.status(400).json({ error: 'Invalid city' });
  res.json({ ok: true, city, zoneCode });
});
app.get('/api/zones/:id', (req, res) => {
  const zone = store.getZones().find((z) => z.ZoneId === Number(req.params.id));
  zone ? res.json(zone) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/zones', (req, res) => {
  try {
    const newZone = store.addZone(req.body);
    res.status(201).json(newZone);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch('/api/zones/:id', (req, res) => {
  const updated = store.updateZone(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Zone not found' });
  res.json(updated);
});
app.delete('/api/zones/:id', (req, res) => {
  const ok = store.deleteZone(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Zone not found' });
  res.json({ ok: true });
});

// Drivers
// Drivers - full CRUD with persistent storage
// Wave A mitigation: GET requires any valid Bearer (planners read driver list);
// mutations require ADMIN.
app.use('/api/drivers', requireAuthBasic);
app.get('/api/drivers', (_req, res) => {
  res.json({ drivers: store.getDrivers() });
});

app.post('/api/drivers', adminOnly, (req, res) => {
  const newDriver = store.addDriver(req.body);
  io.emit('driver:created', newDriver);
  res.status(201).json(newDriver);
});

app.patch('/api/drivers/:id', adminOnly, (req, res) => {
  const updated = store.updateDriver(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Driver not found' });
  io.emit('driver:updated', updated);
  res.json(updated);
});

app.patch('/api/drivers/:id/zones', adminOnly, (req, res) => {
  const zoneCodes = (req.body.zoneIds || []).map((id) => {
    const zone = data.zones.find((z) => z.ZoneId === id);
    return zone?.Code;
  }).filter(Boolean).join(',');
  const updated = store.updateDriver(req.params.id, { zones: zoneCodes });
  if (!updated) return res.status(404).json({ error: 'Driver not found' });
  res.json({ ok: true });
});

app.delete('/api/drivers/:id', adminOnly, (req, res) => {
  const ok = store.deleteDriver(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Driver not found' });
  io.emit('driver:deleted', { DriverId: Number(req.params.id) });
  res.json({ ok: true });
});

// Users - full CRUD with persistence
// Wave A mitigation: all admin-CRUD handlers require ADMIN. /me/* paths
// (change-password registered earlier at line ~263, subscriptions below)
// stay on requireAuthBasic so any authed user can self-serve.
app.get('/api/users', adminOnly, (_req, res) => res.json({ users: store.getUsers() }));

app.post('/api/users', adminOnly, async (req, res) => {
  try {
    const newUser = await store.addUser(req.body);
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/users/:id', adminOnly, async (req, res) => {
  try {
    const updated = await store.updateUser(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:id/reset-password', adminOnly, async (req, res) => {
  const { password } = req.body || {};
  const strength = validatePasswordStrength(password);
  if (!strength.ok) return res.status(400).json({ error: strength.error, code: strength.code });
  const target = store.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Phase 4a — flag the target so their next login is forced through the
  // change-password screen with the temp password they were just handed.
  const ok = await store.setUserPassword(req.params.id, password, {
    adminInitiated: true, reason: 'admin_reset',
  });
  if (!ok) return res.status(404).json({ error: 'User not found' });
  // Force logout of any active sessions for the reset user so the rotation
  // is real, not cosmetic.
  store.logoutSub(Number(req.params.id));
  store.recordAudit({
    action: 'password.reset.admin',
    actorSub: req.user?.sub, actorName: req.user?.name,
    targetUserId: target.UserId, targetUsername: target.Username,
    success: true, ip: req.ip,
  });
  res.json({ ok: true, mustChangePassword: true });
});

// Phase 4a — self-service profile update. Only the three fields the user is
// supposed to fill on their own (FullName / Email / Phone). Role / IsActive
// / Username stay admin-controlled, edited via /api/users/:id.
const ProfileUpdateSchema = z.object({
  fullName: z.string().trim().min(2, 'שם חייב להכיל לפחות 2 תווים').max(100).optional(),
  email: z.string().trim().email('כתובת מייל לא תקינה').max(200).optional(),
  phone: z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'מספר טלפון לא תקין').optional(),
});
app.patch('/api/users/me/profile', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try { payload = verifyToken(auth.slice(7)); }
  catch (err) {
    const code = err.code === 'TOKEN_REVOKED' ? 'TOKEN_REVOKED' : undefined;
    return res.status(401).json({ error: err.message || 'Invalid token', code });
  }
  const data = parseBody(ProfileUpdateSchema, req.body, res);
  if (!data) return;
  const updated = store.updateUserProfile(payload.sub, data);
  if (!updated) return res.status(404).json({ error: 'משתמש לא נמצא' });
  store.recordAudit({
    action: 'profile.update.self',
    actorSub: payload.sub, actorName: payload.name,
    targetUserId: payload.sub, targetUsername: updated.Username,
    success: true, ip: req.ip,
    details: { fields: Object.keys(data) },
  });
  res.json({
    ok: true,
    user: {
      id: updated.UserId, username: updated.Username, name: updated.FullName,
      email: updated.Email || '', phone: updated.Phone || '',
      role: updated.Role,
      profileCompleted: updated.ProfileCompleted !== false,
    },
  });
});

app.delete('/api/users/:id', adminOnly, (req, res) => {
  try {
    const auth = req.headers.authorization;
    let requesterId = null;
    if (auth?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        requesterId = payload.sub;
      } catch {}
    }
    const ok = store.deleteUser(req.params.id, requesterId);
    if (!ok) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users/me/subscriptions', requireAuthBasic, (_req, res) => res.json({ subscriptions: [
  { SubscriptionId: 1, EventType: 'STOP_FAILED_HIGH', Channel: 'EMAIL', IsActive: true },
  { SubscriptionId: 2, EventType: 'DAILY_DIGEST', Channel: 'EMAIL', IsActive: true },
]}));
app.put('/api/users/me/subscriptions', requireAuthBasic, (_req, res) => res.json({ ok: true }));

// Runs
// Runs - backed by persistent store (no demo data - build from real SAP orders)
app.get('/api/runs', (req, res) => {
  let filtered = [...store.getRuns()];
  if (req.query.runDate) filtered = filtered.filter((r) => r.RunDate === req.query.runDate);
  if (req.query.driverId) filtered = filtered.filter((r) => r.DriverId === Number(req.query.driverId));
  if (req.query.status) filtered = filtered.filter((r) => r.Status === req.query.status);
  res.json({ runs: filtered });
});

app.get('/api/runs/:id', (req, res) => {
  const run = store.getRunDetails(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.post('/api/runs', (req, res) => {
  const newRun = store.addRun(req.body);
  io.emit('run:created', newRun);
  res.status(201).json(newRun);
});

app.post('/api/runs/:id/duplicate', (req, res) => {
  const newRunDate = req.body.runDate || new Date().toISOString().slice(0, 10);
  const newRun = store.duplicateRun(req.params.id, newRunDate);
  if (!newRun) return res.status(404).json({ error: 'Source run not found' });
  io.emit('run:created', newRun);
  res.status(201).json(newRun);
});

app.patch('/api/runs/:id', (req, res) => {
  try {
    const updated = store.updateRun(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    io.emit('run:updated', updated);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch('/api/runs/:id/status', (req, res) => {
  const runId = Number(req.params.id);
  const run = store.updateRun(runId, { status: req.body.status });
  if (!run) return res.status(404).json({ error: 'Not found' });
  io.emit('run:status-changed', { runId, newStatus: req.body.status });
  res.json({ runId, newStatus: req.body.status });
});

app.delete('/api/runs/:id', (req, res) => {
  store.deleteRun(req.params.id);
  io.emit('run:deleted', { runId: Number(req.params.id) });
  res.json({ ok: true });
});

// Stops - add/remove/reorder within a run
app.post('/api/runs/:runId/stops', (req, res) => {
  const newStop = store.addStop(req.params.runId, req.body);
  if (!newStop) return res.status(404).json({ error: 'Run not found' });
  io.emit('stop:added', newStop);
  res.status(201).json(newStop);
});

app.patch('/api/stops/:stopId', (req, res) => {
  const updated = store.updateStop(req.params.stopId, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.delete('/api/stops/:stopId', (req, res) => {
  const ok = store.deleteStop(req.params.stopId);
  if (!ok) return res.status(404).json({ error: 'Stop not found' });
  io.emit('stop:deleted', { stopId: Number(req.params.stopId) });
  res.json({ ok: true });
});

app.post('/api/stops/:stopId/move-up', (req, res) => {
  store.moveStop(req.params.stopId, 'up');
  res.json({ ok: true });
});

app.post('/api/stops/:stopId/move-down', (req, res) => {
  store.moveStop(req.params.stopId, 'down');
  res.json({ ok: true });
});

// Move a stop to a different run
app.post('/api/stops/:stopId/move-to-run', (req, res) => {
  const result = store.moveStopToRun(req.params.stopId, req.body.targetRunId);
  if (!result) return res.status(400).json({ error: 'Stop or target run not found' });
  io.emit('stop:moved', result);
  res.json(result);
});

// Split a run
app.post('/api/runs/:id/split', (req, res) => {
  const maxStops = Number(req.body.maxStopsPerRun) || 25;
  const newRun = store.splitRun(req.params.id, maxStops);
  if (!newRun) return res.status(400).json({ error: 'המסלול קטנה מדי לפיצול' });
  io.emit('run:split', { originalRunId: Number(req.params.id), newRunId: newRun.RunId });
  res.json(newRun);
});

// Add SAP order to a stop
app.post('/api/stops/:stopId/orders', (req, res) => {
  const newOrder = store.addOrderToStop(req.params.stopId, req.body);
  if (!newOrder) return res.status(404).json({ error: 'Stop not found' });
  io.emit('order:added', newOrder);
  res.status(201).json(newOrder);
});

app.delete('/api/run-orders/:runOrderId', (req, res) => {
  const ok = store.deleteRunOrder(req.params.runOrderId);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/**
 * Auto-plan day: pulls all open SAP orders, groups by city→zone,
 * and creates one run per zone with stops+orders.
 * Idempotent: skips orders already assigned to a run today.
 */
// ------------------------------------------------------------------
// Shared exclusion logic — runs the SAME 3 filters (low customer total,
// too few lines, missing stock) used by /api/runs/auto-plan. Reused by
// /api/runs/auto-plan/preview-exclusions so the planner can see exactly
// who will and won't be planned, without creating any runs.
// Returns { allOrders, plannableOrders, excludedOrders, filters,
//           alreadyAssigned, existingRuns }.
// ------------------------------------------------------------------
async function computePlanExclusions(opts = {}) {
  const runDate = opts.runDate || new Date().toISOString().slice(0, 10);

  // Same-day runs — used to decide whether to add stops to an existing run
  // for a given zone (later in auto-plan, NOT for the alreadyAssigned check).
  const existingRuns = store.getRuns().filter((r) => r.RunDate === runDate);

  // alreadyAssigned spans ALL runs (cross-day). An order that's been in any
  // earlier run is presumed dispatched/picked; re-planning it for today
  // would create a "ghost" run-order whose SAP lines may already be closed
  // (OpenQty=0), causing buildWave to fail with "no open lines". The
  // operator can still pull a specific order back via /api/runs/force-include.
  //
  // A2g-FIX-CANCEL-EXCLUSION (2026-05-20): CANCELLED entities (runs OR
  // their child run-orders) DO NOT lock the SAP order. The original design
  // predates the CANCELLED concept; without this exclusion, any bulk
  // run/wave cancellation leaves the SAP orders permanently "ghost-blocked"
  // from re-planning even though no live run owns them. Mirrored in
  // previewSelectedOrders.js (same logic, shared test coverage).
  const allRunOrders = store.load().runOrders || [];
  const allStops = store.load().stops || [];
  const allRunsForStatus = store.getRuns() || [];
  const stopIdToRunId = new Map(allStops.map((s) => [s.StopId, s.RunId]));
  const runStatusById = new Map(allRunsForStatus.map((r) => [r.RunId, r.Status]));
  const alreadyAssigned = new Set(
    allRunOrders
      .filter((o) => {
        // A2g-FIX-CANCEL-EXCLUSION: skip cancelled run-orders and orders on cancelled runs.
        if (o.Status === 'CANCELLED') return false;
        const runId = stopIdToRunId.get(o.StopId);
        if (runId == null) return false;
        if (runStatusById.get(runId) === 'CANCELLED') return false;
        return true;
      })
      .map((o) => `${o.CompanyCode}-${o.SapDocEntry}`)
  );

  if (!sapLive) {
    const err = new Error('SAP לא מחובר - לא ניתן לבצע תכנון אוטומטי');
    err.status = 400;
    throw err;
  }
  const allOrders = await sapBridge.getOpenOrdersFlat({ limit: 500 });

  const MIN_CUSTOMER_TOTAL = Number(opts.minCustomerTotal ?? 3000);
  const requireStock = opts.requireStock !== false;

  // (a) Customer-total aggregation key — uses CardCode, NOT CardName.
  //
  // The planner UI promises "סך הזמנות הלקוח (שתי החברות)". The grouping
  // must use a stable business identifier (codes), not a free-text name
  // that can split chains because of quote variants ("בע\"מ" vs "בע״מ"),
  // spacing, or inconsistent branch suffixes.
  //
  // Policy:
  //   - If SAP exposes a parent identifier (ParentCardCode / ChainCode /
  //     MasterCustomerKey / Father) — use it.
  //   - Otherwise fall back to CardCode itself. Each CardCode is treated
  //     as its own customer; branch-level aggregation is NOT done here.
  //     If two branches of the same chain have different CardCodes, the
  //     chain is intentionally split — the operator gets a precise read
  //     (no false-positive aggregation) at the cost of some orders
  //     remaining below the threshold.
  //
  // No CardName parsing is used as a chain key (was tried earlier and
  // reverted — name parsing is too fragile).
  const customerTotals = new Map();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const customerKey = (o) =>
    String(o.ParentCardCode || o.ChainCode || o.MasterCustomerKey || o.Father || o.CardCode || '').trim();
  for (const o of allOrders) {
    const k = customerKey(o);
    customerTotals.set(k, (customerTotals.get(k) || 0) + Number(o.DocTotal || 0));
  }

  // (b) Per-order lines + stock availability.
  // Always load order lines (regardless of requireStock) — the planner UI
  // wants to see WHICH items are in any excluded order, not just the ones
  // failing stock. Stock map is still loaded only when requireStock=true.
  let stockMap = new Map();
  let linesByOrder = new Map();
  const refs = allOrders.map((o) => ({ companyCode: o.CompanyCode, docEntry: o.DocEntry }));
  const allLines = await sapBridge.getBulkOrderLines(refs).catch((e) => {
    console.warn('[plan-exclusions] getBulkOrderLines failed:', e.message);
    return [];
  });
  for (const ln of allLines) {
    const k = `${ln.CompanyCode}:${ln.DocEntry}`;
    if (!linesByOrder.has(k)) linesByOrder.set(k, []);
    linesByOrder.get(k).push(ln);
  }
  if (requireStock) {
    const PICKING_WAREHOUSES = (process.env.PICKING_WAREHOUSES || '01,02,03,10,20')
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const code of ['A', 'B']) {
      const itemCodes = [...new Set(allLines.filter((l) => l.CompanyCode === code).map((l) => l.ItemCode))];
      if (itemCodes.length === 0) continue;
      for (let i = 0; i < itemCodes.length; i += 200) {
        const batch = itemCodes.slice(i, i + 200);
        const stock = await sapBridge.getItemsStock(code, batch).catch(() => []);
        for (const s of stock) {
          if (!PICKING_WAREHOUSES.includes(String(s.WarehouseCode))) continue;
          const sk = `${code}:${s.ItemCode}`;
          stockMap.set(sk, (stockMap.get(sk) || 0) + Number(s.Available || 0));
        }
      }
    }
  }

  // Helper: compact items[] for any reason (one row per SKU in the order).
  function itemsOf(o) {
    const lns = linesByOrder.get(`${o.CompanyCode}:${o.DocEntry}`) || [];
    return lns.map((ln) => ({
      itemCode: ln.ItemCode,
      itemName: ln.ItemName,
      quantity: Number(ln.OpenQty || ln.Quantity || 0),
    }));
  }

  // (c) Apply the 3 filters.
  const plannableOrders = [];
  const excludedOrders = [];
  // Did SAP return any lines at all? If yes, "no rows for THIS order" is
  // meaningful (the order is closed). If allLines is empty, the SAP call
  // itself probably failed and we shouldn't blame each order for it.
  const sapLinesAvailable = allLines.length > 0;

  for (const o of allOrders) {
    const reasons = [];
    // Read the per-customer total under the same key the loop in (a) wrote.
    const custTotal = customerTotals.get(customerKey(o)) || 0;
    if (custTotal < MIN_CUSTOMER_TOTAL) {
      reasons.push({
        type: 'low_total', total: custTotal, threshold: MIN_CUSTOMER_TOTAL,
        items: itemsOf(o),
      });
    }
    const ordLinesCount = Number(o.LinesCount || 0);
    // no_open_lines — RDR1 has zero open rows for this DocEntry. Either the
    // order shipped from a previous run-day (OpenQty already drawn down by
    // a real-life DN in SAP) or the order is closed. Either way, this run
    // order would be dead weight: buildWave's getBulkOrderLines call
    // returns empty and the picker UI shows "no open lines found".
    if (sapLinesAvailable) {
      const lns = linesByOrder.get(`${o.CompanyCode}:${o.DocEntry}`) || [];
      if (lns.length === 0) {
        reasons.push({ type: 'no_open_lines', linesCount: ordLinesCount, items: [] });
      }
    }
    if (requireStock) {
      const lns = linesByOrder.get(`${o.CompanyCode}:${o.DocEntry}`) || [];
      const missing = [];
      for (const ln of lns) {
        const avail = stockMap.get(`${o.CompanyCode}:${ln.ItemCode}`) || 0;
        const needed = Number(ln.OpenQty || ln.Quantity || 0);
        if (avail < needed) {
          missing.push({ itemCode: ln.ItemCode, itemName: ln.ItemName, needed, available: avail });
        }
      }
      if (missing.length > 0) reasons.push({ type: 'missing_stock', items: missing });
    }
    if (reasons.length > 0) {
      excludedOrders.push({
        companyCode: o.CompanyCode,
        docEntry: o.DocEntry,
        docNum: o.DocNum,
        cardCode: o.CardCode,
        cardName: o.CardName,
        docTotal: Number(o.DocTotal || 0),
        customerTotal: custTotal,
        shipToAddress: o.ShipToAddress,
        custCity: o.CustCity,
        reasons,
      });
    } else {
      plannableOrders.push(o);
    }
  }

  return {
    runDate,
    allOrders,
    plannableOrders,
    excludedOrders,
    filters: {
      minCustomerTotal: MIN_CUSTOMER_TOTAL,
      requireStock,
    },
    alreadyAssigned,
    existingRuns,
  };
}

// Preview-only: shows the planner exactly who would be excluded if they
// ran auto-plan right now. Does NOT mutate any data — no runs are
// created. Same filters as /api/runs/auto-plan so there is one source of
// truth for the exclusion rule.
app.get('/api/runs/auto-plan/preview-exclusions', async (req, res) => {
  try {
    const result = await computePlanExclusions({
      runDate: req.query.runDate,
      minCustomerTotal: req.query.minCustomerTotal,
      requireStock: req.query.requireStock !== 'false',
    });
    const e = result.excludedOrders;
    res.json({
      runDate: result.runDate,
      excludedOrders: e,
      summary: {
        totalOrders: result.allOrders.length,
        ordersPlannable: result.plannableOrders.length,
        ordersExcluded: e.length,
        excludedLowTotal:     e.filter((o) => o.reasons.some((r) => r.type === 'low_total')).length,
        excludedMissingStock: e.filter((o) => o.reasons.some((r) => r.type === 'missing_stock')).length,
        excludedNoOpenLines:  e.filter((o) => o.reasons.some((r) => r.type === 'no_open_lines')).length,
      },
      filters: result.filters,
      preview: true,
    });
  } catch (err) {
    console.error('[preview-exclusions] failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Phase 1 of the open-orders-with-condition feature. For each open order
// returns the same exclusion breakdown the planner uses, PLUS a delivery-day
// check derived from customerDeliveryProfiles. The frontend uses this to
// paint a per-order pass/fail badge on the open-orders screen so the
// logistics manager can preview "what would happen if I planned today"
// without actually creating a run.
//
// Query params (all optional):
//   runDate           YYYY-MM-DD (default: today UTC)
//   minCustomerTotal  number (default: 3000 via computePlanExclusions)
//   requireStock      'false' disables stock check (default true)
//   applyDeliveryDay  'false' disables the day check (default true)
//
// Errors propagate from computePlanExclusions (e.g. 400 if SAP is offline).
app.get('/api/orders/open-with-plan-eval', async (req, res) => {
  try {
    const base = await computePlanExclusions({
      runDate: req.query.runDate,
      minCustomerTotal: req.query.minCustomerTotal,
      requireStock: req.query.requireStock !== 'false',
    });
    const applyDeliveryDay = req.query.applyDeliveryDay !== 'false';

    const exclusionMap = new Map();
    for (const ex of base.excludedOrders) {
      exclusionMap.set(`${ex.companyCode}:${ex.docEntry}`, ex.reasons);
    }

    const todayHebrew = hebrewDayFromDate(base.runDate);

    const profiles = store.load().customerDeliveryProfiles || [];
    const profileMap = new Map();
    for (const p of profiles) {
      if (p?.CardCode) profileMap.set(`${p.Company || ''}:${p.CardCode}`, p);
    }

    const filters = { ...base.filters, applyDeliveryDay };

    // (2026-05-27) Build a per-customer total map so evaluatePlanForOrder
    // can surface customerTotalCurrent on EVERY row (passing or failing).
    // Uses the same customerKey rule as computePlanExclusions so the two
    // datasets stay aligned even if the rule changes there. The user
    // asked: "why does a ₪525 order say 'עובר' against a ₪3,000 threshold?"
    // Answer: because the *customer's* aggregate ≥ ₪3,000. Surface it.
    const customerKey = (o) =>
      String(o.ParentCardCode || o.ChainCode || o.MasterCustomerKey || o.Father || o.CardCode || '').trim();
    const customerTotalsByKey = new Map();
    for (const o of base.allOrders) {
      const k = customerKey(o);
      customerTotalsByKey.set(k, (customerTotalsByKey.get(k) || 0) + Number(o.DocTotal || 0));
    }

    const ordersWithEval = base.allOrders.map((o) => {
      const companyName = o.CompanyCode === 'A' ? 'OIG' : o.CompanyCode === 'B' ? 'UNICO' : o.CompanyCode;
      const profile = profileMap.get(`${companyName}:${o.CardCode}`) || null;
      const planEval = evaluatePlanForOrder({
        order: o,
        exclusionReasons: exclusionMap.get(`${o.CompanyCode}:${o.DocEntry}`) || [],
        customerTotal: customerTotalsByKey.get(customerKey(o)) ?? 0,
        profile,
        todayHebrew,
        filters,
      });
      // Open-orders zone toolbar (2026-05-24): mirror the city→zone
      // enrichment from /api/orders/open so the frontend toolbar works
      // identically whether plan-eval is on or off. CITY-derived; ignores
      // any profile.Zone the customer happens to carry.
      const addressParts = (o.ShipToAddress || '')
        .split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
      const city = addressParts[addressParts.length - 1] || o.CustCity || '';
      const zone = city ? store.suggestZoneForCity(city) : null;
      return {
        ...o,
        planEval,
        Zone:      zone?.Code     || null,
        ZoneName:  zone?.Name     || null,
        ZoneColor: zone?.ColorHex || zone?.Color || null,
      };
    });

    const passing = ordersWithEval.filter((x) => x.planEval.passes).length;
    const failingDayOnly = ordersWithEval.filter((x) =>
      !x.planEval.passes &&
      x.planEval.customerTotalOK &&
      x.planEval.hasOpenLines &&
      x.planEval.stockOK &&
      !x.planEval.deliveryDayOK
    ).length;

    res.json({
      runDate: base.runDate,
      todayHebrew,
      filters,
      summary: {
        total: ordersWithEval.length,
        passing,
        failing: ordersWithEval.length - passing,
        failingDayOnly,
      },
      ordersWithEval,
    });
  } catch (err) {
    console.error('[open-with-plan-eval] failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/runs/auto-plan', async (req, res) => {
  try {
    const plan = await computePlanExclusions({
      runDate: req.body.runDate,
      minCustomerTotal: req.body.minCustomerTotal,
      requireStock: req.body.requireStock,
    });
    const { runDate, plannableOrders: orders, excludedOrders, alreadyAssigned, existingRuns, filters } = plan;

    // Group by zone
    const byZone = {}; // zoneCode → { zone, orders: [...] }
    const unassigned = [];
    for (const order of orders) {
      const key = `${order.CompanyCode}-${order.DocEntry}`;
      if (alreadyAssigned.has(key)) continue;

      // Parse city from ShipToAddress (last non-empty line) or fallback to CustCity
      const addressParts = (order.ShipToAddress || '')
        .split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
      const city = addressParts[addressParts.length - 1] || order.CustCity || '';
      const street = addressParts.length > 1 ? addressParts[0] : '';

      const zone = store.suggestZoneForCity(city);
      if (!zone) {
        unassigned.push({ ...order, cityParsed: city });
        continue;
      }
      if (!byZone[zone.Code]) byZone[zone.Code] = { zone, orders: [] };
      byZone[zone.Code].orders.push({ ...order, cityParsed: city, streetParsed: street });
    }

    // Create runs + stops + orders
    const runsCreated = [];
    for (const { zone, orders: zoneOrders } of Object.values(byZone)) {
      // Check if there's already a run for this zone+date
      let targetRun = existingRuns.find((r) => r.ZoneId === zone.ZoneId);
      if (!targetRun) {
        targetRun = store.addRun({
          runDate,
          zoneId: zone.ZoneId,
          driverId: null,
          status: 'OPEN',
          notes: `תכנון אוטומטי - ${runDate}`,
        });
      }

      // Group orders by customer address (merge same destination)
      const byAddressKey = {};
      for (const o of zoneOrders) {
        const key = `${o.streetParsed}|${o.cityParsed}|${o.CardCode}`;
        if (!byAddressKey[key]) byAddressKey[key] = [];
        byAddressKey[key].push(o);
      }

      for (const ordersAtAddress of Object.values(byAddressKey)) {
        const first = ordersAtAddress[0];
        const newStop = store.addStop(targetRun.RunId, {
          street: first.streetParsed || first.CardName,
          buildingNumber: '',
          city: first.cityParsed,
          branchName: first.CardName,
          contactPhone: first.CustPhone,
        });
        for (const o of ordersAtAddress) {
          store.addOrderToStop(newStop.StopId, {
            companyCode: o.CompanyCode,
            docEntry: o.DocEntry,
            docNum: o.DocNum,
            cardCode: o.CardCode,
            cardName: o.CardName,
            total: o.DocTotal,
            linesCount: o.LinesCount,
          });
        }
      }

      runsCreated.push({
        run: targetRun,
        stopCount: store.getRunDetails(targetRun.RunId).stops.length,
        zoneName: zone.Name,
        orderCount: zoneOrders.length,
      });
    }

    io.emit('runs:auto-planned', { runDate, count: runsCreated.length });

    res.json({
      runsCreated,
      unassignedAddresses: unassigned.length > 0
        ? unassigned.map((o) => ({
            customerName: o.CardName,
            city: o.cityParsed,
            docNum: o.DocNum,
            companyCode: o.CompanyCode,
          }))
        : null,
      excludedOrders, // orders skipped because below 3000₪ or missing stock
      summary: {
        zonesPlanned: runsCreated.length,
        ordersAssigned: orders.length - unassigned.length,
        ordersUnassigned: unassigned.length,
        ordersSkipped: Array.from(alreadyAssigned).length,
        ordersExcluded: excludedOrders.length,
        excludedLowTotal: excludedOrders.filter((o) => o.reasons.some((r) => r.type === 'low_total')).length,
        excludedMissingStock: excludedOrders.filter((o) => o.reasons.some((r) => r.type === 'missing_stock')).length,
      },
      filters,
    });
  } catch (err) {
    console.error('[auto-plan] failed:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Phase 2 — create runs from a hand-picked list of orders (as opposed to
// /api/runs/auto-plan which discovers orders via computePlanExclusions).
// Used by the OpenOrdersPage "שלח לליקוט" button after the manager has
// previewed which orders pass the daily condition. The endpoint:
//   1. Validates every requested (companyCode, docEntry) exists in the
//      current SAP open-orders snapshot — refuses if any is missing
//      (probably closed / already shipped) so the operator gets a clean
//      diff instead of silent drops.
//   2. Refuses if any order is already in another run (cross-run
//      cross-day uniqueness — same guard auto-plan uses).
//   3. Groups by zone (suggestZoneForCity) and, within a zone, by
//      address+CardCode so multiple orders to the same destination merge
//      into one stop.
//   4. Creates a Run per zone (or reuses an OPEN run for that zone+date
//      so the operator can add to an existing plan without splitting).
//   5. Adds stops + run-orders. Does NOT build the wave — the frontend
//      calls the existing /api/runs/:id/wave for that, which keeps wave
//      creation logic single-sourced.
app.post(
  '/api/runs/from-selected-orders',
  idempotencyMiddleware(idempotencyCache, 'POST /api/runs/from-selected-orders'),
  async (req, res) => {
  try {
    const runDate = req.body.runDate || new Date().toISOString().slice(0, 10);
    const orderRefs = Array.isArray(req.body.orders) ? req.body.orders : null;
    if (!orderRefs || orderRefs.length === 0) {
      return res.status(400).json({ error: 'orders array required (1+)', code: 'NO_ORDERS' });
    }
    if (orderRefs.length > 500) {
      return res.status(400).json({ error: 'too many orders (max 500)', code: 'TOO_MANY' });
    }
    for (const ref of orderRefs) {
      if (!ref || !ref.companyCode || ref.docEntry == null) {
        return res.status(400).json({ error: 'each order needs companyCode + docEntry', code: 'BAD_REF' });
      }
    }

    if (!sapLive) {
      return res.status(400).json({ error: 'SAP לא מחובר', code: 'SAP_OFFLINE' });
    }

    // Pull current open orders and keep only the requested ones.
    const allOpen = await sapBridge.getOpenOrdersFlat({ limit: 1000 });
    const requestedKeys = new Set(orderRefs.map((r) => `${r.companyCode}:${r.docEntry}`));
    const orders = allOpen.filter((o) => requestedKeys.has(`${o.CompanyCode}:${o.DocEntry}`));

    const foundKeys = new Set(orders.map((o) => `${o.CompanyCode}:${o.DocEntry}`));
    const missing = orderRefs.filter((r) => !foundKeys.has(`${r.companyCode}:${r.docEntry}`));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `${missing.length} הזמנות לא נמצאו ברשימה הפתוחה (כנראה נסגרו או הוזמנו לקו אחר)`,
        code: 'ORDERS_MISSING',
        missing: missing.slice(0, 10),
      });
    }

    // Refuse orders that are already in some other run.
    //
    // A2g-FIX-CANCEL-EXCLUSION-2 (2026-05-20): mirror of the same fix
    // landed in previewSelectedOrders.js (preview path) and
    // computePlanExclusions (auto-plan / open-with-plan-eval path). This
    // is the third copy of the same alreadyAssigned algorithm — the LIVE
    // submit handler for POST /api/runs/from-selected-orders. Without
    // this carve-out a cancelled run-order or a run-order on a CANCELLED
    // run is still treated as a permanent lock, so any bulk reset leaves
    // its SAP orders ghost-blocked forever. All other statuses (OPEN /
    // PICKING / LOADED / PENDING_QC / COMPLETED) keep the original lock.
    const storeData = store.load();
    const allRuns = storeData.runs || [];
    const allRunOrders = storeData.runOrders || [];
    const allStops = storeData.stops || [];
    const allWaves = storeData.waves || [];
    const stopIdToRunId = new Map(allStops.map((s) => [s.StopId, s.RunId]));
    const runStatusById = new Map(allRuns.map((r) => [r.RunId, r.Status]));
    const alreadyAssigned = new Set(
      allRunOrders
        .filter((o) => {
          if (o.Status === 'CANCELLED') return false;
          const runId = stopIdToRunId.get(o.StopId);
          if (runId == null) return false;
          if (runStatusById.get(runId) === 'CANCELLED') return false;
          return true;
        })
        .map((o) => `${o.CompanyCode}-${o.SapDocEntry}`)
    );
    const conflicts = orders.filter((o) => alreadyAssigned.has(`${o.CompanyCode}-${o.DocEntry}`));
    if (conflicts.length > 0) {
      const conflictCtx = { runs: allRuns, stops: allStops, runOrders: allRunOrders, waves: allWaves };
      return res.status(409).json({
        error: `${conflicts.length} הזמנות כבר שייכות למסלול קיים`,
        code: 'ALREADY_ASSIGNED',
        conflicts: conflicts.slice(0, 10).map((o) => enrichConflict(o, conflictCtx)),
      });
    }

    // Group by zone (same logic as auto-plan).
    const byZone = {};
    const unassigned = [];
    for (const order of orders) {
      const addressParts = (order.ShipToAddress || '')
        .split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
      const city = addressParts[addressParts.length - 1] || order.CustCity || '';
      const street = addressParts.length > 1 ? addressParts[0] : '';
      const zone = store.suggestZoneForCity(city);
      if (!zone) {
        unassigned.push({ ...order, cityParsed: city });
        continue;
      }
      if (!byZone[zone.Code]) byZone[zone.Code] = { zone, orders: [] };
      byZone[zone.Code].orders.push({ ...order, cityParsed: city, streetParsed: street });
    }

    // Create runs + stops + orders.
    const existingRuns = store.getRuns().filter(
      (r) => r.RunDate === runDate && r.Status !== 'COMPLETED' && r.Status !== 'CANCELLED'
    );
    const runsCreated = [];
    for (const { zone, orders: zoneOrders } of Object.values(byZone)) {
      let targetRun = existingRuns.find((r) => r.ZoneId === zone.ZoneId && r.Status === 'OPEN');
      const reusedExisting = !!targetRun;
      if (!targetRun) {
        targetRun = store.addRun({
          runDate,
          zoneId: zone.ZoneId,
          driverId: null,
          status: 'OPEN',
          notes: `נשלח ידנית מהזמנות פתוחות - ${runDate}`,
        });
      }
      const byAddressKey = {};
      for (const o of zoneOrders) {
        const key = `${o.streetParsed}|${o.cityParsed}|${o.CardCode}`;
        if (!byAddressKey[key]) byAddressKey[key] = [];
        byAddressKey[key].push(o);
      }
      for (const ordersAtAddress of Object.values(byAddressKey)) {
        const first = ordersAtAddress[0];
        const newStop = store.addStop(targetRun.RunId, {
          street: first.streetParsed || first.CardName,
          buildingNumber: '',
          city: first.cityParsed,
          branchName: first.CardName,
          contactPhone: first.CustPhone,
        });
        for (const o of ordersAtAddress) {
          store.addOrderToStop(newStop.StopId, {
            companyCode: o.CompanyCode,
            docEntry: o.DocEntry,
            docNum: o.DocNum,
            cardCode: o.CardCode,
            cardName: o.CardName,
            total: o.DocTotal,
            linesCount: o.LinesCount,
          });
        }
      }
      const refreshed = store.getRunDetails(targetRun.RunId);
      runsCreated.push({
        runId: targetRun.RunId,
        runNumber: targetRun.RunNumber,
        zoneCode: zone.Code,
        zoneName: zone.Name,
        zoneId: zone.ZoneId,
        stopCount: (refreshed?.stops || []).length,
        orderCount: zoneOrders.length,
        reusedExisting,
      });
    }

    io.emit('runs:from-selected-orders', { runDate, count: runsCreated.length });

    return res.json({
      ok: true,
      runDate,
      runsCreated,
      unassigned: unassigned.length > 0 ? unassigned.map((o) => ({
        customerName: o.CardName, city: o.cityParsed, docNum: o.DocNum, companyCode: o.CompanyCode,
      })) : null,
      summary: {
        ordersRequested: orderRefs.length,
        ordersAssigned: orders.length - unassigned.length,
        ordersUnassigned: unassigned.length,
        runsCreated: runsCreated.length,
        runsReused: runsCreated.filter((r) => r.reusedExisting).length,
      },
    });
  } catch (err) {
    console.error('[from-selected-orders] failed:', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
});

// Phase 2 v2 — dry-run/preview for from-selected-orders. Same payload, same
// guards, but never mutates the store. Lets the OpenOrdersPage show "you're
// about to create X runs in Y zones with Z stops" before the operator
// commits. Heavy lifting is in previewSelectedOrders.js so the logic is
// unit-testable without spinning up Express or SAP.
//
// Honors Idempotency-Key on its own cache namespace so a client can reuse
// a key across the preview + real submit without conflict.
app.post(
  '/api/runs/from-selected-orders/preview',
  idempotencyMiddleware(idempotencyCache, 'POST /api/runs/from-selected-orders/preview'),
  async (req, res) => {
  try {
    const runDate = req.body.runDate || new Date().toISOString().slice(0, 10);
    const orderRefs = Array.isArray(req.body.orders) ? req.body.orders : null;

    // Cheap validation first so we don't hit SAP on obviously bad input.
    // These three checks mirror the helper's guards 1-3; we duplicate them
    // intentionally here to skip the SAP fetch on bad requests.
    if (!orderRefs || orderRefs.length === 0) {
      return res.status(400).json({ error: 'orders array required (1+)', code: 'NO_ORDERS' });
    }
    if (orderRefs.length > 500) {
      return res.status(400).json({ error: 'too many orders (max 500)', code: 'TOO_MANY' });
    }
    for (const ref of orderRefs) {
      if (!ref || !ref.companyCode || ref.docEntry == null) {
        return res.status(400).json({ error: 'each order needs companyCode + docEntry', code: 'BAD_REF' });
      }
    }

    if (!sapLive) {
      return res.status(400).json({ error: 'SAP לא מחובר', code: 'SAP_OFFLINE' });
    }

    const allOpen = await sapBridge.getOpenOrdersFlat({ limit: 1000 });
    const storeSnapshot = store.load();

    const result = previewSelectedOrders({
      runDate,
      orderRefs,
      sapOpenOrders: allOpen,
      storeSnapshot,
      suggestZoneForCity: (city) => store.suggestZoneForCity(city),
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[preview-from-selected-orders] failed:', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code || null });
  }
});

// Create a new picking wave - pulls real SAP order lines + aggregates.
//
// Per-zone-picker-assignment (2026-05-21): accepts an optional body
//   { assignedPickerId: <PickerId> }
// to record which picker the planner chose for this zone/run in the
// SendToPicking modal. The id is a PickerId from store.pickers (the
// warehouse-handheld entity surfaced via /api/pickers + PickersPage),
// NOT a UserId — corrected in 2026-05-22, see commit bba4441. The id
// must point to an active picker; invalid / inactive / missing ids
// return 400 INVALID_PICKER and no wave is created. Omitting the field
// keeps the legacy path (unassigned wave, exactly as before the feature).
//
// Reused-run case: if a wave already exists on this run in IN_PROGRESS or
// PENDING_QC, createWaveFromLines throws WAVE_IN_PROGRESS — we surface that
// as 409 so the planner can resolve it manually (cancel the live wave or
// pick a different run). PENDING waves are still cancelled silently as
// before — they represent a wave that was just created but never started.
app.post('/api/runs/:id/wave', async (req, res) => {
  const runId = Number(req.params.id);
  const runDetails = store.getRunDetails(runId);
  if (!runDetails) return res.status(404).json({ error: 'Run not found' });

  // Validate picker BEFORE touching SAP — otherwise a bad pickerId would
  // burn a SAP getBulkOrderLines call for nothing.
  //
  // Per-zone-picker-assignment correction (2026-05-22): the id is a
  // PickerId from store.pickers, not a UserId. isPickableUser() and
  // getPickerById() both read from that table now. Naming on the wire
  // (assignedPickerId, AssignedPickerName) stays the same — only the FK
  // target changed.
  const assignedPickerIdRaw = req.body?.assignedPickerId;
  let assignedPickerId = null;
  let assignedPickerName = null;
  if (assignedPickerIdRaw != null) {
    const id = Number(assignedPickerIdRaw);
    if (!Number.isInteger(id) || !store.isPickableUser(id)) {
      return res.status(400).json({
        error: 'המלקט שנבחר לא קיים או לא פעיל',
        code: 'INVALID_PICKER',
      });
    }
    const picker = store.getPickerById(id);
    assignedPickerId = id;
    assignedPickerName = picker.FullName;
  }
  // assignedBy is the planner who pressed "אשר ושלח" — pulled from the JWT
  // already verified by the global requireAuthBasic gate registered for
  // /api/runs/*. Picker tokens carry sub='picker-N' (a string that becomes
  // NaN under Number()) — those callers shouldn't be triggering this path
  // in practice, but the guard keeps AssignedBy a clean number-or-null.
  const subAsNumber = req.user?.sub != null ? Number(req.user.sub) : null;
  const assignedBy = Number.isFinite(subAsNumber) ? subAsNumber : null;

  const orderRefs = [];
  for (const stop of runDetails.stops || []) {
    for (const order of stop.orders || []) {
      orderRefs.push({ companyCode: order.CompanyCode, docEntry: order.SapDocEntry });
    }
  }

  if (orderRefs.length === 0) {
    return res.status(400).json({ error: 'אין הזמנות במסלול - לא ניתן ליצור גל ליקוט' });
  }
  if (!sapLive) {
    return res.status(400).json({ error: 'SAP לא מחובר - נדרש לקרוא שורות הזמנה' });
  }

  try {
    const lines = await sapBridge.getBulkOrderLines(orderRefs);
    if (lines.length === 0) {
      return res.status(400).json({ error: 'לא נמצאו שורות פתוחות בהזמנות' });
    }

    const wave = store.createWaveFromLines(runId, lines, {
      assignedPickerId,
      assignedPickerName,
      assignedBy,
    });
    if (!wave) return res.status(500).json({ error: 'Failed to create wave' });

    store.updateRun(runId, { status: 'PICKING' });
    io.emit('wave:created', { runId, waveId: wave.WaveId });
    res.status(201).json(store.getWave(wave.WaveId));
  } catch (err) {
    if (err.code === 'WAVE_IN_PROGRESS') {
      return res.status(409).json({
        error: err.message,
        code: 'WAVE_IN_PROGRESS',
        activeWaveId: err.activeWaveId,
        activeWaveStatus: err.activeWaveStatus,
      });
    }
    console.error('[wave] creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:id/wave', (req, res) => {
  // A2g-FIX-WHITE-SCREEN (2026-05-20): when a run was deleted (or cancelled)
  // but a wave row still exists with its RunId, the previous version of this
  // handler happily returned that orphan wave. Frontend then tried to render
  // a picking page whose parent run is gone → uncaught render error → blank
  // page. Guard: 404 unless the run still exists in a state that owns waves.
  const runId = Number(req.params.id);
  const run = (store.getRuns() || []).find((r) => r && Number(r.RunId) === runId);
  if (!run) return res.status(404).json({ error: 'Run not found', code: 'RUN_NOT_FOUND' });
  if (run.Status === 'CANCELLED') {
    return res.status(404).json({ error: 'Run cancelled', code: 'RUN_CANCELLED' });
  }
  const wave = store.getWaveForRun(req.params.id);
  if (!wave) return res.status(404).json({ error: 'No active wave for this run', code: 'WAVE_NOT_FOUND' });
  res.json(wave);
});
app.post('/api/runs/:id/optimize-order', (req, res) => {
  const ok = store.smartSortStops(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Run not found' });
  const run = store.getRunDetails(req.params.id);
  io.emit('run:updated', { runId: Number(req.params.id) });
  res.json({ ok: true, RunId: Number(req.params.id), stopCount: run?.stops?.length || 0 });
});
app.post('/api/runs/stops/:stopId/tracking-link', (req, res) => {
  const token = `demo-token-${req.params.stopId}-${Date.now()}`;
  res.json({ token, url: `http://localhost:${PORT}/t/${token}` });
});

// ----------------------------------------------------------------------------
// WhatsApp/SMS notifications - generate "click-to-send" links the office can
// fire to a customer with their tracking link + ETA. Doesn't post to WhatsApp
// directly (no business API yet) - opens wa.me/sms: links.
// ----------------------------------------------------------------------------
function buildPublicBase(req) {
  // Try the cf-tunnel URL first (so external customers can click the link),
  // fall back to whatever host the request came on. Earlier code used CJS
  // require() which silently throws under "type": "module" — we now use the
  // already-imported `fs` (existsSync etc. via dynamic import is too heavy
  // for a per-request path). fs is bound at module scope via fsSync.
  try {
    const cfLog = path.resolve(__dirname, '..', '..', 'logs', 'cf-tunnel-error.log');
    if (fsSync.existsSync(cfLog)) {
      const txt = fsSync.readFileSync(cfLog, 'utf8');
      const matches = txt.match(/https:\/\/[a-z-]+\.trycloudflare\.com/g);
      if (matches && matches.length) return matches[matches.length - 1];
    }
  } catch (err) {
    console.warn('[buildPublicBase] cf-tunnel log read failed:', err.message);
  }
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  return `${req.protocol || 'http'}://${req.get('host') || `localhost:${PORT}`}`;
}

/**
 * Compute a rough ETA for a stop based on its position in the run.
 * Assumes ~25 minutes per stop on average if no real GPS data.
 */
function computeEta(stop, runDetails) {
  if (stop.Status === 'DELIVERED') return { minutesAway: 0, label: 'נמסר' };
  // Find how many ARRIVED/PENDING stops come before this one
  const stops = (runDetails.stops || []).slice().sort(
    (a, b) => Number(a.StopOrder || 0) - Number(b.StopOrder || 0)
  );
  const idx = stops.findIndex((s) => s.StopId === stop.StopId);
  if (idx < 0) return { minutesAway: null, label: 'לא ידוע' };
  let stopsAhead = 0;
  for (let i = 0; i < idx; i++) {
    const s = stops[i];
    if (!['DELIVERED', 'CANCELLED', 'FAILED'].includes(s.Status)) stopsAhead += 1;
  }
  const AVG_MIN_PER_STOP = 25;
  const min = stopsAhead * AVG_MIN_PER_STOP + (stop.Status === 'ARRIVED' ? 0 : 10);
  return {
    minutesAway: min,
    label: min < 5 ? 'תוך מס׳ דקות' : min < 60 ? `~${min} דקות` : `~${Math.round(min / 60)} שעות`,
    estimatedAt: new Date(Date.now() + min * 60_000).toISOString(),
  };
}

/**
 * Build a WhatsApp-ready notification message + share URL.
 *   GET /api/notify/eta/:stopId
 * Returns:
 *   { trackingUrl, message, whatsappUrl, smsUrl, eta }
 */
app.get('/api/notify/eta/:stopId', (req, res) => {
  const stopId = Number(req.params.stopId);
  const allStops = store.load().stops || [];
  const stop = allStops.find((s) => s.StopId === stopId);
  if (!stop) return res.status(404).json({ error: 'Stop not found' });
  const runDetails = store.getRunDetails(stop.RunId);
  if (!runDetails) return res.status(404).json({ error: 'Run not found' });

  const phone = (stop.ContactPhone || '').replace(/\D/g, '');
  const eta = computeEta(stop, runDetails);
  const base = buildPublicBase(req);

  // Reuse the existing demo tracking-link generator to get a token
  const token = `t-${stopId}-${Date.now().toString(36)}`;
  const trackingUrl = `${base}/t/${token}`;

  // Hebrew customer-facing message
  const branchName = stop.BranchName || 'הלקוח';
  const driverName = runDetails.DriverName || 'הנהג שלנו';
  const message = stop.Status === 'DELIVERED'
    ? `שלום ${branchName} 👋\nהמשלוח שלך נמסר בהצלחה. תודה שבחרתם בנו!`
    : `שלום ${branchName} 👋\nהמשלוח שלך בדרך אליך.\nזמן הגעה משוער: ${eta.label}\nמעקב חי: ${trackingUrl}\n${driverName} מתקשר אם יש שינוי 🚚`;

  // wa.me requires international format. If phone starts with 0, convert to +972
  const intlPhone = phone.startsWith('0') ? `972${phone.slice(1)}` : phone;
  res.json({
    stopId,
    eta,
    trackingUrl,
    message,
    phone: stop.ContactPhone,
    whatsappUrl: phone ? `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}` : null,
    smsUrl: phone ? `sms:${stop.ContactPhone}?body=${encodeURIComponent(message)}` : null,
  });
});

// Orders - use real SAP when available
app.get('/api/orders/unified', async (req, res) => {
  if (sapLive) {
    try {
      const groups = await sapBridge.getOpenOrdersUnified({ limit: 200 });
      // Enrich each group with the dominant customer's delivery profile so
      // the planner can group/highlight by zone and weekly schedule.
      const enriched = groups.map((g) => {
        const firstOrder = g.orders?.[0];
        const cardCode = firstOrder ? String(firstOrder.cardCode || '').trim() : '';
        const company = firstOrder
          ? (firstOrder.companyCode === 'A' ? 'OIG'
             : firstOrder.companyCode === 'B' ? 'UNICO' : null)
          : null;
        const profile = cardCode ? store.getCustomerProfile(cardCode, company) : null;
        return {
          ...g,
          suggestedZone:    profile?.Zone || '',
          suggestedSubZone: profile?.SubZone || '',
          scheduledDays:    profile?.DeliveryDays || [],
          docPolicy:        profile?.DocPolicy || null,
          profileStatus:    profile?.Status || (profile ? '' : 'no_profile'),
        };
      });
      let out = enriched;
      if (req.query.zone) out = out.filter((g) => g.suggestedZone === req.query.zone);
      if (req.query.day)  out = out.filter((g) => (g.scheduledDays || []).includes(req.query.day));
      return res.json({ groups: out, count: out.length, source: 'sap', enrichedFromProfiles: true });
    } catch (err) { console.warn('[sap] unified failed:', err.message); }
  }
  res.json({ groups: data.unifiedGroups, count: data.unifiedGroups.length, source: 'demo' });
});
app.get('/api/orders/open', async (req, res) => {
  if (sapLive) {
    try {
      const { company, search, limit = 100 } = req.query;
      const orders = await sapBridge.getOpenOrdersFlat({
        limit: Number(limit),
        company: company || null,
        search: search || null,
      });
      // Enrich each order with the customer's delivery profile:
      //   - suggestedZone     → canonical store zone (e.g. CENTER, EILAT)
      //   - suggestedSubZone  → 'קרוב'/'רחוק'/'תל אביב' or ''
      //   - scheduledDays     → e.g. ['שני','חמישי']
      //   - profileIssue      → reason if the profile is incomplete in SAP
      // Filtering by zone/day is up to the caller (?zone=, ?day=) and applied
      // after enrichment so unmatched orders still surface.
      //
      // Open-orders zone toolbar (2026-05-24): also add Zone/ZoneName/
      // ZoneColor derived from the city via store.suggestZoneForCity (the
      // same cityToZone map auto-plan + send-to-picking use). This is the
      // CITY-derived zone, distinct from `suggestedZone` (profile-derived)
      // which the customer's admin set explicitly. Either may be null when
      // the city has no mapping; the frontend toolbar uses Zone.
      const enriched = orders.map((o) => {
        const cardCode = String(o.CardCode || '').trim();
        const companyCode = (o.CompanyCode || o.Company || '').toString();
        const companyKey = companyCode === 'A' ? 'OIG' : companyCode === 'B' ? 'UNICO' : null;
        const profile = cardCode ? store.getCustomerProfile(cardCode, companyKey) : null;
        const addressParts = (o.ShipToAddress || '')
          .split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
        const city = addressParts[addressParts.length - 1] || o.CustCity || '';
        const zone = city ? store.suggestZoneForCity(city) : null;
        return {
          ...o,
          suggestedZone:    profile?.Zone || '',
          suggestedSubZone: profile?.SubZone || '',
          scheduledDays:    profile?.DeliveryDays || [],
          profileIssue:     profile?.Issue || (profile ? '' : 'no_profile'),
          Zone:      zone?.Code     || null,
          ZoneName:  zone?.Name     || null,
          ZoneColor: zone?.ColorHex || zone?.Color || null,
        };
      });
      let out = enriched;
      if (req.query.zone) out = out.filter((o) => o.suggestedZone === req.query.zone);
      if (req.query.day)  out = out.filter((o) => (o.scheduledDays || []).includes(req.query.day));
      return res.json({ orders: out, count: out.length, source: 'sap', enrichedFromProfiles: true });
    } catch (err) {
      console.warn('[sap] open orders failed:', err.message);
    }
  }
  res.json({ orders: [], count: 0 });
});

app.get('/api/orders/:company/:docEntry/lines', async (req, res) => {
  if (sapLive) {
    try {
      const lines = await sapBridge.getOrderLines(req.params.company.toUpperCase(), req.params.docEntry);
      return res.json({ lines });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.json({ lines: [] });
});
app.get('/api/orders/stats', async (_req, res) => {
  if (sapLive) {
    try {
      const stats = await sapBridge.getOverallStats();
      const totalOpen = (stats.companyA?.OpenOrders || 0) + (stats.companyB?.OpenOrders || 0);
      return res.json({
        totalOrders: totalOpen,
        totalStops: Math.ceil(totalOpen * 0.8), // estimate
        stopsSaved: Math.floor(totalOpen * 0.2),
        mergeRatio: 0.2,
        mergedStops: Math.floor(totalOpen * 0.15),
        companyA: stats.companyA,
        companyB: stats.companyB,
        source: 'sap',
      });
    } catch (err) { console.warn('[sap] stats failed:', err.message); }
  }
  res.json(data.stats);
});

// Failures
// Failure reasons catalog (stays - these are standard categories)
app.get('/api/failures/reasons', (_req, res) => res.json({ reasons: data.failureReasons }));
// Failures - start empty, populated only when drivers report real failures
let runtimeFailures = [];
app.get('/api/failures', (_req, res) => res.json({ failures: runtimeFailures }));
app.post('/api/failures/report', (req, res) => {
  const reason = data.failureReasons.find((r) => r.ReasonCode === req.body.reasonCode);
  const newFailure = {
    FailureId: runtimeFailures.length + 1,
    StopId: req.body.stopId,
    ReasonCode: req.body.reasonCode,
    ReasonName: reason?.Name || req.body.reasonCode,
    Category: reason?.Category || 'OTHER',
    Severity: reason?.Severity || 'MEDIUM',
    Notes: req.body.notes,
    PhotoUrl: null,
    ResolutionStatus: 'OPEN',
    CreatedAt: new Date().toISOString(),
  };
  runtimeFailures.push(newFailure);
  io.emit('failure:reported', newFailure);
  res.status(201).json(newFailure);
});
app.post('/api/failures/:id/reschedule', (req, res) => {
  const f = runtimeFailures.find((x) => x.FailureId === Number(req.params.id));
  if (f) { f.ResolutionStatus = 'RESCHEDULED'; f.ResolvedAt = new Date().toISOString(); }
  res.json({ ok: true });
});
app.post('/api/failures/:id/resolve', (req, res) => {
  const f = runtimeFailures.find((x) => x.FailureId === Number(req.params.id));
  if (f) { f.ResolutionStatus = req.body.status || 'RESOLVED'; f.ResolvedAt = new Date().toISOString(); }
  res.json({ ok: true });
});

// Returns - start empty, user creates them
let runtimeReturns = [];
app.get('/api/returns', (_req, res) => res.json({ returns: runtimeReturns }));
app.post('/api/returns', (req, res) => {
  const newReturn = {
    ReturnId: runtimeReturns.length + 1,
    ReturnNumber: `RET-${new Date().toISOString().slice(0, 10)}-${String(runtimeReturns.length + 1).padStart(3, '0')}`,
    ...req.body,
    Status: 'OPEN',
    CreatedAt: new Date().toISOString(),
    LinesCount: req.body.lines?.length || 0,
  };
  runtimeReturns.push(newReturn);
  res.status(201).json(newReturn);
});

// Analytics - computed from real persistent store + SAP
app.get('/api/analytics/summary', async (_req, res) => {
  const runs = store.getRuns();
  const drivers = store.getDrivers();
  const zones = store.getZones();
  const runOrders = store.load().runOrders || [];
  const stops = store.load().stops || [];

  const totalRuns = runs.length;
  const completedRuns = runs.filter((r) => r.Status === 'COMPLETED').length;
  const totalStops = stops.length;
  const deliveredStops = stops.filter((s) => s.Status === 'DELIVERED' || s.Status === 'PARTIAL').length;
  const failedStops = stops.filter((s) => s.Status === 'FAILED').length;
  const totalOrders = runOrders.length;
  const deliveredOrders = runOrders.filter((o) => o.Status === 'DELIVERED').length;
  const ordersCompanyA = runOrders.filter((o) => o.CompanyCode === 'A').length;
  const ordersCompanyB = runOrders.filter((o) => o.CompanyCode === 'B').length;

  // Per-driver: count runs + stops per driver
  const driverStats = drivers.map((d) => {
    const driverRuns = runs.filter((r) => r.DriverId === d.DriverId);
    const driverStopIds = stops
      .filter((s) => driverRuns.some((r) => r.RunId === s.RunId))
      .map((s) => s.StopId);
    const driverStops = stops.filter((s) => driverStopIds.includes(s.StopId));
    return {
      DriverId: d.DriverId, Code: d.Code, FullName: d.FullName,
      Runs: driverRuns.length,
      TotalStops: driverStops.length,
      DeliveredStops: driverStops.filter((s) => s.Status === 'DELIVERED' || s.Status === 'PARTIAL').length,
      FailedStops: driverStops.filter((s) => s.Status === 'FAILED').length,
      AvgStopMinutes: null, AvgRunMinutes: null,
    };
  });

  const zoneStats = zones.map((z) => {
    const zoneRuns = runs.filter((r) => r.ZoneId === z.ZoneId);
    const zoneStopIds = stops.filter((s) => zoneRuns.some((r) => r.RunId === s.RunId)).map((s) => s.StopId);
    return {
      ...z,
      Runs: zoneRuns.length,
      TotalStops: zoneStopIds.length,
      DeliveredStops: stops.filter((s) => zoneStopIds.includes(s.StopId) && (s.Status === 'DELIVERED' || s.Status === 'PARTIAL')).length,
      FailedStops: stops.filter((s) => zoneStopIds.includes(s.StopId) && s.Status === 'FAILED').length,
      TotalOrders: runOrders.filter((o) => zoneStopIds.includes(o.StopId)).length,
    };
  });

  // Failure breakdown
  const failureCounts = {};
  for (const f of runtimeFailures) {
    const key = f.ReasonCode;
    if (!failureCounts[key]) {
      const reason = data.failureReasons.find((r) => r.ReasonCode === f.ReasonCode);
      failureCounts[key] = {
        ReasonCode: f.ReasonCode, Name: reason?.Name || f.ReasonCode,
        Category: reason?.Category, Severity: reason?.Severity,
        Count: 0, Rescheduled: 0, Resolved: 0, Cancelled: 0, StillOpen: 0,
      };
    }
    failureCounts[key].Count++;
    if (f.ResolutionStatus === 'RESCHEDULED') failureCounts[key].Rescheduled++;
    else if (f.ResolutionStatus === 'RESOLVED') failureCounts[key].Resolved++;
    else if (f.ResolutionStatus === 'CANCELLED') failureCounts[key].Cancelled++;
    else failureCounts[key].StillOpen++;
  }

  res.json({
    overall: {
      totalRuns, completedRuns,
      totalStops, deliveredStops, partialStops: 0, failedStops,
      totalOrders, deliveredOrders,
      ordersCompanyA, ordersCompanyB,
      avgStopMinutes: null, avgRunMinutes: null,
      successRate: totalStops > 0 ? (deliveredStops / totalStops) : null,
      failureRate: totalStops > 0 ? (failedStops / totalStops) : null,
      unifiedStops: totalStops,
      mergedStops: stops.filter((s) => {
        const ordersAtStop = runOrders.filter((o) => o.StopId === s.StopId);
        return ordersAtStop.some((o) => o.CompanyCode === 'A') && ordersAtStop.some((o) => o.CompanyCode === 'B');
      }).length,
      mergerRatio: null,
    },
    daily: [], // can compute later if needed
    drivers: driverStats,
    zones: zoneStats,
    failures: Object.values(failureCounts),
    syncHealth: {
      PendingDeliveryNotes: runOrders.filter((o) => o.Status === 'DELIVERED' && !o.SapDeliveryDocEntry).length,
      SyncedDeliveryNotes: runOrders.filter((o) => o.SapDeliveryDocEntry).length,
      PendingReturnRequests: 0, QueueBacklog: 0, PermanentFailures: 0,
    },
  });
});
app.get('/api/reports/exceptions', (_req, res) => res.json({
  summary: { total: 3, addressesWithoutZone: 1, failedStops: 1, unassignedReturns: 1, failedDeliveryNotes: 0 },
  exceptions: {
    addressesWithoutZone: [{ AddressId: 99, Street: 'הגליל', BuildingNumber: '10', City: 'טבריה', BranchName: 'סופר מיני טבריה', CustomerLinks: 1 }],
    failedStops: [data.stops.find((s) => s.Status === 'FAILED')],
    unassignedReturns: data.returnRequests.map((r) => ({ ...r, CompanyCode: 'A' })),
    failedDeliveryNotes: [],
  },
}));

// Tracking - real GPS positions from drivers
const driverPositions = new Map();

app.get('/api/tracking/drivers', (_req, res) => {
  const allRuns = store.getRuns();
  const locations = [];
  for (const [driverId, pos] of driverPositions) {
    const driver = store.getDrivers().find((d) => d.DriverId === driverId);
    if (!driver) continue;
    const run = allRuns.find((r) => r.DriverId === driverId && r.Status === 'IN_TRANSIT');
    locations.push({
      DriverId: driverId,
      RunId: run?.RunId || null,
      DriverName: driver.FullName,
      VehiclePlate: driver.VehiclePlate,
      RunNumber: run?.RunNumber || null,
      RunStatus: run?.Status || null,
      ZoneName: run?.ZoneName || null,
      ZoneColor: run?.ZoneColor || '#6b7280',
      Latitude: pos.latitude,
      Longitude: pos.longitude,
      Accuracy: pos.accuracy,
      Heading: pos.heading,
      SpeedKmh: pos.speedKmh,
      BatteryLevel: pos.batteryLevel,
      UpdatedAt: pos.updatedAt,
    });
  }
  res.json({ locations });
});

app.post('/api/tracking/position', (req, res) => {
  const auth = req.headers.authorization;
  let driverId = null;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      driverId = payload.driverId;
    } catch {}
  }
  if (!driverId) return res.status(401).json({ error: 'Driver auth required' });

  driverPositions.set(driverId, {
    ...req.body,
    updatedAt: new Date().toISOString(),
  });

  io.emit('driver:position', { driverId, ...req.body, at: new Date() });
  res.json({ ok: true });
});

// Driver
app.get('/api/driver/my-runs', (req, res) => {
  const auth = req.headers.authorization;
  let driverId = 1;
  if (auth) {
    try { const payload = jwt.verify(auth.slice(7), JWT_SECRET); driverId = payload.driverId || 1; } catch {}
  }
  const today = new Date().toISOString().slice(0, 10);
  const runs = store.getRuns().filter((r) => r.DriverId === driverId);
  // Show today's and recent runs
  res.json({ runs });
});
app.get('/api/driver/runs/:id/manifest', (req, res) => {
  const run = store.getRunDetails(req.params.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  res.json(run);
});
app.patch('/api/driver/stops/:stopId/status', (req, res) => {
  const stop = store.updateStop(req.params.stopId, {
    status: req.body.status,
    notes: req.body.notes,
  });
  if (!stop) return res.status(404).json({ error: 'Stop not found' });
  if (req.body.status === 'ARRIVED') {
    stop.ArrivedAt = new Date().toISOString();
    store.save?.();
  }
  io.emit('stop:status-changed', { stopId: stop.StopId, status: stop.Status });

  // When driver marks ARRIVED - auto-advance run to IN_TRANSIT if still LOADED
  const run = store.getRuns().find((r) => r.RunId === stop.RunId);
  if (run && ['LOADED', 'PLANNED', 'OPEN'].includes(run.Status) && req.body.status === 'ARRIVED') {
    store.updateRun(run.RunId, { status: 'IN_TRANSIT' });
  }
  res.json({ ok: true, stopId: req.params.stopId, status: req.body.status });
});

/**
 * Complete a stop with optional signature + photo.
 * This is THE moment of truth - creates Delivery Notes in SAP for every order.
 *
 * Since Service Layer is not configured, we simulate:
 *  - Store signature locally
 *  - Mark orders with a fake SapDeliveryDocEntry
 *  - Log to pending-sap-writes for when connection is restored
 */
app.post('/api/driver/stops/:stopId/complete', (req, res) => {
  const stopId = Number(req.params.stopId);
  const runDetails = store.getRuns().find((r) =>
    (store.load().stops || []).some((s) => s.StopId === stopId && r.RunId === s.RunId)
  );
  if (!runDetails) return res.status(404).json({ error: 'Stop not found' });

  // Mark stop as delivered
  const stop = store.updateStop(stopId, { status: 'DELIVERED' });
  stop.CompletedAt = new Date().toISOString();
  if (req.body.signatureDataUrl) stop.SignatureUrl = req.body.signatureDataUrl;
  if (req.body.photoDataUrl) stop.PhotoUrl = req.body.photoDataUrl;
  if (req.body.notes) stop.Notes = req.body.notes;
  // POD: capture GPS at moment of delivery for legal/audit trail
  if (req.body.gps) {
    stop.PodGps = {
      lat: Number(req.body.gps.lat),
      lng: Number(req.body.gps.lng),
      accuracy: Number(req.body.gps.accuracy || 0),
      timestamp: req.body.gps.timestamp || Date.now(),
    };
  }
  if (req.body.capturedAt) stop.PodCapturedAt = req.body.capturedAt;
  store.save?.();

  // Find all orders at this stop and mark them delivered + simulated SAP ref
  const allOrders = store.load().runOrders || [];
  const stopOrders = allOrders.filter((o) => o.StopId === stopId);
  const results = [];
  for (const order of stopOrders) {
    order.Status = 'DELIVERED';
    // SapDeliveryDocEntry is intentionally NOT touched here. It must be
    // either null (no DN written to SAP yet) or a genuine DocEntry returned
    // by Service Layer in the future `flush-aggregate-docs` write path
    // (Phase A2). Faking it with `9000000 + RunOrderId` used to make the
    // store look like SAP confirmed the document, blocking the later
    // "attach POD to existing DN" flow (Phase B/C). See cowork/INCIDENTS.md
    // and the A1 migration in scripts/migrate-fake-sap-doc-entries.js.
    order.DeliveredAt = new Date().toISOString();
    results.push({
      runOrderId: order.RunOrderId,
      success: true,
      sapDocEntry: order.SapDeliveryDocEntry, // null in steady state until Phase A2
      simulated: false, // we no longer fake — caller can distinguish properly
    });
  }
  store.save?.();

  // Auto-generate Delivery Notes (separated by company) for this stop
  let generatedDocs = [];
  try {
    generatedDocs = store.generateDeliveryNotesForStop(stopId, { method: 'AUTO' });
  } catch (err) {
    console.warn('[stop-complete] DN generation failed:', err.message);
  }

  // Record driver performance — used by planner & leaderboard.
  try {
    const run = (store.load().runs || []).find((r) => r.RunId === stop.RunId);
    if (run && run.DriverId) {
      // Calculate minutes at stop (ARRIVED → DELIVERED).
      let minutesAtStop = null;
      if (stop.ArrivedAt && stop.CompletedAt) {
        minutesAtStop = Math.max(0, Math.round(
          (new Date(stop.CompletedAt) - new Date(stop.ArrivedAt)) / 60000
        ));
      }
      store.recordDriverPerformance(run.DriverId, run.ZoneCode, {
        delivered: true,
        minutesAtStop,
      });
    }
  } catch (e) { console.warn('[perf] record failed:', e.message); }

  io.emit('stop:completed', { stopId, orders: results.length, deliveryNotes: generatedDocs.length });

  // Check if this is the last stop → auto-complete the run
  const allStopsInRun = (store.load().stops || []).filter((s) => s.RunId === runDetails.RunId);
  const allDone = allStopsInRun.every((s) => ['DELIVERED', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(s.Status));
  if (allDone) {
    store.updateRun(runDetails.RunId, { status: 'COMPLETED' });
    io.emit('run:completed', { runId: runDetails.RunId });
  }

  res.json({
    stopId,
    stopStatus: 'DELIVERED',
    orders: results,
    runCompleted: allDone,
  });
});

app.post('/api/driver/orders/:runOrderId/deliver', (req, res) => {
  const orders = store.load().runOrders || [];
  const order = orders.find((o) => o.RunOrderId === Number(req.params.runOrderId));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.Status = 'DELIVERED';
  // SapDeliveryDocEntry intentionally NOT assigned here — see A1 in the
  // sibling /api/driver/stops/:stopId/complete handler for the full
  // rationale. Driver-side endpoints never mint SAP DocEntries.
  order.DeliveredAt = new Date().toISOString();
  store.save?.();
  io.emit('order:delivered', { runOrderId: order.RunOrderId });
  res.json({
    runOrderId: order.RunOrderId,
    sapDocEntry: order.SapDeliveryDocEntry,
    sapDocNum: order.SapDocNum,
    alreadyExisted: false,
    simulated: true,
  });
});

// Customer tracking (public). Wave A hardening: validate token format and
// age before exposing any stop data. The legacy demo behaviour returned an
// arbitrary in-transit stop for ANY token string, leaking PII (address,
// branch name, GPS) to anyone who hit the URL. Tokens are issued by
// /api/runs/stops/:stopId/tracking-link in the form `demo-token-<stopId>-<ms>`.
app.get('/api/public/track/:token', (req, res) => {
  const m = String(req.params.token || '').match(/^demo-token-(\d+)-(\d{10,})$/);
  if (!m) return res.status(404).json({ error: 'Invalid or expired tracking link' });
  const stopId = Number(m[1]);
  const issuedAtMs = Number(m[2]);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > 48 * 3600 * 1000) {
    return res.status(404).json({ error: 'Invalid or expired tracking link' });
  }
  const stop = data.stops.find((s) => s.StopId === stopId);
  if (!stop) return res.status(404).json({ error: 'Not found' });
  const run = data.runs.find((r) => r.RunId === stop.RunId);
  res.json({
    stopId: stop.StopId, status: stop.Status, stopOrder: stop.StopOrder,
    arrivedAt: stop.ArrivedAt, completedAt: stop.CompletedAt,
    address: {
      street: stop.Street, buildingNumber: stop.BuildingNumber, city: stop.City,
      latitude: stop.Latitude, longitude: stop.Longitude, branchName: stop.BranchName,
    },
    run: {
      runNumber: run?.RunNumber, runDate: run?.RunDate, status: run?.Status,
      zoneName: run?.ZoneName, zoneColor: run?.ZoneColor,
      driverName: run?.DriverName, vehiclePlate: run?.VehiclePlate,
    },
    driverLocation: run?.Status === 'IN_TRANSIT' ? {
      latitude: 32.0775, longitude: 34.7748, updatedAt: new Date().toISOString(),
    } : null,
    progress: {
      totalStops: data.stops.filter((s) => s.RunId === run?.RunId).length,
      completedStops: data.stops.filter((s) => s.RunId === run?.RunId && ['DELIVERED', 'PARTIAL'].includes(s.Status)).length,
      currentStopOrder: stop.StopOrder, yourPosition: stop.StopOrder,
    },
    eta: run?.Status === 'IN_TRANSIT'
      ? { status: 'IN_TRANSIT', message: 'המשלוח בדרך אליך', approximateMinutes: 25 }
      : { status: 'PREPARING', message: 'המשלוח מוכן ליציאה' },
    expiresAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  });
});

// Settings + SAP (for Settings page)
app.get('/api/settings', (_req, res) => res.json({
  settings: [
    { key: 'warehouse.defaultCode', value: '01', category: 'WAREHOUSE', dataType: 'STRING', description: 'קוד מחסן ברירת מחדל' },
    { key: 'warehouse.returnCode', value: '99', category: 'WAREHOUSE', dataType: 'STRING', description: 'קוד מחסן לחזרות' },
    { key: 'notifications.smsEnabled', value: true, category: 'NOTIFICATIONS', dataType: 'BOOLEAN', description: 'שליחת SMS' },
    { key: 'notifications.emailEnabled', value: true, category: 'NOTIFICATIONS', dataType: 'BOOLEAN', description: 'שליחת אימייל' },
    { key: 'portal.baseUrl', value: 'http://localhost:4000', category: 'GENERAL', dataType: 'STRING', description: 'כתובת פורטל לקוחות' },
  ],
}));
app.put('/api/settings/:key', (_req, res) => res.json({ ok: true }));
app.get('/api/sap/sample/:company', async (req, res) => {
  const code = req.params.company.toUpperCase();
  if (sapLive) {
    try {
      const data = await sapBridge.getSamplePreview(code);
      return res.json(data);
    } catch (err) {
      console.warn('[sap] sample failed:', err.message);
    }
  }
  // Fallback demo data
  res.json({
    companyCode: code,
    customers: [
      { CardCode: 'DEMO-C001', CardName: 'דמו לקוח 1', Phone1: '03-5550001', City: 'תל אביב' },
    ],
    items: [
      { ItemCode: 'DEMO-ITM1', ItemName: 'דמו פריט 1', SellItem: 'Y' },
    ],
    recentOrders: [],
  });
});

// Real SAP diagnostic - use actual connection
app.get('/api/sap/diagnose', async (_req, res) => {
  if (!sapLive) {
    return res.json({
      status: 'disconnected',
      checkedAt: new Date().toISOString(),
      checks: {
        sqlCompanyA: { ok: false, step: 'config', error: 'SAP not configured in demo mode' },
        sqlCompanyB: { ok: false, step: 'config', error: 'SAP not configured' },
        serviceLayerCompanyA: { ok: false, step: 'config', error: 'Service Layer not tested in demo' },
        serviceLayerCompanyB: { ok: false, step: 'config', error: 'Service Layer not tested in demo' },
      },
      summary: { total: 4, ok: 0, failed: 4 },
    });
  }
  try {
    const stats = await sapBridge.getOverallStats();
    res.json({
      status: 'fully-connected',
      checkedAt: new Date().toISOString(),
      durationMs: 200,
      checks: {
        sqlCompanyA: {
          ok: true, step: 'ok', latencyMs: 60, dbName: process.env.SAP_SQL_DB_A,
          stats: {
            Customers: stats.companyA?.Customers || 0,
            Items: stats.companyA?.Items || 0,
            OpenOrders: stats.companyA?.OpenOrders || 0,
          },
        },
        sqlCompanyB: {
          ok: true, step: 'ok', latencyMs: 25, dbName: process.env.SAP_SQL_DB_B,
          stats: {
            Customers: stats.companyB?.Customers || 0,
            Items: stats.companyB?.Items || 0,
            OpenOrders: stats.companyB?.OpenOrders || 0,
          },
        },
        serviceLayerCompanyA: { ok: false, step: 'config', error: 'Service Layer not configured (missing SAP_SL_PASSWORD)', hint: 'לקריאה בלבד מספיק. לכתיבה (יצירת תעודות משלוח) צריך להוסיף SAP_SL_PASSWORD.' },
        serviceLayerCompanyB: { ok: false, step: 'config', error: 'Service Layer not configured', hint: 'ראה למעלה' },
      },
      summary: { total: 4, ok: 2, failed: 2 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Document Generator Endpoints (Delivery Notes + Invoices)
// ============================================================================

/**
 * Preview - what documents will be generated for this stop?
 * Doesn't actually create them, just shows the breakdown.
 */
app.get('/api/stops/:stopId/document-preview', (req, res) => {
  const stopId = Number(req.params.stopId);
  const stops = store.load().stops || [];
  const stop = stops.find((s) => s.StopId === stopId);
  if (!stop) return res.status(404).json({ error: 'Stop not found' });

  const orders = (store.load().runOrders || []).filter((o) => o.StopId === stopId);

  // Group by (Company, CardCode) - same logic as the actual generator
  const groups = new Map();
  for (const order of orders) {
    if (order.Status === 'CANCELLED') continue;
    const key = `${order.CompanyCode}|${order.SapCardCode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        CompanyCode: order.CompanyCode,
        CompanyName: order.CompanyName,
        SapCardCode: order.SapCardCode,
        SapCardName: order.SapCardName,
        orders: [],
        TotalAmount: 0,
        LineCount: 0,
      });
    }
    const g = groups.get(key);
    g.orders.push(order);
    g.TotalAmount += Number(order.OrderTotal || 0);
    g.LineCount += Number(order.LinesCount || 0);
  }

  res.json({
    stop: { StopId: stop.StopId, ...stop },
    documents: Array.from(groups.values()).map((g) => ({
      ...g,
      VatAmount: Number((g.TotalAmount * 0.17).toFixed(2)),
      GrossAmount: Number((g.TotalAmount * 1.17).toFixed(2)),
    })),
    summary: {
      totalDeliveryNotes: groups.size,
      totalInvoices: groups.size,
      byCompany: {
        A: Array.from(groups.values()).filter((g) => g.CompanyCode === 'A').length,
        B: Array.from(groups.values()).filter((g) => g.CompanyCode === 'B').length,
      },
    },
  });
});

/**
 * Generate Delivery Notes for a stop (creates them in our store).
 */
app.post('/api/stops/:stopId/generate-delivery-notes', (req, res) => {
  const docs = store.generateDeliveryNotesForStop(req.params.stopId, req.body || {});
  if (!docs) return res.status(404).json({ error: 'Stop not found' });
  io.emit('docs:generated', { stopId: Number(req.params.stopId), count: docs.length });
  res.status(201).json({ documents: docs });
});

/**
 * Generate Invoices from existing Delivery Notes.
 */
app.post('/api/delivery-notes/:id/generate-invoice', (req, res) => {
  const inv = store.generateInvoiceFromDeliveryNote(req.params.id, req.body || {});
  if (!inv) return res.status(404).json({ error: 'Delivery note not found' });
  io.emit('docs:generated', { invoiceId: inv.InvoiceId });
  res.status(201).json(inv);
});

/**
 * Generate ALL invoices for a run (one per delivery note).
 */
app.post('/api/runs/:id/generate-invoices', (req, res) => {
  const invs = store.generateInvoicesForRun(req.params.id);
  res.status(201).json({ invoices: invs, count: invs.length });
});

/**
 * Confirm a SAP document was created (user enters DocEntry/DocNum manually).
 */
app.post('/api/documents/:type/:id/confirm-sap', (req, res) => {
  const { sapDocEntry, sapDocNum } = req.body;
  const result = store.confirmSapDocument(req.params.id, req.params.type, sapDocEntry, sapDocNum);
  if (!result) return res.status(404).json({ error: 'Document not found' });
  // 2026-05-24: confirmSapDocument now returns { error, ... } on placeholder
  // DocEntry/DocNum (sapDocEntry < CONFIRM_SAP_MIN_DOCENTRY etc.) — map to 400
  // so the UI can show "this looks like a typo / placeholder" instead of
  // silently storing yet another fake SAP_CONFIRMED row.
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

/**
 * DEV.13: revert a suspicious manual SAP confirmation back to PENDING_EXPORT.
 *
 * Why this exists:
 *   The store still holds 3 SAP_CONFIRMED Delivery Notes with
 *   SapDeliveryDocEntry=1 (DN-40, DN-83, DN-84). DEV.10 prevents creating
 *   new ones; this endpoint lets an admin clean up the existing fakes
 *   without manual JSON surgery. The reset is LOCAL ONLY — it does not
 *   touch SAP. If the placeholder happens to correspond to a real SAP
 *   doc, the admin re-runs "confirm-sap" with the correct DocEntry.
 *
 * Guards (defense-in-depth, also checked by store.canRevertConfirmation):
 *   - ADMIN role required (adminOnly middleware)
 *   - Doc must exist                                   → 404
 *   - Doc.Status must be SAP_CONFIRMED                 → 400 NOT_SAP_CONFIRMED
 *   - Doc.Sap*DocEntry must be < CONFIRM_SAP_MIN_DOCENTRY (placeholder)
 *                                                       → 400 NOT_SUSPICIOUS
 *
 * Body (optional): { reason: string } — included in the audit log.
 */
app.post('/api/documents/:type/:id/revert-confirm', adminOnly, (req, res) => {
  const { type, id } = req.params;
  if (type !== 'deliveryNote' && type !== 'invoice') {
    return res.status(400).json({ error: 'INVALID_TYPE', provided: type });
  }
  const result = store.revertSapConfirmation(type, id);
  if (result === null) return res.status(404).json({ error: 'Document not found' });
  if (result.error) return res.status(400).json(result);

  // Audit log — captures who reverted, what the previous values were, and
  // the optional human reason. Lets us reconstruct intent later if we need
  // to debug "why did this doc go back to PENDING_EXPORT".
  store.recordAudit({
    action: 'document.revert_confirm',
    actorSub: req.user?.sub,
    actorName: req.user?.name || req.user?.username,
    ip: req.ip,
    details: {
      docType: type,
      docId: Number(id),
      docNumber: result.doc.DocNumber,
      previousSapDocEntry: result.previous.SapDocEntry,
      previousSapDocNum: result.previous.SapDocNum,
      previousConfirmedAt: result.previous.ConfirmedAt,
      reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null,
    },
  });

  res.json(result);
});

/**
 * Mark documents as exported (after user downloads them for manual SAP entry).
 */
app.post('/api/documents/mark-exported', (req, res) => {
  const { docIds, type } = req.body;
  store.markDocsExported(docIds || [], type || 'deliveryNote');
  res.json({ ok: true });
});

/**
 * List delivery notes with filters.
 */
app.get('/api/delivery-notes', (req, res) => {
  res.json({ deliveryNotes: store.listDeliveryNotes(req.query) });
});

/**
 * List invoices with filters.
 */
app.get('/api/invoices', (req, res) => {
  res.json({ invoices: store.listInvoices(req.query) });
});

/**
 * Document statistics.
 */
app.get('/api/documents/stats', (req, res) => {
  res.json(store.getDocumentStats(req.query));
});

/**
 * Excel export of delivery notes for a specific company - SAP-ready format.
 * The user can use this to do bulk entry in SAP.
 */
app.get('/api/reports/delivery-notes.xlsx', async (req, res) => {
  const { runDate, company } = req.query;
  const dns = store.listDeliveryNotes({ runDate, companyCode: company });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="delivery-notes-${runDate || 'all'}-${company || 'both'}.csv"`);

  const lines = [
    '"DN ID","חברה","תאריך","לקוח (CardCode)","שם לקוח","הזמנות מקור","סה""כ פריטים","סה""כ סכום","סטטוס","SAP DocEntry","SAP DocNum"',
  ];
  for (const dn of dns) {
    const sources = (dn.SourceOrders || []).map((s) => `${s.SapDocNum}`).join(' + ');
    lines.push([
      dn.DocNumber,
      dn.CompanyCode,
      dn.DeliveryDate,
      dn.SapCardCode,
      `"${(dn.SapCardName || '').replace(/"/g, '""')}"`,
      `"${sources}"`,
      dn.LineCount,
      dn.TotalAmount,
      dn.Status,
      dn.SapDeliveryDocEntry || '',
      dn.SapDeliveryDocNum || '',
    ].join(','));
  }

  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/api/reports/invoices.xlsx', async (req, res) => {
  const { runDate, company } = req.query;
  const invs = store.listInvoices({ runDate, companyCode: company });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="invoices-${runDate || 'all'}-${company || 'both'}.csv"`);

  const lines = [
    '"INV ID","חברה","תאריך","לקוח","שם","DN ID","פריטים","סכום נטו","מע""מ","ברוטו","סטטוס","SAP DocEntry"',
  ];
  for (const inv of invs) {
    lines.push([
      inv.DocNumber,
      inv.CompanyCode,
      inv.InvoiceDate,
      inv.SapCardCode,
      `"${(inv.SapCardName || '').replace(/"/g, '""')}"`,
      inv.DeliveryNoteId,
      inv.LineCount,
      inv.TotalAmount,
      inv.VatAmount,
      inv.GrossAmount,
      inv.Status,
      inv.SapInvoiceDocEntry || '',
    ].join(','));
  }
  res.send('\uFEFF' + lines.join('\n'));
});

// Picking endpoints - use real persistent wave
app.get('/api/picking/waves', (req, res) => {
  res.json({ waves: store.listWaves(req.query) });
});

app.get('/api/picking/:id', (req, res) => {
  const wave = store.getWave(req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });
  res.json(wave);
});

// Pick a SPECIFIC allocation row (sub-line under a wave line).
// This is the "per-row" picking the warehouse worker uses when an item
// is split across multiple customers in the same wave.
// QC Review endpoints - approve/reject after picking complete
// Per-order QC approve — feature C, stage 1.
// Generates the SAP documents this specific order needs (per DocPolicy)
// in DRY-RUN (store-only, status=PENDING_EXPORT). Used by the per-order
// "אשר הזמנה" button in PickingPage. Idempotent.
app.post('/api/orders/:runOrderId/qc-approve', (req, res) => {
  const auth = req.headers.authorization;
  let approvedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { approvedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  try {
    const result = store.generateDocsForRunOrder(req.params.runOrderId, {
      approvedBy,
      method: 'AUTO_QC_PER_ORDER',
    });
    io.emit('order:qc-approved', { runOrderId: Number(req.params.runOrderId) });
    res.json({
      ok: true,
      idempotent: !!result.idempotent,
      isPartial: !!result.isPartial,
      totalOrdered: result.totalOrdered,
      totalPicked: result.totalPicked,
      deliveryNote: result.deliveryNote
        ? {
            DeliveryNoteId: result.deliveryNote.DeliveryNoteId,
            DocNumber: result.deliveryNote.DocNumber,
            IsPartial: !!result.deliveryNote.IsPartial,
            Shortages: result.deliveryNote.Shortages || [],
          }
        : null,
      invoice: result.invoice
        ? { InvoiceId: result.invoice.InvoiceId, DocNumber: result.invoice.DocNumber }
        : null,
    });
  } catch (err) {
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.cardCode) payload.cardCode = err.cardCode;
    if (err.cardName) payload.cardName = err.cardName;
    res.status(err.status || 500).json(payload);
  }
});

// =====================================================================
// QC Control endpoints — P3 (2026-05-26)
//
// Three endpoints under qcControllerOnly for the "בקרה אחרי ליקוט" screen:
//   - GET  /api/qc/pending                 → list orders waiting for QC
//   - POST /api/qc/approve-order/:id       → approve (wraps the existing
//                                            store.generateDocsForRunOrder
//                                            with the QC gate)
//   - POST /api/qc/reject-order/:id        → reject with reason
//
// The picker's per-order approve at /api/orders/:runOrderId/qc-approve
// keeps working for backward compatibility (dual flow during P1-P5). The
// QC controller route is a separate gate so a future change can disable
// the picker's approve without touching the QC controller's path.
// LOCAL ONLY — no SAP HTTP from any of these.
// =====================================================================

app.get('/api/qc/pending', qcControllerOnly, (req, res) => {
  const filters = {
    runDate:  req.query.runDate || undefined,
    pickerId: req.query.pickerId != null && req.query.pickerId !== ''
      ? Number(req.query.pickerId) : undefined,
    zoneCode: req.query.zoneCode || undefined,
    status:   req.query.status || undefined,
  };
  const orders = store.listQcPendingOrders(filters);
  res.json({ orders, count: orders.length, filters });
});

// (2026-05-30) "אישרת היום" + "דחית היום" counters. Drives the small
// badge on QcControlPage's header so the controller knows where today's
// approved orders went (→ /documents, PENDING_EXPORT). Lives alongside
// /api/qc/pending because the matrix UI polls it on the same interval.
app.get('/api/qc/today-summary', qcControllerOnly, (req, res) => {
  const s = store.load();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const isToday = (iso) => typeof iso === 'string' && iso.slice(0, 10) === today;

  let approvedToday = 0;
  let rejectedToday = 0;
  for (const o of (s.runOrders || [])) {
    if (o.QcApproved && isToday(o.QcApprovedAt)) approvedToday++;
    if (o.QcRejected && isToday(o.QcRejectedAt)) rejectedToday++;
  }
  res.json({
    today,
    approvedToday,
    rejectedToday,
    pendingCount: store.listQcPendingOrders({}).length,
  });
});

app.post('/api/qc/approve-order/:runOrderId', qcControllerOnly, (req, res) => {
  try {
    const result = store.generateDocsForRunOrder(req.params.runOrderId, {
      approvedBy: req.user?.name,
      method: 'QC_CONTROL_PER_ORDER',
    });
    io.emit('order:qc-approved', { runOrderId: Number(req.params.runOrderId) });
    res.json({
      ok: true,
      idempotent: !!result.idempotent,
      isPartial: !!result.isPartial,
      totalOrdered: result.totalOrdered,
      totalPicked: result.totalPicked,
      deliveryNote: result.deliveryNote
        ? {
            DeliveryNoteId: result.deliveryNote.DeliveryNoteId,
            DocNumber: result.deliveryNote.DocNumber,
            IsPartial: !!result.deliveryNote.IsPartial,
            Shortages: result.deliveryNote.Shortages || [],
          }
        : null,
      invoice: result.invoice
        ? { InvoiceId: result.invoice.InvoiceId, DocNumber: result.invoice.DocNumber }
        : null,
    });
  } catch (err) {
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.cardCode) payload.cardCode = err.cardCode;
    if (err.cardName) payload.cardName = err.cardName;
    res.status(err.status || 500).json(payload);
  }
});

// (2026-05-31) Partial-QC handoff — picker (or anyone with picker access)
// can flag a single order in their wave as "ready for QC review" without
// waiting for the whole wave to finish. The order appears on
// /qc-control immediately even though its wave is still PICKING.
// Open to any authenticated user (the picker themselves trigger it).
app.post('/api/run-orders/:runOrderId/ready-for-qc', (req, res) => {
  const auth = req.headers.authorization;
  let flaggedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { flaggedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  if (!flaggedBy) return res.status(401).json({ error: 'Authentication required' });
  const result = store.markRunOrderReadyForQc(req.params.runOrderId, { flaggedBy });
  if (result.error) {
    const code = result.error === 'ORDER_NOT_FOUND' ? 404 : 422;
    return res.status(code).json(result);
  }
  store.recordAudit?.({
    action: 'qc.ready-for-qc',
    actorName: flaggedBy,
    ip: req.ip,
    details: { runOrderId: Number(req.params.runOrderId), alreadyFlagged: !!result.alreadyFlagged },
  });
  io.emit('order:ready-for-qc', { runOrderId: Number(req.params.runOrderId) });
  res.json(result);
});

app.post('/api/qc/reject-order/:runOrderId', qcControllerOnly, (req, res) => {
  const reason = (req.body?.reason || '').toString().trim();
  if (!reason) {
    return res.status(400).json({
      error: 'REASON_REQUIRED',
      message: 'חובה לפרט סיבת דחייה',
    });
  }
  const result = store.rejectOrderQc(req.params.runOrderId, {
    reason: reason.slice(0, 500),
    rejectedBy: req.user?.name,
  });
  if (result.error) {
    const statusCode = result.error === 'ORDER_NOT_FOUND' ? 404 : 400;
    return res.status(statusCode).json(result);
  }
  store.recordAudit({
    action: 'qc.reject-order',
    actorSub: req.user?.sub,
    actorName: req.user?.name,
    ip: req.ip,
    details: {
      runOrderId: Number(req.params.runOrderId),
      reason: reason.slice(0, 500),
    },
  });
  io.emit('order:qc-rejected', { runOrderId: Number(req.params.runOrderId) });
  res.json(result);
});

// =====================================================================
// Role Permissions endpoints (2026-05-28)
//
// Admin-only matrix of role→allowedScreens. The frontend's
// /role-permissions page reads + writes here, and /api/auth/me serves
// the *effective* allowedScreens for the current user (so the sidebar
// doesn't need to refetch on every page).
//
//   GET  /api/admin/screens              — master screen registry
//   GET  /api/admin/role-permissions     — all rows
//   PUT  /api/admin/role-permissions/:roleCode  — update one role
//
// LOCAL ONLY — no SAP HTTP from any of these.
// =====================================================================
app.get('/api/admin/screens', adminOnly, (req, res) => {
  res.json({ screens: SCREENS, roleCodes: ROLE_CODES });
});

app.get('/api/admin/role-permissions', adminOnly, (req, res) => {
  res.json({ rolePermissions: store.listRolePermissions() });
});

app.put('/api/admin/role-permissions/:roleCode', adminOnly, (req, res) => {
  const roleCode = String(req.params.roleCode || '').toUpperCase();
  const allowedScreens = Array.isArray(req.body?.allowedScreens)
    ? req.body.allowedScreens : null;
  if (!allowedScreens) {
    return res.status(400).json({ error: 'BAD_BODY', message: 'allowedScreens must be an array of strings' });
  }
  const result = store.setRolePermissions(roleCode, allowedScreens, {
    updatedBy: req.user?.name || req.user?.username,
  });
  if (!result.ok) {
    const statusByCode = {
      UNKNOWN_ROLE: 404,
      ALLOWED_SCREENS_NOT_ARRAY: 400,
      ADMIN_MUST_KEEP_PERMISSIONS_PAGE: 422,
    };
    return res.status(statusByCode[result.error] || 400).json(result);
  }
  store.recordAudit({
    action: 'role-permissions.update',
    actorSub: req.user?.sub,
    actorName: req.user?.name,
    ip: req.ip,
    details: { roleCode, allowedScreens: result.row.AllowedScreens },
  });
  // Tell every connected client that role permissions changed so the
  // sidebar can refetch /api/auth/me to pick up the new mask.
  io.emit('role-permissions:updated', { roleCode });
  res.json(result);
});

// Phase 3 — run-level aggregate flush. Walks all approved orders in the
// run with AggregatePending=true, groups by AggregationKey, and emits one
// consolidated DN per group. Admin-only because it mints documents en masse.
app.post('/api/runs/:id/flush-aggregate-docs', adminOnly, async (req, res) => {
  const auth = req.headers.authorization;
  let approvedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { approvedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  try {
    // Phase A2-2: flushAggregateDocsForRun is now async — it performs a
    // dry-run SAP payload check on every DN it creates.
    // (2026-05-30) Phase 2 — liveWrite is opt-in per click via the new
    // "שלח חי ל-SAP" checkbox in RunDetailsPage. Default stays false →
    // dry-run only, so an accidental button press never posts to SAP.
    // The actual write is still gated by SAP_WRITE_ENABLED +
    // SAP_LIVE_WRITE_DB_WHITELIST inside writeDeliveryNote/writeInvoice,
    // so this flag at most ENABLES the attempt — env still has the
    // final say.
    const liveWrite = req.body?.liveWrite === true;
    const result = await store.flushAggregateDocsForRun(req.params.id, {
      approvedBy,
      method: liveWrite ? 'AUTO_AGGREGATE_FLUSH_LIVE' : 'AUTO_AGGREGATE_FLUSH',
      liveWrite,
    });
    if (liveWrite) {
      store.recordAudit?.({
        action: 'flush-aggregate-docs.live-attempted',
        actorName: approvedBy,
        ip: req.ip,
        details: { runId: Number(req.params.id) },
      });
    }
    io.emit('run:aggregate-flushed', { runId: Number(req.params.id) });
    res.json({
      ok: true,
      ordersTouched: result.ordersTouched,
      deliveryNotes: result.docsCreated.map((d) => ({
        DeliveryNoteId: d.DeliveryNoteId,
        DocNumber: d.DocNumber,
        IsPartial: !!d.IsPartial,
        SourceOrderCount: d.SourceOrders?.length || 0,
        AggregationSource: d.AggregationSource,
        // A2-2 audit summary — null when dry-run didn't run or failed
        SapWriteAttempts: d.SapWriteAttempts || 0,
        LastDryRunPayloadAt: d.LastDryRunPayloadAt || null,
        SapWriteLastError: d.SapWriteLastError || null,
      })),
      // Top 5 DN payloads as previews so the operator can sanity-check
      // CardCode / DocDate / DocumentLines structure before A2c flips the
      // live switch. Truncated to 1000 chars each (already truncated on
      // the DN record itself).
      dryRunPayloads: result.docsCreated.slice(0, 5).map((d) => ({
        DocNumber: d.DocNumber,
        CompanyCode: d.CompanyCode,
        SapCardName: d.SapCardName,
        preview: d.LastDryRunPayloadPreview,
        attemptedAt: d.LastDryRunPayloadAt,
        error: d.SapWriteLastError,
      })),
      invoices: result.invoicesCreated.map((i) => ({
        InvoiceId: i.InvoiceId,
        DocNumber: i.DocNumber,
      })),
      skipped: result.skipped,
    });
  } catch (err) {
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.unapproved) payload.unapproved = err.unapproved;
    // A2-3: surface the structured fields for the new error codes so the
    // UI can list which customers / which fields blocked the flush.
    if (err.missingPolicy) payload.missingPolicy = err.missingPolicy;
    if (err.missingFields) payload.missingFields = err.missingFields;
    if (err.docNumber) payload.docNumber = err.docNumber;
    res.status(err.status || 500).json(payload);
  }
});

// (2026-05-30) Reset stuck aggregate invoices — one-time admin tool to
// recover invoices that got stuck in PENDING_EXPORT because of a bug in
// flushAggregateDocsForRun (see commit a2ec4e5 fix). For each invoice
// ID in the body, marks it (and its linked DN, if any) as CANCELLED
// and resets the source orders' AggregatePending=true so the next
// flush-aggregate-docs call can recreate them cleanly with valid
// DocNumber and audit fields. Does NOT touch QcApproved/QcApprovedAt
// (the orders stay approved — we're just undoing the doc-creation step).
//
// Body: { invoiceIds: number[] }
// Returns: { cancelled: { invoiceIds, deliveryNoteIds }, resetRunOrders: number[] }
//
// Idempotent: an already-CANCELLED invoice is skipped. An invoice with
// SapInvoiceDocEntry set (= already in SAP) is refused (422) — we don't
// silently cancel something the customer actually received.
app.post('/api/admin/reset-stuck-aggregate-docs', adminOnly, (req, res) => {
  const invoiceIds = Array.isArray(req.body?.invoiceIds) ? req.body.invoiceIds.map(Number) : null;
  if (!invoiceIds?.length) {
    return res.status(400).json({ error: 'BAD_BODY', message: 'invoiceIds: number[] required' });
  }
  const s = store.load();
  const cancelledInvoiceIds = [];
  const cancelledDnIds = new Set();
  const resetRunOrderIds = new Set();
  const skipped = [];
  const refused = [];

  for (const invId of invoiceIds) {
    const inv = (s.invoices || []).find((i) => i.InvoiceId === invId);
    if (!inv) { skipped.push({ invoiceId: invId, reason: 'NOT_FOUND' }); continue; }
    if (inv.Status === 'CANCELLED') { skipped.push({ invoiceId: invId, reason: 'ALREADY_CANCELLED' }); continue; }
    if (inv.SapInvoiceDocEntry) {
      refused.push({ invoiceId: invId, reason: 'ALREADY_IN_SAP', sapDocEntry: inv.SapInvoiceDocEntry });
      continue;
    }
    inv.Status = 'CANCELLED';
    inv.CancelledAt = new Date().toISOString();
    inv.CancelledBy = req.user?.name || 'admin';
    inv.CancelReason = req.body?.reason || 'reset-stuck-aggregate-docs';
    cancelledInvoiceIds.push(invId);

    // Cancel the linked DN if it exists, isn't already in SAP, and isn't
    // shared by another non-cancelled invoice.
    if (inv.DeliveryNoteId) {
      const dn = (s.deliveryNotes || []).find((d) => d.DeliveryNoteId === inv.DeliveryNoteId);
      if (dn && dn.Status !== 'CANCELLED' && !dn.SapDeliveryDocEntry) {
        const othersUsingDn = (s.invoices || []).some((i) =>
          i.InvoiceId !== invId &&
          i.DeliveryNoteId === dn.DeliveryNoteId &&
          i.Status !== 'CANCELLED'
        );
        if (!othersUsingDn) {
          dn.Status = 'CANCELLED';
          dn.CancelledAt = new Date().toISOString();
          dn.CancelReason = 'reset-stuck-aggregate-docs';
          cancelledDnIds.add(dn.DeliveryNoteId);
        }
      }
    }

    // Reset the source runOrders so the next flush sees them as pending.
    for (const src of (inv.SourceOrders || [])) {
      const ord = (s.runOrders || []).find((o) => o.RunOrderId === src.RunOrderId);
      if (!ord) continue;
      ord.DeliveryNoteId = null;
      ord.InvoiceId = null;
      ord.AggregatePending = true; // re-mark for the next flush
      resetRunOrderIds.add(ord.RunOrderId);
    }
  }

  store.save();
  store.recordAudit?.({
    action: 'admin.reset-stuck-aggregate-docs',
    actorSub: req.user?.sub,
    actorName: req.user?.name,
    ip: req.ip,
    details: {
      invoiceIdsRequested: invoiceIds,
      cancelledInvoiceIds,
      cancelledDeliveryNoteIds: [...cancelledDnIds],
      resetRunOrderIds: [...resetRunOrderIds],
      skipped,
      refused,
    },
  });
  res.json({
    ok: true,
    cancelled: {
      invoiceIds: cancelledInvoiceIds,
      deliveryNoteIds: [...cancelledDnIds],
    },
    resetRunOrderIds: [...resetRunOrderIds],
    skipped,
    refused,
  });
});

// A2c-4b — admin-only endpoint to invoke flushAggregateDocsForRun with
// liveWrite=true OUTSIDE the picking -> QC-approve UI flow. Strictly for
// validating the live SAP write path on TEST runs only.
//
// Defense-in-depth guards (all must pass, in this order):
//   1. adminOnly middleware    -> JWT + role==='ADMIN' (401 / 403)
//   2. runId positive integer  -> 400 INVALID_RUN_ID
//   3. body.confirm === 'I-UNDERSTAND-THIS-WRITES-TO-SAP' -> 400 BAD_INPUT
//   4. Run exists              -> 404 RUN_NOT_FOUND
//   5. run.IsTest === true     -> 403 NOT_TEST_RUN
//   6. SAP_WRITE_ENABLED env   -> 403 LIVE_WRITE_DISABLED
//   7. Inside flush: serviceLayer whitelist gate (already wired)
//   8. Inside flush: QC + DocPolicy + payload validation (already wired)
//
// Body schema is locked down on purpose: no liveWrite flag, no method
// override. This endpoint is ONLY for live test-flush. Dry-run callers
// should use the existing /api/runs/:id/flush-aggregate-docs endpoint.
const TestFlushBodySchema = z.object({
  confirm: z.literal('I-UNDERSTAND-THIS-WRITES-TO-SAP'),
}).strict();

app.post('/api/admin/sap-write/test-flush/:runId', adminOnly, async (req, res) => {
  // 2. Validate runId is a positive integer.
  const runId = Number(req.params.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return res.status(400).json({ error: 'invalid runId', code: 'INVALID_RUN_ID' });
  }
  // 3. Validate body confirm string is the exact magic value.
  const body = parseBody(TestFlushBodySchema, req.body, res);
  if (!body) return;
  // 4. Lookup run.
  const run = store.getRuns().find((r) => r && Number(r.RunId) === runId);
  if (!run) {
    return res.status(404).json({ error: 'run not found', code: 'RUN_NOT_FOUND' });
  }
  // 5. Refuse unless run is explicitly marked IsTest=true.
  if (run.IsTest !== true) {
    return res.status(403).json({
      error: 'run is not marked IsTest=true; refusing live write',
      code: 'NOT_TEST_RUN',
      runId,
    });
  }
  // 6. Refuse if SAP_WRITE_ENABLED env is not enabled.
  if (process.env.SAP_WRITE_ENABLED !== 'true') {
    return res.status(403).json({
      error: 'SAP_WRITE_ENABLED is not true; refusing live write',
      code: 'LIVE_WRITE_DISABLED',
    });
  }
  // 7 + 8 are enforced inside flushAggregateDocsForRun and the serviceLayer
  // it calls. Let exceptions propagate with their status/code.
  try {
    const approvedBy = req.user?.name || req.user?.username || `user:${req.user?.sub}`;
    const result = await store.flushAggregateDocsForRun(runId, {
      approvedBy,
      method: 'TEST_FLUSH_LIVE',
      liveWrite: true,
    });
    io.emit('run:aggregate-flushed', { runId, source: 'test-flush' });
    return res.json({ ok: true, source: 'test-flush', runId, result });
  } catch (err) {
    const payload = { error: err.message };
    if (err.code) payload.code = err.code;
    if (err.unapproved) payload.unapproved = err.unapproved;
    if (err.missingPolicy) payload.missingPolicy = err.missingPolicy;
    if (err.missingFields) payload.missingFields = err.missingFields;
    if (err.docNumber) payload.docNumber = err.docNumber;
    return res.status(err.status || 500).json(payload);
  }
});

// DEV.14: per-invoice export to SAP TEST.
//
// Why a NEW endpoint instead of reusing /api/sap/write/invoice/:id:
//   The legacy /api/sap/write/invoice/:id has no admin gate, no confirm
//   phrase, no PENDING_EXPORT check, and no production-DB blocker. It
//   pre-dates the strict gating pattern. Building a new endpoint lets us
//   layer all 6 defense-in-depth checks without breaking anything else.
//
// Defense-in-depth gates (all must pass, in this order):
//   1. adminOnly middleware       -> JWT + role==='ADMIN' (401 / 403)
//   2. invoiceId positive integer -> 400 INVALID_INVOICE_ID
//   3. body.confirm magic phrase  -> 400 BAD_INPUT
//   4. SAP_WRITE_ENABLED='true'   -> 403 LIVE_WRITE_DISABLED
//   5. CompanyDB not in production block-list -> 403 PRODUCTION_DB_BLOCKED
//   6. Invoice exists             -> 404 INVOICE_NOT_FOUND
//   7. canExportInvoiceToSap(...) -> 400 NOT_PENDING_EXPORT / ALREADY_EXPORTED / ...
//   8. (inside writeInvoice) whitelist case-sensitive check -> 503 if drift
//
// Blast radius: exactly 1 invoice per call. No bulk path.

const ExportInvoiceBodySchema = z.object({
  confirm: z.literal('I-UNDERSTAND-THIS-WRITES-TO-SAP'),
}).strict();

// Block-list of production company DBs. Belt-and-suspenders alongside
// SAP_LIVE_WRITE_DB_WHITELIST: even if the whitelist drifts, this hard
// reject prevents an accidental production write through this endpoint.
const SAP_PRODUCTION_DB_BLOCKLIST = ['SAP_OIG', 'SAP_Unico', 'SAP_Unico_Eilat'];

function _resolveCompanyDb(companyCode) {
  if (companyCode === 'A') return process.env.SAP_SL_COMPANY_DB_A || null;
  if (companyCode === 'B') return process.env.SAP_SL_COMPANY_DB_B || null;
  return null;
}

/**
 * DEV.16: read-only stock lookup for a SAP item. Used by the UI export
 * dialog to warn the operator before they hit "send" on an invoice whose
 * items don't have enough stock in TEST_OIG (LIVE.5 attempt #5 fail mode).
 * Admin-only because the underlying SAP login uses the writer credentials.
 * Does NOT require SAP_WRITE_ENABLED — it's a GET, not a write.
 */
app.get('/api/admin/sap-write/items/:itemCode/stock', adminOnly, async (req, res) => {
  const itemCode = String(req.params.itemCode || '').trim();
  if (!itemCode) {
    return res.status(400).json({ error: 'itemCode required', code: 'INVALID_ITEM_CODE' });
  }
  // companyCode picks which TEST CompanyDB to query — default A=TEST_OIG.
  // We don't expose production company codes here; the env-mapping is the
  // bound.
  const companyCode = String(req.query.companyCode || 'A').trim().toUpperCase();
  if (companyCode !== 'A' && companyCode !== 'B') {
    return res.status(400).json({ error: 'companyCode must be A or B', code: 'INVALID_COMPANY' });
  }
  try {
    const { getItemStock } = await import('./sapWriter.js');
    const stock = await getItemStock(itemCode, companyCode);
    return res.json({ ok: true, ...stock, companyCode });
  } catch (err) {
    // Surface SAP-side errors verbatim (already contains the SAP error text)
    return res.status(502).json({ error: err.message, code: 'SAP_GET_FAILED' });
  }
});

/**
 * DEV.14 preview — dry-run inspection of the SAP payload that WOULD be
 * sent for this invoice, plus the guard verdict. Read-only: never writes
 * to SAP, never mutates the store. Does NOT require SAP_WRITE_ENABLED —
 * operators should be able to inspect the payload even on a quiet system.
 */
app.post('/api/admin/sap-write/invoices/:invoiceId/preview', adminOnly, async (req, res) => {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({ error: 'invalid invoiceId', code: 'INVALID_INVOICE_ID' });
  }
  const invoice = (store.load().invoices || []).find((i) => i.InvoiceId === invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });

  const dn = invoice.DeliveryNoteId
    ? (store.load().deliveryNotes || []).find((d) => d.DeliveryNoteId === invoice.DeliveryNoteId)
    : null;

  const guard = store.canExportInvoiceToSap(invoice);
  const targetCompanyDb = _resolveCompanyDb(invoice.CompanyCode);
  const isProductionDb = SAP_PRODUCTION_DB_BLOCKLIST.includes(targetCompanyDb);

  // Force dryRun=true so writeInvoice builds the payload and returns it
  // without touching the network (also short-circuits the per-request
  // whitelist gate — we want to see the payload regardless).
  const { writeInvoice } = await import('./sapWriter.js');
  const result = await writeInvoice(invoice, dn, { dryRun: true });

  return res.json({
    ok: true,
    mode: 'preview',
    canExport: guard.ok === true && !isProductionDb,
    guard,
    productionDbBlocked: isProductionDb,
    targetCompanyDb,
    invoice: {
      InvoiceId: invoice.InvoiceId,
      DocNumber: invoice.DocNumber,
      Status: invoice.Status,
      CompanyCode: invoice.CompanyCode,
      SapCardCode: invoice.SapCardCode,
      SapCardName: invoice.SapCardName,
      TotalAmount: invoice.TotalAmount,
      DeliveryNoteId: invoice.DeliveryNoteId,
      hasLines: Array.isArray(invoice.Lines) && invoice.Lines.length > 0,
    },
    linkedDn: dn ? {
      DeliveryNoteId: dn.DeliveryNoteId,
      DocNumber: dn.DocNumber,
      Status: dn.Status,
      SapDeliveryDocEntry: dn.SapDeliveryDocEntry,
    } : null,
    payloadThatWouldBeSent: result.payload,
    payloadShape: dn?.SapDeliveryDocEntry ? 'live-mode (BaseType=15 ref to DN)' : 'standalone (ItemCode+Quantity)',
  });
});

/**
 * DEV.14 export-test — LIVE write of a single PENDING_EXPORT invoice to
 * the configured TEST CompanyDB. Multiple defense-in-depth gates run
 * before any network call; see comment block above. On success the
 * invoice is updated to SAP_CONFIRMED with the real DocEntry/DocNum.
 */
app.post('/api/admin/sap-write/invoices/:invoiceId/export-test', adminOnly, async (req, res) => {
  // Gate 2: invoiceId positive integer
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({ error: 'invalid invoiceId', code: 'INVALID_INVOICE_ID' });
  }
  // Gate 3: body confirm phrase (matches the test-flush pattern)
  const body = parseBody(ExportInvoiceBodySchema, req.body, res);
  if (!body) return;
  // Gate 4: SAP_WRITE_ENABLED env. Early reject — no point continuing if
  // writeInvoice would dry-run anyway.
  if (process.env.SAP_WRITE_ENABLED !== 'true') {
    return res.status(403).json({
      error: 'SAP_WRITE_ENABLED is not true; refusing live write',
      code: 'LIVE_WRITE_DISABLED',
    });
  }
  // Gate 6: invoice exists
  const invoice = (store.load().invoices || []).find((i) => i.InvoiceId === invoiceId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  // Gate 5: production DB block-list (after we know the invoice's company)
  const targetCompanyDb = _resolveCompanyDb(invoice.CompanyCode);
  if (SAP_PRODUCTION_DB_BLOCKLIST.includes(targetCompanyDb)) {
    return res.status(403).json({
      error: `production CompanyDB '${targetCompanyDb}' is forbidden via this endpoint`,
      code: 'PRODUCTION_DB_BLOCKED',
      companyDb: targetCompanyDb,
    });
  }
  // Gate 7: invoice state checks (status, no existing DocEntry, lines present)
  const guard = store.canExportInvoiceToSap(invoice);
  if (guard.error) return res.status(400).json(guard);

  // Look up linked DN if any — used by the payload builder to decide
  // live-mode (BaseType=15) vs standalone (ItemCode+Quantity).
  const dn = invoice.DeliveryNoteId
    ? (store.load().deliveryNotes || []).find((d) => d.DeliveryNoteId === invoice.DeliveryNoteId)
    : null;

  // Execute. writeInvoice() runs gate 8 (per-request whitelist) internally
  // and returns { ok, sapDocEntry, sapDocNum, payload, ... } or throws.
  const { writeInvoice } = await import('./sapWriter.js');
  let result;
  try {
    result = await writeInvoice(invoice, dn, { dryRun: false });
  } catch (err) {
    return res.status(500).json({ error: err.message, code: 'SAP_WRITE_EXCEPTION' });
  }
  if (!result.ok) {
    return res.status(502).json({
      error: result.error || 'SAP write failed',
      code: result.code || 'SAP_WRITE_FAILED',
      payload: result.payload,
    });
  }

  // Success: persist the real DocEntry/DocNum and flip status.
  if (result.sapDocEntry) {
    invoice.SapInvoiceDocEntry = result.sapDocEntry;
    invoice.SapInvoiceDocNum = result.sapDocNum;
    invoice.Status = 'SAP_CONFIRMED';
    invoice.SentToSapAt = new Date().toISOString();
    invoice.ConfirmedAt = new Date().toISOString();
    store.save?.();
  }

  store.recordAudit({
    action: 'invoice.export_test',
    actorSub: req.user?.sub,
    actorName: req.user?.name || req.user?.username,
    ip: req.ip,
    details: {
      invoiceId: invoice.InvoiceId,
      docNumber: invoice.DocNumber,
      companyCode: invoice.CompanyCode,
      companyDb: targetCompanyDb,
      sapCardCode: invoice.SapCardCode,
      sapDocEntry: result.sapDocEntry,
      sapDocNum: result.sapDocNum,
    },
  });

  return res.json({
    ok: true,
    mode: 'live',
    invoiceId: invoice.InvoiceId,
    docNumber: invoice.DocNumber,
    sapDocEntry: result.sapDocEntry,
    sapDocNum: result.sapDocNum,
    payload: result.payload,
  });
});

app.post('/api/picking/:waveId/qc-approve', (req, res) => {
  const auth = req.headers.authorization;
  let approvedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { approvedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  const result = store.approveWaveQc(req.params.waveId, {
    approvedBy,
    notes: req.body?.notes,
  });
  if (!result || result.ok === false) {
    return res.status(400).json({ error: result?.error || 'Wave not found or not in QC state' });
  }
  io.emit('wave:qc-approved', { waveId: Number(req.params.waveId) });
  res.json(result);
});

app.post('/api/picking/:waveId/qc-reject', (req, res) => {
  const auth = req.headers.authorization;
  let rejectedBy = null;
  if (auth?.startsWith('Bearer ')) {
    try { rejectedBy = jwt.verify(auth.slice(7), JWT_SECRET).name; } catch {}
  }
  const result = store.rejectWaveQc(req.params.waveId, {
    rejectedBy,
    notes: req.body?.notes,
    resetLineIds: req.body?.resetLineIds,
  });
  if (!result) return res.status(404).json({ error: 'Wave not found' });
  io.emit('wave:qc-rejected', { waveId: Number(req.params.waveId) });
  res.json(result);
});

app.post('/api/picking/allocations/:allocId/pick', (req, res) => {
  const auth = req.headers.authorization;
  let userId = null, userName = null;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      userId = payload.sub;
      userName = payload.name;
    } catch {}
  }
  const result = store.pickAllocation(
    req.params.allocId,
    req.body.pickedQuantity != null ? req.body.pickedQuantity : 1,
    userId,
    userName
  );
  if (!result) return res.status(404).json({ error: 'Allocation not found' });
  io.emit('pick:allocation', { allocationId: Number(req.params.allocId), waveLineId: result.line?.WaveLineId });
  res.json(result);
});

app.post('/api/picking/allocations/:allocId/reset', (req, res) => {
  const result = store.resetAllocation(req.params.allocId);
  if (!result) return res.status(404).json({ error: 'Allocation not found' });
  io.emit('pick:allocation', { allocationId: Number(req.params.allocId), waveLineId: result.line?.WaveLineId });
  res.json(result);
});

// Pick - scan or manually enter quantity
app.post('/api/picking/lines/:lineId/pick', (req, res) => {
  const auth = req.headers.authorization;
  let userId = null, userName = null;
  if (auth?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      userId = payload.sub;
      userName = payload.name;
    } catch {}
  }

  const line = store.recordPick(
    req.params.lineId,
    req.body.pickedQuantity || 1,
    userId,
    userName
  );
  if (!line) return res.status(404).json({ error: 'Line not found' });

  io.emit('picking:line-updated', line);
  res.json(line);
});

// Pick by barcode - scan a barcode and find matching line
app.post('/api/picking/:id/scan', (req, res) => {
  const { barcode } = req.body;
  const wave = store.getWave(req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });

  const line = wave.lines.find((l) =>
    l.Barcode === barcode || l.SapItemCode === barcode
  );
  if (!line) {
    return res.status(404).json({ error: `ברקוד ${barcode} לא נמצא בגל ליקוט זה` });
  }
  if (line.Status === 'COMPLETED') {
    return res.status(400).json({ error: 'הפריט כבר נלקט במלואו', line });
  }
  // Increment by 1
  const updated = store.recordPick(line.WaveLineId, 1);
  io.emit('picking:line-updated', updated);
  res.json(updated);
});

// Mark as shortage
app.post('/api/picking/lines/:lineId/shortage', (req, res) => {
  const line = store.markShortage(req.params.lineId, req.body.notes);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  io.emit('picking:line-updated', line);
  res.json(line);
});

// Reset a line (undo pick)
app.post('/api/picking/lines/:lineId/reset', (req, res) => {
  const line = store.resetWaveLine(req.params.lineId);
  if (!line) return res.status(404).json({ error: 'Line not found' });
  io.emit('picking:line-updated', line);
  res.json(line);
});

// Bulk PDF - all runs for a day
app.get('/api/reports/runs/bulk-manifest.pdf', (req, res) => {
  const runDate = req.query.runDate || new Date().toISOString().slice(0, 10);
  const runsForDate = store.getRuns().filter((r) => r.RunDate === runDate);
  if (runsForDate.length === 0) {
    return res.status(404).json({ error: 'אין מסלולים לתאריך זה' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="all-manifests-${runDate}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  // Cover page
  doc.fontSize(24).fillColor('#1e3a8a').text('Daily Delivery Manifests', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor('#6b7280').text(runDate, { align: 'center' });
  doc.moveDown(1);
  doc.fontSize(12).fillColor('#111').text(
    `${runsForDate.length} runs | ` +
    `${runsForDate.reduce((s, r) => s + (r.StopCount || 0), 0)} stops | ` +
    `${runsForDate.reduce((s, r) => s + (r.OrderCount || 0), 0)} orders`,
    { align: 'center' }
  );
  doc.moveDown(2);

  // Summary list
  doc.fontSize(12).fillColor('#000');
  runsForDate.forEach((r) => {
    doc.text(`${r.RunNumber}  ${r.ZoneName}  (${r.StopCount} stops)  Driver: ${r.DriverName || '---'}`);
  });

  // One page per run
  for (const run of runsForDate) {
    doc.addPage();
    doc.fontSize(18).fillColor('#1e3a8a').text(run.RunNumber, { align: 'center' });
    doc.fontSize(11).fillColor('#374151').text(
      `Zone: ${run.ZoneCode} (${run.ZoneName}) | Driver: ${run.DriverName || '---'} | Plate: ${run.VehiclePlate || '---'}`,
      { align: 'center' }
    );
    doc.moveDown(0.5);
    doc.strokeColor('#2563eb').lineWidth(2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.5);

    const runDetails = store.getRunDetails(run.RunId);
    const runStops = runDetails?.stops || [];

    runStops.forEach((stop, idx) => {
      if (doc.y > 740) doc.addPage();
      const y0 = doc.y;
      doc.roundedRect(40, y0, 515, 22, 4).fillAndStroke('#eff6ff', '#2563eb');
      doc.fillColor('#1e3a8a').fontSize(10).text(
        `#${stop.StopOrder || idx + 1} | ${stop.Street || ''} ${stop.BuildingNumber || ''}, ${stop.City || ''}`,
        48, y0 + 6, { width: 500 }
      );
      doc.y = y0 + 26;
      if (stop.BranchName) doc.fontSize(9).fillColor('#6b7280').text(`   ${stop.BranchName}`);
      if (stop.ContactPhone) doc.fontSize(9).fillColor('#374151').text(`   Tel: ${stop.ContactPhone}`);
      for (const o of stop.orders || []) {
        doc.fontSize(9).fillColor('#111').text(
          `     [ ] ${o.CompanyCode} | ${o.SapCardName} | #${o.SapDocNum} | ${o.LinesCount} lines | ${o.OrderTotal || 0}`
        );
      }
      doc.fontSize(8).fillColor('#9ca3af').text('   Signature: _____________________');
      doc.moveDown(0.5);
    });
  }

  doc.end();
});

// Reports endpoints
app.get('/api/reports/runs/:id/manifest.pdf', (req, res) => {
  const runFromStore = store.getRunDetails(req.params.id);
  const run = runFromStore || data.runs.find((r) => r.RunId === Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="manifest-${run.RunNumber}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  // Header
  doc.fontSize(22).fillColor('#1e3a8a').text('DRIVER MANIFEST', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor('#374151').text(run.RunNumber, { align: 'center' });
  doc.fontSize(11).fillColor('#6b7280').text(run.RunDate, { align: 'center' });

  doc.moveDown(1);
  doc.strokeColor('#2563eb').lineWidth(2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.5);

  // Info
  doc.fontSize(11).fillColor('#111');
  doc.text(`Zone: ${run.ZoneCode} (${run.ZoneName})`);
  doc.text(`Driver: ${run.DriverName} | Plate: ${run.VehiclePlate || '---'}`);
  doc.text(`Status: ${run.Status} | Stops: ${run.StopCount} | Orders: ${run.OrderCount}`);

  doc.moveDown();

  // Stops
  const runStops = data.stops.filter((s) => s.RunId === run.RunId);
  runStops.forEach((stop, idx) => {
    if (doc.y > 720) doc.addPage();

    // Stop header box
    const y0 = doc.y;
    doc.roundedRect(40, y0, 515, 22, 4).fillAndStroke('#eff6ff', '#2563eb');
    doc.fillColor('#1e3a8a').fontSize(12).text(
      `#${stop.StopOrder || idx + 1}  |  ${stop.Street} ${stop.BuildingNumber}, ${stop.City}`,
      48, y0 + 5, { width: 500 }
    );
    doc.y = y0 + 28;

    if (stop.BranchName) {
      doc.fontSize(9).fillColor('#6b7280').text(`   ${stop.BranchName}`);
    }
    if (stop.DeliveryWindowStart) {
      doc.fontSize(9).fillColor('#d97706').text(
        `   ⏰ Window: ${String(stop.DeliveryWindowStart).slice(0, 5)}-${String(stop.DeliveryWindowEnd).slice(0, 5)}`
      );
    }
    if (stop.ContactPhone) {
      doc.fontSize(9).fillColor('#374151').text(`   ☎  ${stop.ContactPhone} (${stop.ContactName || ''})`);
    }

    // Orders
    const orders = data.runOrders.filter((o) => o.StopId === stop.StopId);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#059669').text('   Deliveries:');
    for (const o of orders) {
      doc.fontSize(9).fillColor('#111').text(
        `     [ ]  Company ${o.CompanyCode}  |  ${o.SapCardName}  |  #${o.SapDocNum}  |  ${o.LinesCount} lines  |  ₪${o.OrderTotal}`
      );
    }

    doc.moveDown(0.3);
    doc.fontSize(8).fillColor('#9ca3af').text('   Customer signature: _____________________________');
    doc.moveDown(0.8);
  });

  // Footer
  doc.fontSize(8).fillColor('#9ca3af').text(
    `Printed ${new Date().toLocaleString()}  |  SAP Logistics Hub DEMO`,
    40, 800, { width: 515, align: 'center' }
  );

  doc.end();
});
// ----------------------------------------------------------------------------
// Distribution Summary PDF (Hebrew) - "ריכוז קו חלוקה"
// One row per customer/stop with the document numbers (DN/INV/RET).
// No item-level detail - meant as a quick reference for the driver +
// office reconciliation.
// ----------------------------------------------------------------------------
app.get('/api/reports/runs/:id/distribution-summary.pdf', async (req, res) => {
  try {
    const runId = Number(req.params.id);
    const details = store.getRunDetails(runId);
    if (!details) return res.status(404).json({ error: 'Run not found' });

    const stops = (details.stops || []).slice().sort(
      (a, b) => Number(a.StopOrder || 0) - Number(b.StopOrder || 0)
    );

    // Pull DNs / invoices already generated for this run
    const docsStore = store.load();
    const dns = (docsStore.deliveryNotes || []).filter((d) => d.RunId === runId);
    const invs = (docsStore.invoices || []).filter((i) => i.RunId === runId);
    const returnsForRun = (docsStore.returns || []).filter(
      (r) => stops.some((s) => s.StopId === r.StopId)
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="distribution-${details.RunNumber}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    try {
      doc.registerFont('Hebrew', HEBREW_FONT_PATH);
      doc.registerFont('Hebrew-Bold', HEBREW_FONT_BOLD_PATH);
    } catch {}
    doc.pipe(res);

    // Title
    doc.font('Hebrew-Bold').fontSize(20).fillColor('#1e3a8a')
      .text(rtlText('ריכוז קו חלוקה'), { align: 'center' });
    doc.font('Hebrew').fontSize(13).fillColor('#6b7280')
      .text(`${details.RunNumber} · ${details.RunDate}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#374151')
      .text(`${rtlText('אזור')}: ${rtlText(details.ZoneName || '')}    ${rtlText('נהג')}: ${rtlText(details.DriverName || '___________')}    ${rtlText('רכב')}: ${details.VehiclePlate || '___'}`, { align: 'center' });
    doc.moveDown(0.5);

    // Totals box (no monetary value)
    const totalDns = dns.length;
    const totalInvs = invs.length;
    const totalReturns = returnsForRun.length;
    doc.roundedRect(30, doc.y, 535, 32, 4).fillAndStroke('#eff6ff', '#2563eb');
    doc.fillColor('#1e3a8a').font('Hebrew-Bold').fontSize(11)
      .text(rtlText(`עצירות: ${stops.length}    תעודות משלוח: ${totalDns}    חשבוניות: ${totalInvs}    החזרות: ${totalReturns}`),
        35, doc.y + 10, { width: 525, align: 'center' });
    doc.moveDown(2.0);

    // Table header (with company column)
    const headerY = doc.y;
    doc.rect(30, headerY, 535, 20).fill('#f3f4f6');
    doc.font('Hebrew-Bold').fontSize(9).fillColor('#374151');
    doc.text(rtlText('#'), 35, headerY + 6, { width: 22, align: 'center' });
    doc.text(rtlText('לקוח / סניף'), 290, headerY + 6, { width: 230, align: 'right' });
    doc.text(rtlText('חברה'), 235, headerY + 6, { width: 50, align: 'center' });
    doc.text(rtlText('עיר'), 165, headerY + 6, { width: 65, align: 'right' });
    doc.text(rtlText('סוג מסמך'), 100, headerY + 6, { width: 60, align: 'right' });
    doc.text(rtlText('מספר'), 60, headerY + 6, { width: 35, align: 'right' });
    doc.y = headerY + 22;

    // One row per (stop, document) - so a customer with both DN and INV gets 2 rows
    let alt = false;
    let rowNum = 0;
    for (const stop of stops) {
      const stopDns = dns.filter((d) => d.StopId === stop.StopId);
      const stopInvs = invs.filter((i) => i.StopId === stop.StopId);
      const stopRets = returnsForRun.filter((r) => r.StopId === stop.StopId);

      // If no docs at all, still show a row
      const items = [];
      for (const d of stopDns) {
        items.push({
          type: 'DN',
          typeLabel: 'ת.משלוח',
          color: '#1d4ed8',
          docNum: d.SapDeliveryDocNum || `(${d.DocNumber})`,
          confirmed: d.Status === 'CONFIRMED',
          amount: d.TotalAmount,
          companyCode: d.CompanyCode,
          cardName: d.SapCardName,
        });
      }
      for (const i of stopInvs) {
        items.push({
          type: 'INV',
          typeLabel: 'חשבונית',
          color: '#7c3aed',
          docNum: i.SapInvoiceDocNum || `(${i.DocNumber})`,
          confirmed: i.Status === 'CONFIRMED',
          amount: i.TotalAmount,
          companyCode: i.CompanyCode,
          cardName: i.SapCardName,
        });
      }
      for (const r of stopRets) {
        items.push({
          type: 'RET',
          typeLabel: 'החזרה',
          color: '#dc2626',
          docNum: r.SapDocNum || r.RetRequestId || `RET-${r.ReturnId}`,
          confirmed: false,
          amount: r.TotalValue || 0,
          companyCode: r.CompanyCode,
          cardName: r.CardName || stop.BranchName,
        });
      }
      if (items.length === 0) {
        items.push({
          type: 'PENDING',
          typeLabel: 'ממתין',
          color: '#9ca3af',
          docNum: '—',
          confirmed: false,
          amount: 0,
          companyCode: null,
          cardName: stop.BranchName,
        });
      }

      for (const it of items) {
        if (doc.y > 770) {
          doc.addPage();
          // Re-print header on new page
          const hY = doc.y;
          doc.rect(30, hY, 535, 20).fill('#f3f4f6');
          doc.font('Hebrew-Bold').fontSize(9).fillColor('#374151');
          doc.text(rtlText('#'), 35, hY + 6, { width: 22, align: 'center' });
          doc.text(rtlText('לקוח / סניף'), 290, hY + 6, { width: 230, align: 'right' });
          doc.text(rtlText('חברה'), 235, hY + 6, { width: 50, align: 'center' });
          doc.text(rtlText('עיר'), 165, hY + 6, { width: 65, align: 'right' });
          doc.text(rtlText('סוג מסמך'), 100, hY + 6, { width: 60, align: 'right' });
          doc.text(rtlText('מספר'), 60, hY + 6, { width: 35, align: 'right' });
          doc.y = hY + 22;
        }
        rowNum += 1;
        const rowY = doc.y;
        doc.rect(30, rowY, 535, 22).fill(alt ? '#fafafa' : '#fff');
        // Stop number
        doc.font('Hebrew-Bold').fontSize(10).fillColor('#374151')
          .text(String(stop.StopOrder || rowNum), 35, rowY + 6, { width: 22, align: 'center' });
        // Customer name
        doc.font('Hebrew').fontSize(9).fillColor('#111')
          .text(rtlText(it.cardName || stop.BranchName || ''), 290, rowY + 6, { width: 230, height: 14, align: 'right', ellipsis: true });
        // Company badge (colored pill)
        const isOIG = it.companyCode === 'A';
        const isUnico = it.companyCode === 'B';
        if (isOIG || isUnico) {
          const pillColor = isOIG ? '#dbeafe' : '#dcfce7';
          const textColor = isOIG ? '#1e40af' : '#166534';
          doc.roundedRect(238, rowY + 5, 44, 14, 7).fill(pillColor);
          doc.font('Hebrew-Bold').fontSize(8).fillColor(textColor)
            .text(isOIG ? 'OIG' : 'Unico', 238, rowY + 8, { width: 44, align: 'center' });
        } else {
          doc.font('Hebrew').fontSize(8).fillColor('#9ca3af')
            .text('—', 235, rowY + 7, { width: 50, align: 'center' });
        }
        // City
        doc.font('Hebrew').fontSize(9).fillColor('#6b7280')
          .text(rtlText(stop.City || ''), 165, rowY + 6, { width: 65, align: 'right' });
        // Doc type pill
        doc.font('Hebrew-Bold').fontSize(8).fillColor(it.color)
          .text(rtlText(it.typeLabel), 100, rowY + 6, { width: 60, align: 'right' });
        // Doc number
        doc.font('Hebrew').fontSize(9).fillColor('#111')
          .text(`#${it.docNum}`, 60, rowY + 6, { width: 35, align: 'right' });
        if (it.confirmed) {
          doc.font('Hebrew').fontSize(7).fillColor('#16a34a')
            .text(rtlText('✓ ב-SAP'), 60, rowY + 16, { width: 35, align: 'right' });
        }
        doc.y = rowY + 22;
        doc.strokeColor('#e5e7eb').lineWidth(0.3).moveTo(30, doc.y).lineTo(565, doc.y).stroke();
        alt = !alt;
      }
    }

    // Footer
    doc.font('Hebrew').fontSize(8).fillColor('#9ca3af')
      .text(`${rtlText('הודפס')} ${new Date().toLocaleString('he-IL')} · SAP Logistics Hub`,
        30, 815, { width: 535, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[distribution-summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Loading Manifest PDF (Hebrew) - "ריכוז העמסה לנהג"
// Lists every customer + items + quantities in LIFO load order, optimized
// for printing and handing to the driver before he leaves.
// ----------------------------------------------------------------------------
app.get('/api/reports/runs/:id/loading-manifest.pdf', async (req, res) => {
  try {
    const runId = Number(req.params.id);
    const details = store.getRunDetails(runId);
    if (!details) return res.status(404).json({ error: 'Run not found' });

    // Pull line items per order from SAP (only lines actually picked or on order)
    let linesByStop = new Map();
    // Map source order → assigned doc type (delivery-note / invoice / return)
    const docTypeByDoc = new Map();
    const docNumByDoc = new Map();
    for (const o of (details.runOrders || [])) {
      const k = `${o.CompanyCode}:${o.SapDocEntry}`;
      docTypeByDoc.set(k, store.resolveDocTypeForCardName(o.SapCardName));
      docNumByDoc.set(k, o.SapDocNum);
    }

    if (sapLive) {
      try {
        const orderRefs = (details.runOrders || []).map((o) => ({
          companyCode: o.CompanyCode,
          docEntry: o.SapDocEntry,
        }));
        const allLines = await sapBridge.getBulkOrderLines(orderRefs).catch(() => []);
        const stopByDoc = new Map();
        for (const o of (details.runOrders || [])) {
          stopByDoc.set(`${o.CompanyCode}:${o.SapDocEntry}`, o.StopId);
        }
        for (const ln of allLines) {
          const stopId = stopByDoc.get(`${ln.CompanyCode}:${ln.DocEntry}`);
          if (!stopId) continue;
          if (!linesByStop.has(stopId)) linesByStop.set(stopId, []);
          // Decorate each line with its doc type + source order number
          const dk = `${ln.CompanyCode}:${ln.DocEntry}`;
          linesByStop.get(stopId).push({
            ...ln,
            __DocType: docTypeByDoc.get(dk) || 'INVOICE',
            __SourceDocNum: docNumByDoc.get(dk) || ln.DocNum,
          });
        }
      } catch (e) {
        console.warn('[loading-manifest] SAP fetch failed:', e.message);
      }
    }

    // Returns tied to this run (from local store)
    const returnsForRun = (store.load().returns || [])
      .filter((r) => details.stops?.some((s) => s.StopId === r.StopId))
      .reduce((m, r) => {
        if (!m.has(r.StopId)) m.set(r.StopId, []);
        m.get(r.StopId).push(r);
        return m;
      }, new Map());

    // Build LIFO order
    const stops = (details.stops || []).slice().sort(
      (a, b) => Number(a.StopOrder || 0) - Number(b.StopOrder || 0)
    );
    const totalStops = stops.length;
    const loadOrdered = stops
      .map((s, i) => ({ stop: s, deliveryOrder: i + 1, loadOrder: totalStops - i }))
      .sort((a, b) => a.loadOrder - b.loadOrder); // load order asc → first to load on top

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="loading-${details.RunNumber}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    try {
      doc.registerFont('Hebrew', HEBREW_FONT_PATH);
      doc.registerFont('Hebrew-Bold', HEBREW_FONT_BOLD_PATH);
    } catch {}
    doc.pipe(res);

    // Title
    doc.font('Hebrew-Bold').fontSize(20).fillColor('#1e3a8a')
      .text(rtlText('ריכוז העמסה לנהג'), { align: 'center' });
    doc.font('Hebrew').fontSize(13).fillColor('#6b7280')
      .text(`${details.RunNumber} · ${details.RunDate}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#374151')
      .text(`${rtlText('אזור')}: ${rtlText(details.ZoneName || '')}    ${rtlText('נהג')}: ${rtlText(details.DriverName || '___________')}    ${rtlText('רכב')}: ${details.VehiclePlate || '___'}`, { align: 'center' });
    doc.moveDown(0.4);

    // Important info banner with legend
    doc.roundedRect(30, doc.y, 535, 44, 4).fillAndStroke('#fff7ed', '#f59e0b');
    doc.fillColor('#92400e').fontSize(10).font('Hebrew-Bold')
      .text(rtlText('סדר העמסה: LIFO - הראשון שטוען יורד אחרון. סמן ✓ אחרי כל פריט שטענת.'),
        35, doc.y + 6, { width: 525, align: 'center' });
    doc.font('Hebrew').fontSize(8).fillColor('#78350f')
      .text(rtlText('סוגי מסמכים:  ת.מ. = תעודת משלוח  |  ח-ית = חשבונית  |  החזרה = בקשה להחזרה'),
        35, doc.y + 22, { width: 525, align: 'center' });
    doc.moveDown(2.4);

    // Aggregate totals
    let grandItems = 0, grandQty = 0;
    for (const [, lines] of linesByStop) {
      grandItems += lines.length;
      grandQty += lines.reduce((s, l) => s + Number(l.OpenQty || l.Quantity || 0), 0);
    }
    doc.fontSize(10).fillColor('#111').font('Hebrew')
      .text(`${rtlText('סה"כ עצירות')}: ${totalStops}     ${rtlText('סה"כ פריטים')}: ${grandItems}     ${rtlText('סה"כ יחידות')}: ${grandQty}`, { align: 'center' });
    doc.moveDown(0.6);

    // Stops in LOAD order (first to load = first listed)
    for (let i = 0; i < loadOrdered.length; i++) {
      const { stop, deliveryOrder, loadOrder } = loadOrdered[i];
      if (doc.y > 720) doc.addPage();

      // Stop header box
      const y0 = doc.y;
      doc.roundedRect(30, y0, 535, 32, 4).fillAndStroke('#eff6ff', '#2563eb');
      // Big load order number on the right (RTL)
      doc.fillColor('#fff').rect(30, y0, 36, 32).fill();
      doc.fillColor('#1e3a8a').font('Hebrew-Bold').fontSize(16)
        .text(String(loadOrder), 30, y0 + 7, { width: 36, align: 'center' });

      doc.fillColor('#1e3a8a').font('Hebrew-Bold').fontSize(11)
        .text(rtlText(`טען #${loadOrder}  →  נמסר #${deliveryOrder}`),
          70, y0 + 4, { width: 280, align: 'right' });
      doc.font('Hebrew').fontSize(10).fillColor('#374151')
        .text(rtlText(`${stop.City || ''}  ·  ${stop.BranchName || stop.Street || ''}`),
          70, y0 + 18, { width: 480, align: 'right' });

      doc.y = y0 + 36;

      // Items table for this stop
      const lines = linesByStop.get(stop.StopId) || [];
      const stopReturns = returnsForRun.get(stop.StopId) || [];
      if (lines.length === 0 && stopReturns.length === 0) {
        doc.font('Hebrew').fontSize(9).fillColor('#9ca3af')
          .text(rtlText('   אין פירוט פריטים זמין'), { width: 535 });
      } else {
        // Table header - now with "מסמך" + "סוג" columns
        const headerY = doc.y;
        doc.rect(30, headerY, 535, 18).fill('#f3f4f6');
        doc.font('Hebrew-Bold').fontSize(8).fillColor('#374151');
        doc.text(rtlText('✓'), 35, headerY + 5, { width: 16 });
        doc.text(rtlText('שם פריט'), 250, headerY + 5, { width: 200, align: 'right' });
        doc.text(rtlText('קוד פריט'), 165, headerY + 5, { width: 80, align: 'right' });
        doc.text(rtlText('סוג'), 120, headerY + 5, { width: 40, align: 'right' });
        doc.text(rtlText('מסמך #'), 75, headerY + 5, { width: 40, align: 'right' });
        doc.text(rtlText('כמות'), 50, headerY + 5, { width: 25, align: 'center' });
        doc.y = headerY + 20;

        for (const ln of lines) {
          if (doc.y > 760) doc.addPage();
          const docTypeShort = ln.__DocType === 'DELIVERY_NOTE' ? 'ת.מ.' : 'ח-ית';
          const docTypeColor = ln.__DocType === 'DELIVERY_NOTE' ? '#1e40af' : '#7c3aed';
          // Checkbox
          doc.rect(35, doc.y + 2, 10, 10).strokeColor('#9ca3af').lineWidth(0.5).stroke();
          // Item name
          doc.font('Hebrew').fontSize(9).fillColor('#111');
          doc.text(rtlText(ln.ItemName || ''), 250, doc.y, { width: 200, height: 14, align: 'right', ellipsis: true });
          // Item code
          doc.font('Hebrew').fontSize(8).fillColor('#6b7280')
            .text(ln.ItemCode || '', 165, doc.y - 11, { width: 80, align: 'right' });
          // Doc type pill
          doc.font('Hebrew-Bold').fontSize(8).fillColor(docTypeColor)
            .text(rtlText(docTypeShort), 120, doc.y - 11, { width: 40, align: 'right' });
          // Source order number
          doc.font('Hebrew').fontSize(8).fillColor('#374151')
            .text(`#${ln.__SourceDocNum || ''}`, 75, doc.y - 11, { width: 40, align: 'right' });
          // Qty
          doc.font('Hebrew-Bold').fontSize(10).fillColor('#1e3a8a')
            .text(String(Number(ln.OpenQty || ln.Quantity || 0)), 50, doc.y - 11, { width: 25, align: 'center' });
          doc.y += 5;
          doc.strokeColor('#f3f4f6').lineWidth(0.3).moveTo(30, doc.y).lineTo(565, doc.y).stroke();
        }

        // Returns at this stop (red rows)
        for (const ret of stopReturns) {
          if (doc.y > 760) doc.addPage();
          doc.rect(30, doc.y, 535, 18).fill('#fee2e2');
          doc.rect(35, doc.y + 4, 10, 10).strokeColor('#dc2626').lineWidth(0.5).stroke();
          doc.font('Hebrew').fontSize(9).fillColor('#991b1b')
            .text(rtlText(`החזרה: ${ret.ItemName || ret.Reason || ''}`), 250, doc.y + 4, { width: 200, align: 'right', ellipsis: true });
          doc.font('Hebrew').fontSize(8)
            .text(ret.ItemCode || '', 165, doc.y + 5, { width: 80, align: 'right' });
          doc.font('Hebrew-Bold').fontSize(8).fillColor('#dc2626')
            .text(rtlText('החזרה'), 120, doc.y + 5, { width: 40, align: 'right' });
          doc.font('Hebrew').fontSize(8).fillColor('#7f1d1d')
            .text(`#${ret.RetRequestId || ret.ReturnId || ''}`, 75, doc.y + 5, { width: 40, align: 'right' });
          doc.font('Hebrew-Bold').fontSize(10).fillColor('#991b1b')
            .text(String(Number(ret.Quantity || 0)), 50, doc.y + 4, { width: 25, align: 'center' });
          doc.y += 20;
        }
      }

      doc.moveDown(0.5);
    }

    // Footer
    doc.font('Hebrew').fontSize(8).fillColor('#9ca3af')
      .text(`${rtlText('הודפס')} ${new Date().toLocaleString('he-IL')} · SAP Logistics Hub`,
        30, 815, { width: 535, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[loading-manifest]', err);
    res.status(500).json({ error: err.message });
  }
});

// Excel/CSV export of picking list
app.get('/api/reports/waves/:id/picking.xlsx', (req, res) => {
  const wave = store.getWave(req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="picking-${wave.WaveNumber}.csv"`);

  const csv = '"V","קוד פריט","ברקוד","שם פריט","כמות","יחידה","מחסן","הזמנות משויכות"\n' +
    wave.lines.map((l) => {
      const allocs = (l.allocations || [])
        .map((a) => `${a.CompanyCode} #${a.SapDocNum} (${a.Quantity})`)
        .join(' | ');
      return `" ","${l.SapItemCode}","${l.Barcode || ''}","${l.SapItemName.replace(/"/g, '""')}",${l.TotalQuantity},"${l.UomCode || ''}","${l.BinLocation || ''}","${allocs}"`;
    }).join('\n');

  res.send('\uFEFF' + csv); // BOM for Hebrew Excel
});

// Printable picking list PDF - checklist format
/**
 * Convert logical-order text to visual-order for PDFKit, which does not
 * support the Unicode Bidirectional Algorithm natively (it draws glyphs
 * left-to-right regardless of script direction).
 *
 * Implementation: full Unicode Bidi via `bidi-js`. Replaces the earlier
 * manual reverse() which split on whitespace/punct heuristically and
 * produced unreadable output for mixed Hebrew + Latin + digits + slashes
 * (the common case for delivery notes: customer name + DN number + city).
 *
 * The base direction is auto-detected: if any Hebrew is present, the
 * paragraph is treated as RTL; otherwise LTR. This matches operator
 * intent: a customer name like "סלון גאולה" in an RTL paragraph, a
 * machine-generated id like "RUN-2026-05-13-06" stays LTR.
 */
const _bidi = bidiFactory();

function rtlText(text) {
  if (!text) return '';
  const str = String(text);
  const baseDir = /[֐-׿]/.test(str) ? 'rtl' : 'ltr';
  const levels = _bidi.getEmbeddingLevels(str, baseDir);
  const result = _bidi.getReorderedString(str, levels);
  return result;
}

const HEBREW_FONT_PATH = path.join(__dirname, '../../fonts/arial.ttf');
const HEBREW_FONT_BOLD_PATH = path.join(__dirname, '../../fonts/arial-bold.ttf');

app.get('/api/reports/waves/:id/picking.pdf', (req, res) => {
  const wave = store.getWave(req.params.id);
  if (!wave) return res.status(404).json({ error: 'Wave not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="picking-${wave.WaveNumber}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 30 });

  // Register Hebrew-capable fonts
  try {
    doc.registerFont('Hebrew', HEBREW_FONT_PATH);
    doc.registerFont('Hebrew-Bold', HEBREW_FONT_BOLD_PATH);
  } catch (err) {
    console.warn('[pdf] Hebrew font load failed:', err.message);
  }

  doc.pipe(res);

  // Header
  doc.font('Hebrew-Bold').fontSize(18).fillColor('#1e3a8a')
    .text(rtlText('רשימת ליקוט'), { align: 'center' });
  doc.font('Hebrew').fontSize(13).fillColor('#374151')
    .text(wave.WaveNumber, { align: 'center' });
  doc.fontSize(10).fillColor('#6b7280')
    .text(`${rtlText('מסלול')}: ${wave.RunNumber}    ${rtlText('תאריך')}: ${wave.RunDate}`, { align: 'center' });
  doc.moveDown(0.5);

  doc.strokeColor('#2563eb').lineWidth(2).moveTo(30, doc.y).lineTo(565, doc.y).stroke();
  doc.moveDown(0.5);

  doc.font('Hebrew').fontSize(10).fillColor('#000')
    .text(`${rtlText('סה"כ פריטים')}: ${wave.lines.length}    |    ${rtlText('לקט')}: ${wave.PickedByName || '_________'}    |    ${rtlText('הודפס')}: ${new Date().toLocaleString('he-IL')}`,
      { align: 'right', features: ['rtla'] });
  doc.moveDown(1);

  // Table header (RTL: V on left, name on right)
  const headerY = doc.y;
  doc.rect(30, headerY, 535, 20).fill('#eff6ff');
  doc.fillColor('#1e3a8a').font('Hebrew-Bold').fontSize(9);
  // Right-aligned columns - reading right to left
  doc.text(rtlText('שם פריט'), 220, headerY + 6, { width: 230, align: 'right' });
  doc.text(rtlText('קוד'), 130, headerY + 6, { width: 80, align: 'right' });
  doc.text(rtlText('מיקום'), 70, headerY + 6, { width: 50, align: 'right' });
  doc.text(rtlText('כמות'), 460, headerY + 6, { width: 40, align: 'right' });
  doc.text('V', 510, headerY + 6, { width: 20, align: 'center' });
  doc.text(rtlText('נלקט'), 538, headerY + 6, { width: 25, align: 'right' });
  doc.y = headerY + 24;

  // Lines
  doc.font('Hebrew').fontSize(9).fillColor('#000');
  for (const line of wave.lines) {
    if (doc.y > 770) {
      doc.addPage();
    }
    const y = doc.y;
    // Item name (Hebrew)
    doc.font('Hebrew').fontSize(9).text(rtlText(line.SapItemName || ''),
      220, y + 3, { width: 230, align: 'right', ellipsis: true });
    // Item code
    doc.font('Hebrew-Bold').fontSize(8).text(line.SapItemCode || '',
      130, y + 3, { width: 80, align: 'right' });
    // Bin
    doc.font('Hebrew').fontSize(9).text(line.BinLocation || '-',
      70, y + 3, { width: 50, align: 'right' });
    // Qty
    doc.font('Hebrew-Bold').fontSize(11).text(String(line.TotalQuantity),
      460, y + 2, { width: 40, align: 'right' });
    // Checkbox
    doc.rect(515, y + 3, 10, 10).stroke();
    // Picked space
    doc.font('Hebrew').fontSize(9).text('___', 538, y + 3, { width: 25 });
    doc.y = y + 18;
    doc.strokeColor('#e5e7eb').moveTo(30, doc.y).lineTo(565, doc.y).stroke();
    doc.moveDown(0.1);
  }

  doc.moveDown(2);
  doc.font('Hebrew').fontSize(9).fillColor('#6b7280')
    .text(`${rtlText('חתימת מלקט')}: _____________________    ${rtlText('תאריך')}: ___________`,
      { align: 'left' });
  doc.end();
});

// Audit
app.get('/api/audit/:entityType/:entityId', (req, res) => {
  const { entityType, entityId } = req.params;
  if (entityType === 'user') {
    return res.json({ trail: store.getAuditLog({ targetUserId: entityId, limit: 200 }) });
  }
  res.json({ trail: [] });
});
// Admin-only: full audit log scan, optionally filtered by action prefix.
app.get('/api/audit', adminOnly, (req, res) => {
  res.json({ trail: store.getAuditLog({ action: req.query.action, limit: Number(req.query.limit) || 200 }) });
});

// System — exposes the live public base URL so the frontend can build
// QR/install links that work outside the operator's laptop. The frontend
// uses this when window.location.host is localhost, where naively
// concatenating the host yields a link that nobody else can reach.
app.get('/api/system/public-base', (req, res) => {
  res.json({ base: buildPublicBase(req) });
});

// ----------------------------------------------------------------------------
// Customer Delivery Profiles — master data loaded from OIG + UNICO xlsx.
// Lets the planner filter customers by zone, by weekly delivery day, and
// look up the canonical zone/day for any SAP CardCode.
// (Already gated by the Wave A /api/customers block above — auth required.)
// ----------------------------------------------------------------------------
app.get('/api/customer-profiles', (req, res) => {
  const { zone, day, company, issue, q } = req.query;
  let rows = store.getCustomerProfiles({ zone, day, company, issue });
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((p) =>
      String(p.CardCode).toLowerCase().includes(needle) ||
      (p.Name || '').toLowerCase().includes(needle) ||
      (p.City || '').toLowerCase().includes(needle)
    );
  }
  res.json({ profiles: rows, count: rows.length });
});

app.get('/api/customer-profiles/stats', (_req, res) => {
  res.json(store.getCustomerProfileStats());
});

app.get('/api/customer-profiles/:cardCode', (req, res) => {
  const profile = store.getCustomerProfile(req.params.cardCode, req.query.company);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profile);
});

// Update the document policy for one customer. Body: { perOrderDeliveryNote,
// perOrderInvoice, aggregateDeliveryNote, aggregateInvoice, notes }
// Values: 'yes' | 'no' | 'na' | '' (blank = not yet decided).
app.patch('/api/customer-profiles/:cardCode/policy', (req, res) => {
  try {
    const updated = store.setCustomerProfilePolicy(req.params.cardCode, req.query.company, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Profile not found' });
    res.json({ ok: true, profile: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Demo: reset all data to initial state (for starting a fresh demo)
app.post('/api/demo/reset', async (_req, res) => {
  // Re-import module to get fresh data
  const freshModule = await import(`./demoData.js?t=${Date.now()}`);
  // Mutate the in-memory data object with fresh values
  Object.assign(data.runs, freshModule.runs);
  Object.assign(data.stops, freshModule.stops);
  Object.assign(data.runOrders, freshModule.runOrders);
  io.emit('demo:reset', {});
  res.json({ ok: true, message: 'Demo reset' });
});

// Customer search - real SAP when available
app.get('/api/customers/search', async (req, res) => {
  const q = (req.query.q || '').toString();
  if (q.length < 2) return res.json({ customers: [], count: 0 });

  if (sapLive) {
    try {
      const results = await sapBridge.searchCustomers(q, 20);
      return res.json({ customers: results, count: results.length, source: 'sap' });
    } catch (err) { console.warn('[sap] search failed:', err.message); }
  }

  // Fallback to demo data
  const results = data.runOrders.filter((o) =>
    o.SapCardName.toLowerCase().includes(q.toLowerCase()) || o.SapCardCode.toLowerCase().includes(q.toLowerCase())
  ).map((o) => ({
    CardCode: o.SapCardCode, CardName: o.SapCardName,
    CompanyCode: o.CompanyCode, Phone1: '03-5550000', City: 'תל אביב',
  }));
  res.json({ customers: results, count: results.length });
});

// Addresses
app.get('/api/addresses/:id', (req, res) => {
  const address = data.addresses.find((a) => a.AddressId === Number(req.params.id));
  if (!address) return res.status(404).json({ error: 'Not found' });
  res.json({ address, links: [{ SapCardCode: 'C001', SapAddressName: 'ship1', CompanyCode: 'A', CompanyName: 'OIG' }] });
});
app.patch('/api/addresses/:id', (_req, res) => res.json({ ok: true }));

// Short-link mobile install: serve a self-contained HTML page that:
//   1. Forcefully unregisters any stale Service Worker (PWA cache)
//   2. Writes the JWT to localStorage (matching auth.js zustand store)
//   3. Redirects to "/" → SPA boots fresh and finds the token
// Doing this at the HTTP layer means stale PWAs won't intercept it.
app.get('/m/admin/:shortId', (req, res, next) => {
  const entry = mobileShortLinks.get(req.params.shortId);
  if (!entry || isShortLinkExpired(entry)) {
    if (entry) mobileShortLinks.delete(req.params.shortId);
    return res.status(404).type('html').send(`
      <!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
      <title>קישור לא תקין</title>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1 style="color:#dc2626">⚠ הקישור פג תוקף</h1>
        <p>בקש קישור חדש מהמחשב.</p>
        <a href="/login">חזור לכניסה</a>
      </body></html>
    `);
  }
  // Wave A mitigation: single-use enforcement. The mobile-link is meant to be
  // scanned once on the operator's phone, not re-shared. After first redemption,
  // subsequent fetches return 410 Gone. Token TTL was also reduced 30d → 1h.
  if (entry.usedAt) {
    return res.status(410).type('html').send(`
      <!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
      <title>הקישור כבר נוצל</title>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1 style="color:#dc2626">⚠ הקישור כבר נוצל</h1>
        <p>בקש קישור חדש מהמחשב.</p>
      </body></html>
    `);
  }
  entry.usedAt = Date.now();
  const token = entry.token;
  // Decode JWT payload for the user object
  const parts = token.split('.');
  let user = { name: 'admin', role: 'ADMIN' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    user = { id: payload.sub, name: payload.name, role: payload.role, username: payload.username };
  } catch {}
  // Mimic the zustand persist key shape: { state: { user, token }, version: 0 }
  const persistedAuth = JSON.stringify({ state: { user, token }, version: 0 });
  res.type('html').send(`
<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SAP Logistics - מתחבר…</title>
<style>
body{font-family:'Heebo',system-ui,sans-serif;background:linear-gradient(135deg,#2563eb,#7c3aed);
  color:white;height:100vh;margin:0;display:flex;align-items:center;justify-content:center}
.card{background:white;color:#111;border-radius:24px;padding:32px;text-align:center;
  box-shadow:0 20px 50px rgba(0,0,0,.3);max-width:340px}
.spin{width:40px;height:40px;border:4px solid #dbeafe;border-top-color:#2563eb;
  border-radius:50%;animation:s 1s linear infinite;margin:16px auto}
@keyframes s{to{transform:rotate(360deg)}}
.ok{color:#16a34a;font-size:48px}
h1{margin:8px 0}
p{color:#666;margin:8px 0}
</style>
</head>
<body>
<div class="card">
  <h1>SAP Logistics</h1>
  <div id="spin" class="spin"></div>
  <p id="msg">מתחבר אוטומטית...</p>
</div>
<script>
(async function(){
  try {
    // 1) Unregister any old service worker so it can't serve stale HTML
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
    }
    // 2) Clear PWA caches
    if ('caches' in window) {
      const ks = await caches.keys();
      for (const k of ks) await caches.delete(k);
    }
    // 3) Write the auth into localStorage in the SAME shape that
    //    zustand 'persist' uses, so the SPA picks it up on first load.
    // zustand persist uses the key configured in stores/auth.js → 'logistics-auth'
    localStorage.setItem('logistics-auth', ${JSON.stringify(persistedAuth)});
    localStorage.setItem('token', ${JSON.stringify(token)});
    localStorage.setItem('user', ${JSON.stringify(JSON.stringify(user))});
    // 4) Show success and redirect with a cache-buster so the SW can't
    //    serve a stale index.html that ignores our localStorage entry.
    document.getElementById('spin').outerHTML = '<div class="ok">✓</div>';
    document.getElementById('msg').textContent = 'שלום ${user.name}! מעביר אותך…';
    setTimeout(function(){
      window.location.replace('/?_=' + Date.now());
    }, 800);
  } catch (e) {
    document.getElementById('msg').textContent = 'שגיאה: ' + e.message;
  }
})();
</script>
</body>
</html>
  `);
});

// Serve frontend
const frontendDist = path.resolve(__dirname, '../../../frontend/dist');
import('fs').then(({ existsSync }) => {
  if (existsSync(frontendDist)) {
    console.log(`[demo] Serving frontend from ${frontendDist}`);
    app.use(express.static(frontendDist, { maxAge: '1d' }));
    app.get(/^(?!\/api|\/socket\.io|\/health).*/, (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  } else {
    console.log(`[demo] Frontend build not found. Run: cd frontend && npm run build`);
  }
});

// Agents (LLM) - reuses src/routes/agents.js. Returns 503 if ANTHROPIC_API_KEY is missing.
// Content & Copy Agent — DB-free, stateless. Mounted BEFORE /api/agents so the
// more specific prefix wins before agentsRouter's middleware runs.
app.use('/api/agents', agentsRouter);

// 404 fallback for unknown API endpoints
app.use('/api', (req, res) => {
  console.log(`[demo] Unhandled: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not implemented in demo mode', path: req.path });
});

// Socket.IO
io.use((socket, next) => {
  // Accept any token in demo mode
  next();
});
io.on('connection', (socket) => {
  console.log(`[demo] Socket connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[demo] Socket disconnected: ${socket.id}`));
});

// Rich live simulation (driver movement + stop progression).
//
// A2g-DISABLE-SIM (2026-05-20): can be opted out via DISABLE_LIVE_SIMULATION=
// true in backend/.env. The sim mutates only the in-memory demoData.js
// module (driver GPS, stop status, returns) — it never writes to
// store.json — but the socket noise + fake "deliveries" confuse non-demo
// audiences once real operators are logged in. Default behaviour
// (env unset or anything other than the literal string "true") is
// unchanged: simulation runs as before.
if (process.env.DISABLE_LIVE_SIMULATION !== 'true') {
  startSimulation(io, data);
} else {
  console.log('[demo] Live simulation DISABLED via DISABLE_LIVE_SIMULATION env');
}

// DEV.18: start the auto-DISARM watcher. If SAP_WRITE_ENABLED is left on
// for >5 minutes (e.g. an arm cycle never reached its finally{} disarm),
// the watcher clears it from process.env. Belt-and-suspenders alongside
// the explicit DISARM in restart-safe-driven runbooks.
(async () => {
  try {
    const { startAutoDisarmWatcher } = await import('./sapWriteAutoDisarm.js');
    startAutoDisarmWatcher({ maxMinutes: 5, intervalMs: 60_000 });
    console.log('[sap-write-auto-disarm] watcher started (max 5 min, poll 60s)');
  } catch (err) {
    console.warn('[sap-write-auto-disarm] failed to start:', err.message);
  }
})();

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🎬 SAP Logistics Hub - DEMO SERVER                         ║
║                                                              ║
║  📍 כתובת:  http://localhost:${PORT}                              ║
║                                                              ║
║  👤 התחברות:                                                 ║
║     מנהל:   admin / (כל סיסמה)                              ║
║     נהג:    DRV-01 / (כל סיסמה) - לממשק מובייל              ║
║                                                              ║
║  ℹ️   זהו שרת הדגמה - נתוני דמה בלבד                          ║
║     אין חיבור ל-DB או ל-SAP אמיתי                            ║
╚════════════════════════════════════════════════════════════╝
`);
});
