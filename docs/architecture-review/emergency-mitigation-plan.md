# Emergency Mitigation — Wave A Deployment Plan

**Trigger:** confirmed `PUBLIC_INTERNET_EXPOSED` per `external-reachability-report.md`. Real customer/driver PII and account-CRUD are open to the internet right now via `https://contribute-maker-archives-metres.trycloudflare.com`.

**Goal:** the smallest reversible patch that closes the highest-impact anonymous attack surface, without breaking the live customer-facing tracking flow.

**Scope rule:** still under `freeze-policy.md` — every change is reversible, has rollback notes, and is logged in `INCIDENTS.md`.

**This document is preparation only.** No code is changed by this document. The plan is for a future operator-approved change.

---

## 1. Wave A scope (final)

5 routes/route-families chosen because they're the highest impact-per-line in `exposure-reduction-options.md`:

| # | Route family | Source line(s) in `demoServer.js` | Risk family | Approach |
|---|---|---|---|---|
| W-A1 | `/api/users/*` | 1135-1182 | Account takeover (F34) | Per-endpoint `adminOnly` on POST/PATCH/DELETE/reset-password and on `GET /api/users` (list-all). Leave `/me/*` paths unchanged. |
| W-A2 | `/api/customers/*` | 327-405, 1041-1066, 3255-3275 | PII exfil (F4 family) | Prefix `app.use('/api/customers', requireAuthBasic)` |
| W-A3 | `/api/drivers/*` | 1100-1131 | PII exfil (F7) | Prefix `app.use('/api/drivers', requireAuthBasic)` + per-mutation `adminOnly` |
| W-A4 | `/api/sap/write/*` | 412-457 | Latent SAP write (F32/F33) | Prefix `app.use('/api/sap/write', adminOnly)` (belt-and-suspenders; env still UNSET) |
| W-A5 | `GET /m/admin/:shortId` + `POST /api/auth/mobile-link` | 168-243, 3289-3372 | Credential vending (F31) | Reduce token TTL `30d → 1h`; mark shortId single-use after redemption |

**Out of Wave A** (scheduled for Wave B/C — see `exposure-reduction-options.md` §7.3):
- `/api/runs/*` mutations
- `/api/picking/*` mutations
- `/api/cod/*`, `/api/analytics/*`, `/api/pickers/*`
- `/api/orders/*`, `/api/zones/*`, `/api/audit/*`, `/api/tracking/*`

Wave A is **~30 lines** of code change. Wave B+C combined is ~30 more if approved.

---

## 2. Patch design — `requireAuthBasic` and `adminOnly` middlewares

### 2.1 Middleware definitions
Inserted after the existing `app.use((req,res,next)=>{...})` request logger at `demoServer.js:88`, before any route definitions:

```js
// =====================================================================
// EMERGENCY MITIGATION (Wave A) — added 2026-05-XX per emergency-mitigation-plan.md
// Inert pending PM2 stabilization + restart per pm2-maintenance-runbook.md.
// Rollback: revert this commit; pm2 restart sap-logistics
// =====================================================================
function requireAuthBasic(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

**Why two functions, not one:**
- `requireAuthBasic` accepts any valid token (PLANNER, DRIVER, WAREHOUSE, ADMIN). Closes the anonymous-from-internet exposure while preserving existing UI flows that use any role.
- `adminOnly` is a strict subset, used only where the existing `routes/*.js` would also have `requireRole('ADMIN')`.

**JWT_SECRET reference:** `demoServer.js:46` already imports/reads `JWT_SECRET = process.env.JWT_SECRET`. The same secret signs all current tokens. New middleware verifies against it, so existing tokens (admin-issued via `/api/auth/login`, drivers via `/api/auth/driver-login`, etc.) remain valid.

### 2.2 W-A1 — `/api/users/*` patch

Five existing handlers at `demoServer.js:1135, 1137, 1146, 1156, 1166`. Add `adminOnly` per-handler:

```js
app.get('/api/users', adminOnly, (_req, res) => res.json({ users: store.getUsers() }));
app.post('/api/users', adminOnly, async (req, res) => { /* unchanged body */ });
app.patch('/api/users/:id', adminOnly, async (req, res) => { /* unchanged body */ });
app.post('/api/users/:id/reset-password', adminOnly, async (req, res) => { /* unchanged body */ });
app.delete('/api/users/:id', adminOnly, (req, res) => { /* unchanged body */ });
```

**`/me/*` paths preserved (NOT gated by adminOnly):**
- `/api/users/me/change-password` (line 263) — already has manual JWT verify; unchanged.
- `/api/users/me/subscriptions` GET/PUT (lines 1184, 1188) — currently no auth; ADD `requireAuthBasic` on these to match server.js semantics, but NOT `adminOnly` (these are user-self routes).

**Why per-endpoint instead of `app.use('/api/users', adminOnly)`:**
- Prefix-mounting `adminOnly` on `/api/users` would intercept `/me/change-password` → non-ADMIN users couldn't change their own password. Functionally regressing F14 mitigation.
- Per-endpoint is 5 lines; the `app.use` approach plus carve-outs is also 5 lines but harder to reason about.

**Frontend impact:**
- `pages/UsersPage.jsx` (frontend admin UI) sends Bearer token with ADMIN role → continues to work.
- `pages/SettingsPage.jsx` (or wherever change-password lives) → unaffected.
- Anonymous curl from internet → 401. **Closes F34 entirely.**

### 2.3 W-A2 — `/api/customers/*` patch

Single prefix middleware at the top of customer routes (before line 327):

```js
app.use('/api/customers', requireAuthBasic);
```

That's it. One line.

**Routes covered:** `/customers/policies`, `/customers/policies/:parentName` (PATCH/POST bulk), `/customers/hours/:parentName` (GET/PATCH), `/customers/search`, `/customers/:company/:cardCode`, `/customers/:company/:cardCode/recent-items`, `/customers/:company/:cardCode/ensure-address`. All become "any valid Bearer token required."

**Frontend impact:**
- `pages/ReturnsPage.jsx` and `components/CustomerSearchInput.jsx` (returns dialog) → already authed; continue working.
- `pages/CustomerPolicyPage.jsx` → already authed.
- Anonymous → 401.

**Note:** `requireAuthBasic` is not strict role gate — a DRIVER token would also pass. That's OK for Wave A: the goal is closing the anonymous-from-internet exposure, not perfect role separation. Role gating is a server.js cutover concern (`route-matrix.md`).

### 2.4 W-A3 — `/api/drivers/*` patch

Prefix `requireAuthBasic` plus per-mutation `adminOnly`:

```js
app.use('/api/drivers', requireAuthBasic);   // before line 1100

// Existing handlers — add adminOnly to mutations (already protected by prefix middleware):
// GET /api/drivers — line 1100 — leave at requireAuthBasic (any planner needs it)
// POST /api/drivers — line 1104 — add adminOnly
// PATCH /api/drivers/:id — line 1110 — add adminOnly
// PATCH /api/drivers/:id/zones — line 1117 — add adminOnly
// DELETE /api/drivers/:id — line 1127 — add adminOnly
```

**Frontend impact:**
- `pages/DriversPage.jsx`, `pages/RunsPage.jsx`, `pages/WeeklyReportPage.jsx` — all use `GET /api/drivers`. ADMIN/PLANNER tokens have it.
- DRIVER tokens (mobile drivers) calling their own driver app — driver app does NOT call `/api/drivers` (it calls `/api/driver/my-runs`). So no impact.
- Anonymous → 401. **Closes F7.**

### 2.5 W-A4 — `/api/sap/write/*` patch

```js
app.use('/api/sap/write', adminOnly);   // before line 412
```

**This is belt-and-suspenders** because `SAP_WRITE_ENABLED` is currently UNSET, so the endpoints already short-circuit to dry-run. But:
- The day someone flips that env (intentionally or by mistake), this middleware is the only thing standing between the public internet and real SAP writes.
- One line of code is cheap insurance.

**Frontend impact:**
- `pages/DocumentsPage.jsx` — Documents Hub "send to SAP" buttons send Bearer token; continue to work.
- Anonymous → 401. **Closes F32, F33.**

### 2.6 W-A5 — `/m/admin/:shortId` + `mobile-link` patch

**Two micro-changes:**

#### A. Reduce `mobile-link` token TTL from 30d → 1h
At `demoServer.js:181`, change `expiresIn: '30d'` to `expiresIn: '1h'`.

```js
// before:
{ expiresIn: '30d' }
// after:
{ expiresIn: '1h' }
```

#### B. Single-use enforcement on the consumer route

At `demoServer.js:3289` (the `/m/admin/:shortId` handler), check `entry.usedAt` before serving:

```js
app.get('/m/admin/:shortId', (req, res, next) => {
  const entry = mobileShortLinks.get(req.params.shortId);
  if (!entry) {
    return res.status(404).type('html').send(`...existing 404 HTML...`);
  }
  // NEW: single-use enforcement
  if (entry.usedAt) {
    return res.status(410).type('html').send(`
      <!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
      <title>הקישור כבר נוצל</title>
      <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h1 style="color:#dc2626">⚠ הקישור כבר נוצל</h1>
        <p>בקש קישור חדש מהמחשב.</p>
      </body></html>`);
  }
  entry.usedAt = Date.now();   // mark consumed
  // ...rest of existing handler unchanged...
});
```

**Frontend impact:**
- `components/MobileLinkDialog.jsx` (admin desktop) calls `POST /api/auth/mobile-link` → still works; the response includes a 1h-valid token instead of 30d.
- `pages/MobileShortLinkPage.jsx` (admin's phone) consumes the shortId on first scan → still works.
- A leaked shortId is now useless after first redemption, AND the JWT inside expires in 1 hour anyway.
- **Closes F31.**

---

## 3. Deployment order (sequential, not parallel)

Each step has a hard prerequisite on the previous. Skipping a prerequisite risks regression.

### Step 0 — Prerequisites (must be complete before any code change)
- [ ] **PM2 maintenance window completed** per `pm2-maintenance-runbook.md`. Daemon responsive (`pm2 list <10s`). sap-bi-api drained.
- [ ] **Backups verified** per `backup-inventory.md`: dump.pm2 PRE-CLEANUP-* exists, store.json snapshot exists, Logistics SQL backed up.
- [ ] **Operator + backup operator on call.**
- [ ] **`SAP_WRITE_ENABLED` confirmed UNSET** (`grep -c "^SAP_WRITE_ENABLED" backend/.env` returns 0).
- [ ] **Operator decision logged in `INCIDENTS.md`** confirming Wave A is approved.

### Step 1 — Tag baseline + branch
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"
git status     # confirm working tree clean except prior architecture-review docs
git tag pre-wave-a-mitigation
git checkout -b wave-a-mitigation
```

### Step 2 — Apply Wave A patch
- Edit `backend/src/demo/demoServer.js` per §2.
- ~30 lines net change across the 5 mitigation areas.
- Save.

### Step 3 — Local syntax check
```powershell
cd backend
node --check src/demo/demoServer.js
# Expect: nothing (success). Any syntax error → fix and re-check.
```

### Step 4 — Local function smoke test (same host, before pm2 restart)
Start a SECOND demoServer instance on a free port (e.g. PORT=4101) to validate the patch without touching production.

```powershell
cd backend
$env:DEMO_PORT='4101'
node src/demo/demoServer.js
# Watch for "🎬 SAP Logistics Hub - DEMO SERVER" banner on port 4101
# In a separate shell:
curl -s -o NUL -w "%{http_code}`n" http://localhost:4101/health
# Expect: 200

# Anonymous probes — should all be 401 except /health
curl -s -o NUL -w "%{http_code}`n" http://localhost:4101/api/customers/search?q=test
# Expect: 401
curl -s -o NUL -w "%{http_code}`n" http://localhost:4101/api/drivers
# Expect: 401
curl -s -o NUL -w "%{http_code}`n" http://localhost:4101/api/users
# Expect: 401

# Stop the test server
# Ctrl+C in the first shell
$env:DEMO_PORT=$null
```

If any probe returns 200, **stop the deployment** and fix the patch.

### Step 5 — Commit + push (no PM2 restart yet)
```powershell
git add backend/src/demo/demoServer.js
git commit -m "Wave A emergency mitigation: gate /api/users, /api/customers, /api/drivers, /api/sap/write, /m/admin

Closes F31, F32/F33, F34, F4, F7 from security-reaudit.md while demoServer is still
the running production process. Inert until pm2 restart sap-logistics.

Rollback: git revert <this-sha>; pm2 restart sap-logistics

Refs: external-reachability-report.md (PUBLIC_INTERNET_EXPOSED 2026-05-10)
Refs: emergency-mitigation-plan.md
Refs: INCIDENTS.md entry 2026-05-XX"
git push origin wave-a-mitigation
```

> The patch is now in git but **not yet active in production** — sap-logistics still runs the pre-Wave-A demoServer.js code from disk. Without restart, no effect.

### Step 6 — Operator gate (manual approval)
Operator + backup operator review the diff one more time. **No restart yet.**

### Step 7 — PM2 restart (the moment of activation)
```powershell
# Pre-flight: confirm no orphan on port 4000 (sap-bi-api lesson)
$orphan = (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
$j = pm2 jlist | ConvertFrom-Json
$logistics = $j | Where-Object { $_.name -eq 'sap-logistics' }
if ($orphan -ne $logistics.pid) {
  Write-Host "ABORT: port 4000 owned by pid $orphan but pm2 thinks $($logistics.pid)"
  # Stop and consult pm2-maintenance-runbook.md D.1
  exit 1
}

# Snapshot the dump in case rollback is needed
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-WAVE-A-$ts" -Force

# Restart sap-logistics — picks up the new code from disk
pm2 restart sap-logistics
# Wait for the restart to complete; pm2 returns when child is online
Start-Sleep -Seconds 5

# Persist new state
pm2 save
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-WAVE-A-$ts" -Force
```

**Expected downtime:** ~10-15 seconds (the time PM2 takes to stop and restart the Node process). During those seconds, `/health` returns connection-refused.

### Step 8 — Verification (immediate)
Run the full probe matrix from `post-mitigation-verification.md`. ALL anonymous probes against the 5 Wave A route families must return 401 (or 403 for adminOnly with non-ADMIN token).

If any anonymous probe returns 200 on a Wave A route, **immediate rollback per Step 9.**

### Step 9 — Rollback procedure (if Step 8 fails)
```powershell
# Quick rollback: previous PM2 dump has pre-Wave-A state
git revert HEAD
git push
pm2 restart sap-logistics
# Verify
curl -s http://localhost:4000/health
```

If `pm2 restart` hangs (orphan on port 4000):
- Follow `pm2-maintenance-runbook.md` Section D (Stop-Process the orphan, then retry).

State preserved during rollback:
- `backend/data/store.json` is untouched by the patch.
- Logistics SQL is untouched.
- JWT_SECRET unchanged → existing user/driver tokens still valid.

### Step 10 — Post-deploy
- Update `cowork/INCIDENTS.md` with "Wave A deployed YYYY-MM-DD HH:mm; verification passed; rollback not needed."
- Schedule Wave B/C decision for next week.
- Continue Phase 0 backup automation + monitoring setup per `backup-automation-plan.md` and `monitoring-setup.md`.

---

## 4. Restart dependencies

| Action | Requires PM2 restart? |
|---|---|
| W-A1 (/api/users gates) | YES — handler attribute changed |
| W-A2 (/api/customers prefix) | YES |
| W-A3 (/api/drivers prefix + per-mutation) | YES |
| W-A4 (/api/sap/write prefix) | YES |
| W-A5 (TTL change + single-use) | YES |
| Adding middleware definitions | YES |

**One restart covers all five.** Don't restart per-mitigation; bundle as a single PR + single restart.

**No env changes** required. **No migration** required. **No new dependencies** required.

---

## 5. Validation steps (referenced by Step 8 above)

See `post-mitigation-verification.md` for the full matrix. Summary here:

| Probe | Pre-deploy expected | Post-deploy expected |
|---|---|---|
| Public URL `/health` | 200 | **200 (unchanged)** |
| Public URL `/api/customers/search?q=test` (no auth) | 200 with PII | **401** |
| Public URL `/api/drivers` (no auth) | 200 with PII | **401** |
| Public URL `/api/users` (no auth) | 200 with users list | **401** |
| Public URL `POST /api/users` (no auth) | 200 → user created (CRITICAL) | **401** |
| Public URL `/m/admin/<random>` (no auth) | 404 (key not in map) | 404 (unchanged for invalid keys) |
| Public URL `/api/sap/write/delivery-note/1` (no auth) | 503 (env-gated) | **401** (gated before env check) |
| Authed `/api/customers/search?q=test` (ADMIN token) | 200 | **200 (unchanged)** |
| Authed `/api/users` (ADMIN token) | 200 | **200 (unchanged)** |
| Authed `/api/users` (DRIVER token) | 200 | **403 (newly enforced — adminOnly)** |
| `pages/UsersPage.jsx` in browser (ADMIN session) | works | **works (unchanged)** |
| `pages/MobileShortLinkPage.jsx` first scan | logs in | **logs in (1h token instead of 30d)** |
| `pages/MobileShortLinkPage.jsx` second scan of same shortId | logs in (broken) | **410 Gone** |

---

## 6. Estimated downtime

| Phase | Duration | Customer-visible impact |
|---|---|---|
| Step 0 (prerequisites) | n/a — already scheduled | none |
| Steps 1-6 (preparation) | 1-2 hours | none |
| Step 7 (PM2 restart) | **10-15 seconds** | brief 502 from cf-tunnel during the restart |
| Step 8 (verification) | 5-10 minutes | none |
| Step 9 (rollback if needed) | 10-15 seconds + ~5 minute investigation | repeats Step 7 in reverse |

**Total customer-visible downtime: ~15 seconds** in the success case. ~30 seconds if rollback fires.

---

## 7. Blast radius analysis

### 7.1 What MIGHT break (graded by likelihood)

**LIKELY:**
- Any backend integration (cron job from another machine, external system) that calls `/api/customers`, `/api/drivers`, `/api/users` without a Bearer token. **Mitigation:** survey beforehand. Operator confirms with team.

**POSSIBLE:**
- `pages/MobileShortLinkPage.jsx` users who scan the link more than 30 minutes after creation: previously they had 30 days; now 1 hour. **Mitigation:** the link is meant to be scanned within seconds of creation; document the policy.

**UNLIKELY but worth mentioning:**
- A frontend page that hits `/api/users/me/subscriptions` without a Bearer token. (Frontend always sends Bearer when authed; this would only break for unauthed sessions, which shouldn't be hitting that endpoint anyway.)
- A cron from `tunnel-url-watcher` that hits sap-logistics without auth. (Per `pm2-stabilization.md`, that cron updates Vercel env, not sap-logistics.)

**WILL NOT BREAK:**
- Admin login + admin UI — sends Bearer, role=ADMIN.
- Driver mobile app — uses `/api/driver/*` family, which is NOT in Wave A.
- Picker handheld — `/api/picking/*` not in Wave A.
- Customer SMS tracking — uses `/api/public/track/:token`, not in Wave A.
- DocumentsPage — sends Bearer.
- Wallboard, Dashboard, Planner — all send Bearer.

### 7.2 What CANNOT break in production
- Logistics SQL — not touched.
- store.json — not touched.
- SAP Service Layer — env still UNSET, no writes.
- Anthropic — not touched.
- Cloudflare tunnel — not stopped (just less data flows through it).

### 7.3 What IS already broken before deploy and stays broken
- Routes outside Wave A (Wave B/C) remain anonymous-from-internet until Wave B+C deploy.
- F11/F12 (TLS posture) unchanged.
- F13 (JWT_STRICT_VERIFY) unchanged.
- F15 (public tracking surface) unchanged.

These are explicitly out of Wave A scope — operator decides whether to do Wave B/C in a follow-up window.

---

## 8. Verification matrix (cross-ref `post-mitigation-verification.md`)

The full matrix lives in the companion document. Here's the gate check the operator runs at Step 8:

```text
[ ] /health public — 200 (sanity)
[ ] /api/customers/search public — 401 (W-A2)
[ ] /api/drivers public — 401 (W-A3)
[ ] /api/users public — 401 (W-A1)
[ ] /api/sap/write/delivery-note/1 public — 401 (W-A4)
[ ] /m/admin/<random> public — 404
[ ] /api/customers/search authed (ADMIN) — 200
[ ] /api/drivers authed (ADMIN) — 200
[ ] /api/users authed (ADMIN) — 200
[ ] /api/users authed (DRIVER) — 403
[ ] /api/runs/auto-plan public — 200 (NOT in Wave A, expected unchanged)
[ ] frontend UsersPage with ADMIN session — loads + lists users
[ ] frontend MobileLinkDialog — generates link, link works on first scan, 410 on second scan
[ ] driver app login + my-runs — works (not in Wave A)
[ ] customer SMS tracking link — opens TrackingPage, displays data (not in Wave A)
```

If any check fails, see `post-mitigation-verification.md` §"Rollback trigger criteria" and execute Step 9.

---

## 9. Operator checklist (cross-ref `operator-execution-checklist.md`)

Top-level only here; full checklist in companion doc:

```text
PRE-DEPLOY
[ ] PM2 maintenance complete
[ ] Backups verified (dump.pm2, store.json, SQL)
[ ] SAP_WRITE_ENABLED confirmed unset
[ ] Operator + backup on call
[ ] INCIDENTS.md entry drafted

DEPLOY
[ ] git tag pre-wave-a-mitigation
[ ] branch + apply patch
[ ] node --check passes
[ ] local PORT=4101 smoke test passes
[ ] commit + push
[ ] PM2 dump snapshotted as PRE-WAVE-A
[ ] pm2 restart sap-logistics returned (no orphan)
[ ] /health returns 200 within 10s of restart

VERIFY
[ ] Probe matrix all green
[ ] Frontend smoke test all green

POST-DEPLOY
[ ] PM2 dump snapshotted as POST-WAVE-A
[ ] INCIDENTS.md updated
[ ] pm2 save executed
[ ] Wave B/C decision scheduled
```

---

## 10. What this plan deliberately does NOT do

| Action | Why deferred |
|---|---|
| Stop the cloudflare-tunnel app | Customer SMS tracking depends on it (see `tunnel-dependency-analysis.md`) |
| Migrate to Cloudflare named-tunnel | Multi-hour change; out of emergency scope |
| Apply Wave B (runs/picking/cod) | More routes = more frontend surface to validate. Sequential safer. |
| Apply Wave C (analytics/reports) | Same. |
| Edit server.js or any routes/*.js | Inert in production today. Wait for cutover. |
| Apply F2 ownership check to demoServer's driver routes | demoServer's `/api/driver/*` is anonymous; the F2 fix is in routes/driver.js (server.js path). Will land at cutover, not now. |
| Rotate JWT_SECRET | Forces every active session to re-login. Operationally disruptive. Not in scope unless an active token compromise is observed. |
| Apply migrations 013-019 | Not Phase 0. Migration work starts after stabilization. |

---

## 11. Document references

- `external-reachability-report.md` — the trigger for this plan
- `exposure-reduction-options.md` §1, §2, §3, §4, §6 — per-route impact analysis
- `pm2-maintenance-runbook.md` — required first step
- `pm2-stabilization.md` — root cause of the orphan-on-port-4000 risk
- `freeze-policy.md` §3, §4 — band-aid policy and exception clause
- `tunnel-dependency-analysis.md` — companion document on customer-tunnel dependencies
- `operator-execution-checklist.md` — full checklist
- `post-mitigation-verification.md` — full probe matrix
- `cowork/INCIDENTS.md` — operator audit trail

End of mitigation plan.
