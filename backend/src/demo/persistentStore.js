/**
 * Persistent Store - saves all editable data to a JSON file.
 * Drivers, users, zones all live here and survive restarts.
 *
 * File: backend/data/store.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
// Phase A2-2: dry-run SAP write inside flush-aggregate-docs. The sapWriter
// itself enforces dry-run when SAP_WRITE_ENABLED is not 'true', so this
// import is safe even though SAP writes are still globally disabled.
// Phase A2d (2026-05-19): writeInvoice now mirrors writeDeliveryNote for
// the Invoice side of flushAggregateDocsForRun. Same dry-run-default and
// whitelist gating apply — see sapWriter.js header.
import { writeDeliveryNote, writeInvoice } from './sapWriter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(__dirname, '../../data/store.json');

let cache = null;

function getDefault() {
  const adminHash = bcrypt.hashSync('admin123', 10);
  return {
    drivers: [
      { DriverId: 1, Code: 'DRV-01', FullName: 'דוד כהן', Phone: '050-1234567', Email: 'david@oig.local', VehiclePlate: '12-345-67', VehicleCapacity: 30, IsActive: true, Zones: 'NORTH,SHARON,CENTER,JERUSALEM' },
      { DriverId: 2, Code: 'DRV-02', FullName: 'משה לוי', Phone: '050-7654321', Email: 'moshe@oig.local', VehiclePlate: '89-876-54', VehicleCapacity: 30, IsActive: true, Zones: 'SHFELA,SOUTH-1,SOUTH-2' },
    ],
    nextDriverId: 3,
    users: [
      { UserId: 1, Username: 'admin', FullName: 'איציק - מנהל מערכת', Email: 'admin@oig.local', Phone: '050-0000001', Role: 'ADMIN', IsActive: true, PreferredLanguage: 'he', PasswordHash: adminHash, LastLoginAt: null, CreatedAt: new Date().toISOString() },
    ],
    nextUserId: 2,
    zones: [
      { ZoneId: 1, Code: 'NORTH',     Name: 'צפון',         Description: 'חיפה, קריות, גליל',         ColorHex: '#2563eb', SortOrder: 1, IsActive: true },
      { ZoneId: 2, Code: 'SHARON',    Name: 'שרון',         Description: 'נתניה, הרצליה, רעננה',       ColorHex: '#0891b2', SortOrder: 2, IsActive: true },
      { ZoneId: 3, Code: 'CENTER',    Name: 'מרכז',         Description: 'תל אביב, רמת גן, גבעתיים',  ColorHex: '#059669', SortOrder: 3, IsActive: true },
      { ZoneId: 4, Code: 'JERUSALEM', Name: 'ירושלים',      Description: 'ירושלים והסביבה',            ColorHex: '#ca8a04', SortOrder: 4, IsActive: true },
      { ZoneId: 5, Code: 'SHFELA',    Name: 'שפלה',         Description: 'רחובות, ראשון, רמלה, לוד',  ColorHex: '#dc2626', SortOrder: 5, IsActive: true },
      { ZoneId: 6, Code: 'SOUTH-1',   Name: 'דרום - אשדוד', Description: 'אשדוד, אשקלון, קרית גת',    ColorHex: '#9333ea', SortOrder: 6, IsActive: true },
      { ZoneId: 7, Code: 'SOUTH-2',   Name: 'דרום - ב"ש',   Description: 'באר שבע והדרום',             ColorHex: '#db2777', SortOrder: 7, IsActive: true },
    ],
    nextZoneId: 8,
  };
}

export function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      cache = JSON.parse(raw);
      // Migrate older stores that lack users/zones
      const def = getDefault();
      if (!cache.users) { cache.users = def.users; cache.nextUserId = def.nextUserId; }
      if (!cache.zones) { cache.zones = def.zones; cache.nextZoneId = def.nextZoneId; }
      console.log(`[store] Loaded ${cache.drivers?.length || 0} drivers, ${cache.users?.length || 0} users, ${cache.zones?.length || 0} zones`);
    } else {
      cache = getDefault();
      save();
      console.log(`[store] Created default store at ${STORE_PATH}`);
    }
  } catch (err) {
    console.error('[store] Load failed:', err.message);
    cache = getDefault();
  }
  return cache;
}

export function save() {
  if (!cache) return;
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] Save failed:', err.message);
  }
}

// ============================================================================
// Drivers
// ============================================================================
export function getDrivers() {
  return load().drivers;
}

export function addDriver(data) {
  const store = load();
  // Default capacities per vehicle type. TRUCK = full delivery truck (e.g. Sprinter),
  // COMMERCIAL = light commercial / van. Capacity is in litres + kilos.
  const vehicleType = data.vehicleType || 'TRUCK';
  const defaults = vehicleType === 'COMMERCIAL'
    ? { capacityL: 4000, capacityKg: 800 }
    : { capacityL: 12000, capacityKg: 3500 };
  const newDriver = {
    DriverId: store.nextDriverId++,
    Code: data.code || `DRV-${String(store.nextDriverId).padStart(2, '0')}`,
    FullName: data.fullName || '',
    Phone: data.phone || '',
    Email: data.email || '',
    VehiclePlate: data.vehiclePlate || '',
    VehicleType: vehicleType,                                  // TRUCK | COMMERCIAL
    VehicleCapacityL: Number(data.vehicleCapacityL ?? defaults.capacityL),
    VehicleCapacityKg: Number(data.vehicleCapacityKg ?? defaults.capacityKg),
    // Loading workflow:
    //   COMMERCIAL → 'BY_ITEM' (aggregate items, each customer takes their share)
    //   TRUCK      → 'BY_CUSTOMER' (each customer's items boxed together, LIFO)
    LoadingMode: data.loadingMode || (vehicleType === 'COMMERCIAL' ? 'BY_ITEM' : 'BY_CUSTOMER'),
    VehicleCapacity: data.vehicleCapacity || 30,                // legacy field kept for compat
    IsActive: data.isActive !== false,
    Zones: data.zones || '',
  };
  store.drivers.push(newDriver);
  save();
  return newDriver;
}

export function updateDriver(id, updates) {
  const store = load();
  const driver = store.drivers.find((d) => d.DriverId === Number(id));
  if (!driver) return null;
  const map = { code: 'Code', fullName: 'FullName', phone: 'Phone', email: 'Email',
    vehiclePlate: 'VehiclePlate', vehicleCapacity: 'VehicleCapacity',
    vehicleType: 'VehicleType', vehicleCapacityL: 'VehicleCapacityL',
    vehicleCapacityKg: 'VehicleCapacityKg', loadingMode: 'LoadingMode',
    isActive: 'IsActive', zones: 'Zones' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) driver[to] = updates[from];
  }
  save();
  return driver;
}

export function deleteDriver(id) {
  const store = load();
  const idx = store.drivers.findIndex((d) => d.DriverId === Number(id));
  if (idx < 0) return false;
  store.drivers.splice(idx, 1);
  save();
  return true;
}

// ============================================================================
// Pickers (warehouse handheld terminal users)
// ============================================================================
export function getPickers() {
  const s = load();
  if (!s.pickers) {
    s.pickers = [];
    s.nextPickerId = 1;
    save();
  }
  return s.pickers;
}

export function addPicker(data) {
  const store = load();
  if (!store.pickers) { store.pickers = []; store.nextPickerId = 1; }
  const newPicker = {
    PickerId: store.nextPickerId++,
    Code: data.code || `PICK-${String(store.nextPickerId).padStart(2, '0')}`,
    FullName: data.fullName || '',
    Phone: data.phone || '',
    IsActive: data.isActive !== false,
    CreatedAt: new Date().toISOString(),
  };
  store.pickers.push(newPicker);
  save();
  return newPicker;
}

export function updatePicker(id, updates) {
  const store = load();
  const picker = store.pickers?.find((p) => p.PickerId === Number(id));
  if (!picker) return null;
  const map = { code: 'Code', fullName: 'FullName', phone: 'Phone', isActive: 'IsActive' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) picker[to] = updates[from];
  }
  save();
  return picker;
}

export function deletePicker(id) {
  const store = load();
  if (!store.pickers) return false;
  const idx = store.pickers.findIndex((p) => p.PickerId === Number(id));
  if (idx < 0) return false;
  store.pickers.splice(idx, 1);
  save();
  return true;
}

export function getPickerByCode(code) {
  const list = getPickers();
  return list.find((p) => p.Code === code);
}

export function getPickerById(id) {
  return load().pickers?.find((p) => p.PickerId === Number(id));
}

// Set or rotate a picker's login PIN. Hashed with bcrypt; the picker can
// always reset it from an admin / Picker management screen. We keep it
// optional so existing pickers that pre-date this field can still log in
// (the login handler treats them as "pin not yet set" and asks the picker
// to set one on next login).
export function setPickerPin(pickerId, pin) {
  const store = load();
  const picker = store.pickers?.find((p) => p.PickerId === Number(pickerId));
  if (!picker) return false;
  const pinStr = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(pinStr)) {
    const err = new Error('PIN חייב להיות 4-8 ספרות');
    err.code = 'BAD_PIN_FORMAT';
    throw err;
  }
  picker.PinHash = bcrypt.hashSync(pinStr, 10);
  picker.PinSetAt = new Date().toISOString();
  save();
  return true;
}

// Returns true if the picker has a stored PIN and the provided value
// matches. Returns null when no PIN is set yet (so the login handler can
// decide whether to allow grace-period login).
export function verifyPickerPin(picker, pin) {
  if (!picker?.PinHash) return null;
  return bcrypt.compareSync(String(pin || ''), picker.PinHash);
}

// Admin-only: clear a picker's PIN so they can log in code-only on next
// attempt and be forced to set a fresh PIN. Use when a picker forgets
// their PIN and someone at the office needs to unlock them.
export function clearPickerPin(pickerId) {
  const store = load();
  const picker = store.pickers?.find((p) => p.PickerId === Number(pickerId));
  if (!picker) return false;
  delete picker.PinHash;
  delete picker.PinSetAt;
  save();
  return true;
}

export function clearDriverPin(driverId) {
  const store = load();
  const driver = store.drivers?.find((d) => d.DriverId === Number(driverId));
  if (!driver) return false;
  delete driver.PinHash;
  delete driver.PinSetAt;
  save();
  return true;
}

// ============================================================================
// Token revocation — instead of tracking individual JTI per JWT, we track a
// per-subject "logged-out-at" timestamp. Any token whose `iat` is older than
// that timestamp is rejected. Effect: one /api/auth/logout call invalidates
// every outstanding token for that subject, no list bookkeeping needed.
//
// "subject" follows the JWT sub claim: integer UserId for ADMIN/users,
// `picker-N` for pickers, `driver-N` for drivers.
// ============================================================================
// Store cutoff at now+1 so a token issued in the SAME second as the logout
// call is still revoked (JWT iat resolution is 1 second). The login handler
// below explicitly lowers the cutoff back to (new iat - 1) after minting a
// fresh token so the legitimate new token survives — but only that one.
export function logoutSub(sub) {
  const s = load();
  if (!s.tokenRevocations) s.tokenRevocations = {};
  s.tokenRevocations[String(sub)] = Math.floor(Date.now() / 1000) + 1;
  save();
  return true;
}

export function isSubRevoked(sub, tokenIat) {
  if (sub == null || tokenIat == null) return false;
  const s = load();
  const cutoff = s.tokenRevocations?.[String(sub)];
  if (!cutoff) return false;
  return Number(tokenIat) < Number(cutoff);
}

/**
 * Called by the login handler immediately after a fresh token is signed.
 * Lowers the per-sub revocation cutoff to (tokenIat - 1) so:
 *   - the new token itself is NOT revoked (iat > cutoff)
 *   - any token issued before the new one IS revoked (older iat < cutoff)
 * Only lowers; never raises (so a future logout that bumped the cutoff
 * forward stays in effect).
 */
export function admitFreshToken(sub, tokenIat) {
  const s = load();
  if (!s.tokenRevocations) return;
  const existing = s.tokenRevocations[String(sub)];
  if (existing == null) return;
  const target = Number(tokenIat) - 1;
  if (existing > target) {
    s.tokenRevocations[String(sub)] = target;
    save();
  }
}

// ============================================================================
// Audit log — in-memory ring buffer kept on store.json. Stores the last 1000
// events. Used by the auth + password endpoints; consumed by /api/audit.
// ============================================================================
const AUDIT_LOG_MAX = 1000;

export function recordAudit(event) {
  const s = load();
  if (!s.auditLog) s.auditLog = [];
  s.auditLog.push({
    ts: new Date().toISOString(),
    action: event.action,
    actorSub: event.actorSub ?? null,
    actorName: event.actorName ?? null,
    targetUserId: event.targetUserId ?? null,
    targetUsername: event.targetUsername ?? null,
    success: event.success !== false,
    ip: event.ip ?? null,
    details: event.details ?? null,
  });
  if (s.auditLog.length > AUDIT_LOG_MAX) {
    s.auditLog.splice(0, s.auditLog.length - AUDIT_LOG_MAX);
  }
  save();
}

export function getAuditLog({ targetUserId, action, limit = 200 } = {}) {
  const s = load();
  let rows = s.auditLog || [];
  if (targetUserId != null) rows = rows.filter((r) => r.targetUserId === Number(targetUserId));
  if (action) rows = rows.filter((r) => r.action === action);
  return rows.slice(-Number(limit)).reverse();
}

// ============================================================================
// Phase 4a migration — runs once on startup. Idempotent.
//   - Adds MustChangePassword / PasswordResetReason / ProfileCompleted to
//     every user that doesn't have them.
//   - ProfileCompleted is computed from FullName + Email + Phone presence.
//   - Sets moti's Email to moti@oig.co.il if it's empty (per operator ask).
// ============================================================================
function _isProfileComplete(user) {
  return !!(user.FullName?.trim() && user.Email?.trim() && user.Phone?.trim());
}

// ============================================================================
// Phase 4b — password reset tokens. Each entry: { Hash, UserId, ExpiresAt,
// CreatedAt, Used }. We store the bcrypt hash, never the plaintext; the
// plaintext only ever lives in the email body. TTL 30 min, single-use.
// ============================================================================
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export function recordPasswordResetToken(userId, plainToken) {
  const s = load();
  if (!s.passwordResetTokens) s.passwordResetTokens = [];
  // Invalidate any earlier tokens for the same user so a fresh request
  // supersedes them. Otherwise an attacker could keep a leaked link warm
  // by triggering /forgot-password again.
  s.passwordResetTokens = s.passwordResetTokens.filter((t) =>
    t.UserId !== Number(userId) || t.Used
  );
  s.passwordResetTokens.push({
    Hash: bcrypt.hashSync(String(plainToken), 10),
    UserId: Number(userId),
    CreatedAt: new Date().toISOString(),
    ExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    Used: false,
  });
  save();
}

export function consumePasswordResetToken(plainToken) {
  const s = load();
  if (!s.passwordResetTokens?.length) return null;
  const now = Date.now();
  // Scan active tokens — typically a handful at most.
  for (const entry of s.passwordResetTokens) {
    if (entry.Used) continue;
    if (new Date(entry.ExpiresAt).getTime() < now) continue;
    if (bcrypt.compareSync(String(plainToken), entry.Hash)) {
      entry.Used = true;
      entry.UsedAt = new Date().toISOString();
      save();
      return entry.UserId;
    }
  }
  return null;
}

export function cleanupExpiredResetTokens() {
  const s = load();
  if (!s.passwordResetTokens?.length) return 0;
  const now = Date.now();
  const before = s.passwordResetTokens.length;
  s.passwordResetTokens = s.passwordResetTokens.filter((t) => {
    if (t.Used) return false;
    if (new Date(t.ExpiresAt).getTime() < now) return false;
    return true;
  });
  if (s.passwordResetTokens.length !== before) save();
  return before - s.passwordResetTokens.length;
}

export function getUserByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  return load().users.find((u) =>
    u.IsActive && u.Email && u.Email.toLowerCase() === target
  );
}

export function migrateUsersPhase4a() {
  const s = load();
  if (!s.users) return { updated: 0 };
  let updated = 0;

  for (const u of s.users) {
    let touched = false;
    if (u.MustChangePassword === undefined) {
      u.MustChangePassword = false;
      touched = true;
    }
    if (u.PasswordResetReason === undefined) {
      u.PasswordResetReason = null;
      touched = true;
    }
    // Backfill: moti gets moti@oig.co.il if no Email
    if (u.Username === 'moti' && !u.Email) {
      u.Email = 'moti@oig.co.il';
      touched = true;
    }
    const complete = _isProfileComplete(u);
    if (u.ProfileCompleted !== complete) {
      u.ProfileCompleted = complete;
      touched = true;
    }
    if (touched) updated++;
  }
  if (updated) save();
  return { updated };
}

// Same shape for drivers (the demoServer also has a passwordless code-only
// driver-login that issues a long-lived token).
export function setDriverPin(driverId, pin) {
  const store = load();
  const driver = store.drivers?.find((d) => d.DriverId === Number(driverId));
  if (!driver) return false;
  const pinStr = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(pinStr)) {
    const err = new Error('PIN חייב להיות 4-8 ספרות');
    err.code = 'BAD_PIN_FORMAT';
    throw err;
  }
  driver.PinHash = bcrypt.hashSync(pinStr, 10);
  driver.PinSetAt = new Date().toISOString();
  save();
  return true;
}

export function verifyDriverPin(driver, pin) {
  if (!driver?.PinHash) return null;
  return bcrypt.compareSync(String(pin || ''), driver.PinHash);
}

// ============================================================================
// Users
// ============================================================================
export function getUsers() {
  return load().users.map((u) => {
    const { PasswordHash, ...safe } = u;
    return safe;
  });
}

export function getUserByUsername(username) {
  return load().users.find((u) => u.Username === username);
}

export function getUserById(id) {
  return load().users.find((u) => u.UserId === Number(id));
}

// Per-zone-picker-assignment — picker source correction (2026-05-22):
// the first cut of this feature sourced the SendToPicking dropdown from
// store.users with role in {ADMIN, PLANNER, WAREHOUSE}. That surfaced
// admins/planners instead of the actual warehouse handhelds, because the
// real picker identities live in the separate `pickers` table — the same
// one PickersPage manages and that picker-login authenticates against.
//
// This pair now reads from store.pickers instead, so the dropdown shows
// the 4 real pickers (הראל / לורנזו / יקיר / נהוראי …) and the
// AssignedPickerId on the wave is a PickerId, not a UserId.
//
// Response shape on /api/pickable-users is INTENTIONALLY kept stable to
// avoid touching the frontend in this commit:
//   - userId field now carries the PickerId
//   - role is hard-coded to 'WAREHOUSE' (every picker is, by definition,
//     a warehouse role; the field is informational for the dropdown label)
// A future commit can rename userId→pickerId end-to-end if we want a
// cleaner contract, but it would require a coordinated frontend change.
export function getPickableUsers() {
  return (load().pickers || [])
    .filter((p) => p.IsActive === true)
    .map((p) => ({ userId: p.PickerId, fullName: p.FullName, role: 'WAREHOUSE' }));
}

export function isPickableUser(userId) {
  const p = (load().pickers || []).find((x) => x.PickerId === Number(userId));
  return !!(p && p.IsActive === true);
}

export async function verifyUserPassword(username, password) {
  const user = getUserByUsername(username);
  if (!user || !user.IsActive || !user.PasswordHash) return null;
  const ok = await bcrypt.compare(password, user.PasswordHash);
  return ok ? user : null;
}

export async function addUser(data) {
  const store = load();
  if (store.users.some((u) => u.Username === data.username)) {
    throw new Error(`שם המשתמש '${data.username}' כבר קיים`);
  }
  const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
  const newUser = {
    UserId: store.nextUserId++,
    Username: data.username,
    FullName: data.fullName || '',
    Email: data.email || '',
    Phone: data.phone || '',
    Role: data.role || 'VIEWER',
    IsActive: data.isActive !== false,
    PreferredLanguage: data.preferredLanguage || 'he',
    PasswordHash: passwordHash,
    LastLoginAt: null,
    CreatedAt: new Date().toISOString(),
    // Phase 4a: new users created via admin get a temp password and must
    // rotate it on first login. Profile completeness flag is computed below.
    MustChangePassword: !!data.password,
    PasswordResetReason: data.password ? 'admin_reset' : null,
    PasswordChangedAt: data.password ? new Date().toISOString() : null,
  };
  newUser.ProfileCompleted = _isProfileComplete(newUser);
  store.users.push(newUser);
  save();
  const { PasswordHash, ...safe } = newUser;
  return safe;
}

export async function updateUser(id, updates) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(id));
  if (!user) return null;

  if (updates.username && updates.username !== user.Username) {
    if (store.users.some((u) => u.Username === updates.username && u.UserId !== user.UserId)) {
      throw new Error(`שם המשתמש '${updates.username}' כבר תפוס`);
    }
    user.Username = updates.username;
  }

  const map = { fullName: 'FullName', email: 'Email', phone: 'Phone',
    role: 'Role', isActive: 'IsActive', preferredLanguage: 'PreferredLanguage' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) user[to] = updates[from];
  }
  // Recompute profile completeness after any field change.
  user.ProfileCompleted = _isProfileComplete(user);
  save();
  const { PasswordHash, ...safe } = user;
  return safe;
}

/**
 * Self-service profile update — only the three fields the user is supposed
 * to fill themselves. Role / IsActive / Username stay admin-controlled.
 */
export function updateUserProfile(id, updates) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(id));
  if (!user) return null;
  const map = { fullName: 'FullName', email: 'Email', phone: 'Phone' };
  for (const [from, to] of Object.entries(map)) {
    if (typeof updates[from] === 'string') user[to] = updates[from].trim();
  }
  user.ProfileCompleted = _isProfileComplete(user);
  save();
  const { PasswordHash, ...safe } = user;
  return safe;
}

/**
 * Set a user's password. `options.adminInitiated=true` flags the user as
 * MustChangePassword so the next login forces a rotation through the
 * force-change-password screen. Self-service rotations clear the flag.
 */
export async function setUserPassword(id, newPassword, options = {}) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(id));
  if (!user) return false;
  user.PasswordHash = await bcrypt.hash(newPassword, 10);
  user.PasswordChangedAt = new Date().toISOString();
  if (options.adminInitiated) {
    user.MustChangePassword = true;
    user.PasswordResetReason = options.reason || 'admin_reset';
  } else {
    user.MustChangePassword = false;
    user.PasswordResetReason = null;
  }
  save();
  return true;
}

/**
 * Same-password check — used by /change-password to refuse rotating to
 * the current password.
 */
export async function isCurrentPassword(id, plainPassword) {
  const user = getUserById(id);
  if (!user?.PasswordHash) return false;
  return bcrypt.compare(plainPassword, user.PasswordHash);
}

export function deleteUser(id, requesterId) {
  const store = load();
  if (Number(id) === Number(requesterId)) {
    throw new Error('לא ניתן למחוק את עצמך');
  }
  const idx = store.users.findIndex((u) => u.UserId === Number(id));
  if (idx < 0) return false;
  const user = store.users[idx];
  if (user.Role === 'ADMIN') {
    const otherActiveAdmins = store.users.filter((u) =>
      u.Role === 'ADMIN' && u.UserId !== user.UserId && u.IsActive
    ).length;
    if (otherActiveAdmins === 0) throw new Error('לא ניתן למחוק את המנהל האחרון');
  }
  store.users.splice(idx, 1);
  save();
  return true;
}

export function updateLastLogin(userId) {
  const store = load();
  const user = store.users.find((u) => u.UserId === Number(userId));
  if (user) {
    user.LastLoginAt = new Date().toISOString();
    save();
  }
}

// ============================================================================
// Zones
// ============================================================================
export function getZones() {
  return [...load().zones].sort((a, b) => a.SortOrder - b.SortOrder);
}

export function addZone(data) {
  const store = load();
  if (store.zones.some((z) => z.Code === data.code)) {
    throw new Error(`קוד אזור '${data.code}' כבר קיים`);
  }
  const newZone = {
    ZoneId: store.nextZoneId++,
    Code: data.code,
    Name: data.name || '',
    Description: data.description || '',
    ColorHex: data.colorHex || '#6b7280',
    SortOrder: data.sortOrder || store.zones.length + 1,
    IsActive: data.isActive !== false,
  };
  store.zones.push(newZone);
  save();
  return newZone;
}

export function updateZone(id, updates) {
  const store = load();
  const zone = store.zones.find((z) => z.ZoneId === Number(id));
  if (!zone) return null;
  const map = { code: 'Code', name: 'Name', description: 'Description',
    colorHex: 'ColorHex', sortOrder: 'SortOrder', isActive: 'IsActive' };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) zone[to] = updates[from];
  }
  save();
  return zone;
}

export function deleteZone(id) {
  const store = load();
  const idx = store.zones.findIndex((z) => z.ZoneId === Number(id));
  if (idx < 0) return false;
  store.zones.splice(idx, 1);
  save();
  return true;
}

// ============================================================================
// Runs + Stops + Orders - manual route editing
// ============================================================================

function ensureRunsStore() {
  const s = load();
  if (!s.runs) { s.runs = []; s.nextRunId = 1; }
  if (!s.stops) { s.stops = []; s.nextStopId = 1; }
  if (!s.runOrders) { s.runOrders = []; s.nextRunOrderId = 1; }
  return s;
}

export function getRuns() {
  return ensureRunsStore().runs;
}

export function addRun(data) {
  const s = ensureRunsStore();
  const today = new Date().toISOString().slice(0, 10);
  const runDate = data.runDate || today;
  const zone = s.zones.find((z) => z.ZoneId === Number(data.zoneId));
  const driver = s.drivers.find((d) => d.DriverId === Number(data.driverId));
  const seq = s.runs.filter((r) => r.RunDate === runDate).length + 1;

  const newRun = {
    RunId: s.nextRunId++,
    RunNumber: `RUN-${runDate}-${String(seq).padStart(2, '0')}`,
    RunDate: runDate,
    ZoneId: data.zoneId,
    ZoneCode: zone?.Code || '',
    ZoneName: zone?.Name || '',
    ZoneColor: zone?.ColorHex || '#6b7280',
    DriverId: data.driverId,
    DriverName: driver?.FullName || '',
    DriverPhone: driver?.Phone || '',
    VehiclePlate: driver?.VehiclePlate || '',
    Status: data.status || 'OPEN',
    PlannedStartTime: data.plannedStartTime || null,
    ActualStartTime: null,
    ActualEndTime: null,
    Notes: data.notes || '',
    CreatedAt: new Date().toISOString(),
    StopCount: 0,
    OrderCount: 0,
    // Default picking mode: one consolidated pick-list. Planner can flip to
    // BY_PALLET or BY_CUSTOMER from the Run details page.
    PalletMode: 'SINGLE',
  };
  s.runs.push(newRun);
  save();
  return newRun;
}

export function updateRun(id, updates) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(id));
  if (!run) return null;
  if (updates.status !== undefined) run.Status = updates.status;
  if (updates.driverId !== undefined) {
    run.DriverId = updates.driverId;
    const driver = s.drivers.find((d) => d.DriverId === Number(updates.driverId));
    if (driver) {
      run.DriverName = driver.FullName;
      run.DriverPhone = driver.Phone;
      run.VehiclePlate = driver.VehiclePlate;
    }
  }
  if (updates.notes !== undefined) run.Notes = updates.notes;
  if (updates.palletMode !== undefined) {
    const allowed = ['SINGLE', 'BY_PALLET', 'BY_CUSTOMER'];
    if (!allowed.includes(updates.palletMode)) {
      const err = new Error('PalletMode must be one of ' + allowed.join(', '));
      err.status = 400;
      throw err;
    }
    run.PalletMode = updates.palletMode;
  }
  save();
  return run;
}

export function deleteRun(id) {
  const s = ensureRunsStore();
  const runId = Number(id);
  s.runs = s.runs.filter((r) => r.RunId !== runId);
  const stopIds = s.stops.filter((st) => st.RunId === runId).map((st) => st.StopId);
  s.stops = s.stops.filter((st) => st.RunId !== runId);
  s.runOrders = s.runOrders.filter((o) => !stopIds.includes(o.StopId));
  save();
  return true;
}

/** Get run with its stops + orders nested. */
export function getRunDetails(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;
  const stops = s.stops
    .filter((st) => st.RunId === run.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0))
    .map((stop) => ({
      ...stop,
      orders: s.runOrders.filter((o) => o.StopId === stop.StopId),
      returns: [],
    }));
  return { ...run, stops };
}

// Mapping of common Israeli cities to zone codes (used for auto-assign
// when an order arrives for a customer that has no profile yet).
//
// A2h-CITY-TO-ZONE (2026-05-21): rebuilt from the actual customer→zone
// distribution after the 2026-05-20 Zone Migration. Each city → the
// dominant new zone code among the customers we already have in that
// city. Surprised by some — בני ברק/רמת גן/גבעתיים all turned out to
// be CENTER_FAR, not CENTER_NEAR. רחובות/ראשון/מודיעין moved out of
// the old SHFELA (now empty) into CENTER_NEAR. באר שבע + ערד + דימונה
// rolled up to SOUTH-1 (old SOUTH-2 is empty). The legacy codes
// CENTER / NORTH / SHFELA / SOUTH-2 / NORTHWEST are kept inactive in
// the zones table but no longer referenced here — new orders will
// get a *current* code.
const CITY_TO_ZONE = {
  // ── NORTH_NEAR (חיפה + מפרץ + חוף הכרמל + שומרון צפוני) ────────────
  'חיפה': 'NORTH_NEAR', 'נשר': 'NORTH_NEAR', 'טירת הכרמל': 'NORTH_NEAR', 'טירת כרמל': 'NORTH_NEAR',
  'קריית אתא': 'NORTH_NEAR', 'קרית אתא': 'NORTH_NEAR', 'קריית ביאליק': 'NORTH_NEAR', 'קרית ביאליק': 'NORTH_NEAR',
  'קריית מוצקין': 'NORTH_NEAR', 'קרית מוצקין': 'NORTH_NEAR', 'קריית ים': 'NORTH_NEAR', 'קרית ים': 'NORTH_NEAR',
  'נהריה': 'NORTH_NEAR', 'עכו': 'NORTH_NEAR', 'רגבה': 'NORTH_NEAR', 'קיבוץ רגבה': 'NORTH_NEAR',
  'עין המפרץ': 'NORTH_NEAR', 'מתחם עין המפרץ': 'NORTH_NEAR', 'תל חנן': 'NORTH_NEAR',
  'זכרון יעקב': 'NORTH_NEAR', 'חדרה': 'NORTH_NEAR', 'פרדס חנה': 'NORTH_NEAR',
  'פרדס חנה כרכור': 'NORTH_NEAR', 'בנימינה': 'NORTH_NEAR', 'קיסריה': 'NORTH_NEAR',
  'אור עקיבא': 'NORTH_NEAR', 'רכסים': 'NORTH_NEAR', 'חריש': 'NORTH_NEAR', 'טמרה': 'NORTH_NEAR',
  'יקנעם': 'NORTH_NEAR', 'יקנעם עילית': 'NORTH_NEAR',
  // ── NORTH_FAR (גליל, עמק יזרעאל, כינרת, גולן) ────────────────────────
  'כרמיאל': 'NORTH_FAR', 'מעלות': 'NORTH_FAR', 'מעלות תרשיחא': 'NORTH_FAR', 'תרשיחא': 'NORTH_FAR',
  'מעיליא': 'NORTH_FAR', 'חורפיש': 'NORTH_FAR', 'עפולה': 'NORTH_FAR', 'טבריה': 'NORTH_FAR',
  'צפת': 'NORTH_FAR', 'קרית שמונה': 'NORTH_FAR', 'קריית שמונה': 'NORTH_FAR',
  'נוף הגליל': 'NORTH_FAR', 'נצרת': 'NORTH_FAR', 'נצרת עילית': 'NORTH_FAR',
  'כפר כנא': 'NORTH_FAR', 'מגדל העמק': 'NORTH_FAR', 'בית שאן': 'NORTH_FAR',
  'סכנין': 'NORTH_FAR', 'חצור הגלילית': 'NORTH_FAR', 'כפר קרע': 'NORTH_FAR',
  'באקה אל גרבייה': 'NORTH_FAR', 'באקה': 'NORTH_FAR', 'אום אל פחם': 'NORTH_FAR',
  "ג'דיידה": 'NORTH_FAR', 'כאבול': 'NORTH_FAR',
  // ── SHARON (חוף השרון + שומרון מערבי + משולש) ─────────────────────────
  'נתניה': 'SHARON', 'הרצליה': 'SHARON', 'רעננה': 'SHARON', 'כפר סבא': 'SHARON',
  'הוד השרון': 'SHARON', 'רמת השרון': 'SHARON', 'ראש העין': 'SHARON',
  'אבן יהודה': 'SHARON', 'כפר יונה': 'SHARON', 'תל מונד': 'SHARON',
  'אלפי מנשה': 'SHARON', 'אלעד': 'SHARON', 'כפר קאסם': 'SHARON',
  'טירה': 'SHARON', 'טייבה': 'SHARON', 'צור יצחק': 'SHARON',
  // ── TEL_AVIV (תל אביב בלבד — variants כולן) ──────────────────────────
  'תל אביב': 'TEL_AVIV', 'תל אביב יפו': 'TEL_AVIV', 'תל אביב-יפו': 'TEL_AVIV',
  'ת"א': 'TEL_AVIV', 'יפו': 'TEL_AVIV',
  // ── CENTER_NEAR (טבעת פנימית של גוש דן + שפלה צפונית) ──────────────
  'חולון': 'CENTER_NEAR', 'בת ים': 'CENTER_NEAR',
  'ראשון לציון': 'CENTER_NEAR', 'ראשל"צ': 'CENTER_NEAR', 'ראשלצ': 'CENTER_NEAR',
  'רחובות': 'CENTER_NEAR', 'נס ציונה': 'CENTER_NEAR', 'באר יעקב': 'CENTER_NEAR',
  'רמלה': 'CENTER_NEAR', 'לוד': 'CENTER_NEAR',
  'מודיעין': 'CENTER_NEAR', 'מודיעין מכבים רעות': 'CENTER_NEAR', 'מודיעין עילית': 'CENTER_NEAR',
  'בילו': 'CENTER_NEAR', 'מזכרת בתיה': 'CENTER_NEAR', 'צומת שילת': 'CENTER_NEAR', 'שילת': 'CENTER_NEAR',
  // ── CENTER_FAR (טבעת חיצונית מזרחית של גוש דן) ───────────────────────
  'רמת גן': 'CENTER_FAR', 'גבעתיים': 'CENTER_FAR', 'בני ברק': 'CENTER_FAR',
  'פתח תקווה': 'CENTER_FAR', 'פתח תקוה': 'CENTER_FAR',
  'גני תקווה': 'CENTER_FAR', 'גני תקוה': 'CENTER_FAR',
  'קרית אונו': 'CENTER_FAR', 'קריית אונו': 'CENTER_FAR',
  'אור יהודה': 'CENTER_FAR', 'יהוד': 'CENTER_FAR', 'יהוד מונוסון': 'CENTER_FAR',
  'איירפורט סיטי': 'CENTER_FAR', 'נתב"ג': 'CENTER_FAR', 'נתבג': 'CENTER_FAR',
  'אזור': 'CENTER_FAR', 'גבעת שמואל': 'CENTER_FAR', 'סביון': 'CENTER_FAR',
  'אריאל': 'CENTER_FAR', 'שוהם': 'CENTER_FAR', 'צומת סגולה': 'CENTER_FAR', 'סגולה': 'CENTER_FAR',
  // ── JERUSALEM (ירושלים + פאתי ירושלים) ─────────────────────────────
  'ירושלים': 'JERUSALEM', 'בית שמש': 'JERUSALEM', 'מבשרת ציון': 'JERUSALEM',
  'מעלה אדומים': 'JERUSALEM', 'מישור אדומים': 'JERUSALEM', 'גבעת זאב': 'JERUSALEM',
  'ביתר עילית': 'JERUSALEM', 'אפרת': 'JERUSALEM',
  // ── SOUTH-1 (כל הדרום — שפלת יהודה, נגב מערבי, ב"ש + בקעה) ─────────
  'אשדוד': 'SOUTH-1', 'אשקלון': 'SOUTH-1',
  'קרית גת': 'SOUTH-1', 'קריית גת': 'SOUTH-1', 'כרמי גת': 'SOUTH-1', 'ביג כרמי גת': 'SOUTH-1',
  'קרית מלאכי': 'SOUTH-1', 'קריית מלאכי': 'SOUTH-1',
  'שדרות': 'SOUTH-1', 'נתיבות': 'SOUTH-1', 'אופקים': 'SOUTH-1',
  'ניר עם': 'SOUTH-1', 'קיבוץ ניר עם': 'SOUTH-1',
  'יבנה': 'SOUTH-1', 'גדרה': 'SOUTH-1', 'באר טוביה': 'SOUTH-1', 'קסטינה': 'SOUTH-1', 'ביג קסטינה': 'SOUTH-1',
  'באר שבע': 'SOUTH-1', 'ב"ש': 'SOUTH-1', 'בש': 'SOUTH-1',
  'ערד': 'SOUTH-1', 'דימונה': 'SOUTH-1',
  'מצפה רמון': 'SOUTH-1', 'ירוחם': 'SOUTH-1',
  'רהט': 'SOUTH-1', 'תל שבע': 'SOUTH-1', 'להבים': 'SOUTH-1', 'מיתר': 'SOUTH-1',
  // ── EILAT (אילת בלבד) ────────────────────────────────────────────
  'אילת': 'EILAT',
};

function findZoneByCity(city) {
  if (!city) return null;
  const s = ensureRunsStore();
  const normalized = String(city).trim();
  // 1) User overrides (set via "drag city to another zone" UI) win first
  const overrides = s.cityZoneOverrides || {};
  if (overrides[normalized]) {
    return s.zones.find((z) => z.Code === overrides[normalized]);
  }
  // 2) Hardcoded exact match
  const exactCode = CITY_TO_ZONE[normalized];
  if (exactCode) return s.zones.find((z) => z.Code === exactCode);
  // 3) Partial match (contains)
  for (const [mappedCity, zoneCode] of Object.entries(CITY_TO_ZONE)) {
    if (normalized.includes(mappedCity) || mappedCity.includes(normalized)) {
      return s.zones.find((z) => z.Code === zoneCode);
    }
  }
  return null;
}

/**
 * Return every known city + its currently assigned zone code.
 * Combines built-in CITY_TO_ZONE with user overrides.
 */
export function listCitiesWithZones() {
  const s = ensureRunsStore();
  const overrides = s.cityZoneOverrides || {};
  const all = new Map(); // city -> zoneCode
  for (const [city, code] of Object.entries(CITY_TO_ZONE)) all.set(city, code);
  for (const [city, code] of Object.entries(overrides)) all.set(city, code);
  return [...all.entries()].map(([city, code]) => {
    const zone = s.zones.find((z) => z.Code === code);
    return {
      city,
      zoneCode: code,
      zoneId: zone?.ZoneId ?? null,
      zoneName: zone?.Name ?? null,
      zoneColor: zone?.ColorHex ?? null,
      isOverride: !!overrides[city],
    };
  });
}

/**
 * Move a city from its current zone to another zone (or to none).
 */
export function setCityZone(city, zoneCode) {
  const s = ensureRunsStore();
  if (!s.cityZoneOverrides) s.cityZoneOverrides = {};
  const trimmed = String(city || '').trim();
  if (!trimmed) return false;
  if (zoneCode) {
    s.cityZoneOverrides[trimmed] = zoneCode;
  } else {
    // Reset → use hardcoded default again
    delete s.cityZoneOverrides[trimmed];
  }
  save();
  return true;
}

// ============================================================================
// Customer document policy (delivery-note vs invoice).
// Stored per "parent" customer name so all branches inherit.
// ============================================================================

/**
 * Reduce a SAP CardName to its parent / chain name, so multiple branches of
 * the same customer collapse into a single row in the policy UI.
 *
 * Examples:
 *   "אלקטרה קמעונאות בע"מ - מחסני חשמל ראשל"צ 104"
 *      → "אלקטרה קמעונאות בע"מ"
 *   "א.ל.מ סחר 2000 בע"מ-עפולה"
 *      → "א.ל.מ סחר 2000 בע"מ"
 *   "מנגל בקצב הים בע"מ"
 *      → "מנגל בקצב הים בע"מ"  (no branch suffix)
 */
export function parentNameOf(cardName) {
  if (!cardName) return '';
  let s = String(cardName).trim();
  // First try " - " separator (with spaces)
  const dashSpace = s.indexOf(' - ');
  if (dashSpace > 0) return s.slice(0, dashSpace).trim();
  // Then try "- " (dash + space, no space before)
  const dashAfter = s.indexOf('- ');
  if (dashAfter > 0) return s.slice(0, dashAfter).trim();
  // Then try " -" (space + dash, no space after)
  const dashBefore = s.indexOf(' -');
  if (dashBefore > 0) return s.slice(0, dashBefore).trim();
  // Then a hyphen that comes right after "בע\"מ" (a common chain pattern)
  const m = s.match(/^(.+?בע"מ)\s*-\s*.+$/);
  if (m) return m[1].trim();
  return s;
}

// ============================================================================
// Departure Approval - manager signs off a route before the driver leaves.
// Acts as a final gate after picking + QC + loading.
// ============================================================================

/**
 * Mark a run as approved for departure. Run moves from LOADED → READY_TO_DEPART.
 * Driver app will only show this run after this gate is passed.
 */
export function approveRunDeparture(runId, opts = {}) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return { ok: false, error: 'Run not found' };
  if (!['LOADED', 'PENDING_DEPARTURE', 'OPEN', 'PLANNED'].includes(run.Status)) {
    return { ok: false, error: `המסלול בסטטוס ${run.Status} - לא ניתן לאשר יציאה` };
  }
  // Sanity checks
  const stops = s.stops.filter((st) => st.RunId === run.RunId);
  if (stops.length === 0) {
    return { ok: false, error: 'אין עצירות במסלול' };
  }
  if (!run.DriverId) {
    return { ok: false, error: 'לא משויך נהג - אי אפשר לאשר יציאה' };
  }

  run.Status = 'READY_TO_DEPART';
  run.DepartureApprovedAt = new Date().toISOString();
  run.DepartureApprovedBy = opts.approvedBy || null;
  run.DepartureNotes = opts.notes || null;
  run.DepartureChecklist = {
    pickingComplete: opts.checklist?.pickingComplete ?? true,
    truckLoaded: opts.checklist?.truckLoaded ?? true,
    documentsPrinted: opts.checklist?.documentsPrinted ?? false,
    fuelOk: opts.checklist?.fuelOk ?? true,
    driverPresent: opts.checklist?.driverPresent ?? true,
  };
  save();
  return { ok: true, run };
}

/**
 * Cancel an already-issued departure approval (e.g. driver hasn't left yet
 * and we found a problem). Run drops back to LOADED.
 */
export function cancelDepartureApproval(runId, opts = {}) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return { ok: false, error: 'Run not found' };
  if (run.Status !== 'READY_TO_DEPART') {
    return { ok: false, error: 'אישור היציאה כבר לא רלוונטי' };
  }
  run.Status = 'LOADED';
  run.DepartureRejectedAt = new Date().toISOString();
  run.DepartureRejectedBy = opts.rejectedBy || null;
  run.DepartureRejectReason = opts.reason || null;
  save();
  return { ok: true, run };
}

// ============================================================================
// Per-line actual delivery tracking (partial delivery + damage report).
// One record per WaveLine/Allocation that records what was ACTUALLY delivered
// to the customer at the door (vs what was loaded onto the truck).
// ============================================================================

/**
 * Record what actually arrived at the customer.
 *
 * @param {number} stopId
 * @param {Array} items - [{ allocationId, deliveredQty, damagedQty, missingQty,
 *                            damageNotes, damagePhotoUrl }]
 */
export function recordLineDeliveries(stopId, items, opts = {}) {
  const s = ensureRunsStore();
  if (!s.lineDeliveries) s.lineDeliveries = [];
  if (!s.nextLineDeliveryId) s.nextLineDeliveryId = 1;
  const created = [];
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return { ok: false, error: 'Stop not found' };

  for (const it of items || []) {
    const rec = {
      LineDeliveryId: s.nextLineDeliveryId++,
      StopId: stop.StopId,
      RunId: stop.RunId,
      AllocationId: it.allocationId ? Number(it.allocationId) : null,
      WaveLineId: it.waveLineId ? Number(it.waveLineId) : null,
      ItemCode: it.itemCode || null,
      ItemName: it.itemName || null,
      OrderedQty: Number(it.orderedQty || 0),
      DeliveredQty: Number(it.deliveredQty || 0),
      DamagedQty: Number(it.damagedQty || 0),
      MissingQty: Number(it.missingQty || 0),
      DamageNotes: it.damageNotes || null,
      DamagePhotoUrl: it.damagePhotoUrl || null,
      DeliveryStatus:
        Number(it.deliveredQty || 0) >= Number(it.orderedQty || 0) ? 'FULL' :
        Number(it.deliveredQty || 0) > 0 ? 'PARTIAL' : 'NONE',
      RecordedBy: opts.recordedBy || null,
      RecordedAt: new Date().toISOString(),
    };
    s.lineDeliveries.push(rec);
    created.push(rec);
  }
  save();
  return { ok: true, created };
}

/**
 * Get all line deliveries for a stop / run.
 */
export function getLineDeliveriesForStop(stopId) {
  const s = ensureRunsStore();
  return (s.lineDeliveries || []).filter((d) => d.StopId === Number(stopId));
}

export function getLineDeliveriesForRun(runId) {
  const s = ensureRunsStore();
  return (s.lineDeliveries || []).filter((d) => d.RunId === Number(runId));
}

/**
 * Summary of damage / partial delivery for a stop - used for credit memo
 * generation. Returns {damagedItems, partialItems, totalLines}
 */
export function summariseStopDeliveryIssues(stopId) {
  const recs = getLineDeliveriesForStop(stopId);
  return {
    totalLines: recs.length,
    damagedItems: recs.filter((r) => r.DamagedQty > 0),
    partialItems: recs.filter((r) => r.DeliveryStatus === 'PARTIAL'),
    notDelivered: recs.filter((r) => r.DeliveryStatus === 'NONE'),
    needsCreditMemo: recs.some((r) => r.DamagedQty > 0 || r.MissingQty > 0),
  };
}

// ============================================================================
// Cash on Delivery (COD) - track money the driver collected on each stop.
// Stored as separate records linked to runs/stops so we can reconcile at
// end-of-day (driver hands cash to office).
// ============================================================================

export function listCodCollections(runDate) {
  const s = ensureRunsStore();
  const all = s.codCollections || [];
  if (!runDate) return all;
  // Match by linked run's date
  const runs = (s.runs || []).filter((r) => r.RunDate === runDate);
  const runIds = new Set(runs.map((r) => r.RunId));
  return all.filter((c) => runIds.has(c.RunId));
}

export function recordCodCollection(data) {
  const s = ensureRunsStore();
  if (!s.codCollections) {
    s.codCollections = [];
    s.nextCodId = 1;
  }
  const stop = (s.stops || []).find((st) => st.StopId === Number(data.stopId));
  if (!stop) throw new Error('Stop not found');
  const run = (s.runs || []).find((r) => r.RunId === stop.RunId);
  const rec = {
    CodId: s.nextCodId++,
    RunId: stop.RunId,
    StopId: stop.StopId,
    DriverId: run?.DriverId || null,
    DriverName: run?.DriverName || '',
    BranchName: stop.BranchName,
    City: stop.City,
    Amount: Number(data.amount || 0),
    Method: data.method || 'CASH',           // CASH / CHEQUE / TRANSFER
    ReceiptNumber: data.receiptNumber || null,
    Notes: data.notes || null,
    Status: 'COLLECTED',                     // COLLECTED → DEPOSITED
    CollectedAt: new Date().toISOString(),
    DepositedAt: null,
  };
  s.codCollections.push(rec);
  save();
  return rec;
}

export function markCodDeposited(codId, depositedBy) {
  const s = ensureRunsStore();
  const rec = (s.codCollections || []).find((c) => c.CodId === Number(codId));
  if (!rec) return null;
  rec.Status = 'DEPOSITED';
  rec.DepositedAt = new Date().toISOString();
  rec.DepositedBy = depositedBy;
  save();
  return rec;
}

export function summariseCodForDriver(driverId, runDate) {
  const all = listCodCollections(runDate).filter((c) => c.DriverId === Number(driverId));
  const total = all.reduce((s, c) => s + Number(c.Amount || 0), 0);
  const collected = all.filter((c) => c.Status === 'COLLECTED');
  const deposited = all.filter((c) => c.Status === 'DEPOSITED');
  return {
    driverId,
    runDate,
    total,
    pendingDeposit: collected.reduce((s, c) => s + Number(c.Amount || 0), 0),
    deposited: deposited.reduce((s, c) => s + Number(c.Amount || 0), 0),
    count: all.length,
    items: all,
  };
}

// ============================================================================
// Driver performance tracking (smart route learning).
// Records per-driver per-zone metrics so the planner can suggest the best
// driver for each route, and the dashboard can show a leaderboard.
// ============================================================================

/**
 * Record a delivery event for performance tracking.
 * Called when a stop is completed (success / failure).
 */
export function recordDriverPerformance(driverId, zoneCode, event) {
  const s = ensureRunsStore();
  if (!s.driverStats) s.driverStats = {};
  const key = `${driverId}|${zoneCode || 'NONE'}`;
  if (!s.driverStats[key]) {
    s.driverStats[key] = {
      DriverId: Number(driverId),
      ZoneCode: zoneCode,
      TotalStops: 0,
      Delivered: 0,
      Failed: 0,
      AvgMinutesPerStop: 0,   // exponential moving avg
      LastUpdated: null,
    };
  }
  const r = s.driverStats[key];
  r.TotalStops += 1;
  if (event.delivered) r.Delivered += 1;
  if (event.failed) r.Failed += 1;
  if (event.minutesAtStop != null && event.minutesAtStop >= 0) {
    // EMA with alpha=0.3 — weights recent stops more
    const a = 0.3;
    r.AvgMinutesPerStop = r.AvgMinutesPerStop > 0
      ? Math.round((1 - a) * r.AvgMinutesPerStop + a * event.minutesAtStop)
      : event.minutesAtStop;
  }
  r.LastUpdated = new Date().toISOString();
  save();
  return r;
}

/**
 * Read all stats. Used by analytics page + planner suggestions.
 */
export function getDriverPerformance() {
  const s = ensureRunsStore();
  return Object.values(s.driverStats || {});
}

/**
 * Suggest the best driver for a given zone, based on success rate and speed.
 * Returns the driver IDs sorted best-first (with score).
 */
export function suggestDriversForZone(zoneCode) {
  const stats = getDriverPerformance().filter(
    (r) => r.ZoneCode === zoneCode && r.TotalStops >= 3
  );
  const scored = stats.map((r) => {
    const successRate = r.TotalStops > 0 ? r.Delivered / r.TotalStops : 0;
    // Lower minutes-per-stop is better. Normalise: 10min=1.0, 30min=0.0
    const speedScore = r.AvgMinutesPerStop > 0
      ? Math.max(0, Math.min(1, (30 - r.AvgMinutesPerStop) / 20))
      : 0.5;
    const experience = Math.min(1, r.TotalStops / 100);
    const score = Math.round(
      (successRate * 0.5 + speedScore * 0.3 + experience * 0.2) * 100
    );
    return { ...r, SuccessRate: successRate, Score: score };
  });
  scored.sort((a, b) => b.Score - a.Score);
  return scored;
}

// ============================================================================
// Customer business hours (when each chain is open / closed for delivery)
// Stored per parent customer name. All branches inherit.
// ============================================================================

/**
 * Default windows for an unconfigured customer (08:00-17:00, no break, all days).
 */
const DEFAULT_HOURS = {
  monday:    { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  tuesday:   { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  wednesday: { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  thursday:  { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
  friday:    { open: '08:00', close: '13:00', breakStart: null, breakEnd: null, closed: false },
  saturday:  { open: null,    close: null,    breakStart: null, breakEnd: null, closed: true },
  sunday:    { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false },
};

export function getDefaultBusinessHours() {
  return JSON.parse(JSON.stringify(DEFAULT_HOURS));
}

export function listCustomerHours() {
  const s = ensureRunsStore();
  return s.customerHours || {};
}

export function setCustomerHours(parentName, hours) {
  const s = ensureRunsStore();
  if (!s.customerHours) s.customerHours = {};
  const key = parentNameOf(parentName);
  if (!key) return false;
  if (hours == null) {
    delete s.customerHours[key];
  } else {
    // Light validation
    s.customerHours[key] = hours;
  }
  save();
  return true;
}

/**
 * Resolve hours for a CardName → returns the day-by-day schedule.
 * Falls back to DEFAULT_HOURS if not configured.
 */
export function resolveHoursForCardName(cardName) {
  const s = ensureRunsStore();
  const all = s.customerHours || {};
  const parent = parentNameOf(cardName);
  return all[parent] || getDefaultBusinessHours();
}

/**
 * Given a Date and a hours object, return a description of whether the
 * customer is open at that time (used by route planning + driver UI).
 */
export function getOpenStatusAt(hours, date = new Date()) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const day = days[date.getDay()];
  const dayHours = hours[day] || {};
  if (dayHours.closed) return { open: false, reason: 'סגור היום' };
  if (!dayHours.open || !dayHours.close) return { open: true };
  const minutes = date.getHours() * 60 + date.getMinutes();
  const toMin = (s) => {
    const [h, m] = (s || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  if (minutes < toMin(dayHours.open)) return { open: false, reason: `נפתח ב-${dayHours.open}` };
  if (minutes >= toMin(dayHours.close)) return { open: false, reason: `סגור מ-${dayHours.close}` };
  if (dayHours.breakStart && dayHours.breakEnd) {
    const bs = toMin(dayHours.breakStart);
    const be = toMin(dayHours.breakEnd);
    if (minutes >= bs && minutes < be) {
      return { open: false, reason: `הפסקה ${dayHours.breakStart}-${dayHours.breakEnd}` };
    }
  }
  return { open: true };
}

const VALID_DOC_TYPES = ['DELIVERY_NOTE', 'INVOICE'];

/**
 * Default doc type for any customer not yet configured.
 * Most B2B customers in OIG/Unico get an invoice → INVOICE.
 */
export const DEFAULT_DOC_TYPE = 'INVOICE';

export function listCustomerDocPolicies() {
  const s = ensureRunsStore();
  return s.customerDocPolicies || {};
}

/**
 * Set a doc type for a parent (chain) name. Pass null to remove the override.
 */
export function setCustomerDocPolicy(parentName, docType) {
  const s = ensureRunsStore();
  if (!s.customerDocPolicies) s.customerDocPolicies = {};
  const key = parentNameOf(parentName);
  if (!key) return false;
  if (docType == null) {
    delete s.customerDocPolicies[key];
  } else {
    if (!VALID_DOC_TYPES.includes(docType)) return false;
    s.customerDocPolicies[key] = docType;
  }
  save();
  return true;
}

/**
 * Resolve a single CardName → its current doc type (with default fallback).
 */
export function resolveDocTypeForCardName(cardName) {
  const s = ensureRunsStore();
  const policies = s.customerDocPolicies || {};
  const parent = parentNameOf(cardName);
  return policies[parent] || DEFAULT_DOC_TYPE;
}

export function addStop(runId, data) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  const existing = s.stops.filter((st) => st.RunId === run.RunId);

  // Auto-detect zone based on city for informational purposes
  const autoZone = findZoneByCity(data.city);

  const newStop = {
    StopId: s.nextStopId++,
    RunId: run.RunId,
    AddressId: data.addressId || null,
    StopOrder: existing.length + 1,
    Status: 'PENDING',
    ArrivedAt: null,
    CompletedAt: null,
    SignatureUrl: null,
    PhotoUrl: null,
    Notes: data.notes || null,
    Street: data.street || '',
    BuildingNumber: data.buildingNumber || '',
    City: data.city || '',
    BranchName: data.branchName || '',
    Latitude: data.latitude || null,
    Longitude: data.longitude || null,
    DeliveryWindowStart: data.deliveryWindowStart || null,
    DeliveryWindowEnd: data.deliveryWindowEnd || null,
    DeliveryDays: data.deliveryDays || null,
    ContactPhone: data.contactPhone || null,
    ContactName: data.contactName || null,
    DeliveryNotes: data.deliveryNotes || null,
    SuggestedZoneId: autoZone?.ZoneId || null,
    SuggestedZoneName: autoZone?.Name || null,
  };
  s.stops.push(newStop);
  updateRunCounts(run.RunId);
  save();
  return newStop;
}

/**
 * Find the zone code that matches a city name. Exported for UI suggestions.
 */
export function suggestZoneForCity(city) {
  return findZoneByCity(city);
}

export function deleteStop(stopId) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return false;
  const runId = stop.RunId;
  s.stops = s.stops.filter((st) => st.StopId !== Number(stopId));
  s.runOrders = s.runOrders.filter((o) => o.StopId !== Number(stopId));
  // Resequence
  const remaining = s.stops
    .filter((st) => st.RunId === runId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  remaining.forEach((st, i) => { st.StopOrder = i + 1; });
  updateRunCounts(runId);
  save();
  return true;
}

/**
 * Smart sort stops in a run:
 *  - Group by city (same city = consecutive stops)
 *  - Within each city, sort alphabetically by street
 *  - Cities ordered by the CityOrder sequence of the zone
 */
const CITY_DRIVE_ORDER = {
  // NORTHWEST: coastal route from Hadera up to Nahariya
  NORTHWEST: ['חדרה', 'פרדס חנה', 'פרדס חנה כרכור', 'בנימינה', 'זכרון יעקב', 'קיסריה', 'עתלית', 'טירת הכרמל', 'טירת כרמל', 'חיפה', 'נשר', 'קריית אתא', 'קרית אתא', 'קריית ביאליק', 'קרית ביאליק', 'קריית מוצקין', 'קרית מוצקין', 'קריית ים', 'קרית ים', 'עכו', 'נהריה', 'מעלות', 'מעלות תרשיחא'],
  // NORTH inland route (Galilee + Lower Galilee)
  NORTH: ['כרמיאל', 'עפולה', 'נצרת', 'נוף הגליל', 'מגדל העמק', 'טבריה', 'צפת', 'קריית שמונה'],
  SHARON: ['ראש העין', 'הוד השרון', 'רמת השרון', 'הרצליה', 'רעננה', 'כפר סבא', 'כפר יונה', 'אבן יהודה', 'נתניה', 'חריש'],
  CENTER: ['בני ברק', 'גבעתיים', 'רמת גן', 'תל אביב', 'חולון', 'בת ים', 'אור יהודה', 'יהוד', 'קרית אונו', 'פתח תקווה', 'גני תקווה'],
  JERUSALEM: ['מבשרת ציון', 'ירושלים', 'גבעת זאב', 'מעלה אדומים', 'בית שמש'],
  SHFELA: ['יבנה', 'גדרה', 'רחובות', 'נס ציונה', 'ראשון לציון', 'רמלה', 'לוד', 'מודיעין'],
  'SOUTH-1': ['אשקלון', 'אשדוד', 'קרית מלאכי', 'קריית מלאכי', 'קרית גת', 'קריית גת', 'כרמי גת', 'שדרות', 'נתיבות', 'אופקים'],
  'SOUTH-2': ['רהט', 'להבים', 'באר שבע', 'דימונה', 'ערד', 'ירוחם', 'מצפה רמון', 'אילת'],
};

/**
 * Split a large run in half - creates a new run in the same zone,
 * moves the second half of stops to it. Returns the new run.
 */
export function splitRun(runId, maxStopsPerRun = 25) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  const stops = s.stops
    .filter((st) => st.RunId === run.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));

  if (stops.length <= maxStopsPerRun) return null;

  // Split in roughly equal halves
  const splitAt = Math.ceil(stops.length / 2);
  const keepStops = stops.slice(0, splitAt);
  const moveStops = stops.slice(splitAt);

  // Create new run (same zone, same date)
  const seq = s.runs.filter((r) => r.RunDate === run.RunDate).length + 1;
  const newRun = {
    RunId: s.nextRunId++,
    RunNumber: `RUN-${run.RunDate}-${String(seq).padStart(2, '0')}`,
    RunDate: run.RunDate,
    ZoneId: run.ZoneId, ZoneCode: run.ZoneCode, ZoneName: run.ZoneName, ZoneColor: run.ZoneColor,
    DriverId: null, DriverName: '', DriverPhone: '', VehiclePlate: '',
    Status: 'OPEN',
    PlannedStartTime: null, ActualStartTime: null, ActualEndTime: null,
    Notes: `פוצל אוטומטית מ-${run.RunNumber}`,
    CreatedAt: new Date().toISOString(),
    StopCount: 0, OrderCount: 0,
  };
  s.runs.push(newRun);

  // Move stops to new run
  moveStops.forEach((st, i) => {
    st.RunId = newRun.RunId;
    st.StopOrder = i + 1;
  });
  // Re-number kept stops
  keepStops.forEach((st, i) => { st.StopOrder = i + 1; });

  updateRunCounts(run.RunId);
  updateRunCounts(newRun.RunId);
  save();
  return newRun;
}

/**
 * Move a stop (and its orders) to a different run.
 */
export function moveStopToRun(stopId, targetRunId) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const target = s.runs.find((r) => r.RunId === Number(targetRunId));
  if (!target) return null;

  const oldRunId = stop.RunId;
  stop.RunId = target.RunId;

  // Put at end of target run
  const targetStops = s.stops.filter((st) => st.RunId === target.RunId);
  stop.StopOrder = targetStops.length;

  // Renumber old run
  const oldStops = s.stops
    .filter((st) => st.RunId === oldRunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  oldStops.forEach((st, i) => { st.StopOrder = i + 1; });

  updateRunCounts(oldRunId);
  updateRunCounts(target.RunId);
  save();
  return { stopId: stop.StopId, oldRunId, newRunId: target.RunId };
}

export function smartSortStops(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return false;

  const siblings = s.stops.filter((st) => st.RunId === run.RunId);
  const zoneOrder = CITY_DRIVE_ORDER[run.ZoneCode] || [];

  const getCityRank = (city) => {
    if (!city) return 999;
    const normalized = String(city).trim();
    for (let i = 0; i < zoneOrder.length; i++) {
      const mappedCity = zoneOrder[i];
      if (normalized === mappedCity || normalized.includes(mappedCity) || mappedCity.includes(normalized)) {
        return i;
      }
    }
    return 500; // Unknown cities sorted between ordered and empty
  };

  siblings.sort((a, b) => {
    const rankA = getCityRank(a.City);
    const rankB = getCityRank(b.City);
    if (rankA !== rankB) return rankA - rankB;
    // Same city - sort by street
    const streetA = (a.Street || a.BranchName || '').trim();
    const streetB = (b.Street || b.BranchName || '').trim();
    return streetA.localeCompare(streetB, 'he');
  });

  siblings.forEach((st, i) => { st.StopOrder = i + 1; });
  save();
  return true;
}

export function moveStop(stopId, direction) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return false;
  const siblings = s.stops
    .filter((st) => st.RunId === stop.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));
  const idx = siblings.findIndex((st) => st.StopId === stop.StopId);
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= siblings.length) return false;
  [siblings[idx].StopOrder, siblings[target].StopOrder] =
    [siblings[target].StopOrder, siblings[idx].StopOrder];
  save();
  return true;
}

export function updateStop(stopId, updates) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const map = {
    street: 'Street', buildingNumber: 'BuildingNumber', city: 'City',
    branchName: 'BranchName', contactName: 'ContactName',
    contactPhone: 'ContactPhone', deliveryNotes: 'DeliveryNotes',
    deliveryWindowStart: 'DeliveryWindowStart', deliveryWindowEnd: 'DeliveryWindowEnd',
    notes: 'Notes', status: 'Status',
    stopOrder: 'StopOrder',
  };
  for (const [from, to] of Object.entries(map)) {
    if (updates[from] !== undefined) stop[to] = updates[from];
  }
  if (updates.palletLabel !== undefined) {
    const v = String(updates.palletLabel || '').trim().slice(0, 8);
    stop.PalletLabel = v;
  }
  save();
  return stop;
}

export function addOrderToStop(stopId, orderData) {
  const s = ensureRunsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;
  const exists = s.runOrders.find((o) =>
    o.StopId === Number(stopId) &&
    o.CompanyCode === orderData.companyCode &&
    o.SapDocEntry === orderData.docEntry
  );
  if (exists) return exists;

  const newOrder = {
    RunOrderId: s.nextRunOrderId++,
    StopId: Number(stopId),
    CompanyId: orderData.companyCode === 'A' ? 1 : 2,
    CompanyCode: orderData.companyCode,
    CompanyName: orderData.companyCode === 'A' ? 'OIG' : 'Unico',
    SapDocEntry: orderData.docEntry,
    SapDocNum: orderData.docNum,
    SapCardCode: orderData.cardCode,
    SapCardName: orderData.cardName,
    OrderTotal: orderData.total || 0,
    LinesCount: orderData.linesCount || 0,
    Status: 'PENDING',
    SapDeliveryDocEntry: null,
  };
  s.runOrders.push(newOrder);
  updateRunCounts(stop.RunId);
  save();
  return newOrder;
}

export function deleteRunOrder(runOrderId) {
  const s = ensureRunsStore();
  const order = s.runOrders.find((o) => o.RunOrderId === Number(runOrderId));
  if (!order) return false;
  const stopId = order.StopId;
  s.runOrders = s.runOrders.filter((o) => o.RunOrderId !== Number(runOrderId));
  const stop = s.stops.find((st) => st.StopId === stopId);
  if (stop) updateRunCounts(stop.RunId);
  save();
  return true;
}

function updateRunCounts(runId) {
  const s = ensureRunsStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return;
  const stops = s.stops.filter((st) => st.RunId === run.RunId);
  run.StopCount = stops.length;
  const stopIds = stops.map((st) => st.StopId);
  run.OrderCount = s.runOrders.filter((o) => stopIds.includes(o.StopId)).length;
}

// ============================================================================
// Picking Waves
// ============================================================================

function ensureWavesStore() {
  const s = ensureRunsStore();
  if (!s.waves) { s.waves = []; s.nextWaveId = 1; }
  if (!s.waveLines) { s.waveLines = []; s.nextWaveLineId = 1; }
  if (!s.waveAllocations) { s.waveAllocations = []; s.nextWaveAllocationId = 1; }
  return s;
}

/**
 * Create a new picking wave for a run.
 * Takes pre-fetched SAP order lines and aggregates them by ItemCode.
 * lines: [{ CompanyCode, DocEntry, LineNum, ItemCode, ItemName, OpenQty, WarehouseCode, Barcode, DocNum, CardName, ... }]
 */
// Per-zone-picker-assignment (2026-05-21): third arg accepts an optional
// assignment payload. The signature stays backwards compatible — older
// 2-arg callers continue to create unassigned waves (AssignedPicker* = null,
// matching pre-feature behaviour). When `assignedPickerId` is provided, the
// new wave carries the 4 Assigned* fields so SendToPicking can record which
// picker the planner chose for this zone/run.
//
// Throws a typed error (`{ code: 'WAVE_IN_PROGRESS', activeWaveId, status }`)
// when the run already has an active wave whose Status is IN_PROGRESS or
// PENDING_QC — those represent live picker work and shouldn't be silently
// cancelled by another planner reusing the run. All other in-flight statuses
// (PENDING) are still cancelled as before.
export function createWaveFromLines(runId, orderLines, options = {}) {
  const s = ensureWavesStore();
  const run = s.runs.find((r) => r.RunId === Number(runId));
  if (!run) return null;

  // Build a docEntry+company → city/customer map so each picked line can show
  // exactly which customer/city it goes to (the picker needs this when one
  // wave covers multiple stops).
  const stopsInRun = (s.stops || []).filter((st) => st.RunId === run.RunId);
  const stopById = new Map(stopsInRun.map((st) => [st.StopId, st]));
  const docToCustomer = new Map(); // 'A:42150' -> { stopId, stopOrder, city, branchName, cardName }
  for (const ord of (s.runOrders || [])) {
    const stop = stopById.get(ord.StopId);
    if (!stop) continue;
    const key = `${ord.CompanyCode}:${ord.SapDocEntry}`;
    docToCustomer.set(key, {
      // StopId/StopOrder are needed for the BY_CUSTOMER aggregation key below —
      // see the byItem loop. Without them, the same item ordered by N customers
      // collapses into one wave line with N allocations, which contradicts the
      // "one physical box per customer" semantics of BY_CUSTOMER mode.
      stopId: stop.StopId,
      stopOrder: stop.StopOrder || 0,
      city: stop.City || '',
      branchName: stop.BranchName || ord.SapCardName || '',
      cardName: ord.SapCardName || '',
    });
  }

  // Pallet mode decides how lines aggregate inside this wave:
  //   SINGLE / BY_PALLET  → aggregate by ItemCode only. The picker walks
  //                         the warehouse ONCE per SKU and then splits the
  //                         total across customers at the end. Existing
  //                         behaviour, unchanged.
  //   BY_CUSTOMER         → aggregate by (ItemCode, StopId). The same SKU
  //                         ordered by two customers produces TWO wave
  //                         lines, one per customer, so each line is a
  //                         single physical box. Without this split, the
  //                         picker can see a line headered "Customer A" but
  //                         containing quantities meant for Customer B/C —
  //                         which is the bug this branch fixes.
  const palletMode = run.PalletMode || 'SINGLE';

  // Per-zone-picker-assignment guard: refuse to cancel a wave that is mid-
  // pick or waiting for QC. Otherwise the new wave silently destroys a live
  // picker's progress (PENDING_QC) or in-flight session (IN_PROGRESS).
  const blockingWave = s.waves.find(
    (w) => w.RunId === run.RunId && (w.Status === 'IN_PROGRESS' || w.Status === 'PENDING_QC')
  );
  if (blockingWave) {
    const err = new Error(
      `Run ${run.RunNumber} כבר משויך לגל ליקוט פעיל (${blockingWave.Status}). בטל אותו לפני יצירת חדש.`
    );
    err.code = 'WAVE_IN_PROGRESS';
    err.activeWaveId = blockingWave.WaveId;
    err.activeWaveStatus = blockingWave.Status;
    throw err;
  }

  // Cancel any existing active wave for this run (only PENDING reaches here
  // after the guard above).
  for (const w of s.waves) {
    if (w.RunId === run.RunId && w.Status !== 'CANCELLED' && w.Status !== 'COMPLETED') {
      w.Status = 'CANCELLED';
    }
  }

  // Per-zone-picker-assignment: pull picker info from options. Falsy values
  // (null/undefined) → wave is unassigned, identical to pre-feature behaviour.
  const assignedPickerId   = options.assignedPickerId   != null ? options.assignedPickerId   : null;
  const assignedPickerName = options.assignedPickerName != null ? options.assignedPickerName : null;
  const assignedBy         = options.assignedBy         != null ? options.assignedBy         : null;
  const assignedAt         = assignedPickerId != null ? new Date().toISOString() : null;

  const waveNumber = `WAVE-${run.RunNumber}-${String(s.waves.filter((w) => w.RunId === run.RunId).length + 1).padStart(2, '0')}`;
  const newWave = {
    WaveId: s.nextWaveId++,
    WaveNumber: waveNumber,
    RunId: run.RunId,
    RunNumber: run.RunNumber,
    RunDate: run.RunDate,
    Status: 'PENDING',
    PickedBy: null,
    PickedByName: null,
    AssignedPickerId: assignedPickerId,
    AssignedPickerName: assignedPickerName,
    AssignedBy: assignedBy,
    AssignedAt: assignedAt,
    StartedAt: null,
    CompletedAt: null,
    CreatedAt: new Date().toISOString(),
    TotalLines: 0,
    CompletedLines: 0,
  };
  s.waves.push(newWave);

  // Aggregate lines by ItemCode (SINGLE/BY_PALLET) or (ItemCode, StopId)
  // (BY_CUSTOMER). See the palletMode comment above the docToCustomer loop.
  const byItem = new Map();
  for (const line of orderLines) {
    const cust = docToCustomer.get(`${line.CompanyCode}:${line.DocEntry}`) || {};
    const stopId = cust.stopId != null ? cust.stopId : 'NO_STOP';
    const aggKey = palletMode === 'BY_CUSTOMER'
      ? `${line.ItemCode}|${stopId}`
      : line.ItemCode;
    if (!byItem.has(aggKey)) {
      byItem.set(aggKey, {
        ItemCode: line.ItemCode,
        ItemName: line.ItemName,
        // Phase 3: ItemGroup (OITM.ItmsGrpCod) is captured here so the
        // wave line can carry it and the sort below can group by it.
        // Picker walks one warehouse zone at a time instead of
        // bouncing between mixers / blenders / accessories.
        ItemGroup: line.ItemGroup != null ? Number(line.ItemGroup) : null,
        Barcode: line.Barcode || null,
        WarehouseCode: line.WarehouseCode,
        UomCode: line.UomCode,
        TotalQuantity: 0,
        Allocations: [],
      });
    }
    const agg = byItem.get(aggKey);
    agg.TotalQuantity += Number(line.OpenQty || line.Quantity || 0);
    agg.Allocations.push({
      CompanyCode: line.CompanyCode,
      DocEntry: line.DocEntry,
      DocNum: line.DocNum,
      LineNum: line.LineNum,
      CardName: line.CardName,
      // StopId/StopOrder used by PickingPage.jsx groupKey + sort to keep
      // BY_CUSTOMER groups stable across rerenders. They were already
      // captured here implicitly via City/BranchName, but those aren't
      // unique — see the linked bug in cowork/INCIDENTS.md.
      StopId: cust.stopId != null ? cust.stopId : null,
      StopOrder: cust.stopOrder || 0,
      // City + branch enrich the allocation so the picker sees who/where
      City: cust.city || '',
      BranchName: cust.branchName || '',
      Quantity: Number(line.OpenQty || line.Quantity || 0),
    });
  }

  // City drive order for the run's zone (e.g. NORTH = south→north sequence)
  const driveOrder = CITY_DRIVE_ORDER[run.ZoneCode] || [];
  const cityRank = (city) => {
    if (!city) return 9999;
    const norm = String(city).trim();
    const idx = driveOrder.findIndex(
      (c) => c === norm || norm.includes(c) || c.includes(norm)
    );
    return idx >= 0 ? idx : 9999;
  };

  // Sort allocations inside each item by city drive order so the picker
  // sees them in the order the truck will visit them.
  for (const agg of byItem.values()) {
    agg.Allocations.sort((a, b) => {
      const ra = cityRank(a.City);
      const rb = cityRank(b.City);
      if (ra !== rb) return ra - rb;
      return String(a.City || '').localeCompare(String(b.City || ''), 'he');
    });
  }

  // Sort wave lines. Phase 3 (2026-05-18) re-ordered priorities:
  //   1. ItemGroup ASC (NEW)        - keep mixers / blenders / accessories
  //                                   together so the picker walks one
  //                                   warehouse zone at a time. Items with
  //                                   no group code fall to the bottom.
  //   2. City drive order            - existing zone-based truck sequence
  //   3. City name (he locale)       - tiebreaker within same drive-rank
  //   4. Warehouse code              - existing
  //   5. Item code                   - stable order within a group
  //
  // The user-decided rule was "weight + volume" but OITM coverage is 0%
  // (verified by scripts/discover-item-dimensions.js, 2026-05-18). Until
  // that data is populated, ItemGroup is the proxy.
  const sorted = Array.from(byItem.values()).sort((a, b) => {
    const ga = a.ItemGroup != null ? a.ItemGroup : 999999;
    const gb = b.ItemGroup != null ? b.ItemGroup : 999999;
    if (ga !== gb) return ga - gb;
    const ca = a.Allocations[0]?.City || '';
    const cb = b.Allocations[0]?.City || '';
    const ra = cityRank(ca);
    const rb = cityRank(cb);
    if (ra !== rb) return ra - rb;
    if (ca !== cb) return ca.localeCompare(cb, 'he');
    const whA = a.WarehouseCode || 'ZZZ';
    const whB = b.WarehouseCode || 'ZZZ';
    return whA.localeCompare(whB) || a.ItemCode.localeCompare(b.ItemCode);
  });

  // Create wave lines
  for (const agg of sorted) {
    const waveLine = {
      WaveLineId: s.nextWaveLineId++,
      WaveId: newWave.WaveId,
      SapItemCode: agg.ItemCode,
      SapItemName: agg.ItemName || '',
      // Phase 3: ItemGroup is persisted on the wave line so the picker UI
      // can show a category pill and group items visually. Pre-Phase-3
      // wave lines have null here — that's intentional, no migration.
      ItemGroup: agg.ItemGroup != null ? agg.ItemGroup : null,
      Barcode: agg.Barcode,
      UomCode: agg.UomCode || '',
      BinLocation: agg.WarehouseCode || '',
      TotalQuantity: agg.TotalQuantity,
      PickedQuantity: 0,
      Status: 'PENDING',
      AllocationCount: agg.Allocations.length,
      Notes: null,
    };
    s.waveLines.push(waveLine);

    // Save allocations (link back to specific orders)
    for (const alloc of agg.Allocations) {
      s.waveAllocations.push({
        AllocationId: s.nextWaveAllocationId++,
        WaveLineId: waveLine.WaveLineId,
        CompanyCode: alloc.CompanyCode,
        SapDocEntry: alloc.DocEntry,
        SapDocNum: alloc.DocNum,
        SapOrderLineNum: alloc.LineNum,
        SapCardName: alloc.CardName,
        City: alloc.City || '',
        BranchName: alloc.BranchName || '',
        Quantity: alloc.Quantity,
      });
    }
  }

  newWave.TotalLines = sorted.length;
  save();
  return newWave;
}

export function getWave(waveId) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;

  // Build a lookup so we can backfill City + BranchName on allocations that
  // were saved before those fields were added.
  const stopsInRun = (s.stops || []).filter((st) => st.RunId === wave.RunId);
  const stopById = new Map(stopsInRun.map((st) => [st.StopId, st]));
  const docToCustomer = new Map();
  for (const ord of (s.runOrders || [])) {
    const stop = stopById.get(ord.StopId);
    if (!stop) continue;
    docToCustomer.set(`${ord.CompanyCode}:${ord.SapDocEntry}`, {
      city: stop.City || '',
      branchName: stop.BranchName || ord.SapCardName || '',
      stopId: stop.StopId,
      stopOrder: stop.StopOrder || 0,
      palletLabel: stop.PalletLabel || '',
      // Surfaced so the picking UI can call POST /api/orders/:id/qc-approve
      // and so it can mark the row as "already approved" without an extra
      // request to /api/runs/:runId.
      runOrderId: ord.RunOrderId,
      qcApproved: !!ord.QcApproved,
      deliveryNoteId: ord.DeliveryNoteId || null,
      invoiceId: ord.InvoiceId || null,
      partialFulfillment: !!ord.PartialFulfillment,
      aggregatePending: !!ord.AggregatePending,
    });
  }
  const enrich = (a) => {
    const cust = docToCustomer.get(`${a.CompanyCode}:${a.SapDocEntry}`) || {};
    return {
      ...a,
      City: a.City || cust.city || '',
      BranchName: a.BranchName || cust.branchName || a.SapCardName || '',
      // Pallet-mode picking: surface the planner's manual pallet assignment +
      // a stable stop id, so PickingPage can group rows by stop or by label.
      StopId: cust.stopId || null,
      StopOrder: cust.stopOrder || null,
      PalletLabel: cust.palletLabel || '',
      RunOrderId: cust.runOrderId || null,
      QcApproved: !!cust.qcApproved,
      DeliveryNoteId: cust.deliveryNoteId || null,
      InvoiceId: cust.invoiceId || null,
      PartialFulfillment: !!cust.partialFulfillment,
      AggregatePending: !!cust.aggregatePending,
    };
  };

  // Drive order for the wave's zone (so legacy waves get the same sort order)
  const run = s.runs.find((r) => r.RunId === wave.RunId);
  const driveOrder = (run && CITY_DRIVE_ORDER[run.ZoneCode]) || [];
  const cityRank = (city) => {
    if (!city) return 9999;
    const norm = String(city).trim();
    const idx = driveOrder.findIndex(
      (c) => c === norm || norm.includes(c) || c.includes(norm)
    );
    return idx >= 0 ? idx : 9999;
  };

  const lines = s.waveLines
    .filter((l) => l.WaveId === wave.WaveId)
    .map((l) => {
      const allocations = s.waveAllocations
        .filter((a) => a.WaveLineId === l.WaveLineId)
        .map(enrich)
        .sort((a, b) => {
          const ra = cityRank(a.City);
          const rb = cityRank(b.City);
          if (ra !== rb) return ra - rb;
          return String(a.City || '').localeCompare(String(b.City || ''), 'he');
        });
      const primaryCity = allocations[0]?.City || '';
      return { ...l, allocations, PrimaryCity: primaryCity };
    })
    .sort((a, b) => {
      // Pending lines first (so picker sees what's left), then by city drive order
      const aDone = a.Status === 'COMPLETED' || a.Status === 'SHORTAGE';
      const bDone = b.Status === 'COMPLETED' || b.Status === 'SHORTAGE';
      if (aDone !== bDone) return aDone ? 1 : -1;
      const ra = cityRank(a.PrimaryCity);
      const rb = cityRank(b.PrimaryCity);
      if (ra !== rb) return ra - rb;
      const cityCmp = String(a.PrimaryCity || '').localeCompare(String(b.PrimaryCity || ''), 'he');
      if (cityCmp !== 0) return cityCmp;
      return (a.BinLocation || 'ZZZ').localeCompare(b.BinLocation || 'ZZZ');
    });
  const completed = lines.filter((l) => l.Status === 'COMPLETED').length;
  const picked = lines.reduce((sum, l) => sum + Number(l.PickedQuantity || 0), 0);
  const needed = lines.reduce((sum, l) => sum + Number(l.TotalQuantity || 0), 0);
  return {
    ...wave,
    lines,
    CompletedLines: completed,
    TotalPicked: picked,
    TotalNeeded: needed,
    PalletMode: run?.PalletMode || 'SINGLE',
  };
}

export function getWaveForRun(runId) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.RunId === Number(runId) && w.Status !== 'CANCELLED');
  return wave ? getWave(wave.WaveId) : null;
}

/**
 * Approve a wave's QC and trigger document generation + run advancement.
 * Caller can also pass `notes` (saved on the wave) and `approvedBy` (audit).
 */
export function approveWaveQc(waveId, opts = {}) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;
  if (wave.Status !== 'PENDING_QC') {
    return { ok: false, error: `Wave is in status ${wave.Status}, not PENDING_QC` };
  }
  wave.Status = 'COMPLETED';
  wave.QcApprovedAt = new Date().toISOString();
  wave.QcApprovedBy = opts.approvedBy || null;
  if (opts.notes) wave.QcNotes = opts.notes;

  const run = s.runs.find((r) => r.RunId === wave.RunId);
  if (run && ['PLANNED', 'OPEN', 'PICKING', 'PENDING_QC'].includes(run.Status)) {
    run.Status = 'LOADED';
  }
  // Now generate documents per customer policy
  if (run) {
    try {
      const stopsInRun = s.stops.filter((st) => st.RunId === run.RunId);
      for (const stop of stopsInRun) {
        const dns = generateDeliveryNotesForStop(stop.StopId, { method: 'QC_APPROVED' }) || [];
        for (const dn of dns) {
          const docType = resolveDocTypeForCardName(dn.SapCardName);
          if (docType === 'INVOICE') {
            try { generateInvoiceFromDeliveryNote(dn.DeliveryNoteId); }
            catch (e) { console.warn('[qc-approve] invoice gen failed:', e.message); }
          }
        }
      }
    } catch (e) {
      console.warn('[qc-approve] doc gen failed:', e.message);
    }
  }
  save();
  return { ok: true, wave };
}

/**
 * Reject the wave's QC - sends one or more lines back for re-pick or shortage.
 * Used when QC found a quantity mismatch or wrong item picked.
 */
export function rejectWaveQc(waveId, opts = {}) {
  const s = ensureWavesStore();
  const wave = s.waves.find((w) => w.WaveId === Number(waveId));
  if (!wave) return null;
  // Reset specific lines if provided, otherwise just send wave back to IN_PROGRESS
  if (Array.isArray(opts.resetLineIds)) {
    for (const id of opts.resetLineIds) {
      const ln = s.waveLines.find((l) => l.WaveLineId === Number(id));
      if (ln) {
        ln.PickedQuantity = 0;
        ln.Status = 'PENDING';
      }
      const allocs = s.waveAllocations.filter((a) => a.WaveLineId === Number(id));
      for (const a of allocs) {
        a.PickedQuantity = 0;
        a.Status = 'PENDING';
      }
    }
  }
  wave.Status = 'IN_PROGRESS';
  wave.QcRejectedAt = new Date().toISOString();
  wave.QcRejectedBy = opts.rejectedBy || null;
  if (opts.notes) wave.QcNotes = opts.notes;
  save();
  return { ok: true, wave };
}

/**
 * Record a pick action for a SPECIFIC allocation row (sub-line of a wave line).
 * This allows the picker to mark "picked X units for customer A" separately from
 * "picked Y units for customer B" - each allocation is its own row in the UI.
 *
 * The parent WaveLine's PickedQuantity is recomputed as the sum of all allocations.
 */
export function pickAllocation(allocationId, qty, userId = null, userName = null) {
  const s = ensureWavesStore();
  const alloc = (s.waveAllocations || []).find((a) => a.AllocationId === Number(allocationId));
  if (!alloc) return null;

  const allocPicked = Number(alloc.PickedQuantity || 0) + Number(qty);
  // Cap at the allocation's required quantity
  alloc.PickedQuantity = Math.min(allocPicked, Number(alloc.Quantity));
  alloc.Status = alloc.PickedQuantity >= Number(alloc.Quantity) ? 'COMPLETED' : 'PARTIAL';
  alloc.LastPickedAt = new Date().toISOString();
  if (userName) alloc.LastPickedBy = userName;

  // Recompute the parent line's PickedQuantity as sum of all allocations
  const line = s.waveLines.find((l) => l.WaveLineId === alloc.WaveLineId);
  if (line) {
    const allAllocs = s.waveAllocations.filter((a) => a.WaveLineId === line.WaveLineId);
    const total = allAllocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
    line.PickedQuantity = total;
    if (total >= Number(line.TotalQuantity)) line.Status = 'COMPLETED';
    else if (total > 0) line.Status = 'PARTIAL';

    // Wave / run state propagation (same as recordPick)
    const wave = s.waves.find((w) => w.WaveId === line.WaveId);
    if (wave && wave.Status === 'PENDING') {
      wave.Status = 'IN_PROGRESS';
      wave.StartedAt = new Date().toISOString();
      wave.PickedBy = userId;
      wave.PickedByName = userName;
    }
    const allLines = s.waveLines.filter((l) => l.WaveId === line.WaveId);
    const allDone = allLines.every((l) => l.Status === 'COMPLETED' || l.Status === 'SHORTAGE');
    if (allDone && wave) {
      // Bug fix (2026-05-16): when all lines finish picking, the wave
      // moves to PENDING_QC and waits for approveWaveQc — which is the
      // SOLE place that transitions run.Status to LOADED and triggers
      // DN generation (generateDeliveryNotesForStop per stop).
      //
      // Previously this block did:
      //   wave.Status = 'COMPLETED'
      //   run.Status = 'LOADED' (if run was in PLANNED/OPEN/PICKING)
      // ...which skipped QC entirely. approveWaveQc requires
      // wave.Status==='PENDING_QC' (persistentStore.js line ~1941), so
      // any wave that auto-completed via this path could never be
      // QC-approved, and its DNs were never generated. Four real runs
      // (25, 75, 76, 77) landed in this stuck state. recordPick already
      // moves to PENDING_QC correctly (line ~2110); now pickAllocation
      // matches.
      wave.Status = _nextWaveStatusOnPickingDone(wave.Status);
      if (!wave.CompletedAt) wave.CompletedAt = new Date().toISOString();
      // run.Status is intentionally NOT touched here. approveWaveQc owns
      // that transition.
    }
  }

  save();
  return { alloc, line };
}

/**
 * Pure helper — pick the next wave.Status when all picking is done.
 * Exported for unit tests.
 *
 * Rules:
 *   IN_PROGRESS / PENDING / anything else → PENDING_QC
 *   PENDING_QC                            → PENDING_QC (idempotent)
 *   COMPLETED                             → COMPLETED  (don't downgrade
 *                                           a wave that was already
 *                                           explicitly QC-approved)
 */
export function _nextWaveStatusOnPickingDone(currentStatus) {
  if (currentStatus === 'COMPLETED') return 'COMPLETED';
  if (currentStatus === 'PENDING_QC') return 'PENDING_QC';
  return 'PENDING_QC';
}

/**
 * Reset a specific allocation back to 0 picked.
 */
export function resetAllocation(allocationId) {
  const s = ensureWavesStore();
  const alloc = (s.waveAllocations || []).find((a) => a.AllocationId === Number(allocationId));
  if (!alloc) return null;
  alloc.PickedQuantity = 0;
  alloc.Status = 'PENDING';
  alloc.LastPickedAt = null;
  // Recompute parent line
  const line = s.waveLines.find((l) => l.WaveLineId === alloc.WaveLineId);
  if (line) {
    const allAllocs = s.waveAllocations.filter((a) => a.WaveLineId === line.WaveLineId);
    line.PickedQuantity = allAllocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
    line.Status = line.PickedQuantity > 0 ? 'PARTIAL' : 'PENDING';
  }
  save();
  return { alloc, line };
}

/**
 * FIFO comparator for waveAllocations of a single waveLine.
 *
 * Bug B (2026-05-16): when a waveLine is split across multiple allocations
 * (~32% of real lines in production data; 60–92% for Tineco/DAVO flagship
 * SKUs), recordPick used to update only `line.PickedQuantity` and never
 * propagated the picks to allocations. Since _computeOrderFulfillment
 * sums from allocations, this caused QC-approve to raise NOTHING_PICKED
 * for orders that had been fully picked at the line level.
 *
 * Business decision: when distributing a partial pick across multiple
 * allocations, the OLDEST SAP order gets filled first. There's no
 * proportional split and no fractional units.
 *
 * Sort key (all asc):
 *   1. SapDocEntry — SAP's own monotonic counter, the truest "arrival
 *      order" signal. Allocations carry SapDocEntry directly, no lookup
 *      needed for this primary key.
 *   2. RunOrderId — local fallback if two allocations somehow share a
 *      SapDocEntry (shouldn't happen, but defensive). Requires lookup
 *      via SapDocEntry+CompanyCode → RunOrder, hence the orderByKey arg.
 *   3. AllocationId — final tiebreak so the order is fully deterministic.
 *
 * orderByKey is a function `(alloc) → runOrder|undefined`. Passed in (not
 * imported from ensureDocsStore) so this helper stays pure and unit-
 * testable without store-state setup.
 *
 * Exported as `_compareAllocationsFifo` for unit tests.
 */
export function _compareAllocationsFifo(a, b, orderByKey = () => undefined) {
  const sapA = Number(a.SapDocEntry || 0);
  const sapB = Number(b.SapDocEntry || 0);
  if (sapA !== sapB) return sapA - sapB;
  const roA = Number(orderByKey(a)?.RunOrderId || 0);
  const roB = Number(orderByKey(b)?.RunOrderId || 0);
  if (roA !== roB) return roA - roB;
  return Number(a.AllocationId || 0) - Number(b.AllocationId || 0);
}

/**
 * Compute how a `pickedQty` should be distributed across `sortedAllocs`
 * by FIFO. Returns an array of { AllocationId, take } deltas — does NOT
 * mutate the allocations themselves so the helper is pure (caller applies).
 *
 * Caps:
 *   - Each allocation can only receive up to `alloc.Quantity - alloc.PickedQuantity`.
 *   - Total distributed is capped at `lineTotalQuantity - sum(current picks)`,
 *     i.e. we never over-pick the line. Excess `pickedQty` is silently
 *     dropped (matches the cap behaviour of `pickAllocation`).
 *
 * Negative `pickedQty` is treated as 0 (defensive; recordPick rejects
 * negatives upstream with HTTP 400).
 *
 * Exported as `_distributePickedQtyByFifo` for unit tests.
 */
export function _distributePickedQtyByFifo(pickedQty, sortedAllocs, lineTotalQuantity) {
  const allocs = Array.isArray(sortedAllocs) ? sortedAllocs : [];
  const currentTotal = allocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
  const lineCapacity = Math.max(0, Number(lineTotalQuantity || 0) - currentTotal);
  let toDistribute = Math.min(Math.max(0, Number(pickedQty || 0)), lineCapacity);
  const deltas = [];
  for (const a of allocs) {
    if (toDistribute <= 0) break;
    const allocCap = Number(a.Quantity || 0) - Number(a.PickedQuantity || 0);
    if (allocCap <= 0) continue;
    const take = Math.min(allocCap, toDistribute);
    deltas.push({ AllocationId: a.AllocationId, take });
    toDistribute -= take;
  }
  return deltas;
}

/**
 * Record a pick action — user scanned/entered quantity for a line.
 *
 * Bug B fix (2026-05-16): now propagates the pick into waveAllocations
 * by FIFO of SAP order arrival (oldest SapDocEntry first). The line's
 * PickedQuantity is recomputed as the sum of all its allocations, so
 * the allocations become the single source of truth — matching what
 * pickAllocation() already does and what _computeOrderFulfillment reads.
 *
 * Backward-compat: if a waveLine has zero allocations (legacy data),
 * falls back to the previous behaviour (update line.PickedQuantity only).
 *
 * Negative `pickedQty` is rejected — callers must use resetWaveLine to
 * clear. A future endpoint may add line-level decrement, but it's not
 * in this fix's scope.
 */
export function recordPick(waveLineId, pickedQty, userId = null, userName = null) {
  if (Number(pickedQty) < 0) {
    const err = new Error('recordPick: negative qty not supported; use resetWaveLine to clear');
    err.status = 400;
    throw err;
  }

  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;

  const allocs = (s.waveAllocations || []).filter((a) => a.WaveLineId === line.WaveLineId);

  if (allocs.length === 0) {
    // Legacy line with no allocations — keep prior behaviour so this fix
    // is a strict superset (no surprise breakage on old data).
    const newPicked = Number(line.PickedQuantity || 0) + Number(pickedQty);
    line.PickedQuantity = newPicked;
    if (newPicked >= Number(line.TotalQuantity)) line.Status = 'COMPLETED';
    else if (newPicked > 0) line.Status = 'PARTIAL';
  } else {
    // FIFO distribution. Look up RunOrders for the secondary sort key.
    const docs = ensureDocsStore();
    const orderByKey = (a) => (docs.runOrders || []).find((o) =>
      o && Number(o.SapDocEntry) === Number(a.SapDocEntry) && o.CompanyCode === a.CompanyCode
    );
    allocs.sort((a, b) => _compareAllocationsFifo(a, b, orderByKey));
    const deltas = _distributePickedQtyByFifo(pickedQty, allocs, line.TotalQuantity);

    const now = new Date().toISOString();
    for (const d of deltas) {
      const a = allocs.find((x) => x.AllocationId === d.AllocationId);
      if (!a) continue;
      a.PickedQuantity = Number(a.PickedQuantity || 0) + d.take;
      a.Status = a.PickedQuantity >= Number(a.Quantity) ? 'COMPLETED' : 'PARTIAL';
      a.LastPickedAt = now;
      if (userName) a.LastPickedBy = userName;
    }

    // Line is now derived: sum of all (post-distribution) allocations.
    const newTotal = allocs.reduce((sum, a) => sum + Number(a.PickedQuantity || 0), 0);
    line.PickedQuantity = newTotal;
    if (newTotal >= Number(line.TotalQuantity)) line.Status = 'COMPLETED';
    else if (newTotal > 0) line.Status = 'PARTIAL';
  }

  // Mark wave as in-progress on first pick.
  const wave = s.waves.find((w) => w.WaveId === line.WaveId);
  if (wave && wave.Status === 'PENDING') {
    wave.Status = 'IN_PROGRESS';
    wave.StartedAt = new Date().toISOString();
    wave.PickedBy = userId;
    wave.PickedByName = userName;
  }

  // Check if all lines complete → advance wave to PENDING_QC.
  const allLines = s.waveLines.filter((l) => l.WaveId === line.WaveId);
  const allDone = allLines.every((l) => l.Status === 'COMPLETED' || l.Status === 'SHORTAGE');
  if (allDone && wave) {
    wave.Status = 'PENDING_QC';
    wave.CompletedAt = new Date().toISOString();
  }

  save();
  return line;
}

export function markShortage(waveLineId, notes = null) {
  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;
  line.Status = 'SHORTAGE';
  line.Notes = notes;
  save();
  return line;
}

/**
 * Reset a waveLine — clears all picks on the line AND on its allocations.
 *
 * Bug B fix follow-up (2026-05-16): now that recordPick populates
 * allocations, reset must clear them too. Otherwise we'd leave
 * `line.PickedQuantity = 0` but `alloc.PickedQuantity > 0`, and
 * _computeOrderFulfillment (which sums allocations) would still return
 * stale picks, causing QC-approve to emit DNs for already-reset orders.
 */
export function resetWaveLine(waveLineId) {
  const s = ensureWavesStore();
  const line = s.waveLines.find((l) => l.WaveLineId === Number(waveLineId));
  if (!line) return null;

  const allocs = (s.waveAllocations || []).filter((a) => a.WaveLineId === line.WaveLineId);
  for (const a of allocs) {
    a.PickedQuantity = 0;
    a.Status = 'PENDING';
    a.LastPickedAt = null;
  }

  line.PickedQuantity = 0;
  line.Status = 'PENDING';
  line.Notes = null;
  save();
  return line;
}

export function listWaves({ status = null, runDate = null } = {}) {
  const s = ensureWavesStore();
  let waves = [...s.waves];
  if (status) waves = waves.filter((w) => w.Status === status);
  if (runDate) waves = waves.filter((w) => w.RunDate === runDate);
  return waves.sort((a, b) => b.WaveId - a.WaveId);
}

// Picker Task Inbox (2026-05-22): the per-picker view of "what should I
// pick now?". Backs GET /api/pickers/:pickerId/assigned-waves and the
// upcoming /picker/tasks page. Returns null when the picker doesn't
// exist or isn't active, so the HTTP layer can map that to a clean 404.
//
// Filters applied:
//   - AssignedPickerId matches the requested picker
//   - Wave Status is one of PENDING / IN_PROGRESS / PENDING_QC
//     (CANCELLED / COMPLETED are deliberately excluded — those don't
//     belong in an inbox)
//   - The parent Run is not CANCELLED (an assigned wave with a cancelled
//     run would create UI clutter that takes the picker nowhere)
//
// Each row is denormalised with Run zone fields + WaveLine aggregates so
// the page can render a card without a second round-trip per wave.
const ACTIVE_INBOX_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'PENDING_QC']);
const SORT_PRIORITY = { IN_PROGRESS: 0, PENDING_QC: 1, PENDING: 2 };

export function listAssignedWavesForPicker(pickerId) {
  const id = Number(pickerId);
  if (!Number.isInteger(id)) return null;
  const s = ensureWavesStore();
  const picker = (s.pickers || []).find((p) => p.PickerId === id);
  if (!picker || picker.IsActive !== true) return null;

  const runsById = new Map((s.runs || []).map((r) => [r.RunId, r]));
  const stopsByRunId = new Map();
  for (const stop of (s.stops || [])) {
    if (!stopsByRunId.has(stop.RunId)) stopsByRunId.set(stop.RunId, []);
    stopsByRunId.get(stop.RunId).push(stop);
  }

  const rows = [];
  for (const w of (s.waves || [])) {
    if (w.AssignedPickerId !== id) continue;
    if (!ACTIVE_INBOX_STATUSES.has(w.Status)) continue;

    const run = runsById.get(w.RunId);
    // Drop waves whose run is gone or cancelled — see header comment.
    if (!run || run.Status === 'CANCELLED') continue;

    const stops = stopsByRunId.get(w.RunId) || [];
    const stopIds = new Set(stops.map((st) => st.StopId));
    const orderCount = (s.runOrders || []).filter(
      (o) => stopIds.has(o.StopId) && o.Status !== 'CANCELLED'
    ).length;

    const lines = (s.waveLines || []).filter((wl) => wl.WaveId === w.WaveId);
    const completedLineCount = lines.filter((wl) => wl.Status === 'COMPLETED').length;
    const shortageCount      = lines.filter((wl) => wl.Status === 'SHORTAGE').length;

    rows.push({
      waveId:             w.WaveId,
      waveNumber:         w.WaveNumber,
      runId:              w.RunId,
      runNumber:          w.RunNumber,
      runDate:            w.RunDate,
      zoneCode:           run.ZoneCode || null,
      zoneName:           run.ZoneName || null,
      zoneColor:          run.ZoneColor || null,
      status:             w.Status,
      assignedPickerId:   w.AssignedPickerId,
      assignedPickerName: w.AssignedPickerName,
      assignedAt:         w.AssignedAt,
      orderCount,
      lineCount:          lines.length,
      completedLineCount,
      shortageCount,
      createdAt:          w.CreatedAt,
      startedAt:          w.StartedAt,
    });
  }

  // Sort: active waves first (IN_PROGRESS → PENDING_QC → PENDING),
  // then newest-first within each status. Lets the picker see what's
  // urgent at the top of the list.
  return rows.sort((a, b) => {
    const pa = SORT_PRIORITY[a.status] ?? 99;
    const pb = SORT_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.waveId - a.waveId;
  });
}

/**
 * Duplicate a run - creates a new run with the same stops + addresses
 * on a new date. Does NOT copy the SAP orders (those are one-time per order).
 *
 * Useful for regular customers that get a delivery every Tuesday, for example.
 */
export function duplicateRun(sourceRunId, newRunDate) {
  const s = ensureRunsStore();
  const source = s.runs.find((r) => r.RunId === Number(sourceRunId));
  if (!source) return null;

  const newRun = addRun({
    runDate: newRunDate,
    zoneId: source.ZoneId,
    driverId: source.DriverId,
    notes: source.Notes ? `${source.Notes} (שכפול)` : 'שכפול',
  });

  const sourceStops = s.stops
    .filter((st) => st.RunId === source.RunId)
    .sort((a, b) => (a.StopOrder || 0) - (b.StopOrder || 0));

  for (const ss of sourceStops) {
    addStop(newRun.RunId, {
      addressId: ss.AddressId, street: ss.Street,
      buildingNumber: ss.BuildingNumber, city: ss.City, branchName: ss.BranchName,
      latitude: ss.Latitude, longitude: ss.Longitude,
      deliveryWindowStart: ss.DeliveryWindowStart, deliveryWindowEnd: ss.DeliveryWindowEnd,
      deliveryDays: ss.DeliveryDays,
      contactPhone: ss.ContactPhone, contactName: ss.ContactName,
      deliveryNotes: ss.DeliveryNotes,
    });
  }

  return newRun;
}

// ============================================================================
// Documents - Delivery Notes + Invoices (separated per company)
// ============================================================================

function ensureDocsStore() {
  const s = ensureWavesStore();
  if (!s.deliveryNotes) { s.deliveryNotes = []; s.nextDeliveryNoteId = 1; }
  if (!s.invoices) { s.invoices = []; s.nextInvoiceId = 1; }
  return s;
}

/**
 * Generate Delivery Notes for a stop - one per (Company, Customer).
 * Critical: groups orders properly so each company gets its own DN.
 */
export function generateDeliveryNotesForStop(stopId, options = {}) {
  const s = ensureDocsStore();
  const stop = s.stops.find((st) => st.StopId === Number(stopId));
  if (!stop) return null;

  const stopOrders = s.runOrders.filter((o) => o.StopId === stop.StopId);
  if (stopOrders.length === 0) return [];

  const groups = new Map();
  for (const order of stopOrders) {
    if (order.Status === 'CANCELLED') continue;
    const key = `${order.CompanyCode}|${order.SapCardCode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        CompanyCode: order.CompanyCode,
        CompanyName: order.CompanyName,
        SapCardCode: order.SapCardCode,
        SapCardName: order.SapCardName,
        orders: [],
      });
    }
    groups.get(key).orders.push(order);
  }

  const generated = [];
  for (const group of groups.values()) {
    const existing = s.deliveryNotes.find((dn) =>
      dn.StopId === stop.StopId &&
      dn.CompanyCode === group.CompanyCode &&
      dn.SapCardCode === group.SapCardCode &&
      dn.Status !== 'CANCELLED'
    );
    if (existing && !options.regenerate) {
      generated.push(existing);
      continue;
    }

    const dn = {
      DeliveryNoteId: s.nextDeliveryNoteId++,
      DocNumber: `DN-${stop.StopId}-${group.CompanyCode}-${String(s.nextDeliveryNoteId).padStart(4, '0')}`,
      StopId: stop.StopId,
      RunId: stop.RunId,
      CompanyCode: group.CompanyCode,
      CompanyName: group.CompanyName,
      SapCardCode: group.SapCardCode,
      SapCardName: group.SapCardName,
      SourceOrders: group.orders.map((o) => ({
        RunOrderId: o.RunOrderId,
        SapDocEntry: o.SapDocEntry,
        SapDocNum: o.SapDocNum,
        OrderTotal: o.OrderTotal,
        LinesCount: o.LinesCount,
      })),
      TotalAmount: group.orders.reduce((sum, o) => sum + Number(o.OrderTotal || 0), 0),
      LineCount: group.orders.reduce((sum, o) => sum + Number(o.LinesCount || 0), 0),
      Status: 'PENDING_EXPORT',
      SapDeliveryDocEntry: null,
      SapDeliveryDocNum: null,
      ExportedAt: null,
      SentToSapAt: null,
      ConfirmedAt: null,
      ErrorMessage: null,
      // A2 audit fields — populated by Phase A2-2 dry-run path. Kept null on
      // creation so existing flows are unchanged in A2-1.
      LastDryRunPayloadAt: null,
      LastDryRunPayloadPreview: null,   // truncated to ≤1000 chars by A2-2
      SapWriteAttempts: 0,
      SapWriteAttemptedAt: null,
      SapWriteLastError: null,
      Notes: stop.Notes || null,
      Address: {
        Street: stop.Street, BuildingNumber: stop.BuildingNumber, City: stop.City,
        BranchName: stop.BranchName,
      },
      DeliveryDate: new Date().toISOString().slice(0, 10),
      CreatedAt: new Date().toISOString(),
      Method: options.method || 'AUTO',
    };
    s.deliveryNotes.push(dn);
    generated.push(dn);
  }
  save();
  return generated;
}

export function generateInvoiceFromDeliveryNote(deliveryNoteId, options = {}) {
  const s = ensureDocsStore();
  const dn = s.deliveryNotes.find((d) => d.DeliveryNoteId === Number(deliveryNoteId));
  if (!dn) return null;
  const existing = s.invoices.find((inv) =>
    inv.DeliveryNoteId === dn.DeliveryNoteId && inv.Status !== 'CANCELLED'
  );
  if (existing && !options.regenerate) return existing;

  const invoice = {
    InvoiceId: s.nextInvoiceId++,
    DocNumber: `INV-${dn.StopId}-${dn.CompanyCode}-${String(s.nextInvoiceId).padStart(4, '0')}`,
    DeliveryNoteId: dn.DeliveryNoteId,
    RunId: dn.RunId,
    StopId: dn.StopId,
    CompanyCode: dn.CompanyCode,
    CompanyName: dn.CompanyName,
    SapCardCode: dn.SapCardCode,
    SapCardName: dn.SapCardName,
    TotalAmount: dn.TotalAmount,
    VatAmount: Number((dn.TotalAmount * 0.17).toFixed(2)),
    GrossAmount: Number((dn.TotalAmount * 1.17).toFixed(2)),
    LineCount: dn.LineCount,
    // A2d (2026-05-19): copy aggregated picked lines + source-order refs from
    // the parent DN so writeInvoice can build a standalone payload when the
    // DN hasn't been written to SAP yet (dry-run). Empty arrays for non-
    // aggregate DNs are harmless — the live-mode payload doesn't read them.
    Lines: Array.isArray(dn.Lines) ? dn.Lines.map((l) => ({ ...l })) : [],
    SourceOrders: Array.isArray(dn.SourceOrders) ? dn.SourceOrders.map((s) => ({ ...s })) : [],
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapInvoiceDocNum: null,
    ExportedAt: null,
    SentToSapAt: null,
    ConfirmedAt: null,
    ErrorMessage: null,
    // A2d audit fields — mirror of the DN audit set. Populated by
    // _applyWriteResultToInv after writeInvoice runs (dry-run or live).
    LastDryRunPayloadAt: null,
    LastDryRunPayloadPreview: null,
    SapWriteAttempts: 0,
    SapWriteAttemptedAt: null,
    SapWriteLastError: null,
    InvoiceDate: new Date().toISOString().slice(0, 10),
    CreatedAt: new Date().toISOString(),
    Method: options.method || 'AUTO',
  };
  s.invoices.push(invoice);
  save();
  return invoice;
}

export function generateInvoicesForRun(runId) {
  const s = ensureDocsStore();
  const dns = s.deliveryNotes.filter((d) => d.RunId === Number(runId) && d.Status !== 'CANCELLED');
  const invoices = [];
  for (const dn of dns) {
    const inv = generateInvoiceFromDeliveryNote(dn.DeliveryNoteId);
    if (inv) invoices.push(inv);
  }
  return invoices;
}

// ============================================================================
// Feature C — Per-order document orchestrator.
// Replaces the wave-level + CardName-based legacy flow with one that reads
// DocPolicy from customerDeliveryProfiles (keyed by CardCode + Company) and
// generates exactly the documents the policy asks for, idempotently.
//
// Decisions locked with the operator:
//   - Mode is DRY-RUN — documents land in store.deliveryNotes / store.invoices
//     with Status='PENDING_EXPORT'. No SAP write yet.
//   - Empty policy = blocked (throws 422). Operator must fill via
//     /customer-doc-policy before approving.
//   - Eilat tax-invoice rule is already encoded in policy.perOrderInvoice='yes'
//     for the 78 Eilat customers; no special-case here.
//   - perOrder vs aggregate at this stage: per-order only. Aggregate logic
//     (CONSOLIDATED_PER_ROUTE) is a follow-up phase.
//   - Shortage handling is a follow-up phase. For now, the DN amount is the
//     full order amount (matches existing generateDeliveryNotesForStop).
// ============================================================================

function _findOrderById(runOrderId) {
  const s = ensureDocsStore();
  return s.runOrders.find((o) => o.RunOrderId === Number(runOrderId));
}

function _findStopOfOrder(order) {
  const s = ensureDocsStore();
  return s.stops.find((st) => st.StopId === order.StopId);
}

/**
 * Phase 3 — policy lookup with parent fallback.
 *
 * Returns { policy, source, key } where:
 *   source = 'cardCode' when the policy lives on the customer's own profile
 *   source = 'parent'   when no per-customer profile exists but a profile
 *                        whose Name matches the chain parent name does.
 *   key                  is the stable aggregation key the flush uses to
 *                        group orders: `card:<CardCode>:<Company>` or
 *                        `parent:<parentName>:<Company>`.
 *
 * The parent fallback is opt-in: it only ever kicks in if an admin has
 * created a customerDeliveryProfile whose Name equals the chain parent
 * name (e.g. profile with Name="א.ל.מ סחר 2000 בע\"מ" and a DocPolicy).
 * Today no such profile exists, so behaviour for Phase 1/2 is unchanged.
 */
function _policyForOrder(order) {
  if (!order) return null;
  const profiles = (load().customerDeliveryProfiles || []);
  const cardCode = String(order.SapCardCode || '').trim();
  const company = order.CompanyCode === 'A' ? 'OIG'
                : order.CompanyCode === 'B' ? 'UNICO' : null;

  // Stage 1 — by CardCode + Company (then by CardCode alone for stragglers).
  let p = profiles.find((x) => String(x.CardCode) === cardCode && x.Company === company);
  if (!p) p = profiles.find((x) => String(x.CardCode) === cardCode);
  if (p?.DocPolicy) {
    return {
      policy: p.DocPolicy,
      source: 'cardCode',
      key: `card:${cardCode}:${order.CompanyCode || ''}`,
    };
  }

  // Stage 2 — parent fallback. Find a profile whose Name is the chain
  // parent name AND that profile is itself "at the root" (Name = its own
  // parent name). This avoids accidentally matching a sibling branch.
  const parentName = parentNameOf(order.SapCardName || '');
  if (parentName) {
    const parentP = profiles.find((x) =>
      x.Name === parentName &&
      parentNameOf(x.Name) === parentName &&
      x.DocPolicy
    );
    if (parentP?.DocPolicy) {
      return {
        policy: parentP.DocPolicy,
        source: 'parent',
        key: `parent:${parentName}:${order.CompanyCode || ''}`,
      };
    }
  }

  return null;
}

function _hasAnyPolicySignal(policy) {
  if (!policy) return false;
  return policy.perOrderDeliveryNote === 'yes'
      || policy.perOrderInvoice === 'yes'
      || policy.aggregateDeliveryNote === 'yes'
      || policy.aggregateInvoice === 'yes';
}

/**
 * Phase 3 — reject "both yes" within the same dimension (DN or INV).
 * Cross-dimension mixes are fine: e.g. perOrderDN=yes + aggregateINV=yes is
 * a legit "DN per delivery, monthly consolidated invoice" pattern.
 */
function _validatePolicyShape(policy, cardName, cardCode) {
  const errors = [];
  if (policy.perOrderDeliveryNote === 'yes' && policy.aggregateDeliveryNote === 'yes') {
    errors.push('תעודת משלוח: אסור לסמן גם per-order וגם מאוחד');
  }
  if (policy.perOrderInvoice === 'yes' && policy.aggregateInvoice === 'yes') {
    errors.push('חשבונית: אסור לסמן גם per-order וגם מאוחד');
  }
  if (errors.length) {
    const err = new Error(
      `מדיניות לא תקינה ללקוח ${cardName || cardCode}: ${errors.join('; ')}. ` +
      `תקן ב-/customer-doc-policy.`
    );
    err.status = 422;
    err.code = 'INVALID_POLICY';
    err.cardCode = cardCode;
    err.cardName = cardName;
    err.errors = errors;
    throw err;
  }
}

/**
 * Pick the wave that represents the *current* state of picking for a run.
 *
 * Bug A fix (2026-05-16): a run can have multiple waves over its lifetime
 * (created → CANCELLED → fresh wave created and picked). The old code did
 * `.find()` on RunId alone, which returns the *first* match regardless of
 * Status, so it could lock onto a stale CANCELLED wave whose allocations
 * are all PickedQuantity=0, making the order look empty even though it was
 * actually picked in the active wave.
 *
 * Selection rules:
 *   1. waves of the same RunId
 *   2. Status !== 'CANCELLED' (COMPLETED is fine — that's the happy path)
 *   3. latest by CreatedAt, tiebreak by WaveId
 *
 * Returns null if no non-cancelled wave exists for the run.
 *
 * Exported as `_selectActiveWaveForRun` for unit tests.
 */
export function _selectActiveWaveForRun(allWaves, runId) {
  const candidates = (allWaves || [])
    .filter((w) => w.RunId === Number(runId) && w.Status !== 'CANCELLED');
  let pick = null;
  for (const w of candidates) {
    if (!pick) { pick = w; continue; }
    const tBest = pick.CreatedAt ? Date.parse(pick.CreatedAt) : 0;
    const tCur = w.CreatedAt ? Date.parse(w.CreatedAt) : 0;
    if (tCur > tBest) { pick = w; continue; }
    if (tCur === tBest && (w.WaveId || 0) > (pick.WaveId || 0)) {
      pick = w;
    }
  }
  return pick;
}

/**
 * Phase 2 — compute fulfillment for one RunOrder by walking its allocations
 * across this run's wave. Returns picked/ordered totals + per-item breakdown
 * so the DN can be flagged partial and downstream UI can show shortages.
 *
 * Matching key: SapDocEntry + CompanyCode. Scoped to the *active* wave of
 * the order's run (see _selectActiveWaveForRun) to avoid pulling stale picks
 * from a cancelled wave.
 *
 * Return shape (all callers tolerate a missing `reason`):
 *   { lines, totalOrdered, totalPicked, isEmpty, isPartial, reason }
 *   reason === 'NO_ACTIVE_WAVE' when no non-cancelled wave exists for the run.
 */
function _computeOrderFulfillment(order) {
  const s = ensureDocsStore();
  const stop = _findStopOfOrder(order);
  const runId = stop?.RunId;
  const waves = ensureWavesStore();

  // Pick the active wave for this run (skip CANCELLED, latest by CreatedAt).
  // See _selectActiveWaveForRun for the full rationale.
  const waveOfRun = _selectActiveWaveForRun(waves.waves || [], runId);

  if (!waveOfRun) {
    return {
      lines: [],
      totalOrdered: 0,
      totalPicked: 0,
      isEmpty: true,
      isPartial: false,
      reason: 'NO_ACTIVE_WAVE',
    };
  }

  const allowedWaveLineIds = new Set(
    (waves.waveLines || [])
      .filter((wl) => wl.WaveId === waveOfRun.WaveId)
      .map((wl) => wl.WaveLineId)
  );

  const allocs = (waves.waveAllocations || []).filter((a) =>
    Number(a.SapDocEntry) === Number(order.SapDocEntry) &&
    a.CompanyCode === order.CompanyCode &&
    allowedWaveLineIds.has(a.WaveLineId)
  );

  const lines = [];
  let totalOrdered = 0;
  let totalPicked = 0;
  for (const a of allocs) {
    const wl = (waves.waveLines || []).find((l) => l.WaveLineId === a.WaveLineId);
    const ordered = Number(a.Quantity || 0);
    const picked = Number(a.PickedQuantity || 0);
    totalOrdered += ordered;
    totalPicked += picked;
    lines.push({
      AllocationId: a.AllocationId,
      WaveLineId: a.WaveLineId,
      ItemCode: wl?.SapItemCode || null,
      ItemName: wl?.SapItemName || null,
      Ordered: ordered,
      Picked: picked,
      Missing: Math.max(0, ordered - picked),
    });
  }

  return {
    lines,
    totalOrdered,
    totalPicked,
    isEmpty: totalPicked === 0,
    isPartial: totalPicked > 0 && totalPicked < totalOrdered,
    reason: null,
  };
}

/**
 * Generate the SAP documents one order needs, based on its customer's
 * DocPolicy. Returns { deliveryNote, invoice, skipped } on success, or
 * throws an Error with .status=422 if the policy is empty.
 * Idempotent: re-running on an order that already has docs returns the
 * existing ones unchanged.
 */
export function generateDocsForRunOrder(runOrderId, options = {}) {
  const s = ensureDocsStore();
  const order = _findOrderById(runOrderId);
  if (!order) {
    const err = new Error('Order not found'); err.status = 404; throw err;
  }
  const stop = _findStopOfOrder(order);
  if (!stop) {
    const err = new Error('Stop not found for order'); err.status = 404; throw err;
  }

  // Idempotency — return any docs already linked to this order.
  if (order.DeliveryNoteId || order.InvoiceId) {
    const existing = {
      deliveryNote: order.DeliveryNoteId
        ? s.deliveryNotes.find((d) => d.DeliveryNoteId === order.DeliveryNoteId) || null : null,
      invoice: order.InvoiceId
        ? s.invoices.find((i) => i.InvoiceId === order.InvoiceId) || null : null,
      skipped: false,
      idempotent: true,
    };
    if (!options.regenerate) return existing;
  }

  const policyResult = _policyForOrder(order);
  const policy = policyResult?.policy || null;
  if (!_hasAnyPolicySignal(policy)) {
    const err = new Error(
      'מדיניות מסמכים חסרה ללקוח ' + (order.SapCardName || order.SapCardCode) +
      '. הגדר ב-/customer-doc-policy לפני אישור.'
    );
    err.status = 422;
    err.code = 'NO_POLICY';
    err.cardCode = order.SapCardCode;
    err.cardName = order.SapCardName;
    throw err;
  }

  // Phase 3 — reject conflicting per-order + aggregate flags up front so
  // the admin sees the broken policy instead of getting a silent default.
  _validatePolicyShape(policy, order.SapCardName, order.SapCardCode);

  // Phase 2 — shortage gate. Walk this order's allocations and refuse if
  // nothing was picked (operator can't approve a 0-quantity DN). Partial
  // picks are allowed but flagged on the DN; the SAP order stays open so the
  // leftover can be picked on a later run.
  const fulfillment = _computeOrderFulfillment(order);
  if (fulfillment.isEmpty) {
    const err = new Error(
      'אי אפשר לאשר הזמנה ' + (order.SapDocNum || order.SapDocEntry) +
      ' — לא נלקטה אף יחידה. לקט לפחות פריט אחד לפני אישור.'
    );
    err.status = 422;
    err.code = 'NOTHING_PICKED';
    err.cardCode = order.SapCardCode;
    err.cardName = order.SapCardName;
    throw err;
  }

  const result = {
    deliveryNote: null, invoice: null, skipped: false, idempotent: false,
    isPartial: fulfillment.isPartial,
    totalOrdered: fulfillment.totalOrdered,
    totalPicked: fulfillment.totalPicked,
    aggregatePending: false,
  };

  // Phase 3 — if the policy says "aggregate" for either dimension AND
  // does NOT also say per-order for that dimension, defer doc creation
  // until the run-level flush. The order is still marked QcApproved so the
  // picker UI shows it as done; the flush will populate DeliveryNoteId /
  // InvoiceId once the operator triggers it from RunDetailsPage.
  const wantsAggDN  = policy.aggregateDeliveryNote === 'yes' && policy.perOrderDeliveryNote !== 'yes';
  const wantsAggINV = policy.aggregateInvoice === 'yes' && policy.perOrderInvoice !== 'yes';

  // Create a single-order DN scoped to THIS order (not all orders at the stop).
  // We piggyback on the existing DN shape so downstream code (PDFs, /api/delivery-notes)
  // keeps working unchanged. Phase 2 adds IsPartial + per-item Lines/Shortages
  // so the actual picked quantities (not the ordered quantities) go on the DN.
  if (policy.perOrderDeliveryNote === 'yes' || policy.perOrderInvoice === 'yes') {
    const pickedLines = fulfillment.lines.filter((l) => l.Picked > 0);
    const shortages = fulfillment.lines.filter((l) => l.Missing > 0);

    const dn = {
      DeliveryNoteId: s.nextDeliveryNoteId++,
      DocNumber: `DN-${stop.StopId}-${order.CompanyCode}-${String(s.nextDeliveryNoteId).padStart(4, '0')}`,
      StopId: stop.StopId,
      RunId: stop.RunId,
      RunOrderId: order.RunOrderId,
      CompanyCode: order.CompanyCode,
      CompanyName: order.CompanyName,
      SapCardCode: order.SapCardCode,
      SapCardName: order.SapCardName,
      SourceOrders: [{
        RunOrderId: order.RunOrderId,
        SapDocEntry: order.SapDocEntry,
        SapDocNum: order.SapDocNum,
        OrderTotal: order.OrderTotal,
        LinesCount: order.LinesCount,
      }],
      TotalAmount: Number(order.OrderTotal || 0),
      LineCount: pickedLines.length,
      IsPartial: fulfillment.isPartial,
      TotalOrdered: fulfillment.totalOrdered,
      TotalPicked: fulfillment.totalPicked,
      Lines: pickedLines,
      Shortages: shortages,
      Status: 'PENDING_EXPORT',
      SapDeliveryDocEntry: null,
      SapDeliveryDocNum: null,
      ExportedAt: null,
      SentToSapAt: null,
      ConfirmedAt: null,
      ErrorMessage: null,
      Notes: stop.Notes || null,
      Address: {
        Street: stop.Street, BuildingNumber: stop.BuildingNumber, City: stop.City,
        BranchName: stop.BranchName,
      },
      DeliveryDate: new Date().toISOString().slice(0, 10),
      CreatedAt: new Date().toISOString(),
      Method: options.method || 'AUTO_QC_PER_ORDER',
    };
    s.deliveryNotes.push(dn);
    order.DeliveryNoteId = dn.DeliveryNoteId;
    if (fulfillment.isPartial) order.PartialFulfillment = true;
    result.deliveryNote = dn;

    // perOrderInvoice='yes' → also emit a tax invoice from this DN.
    if (policy.perOrderInvoice === 'yes') {
      const inv = generateInvoiceFromDeliveryNote(dn.DeliveryNoteId, { method: 'AUTO_QC_PER_ORDER' });
      if (inv) {
        order.InvoiceId = inv.InvoiceId;
        result.invoice = inv;
      }
    }
  }

  // Phase 3 — if any aggregate flag is set without its per-order counterpart,
  // tag the order so the run-level flush picks it up. AggregationKey is the
  // GroupBy key the flush uses; it comes from _policyForOrder so it matches
  // exactly the level the admin authored the policy at (CardCode or parent).
  if (wantsAggDN || wantsAggINV) {
    order.AggregatePending = true;
    order.AggregationKey = policyResult.key;
    order.AggregationSource = policyResult.source;
    result.aggregatePending = true;
  }

  order.QcApproved = true;
  order.QcApprovedAt = new Date().toISOString();
  order.QcApprovedBy = options.approvedBy || null;
  save();
  return result;
}

/**
 * Phase 3 — run-level aggregate flush. Walks every RunOrder in the run
 * that's marked AggregatePending=true, groups them by AggregationKey, and
 * emits one consolidated DN per group (plus a consolidated invoice if the
 * policy asks for it). The SAP order stays the source of truth for each
 * shortage — we only persist the picked quantities here.
 *
 * Idempotent: orders that already have a DeliveryNoteId/InvoiceId from a
 * previous flush are skipped (they appear in `skipped` for visibility).
 * Refuses to run if any order in the run is unapproved (returns 422).
 */
/**
 * A2c-4a (2026-05-16): apply the result of writeDeliveryNote() to the
 * local DN. Mutates `dn` in place. Pure helper, exported for unit tests.
 *
 * Cases:
 *   wr.ok && wr.payload && wr.dryRun !== false
 *     → audit fields updated (LastDryRunPayloadAt/Preview), SapWriteLastError
 *       cleared. Status stays as-is (PENDING_EXPORT). This is the current
 *       A2-2 behaviour and is the default when options.liveWrite is not
 *       passed to flushAggregateDocsForRun.
 *
 *   wr.ok && wr.payload && wr.dryRun === false && wr.sapDocEntry != null
 *     → live write success. All audit fields updated, PLUS:
 *       SapDeliveryDocEntry + SapDeliveryDocNum populated,
 *       Status='EXPORTED', ExportedAt + SentToSapAt set.
 *
 *   !wr.ok
 *     → SapWriteLastError set with the error message. Status NOT advanced
 *       (stays PENDING_EXPORT) — operator can retry by re-running the
 *       flush after fixing whatever broke (e.g. SAP login, env, payload).
 *
 *   missing dn or wr → no-op (defensive).
 *
 * Note: field names LastDryRunPayloadAt/Preview are historical (introduced
 * in A2-1 for dry-run only). A2c-4a populates them for live writes too —
 * they document "last payload sent to SAP" regardless of mode.
 */
export function _applyWriteResultToDn(dn, wr) {
  if (!dn || !wr) return;
  if (wr.ok && wr.payload) {
    const now = new Date().toISOString();
    dn.LastDryRunPayloadAt = now;
    dn.LastDryRunPayloadPreview = JSON.stringify(wr.payload).slice(0, 1000);
    dn.SapWriteLastError = null;
    if (wr.dryRun === false && wr.sapDocEntry != null) {
      dn.SapDeliveryDocEntry = wr.sapDocEntry;
      dn.SapDeliveryDocNum = wr.sapDocNum != null ? wr.sapDocNum : null;
      dn.Status = 'EXPORTED';
      dn.ExportedAt = now;
      dn.SentToSapAt = now;
    }
  } else if (!wr.ok) {
    dn.SapWriteLastError = wr.error
      || (wr.dryRun === false ? 'unknown live write failure' : 'unknown dry-run failure');
    // Status stays unchanged (PENDING_EXPORT) — caller can retry.
  }
}

/**
 * A2d (2026-05-19): mirror of _applyWriteResultToDn for Invoice records.
 *
 * The Invoice has its own SAP DocEntry/DocNum pair (SapInvoiceDocEntry /
 * SapInvoiceDocNum) and the same audit fields as the DN. Status transitions
 * are identical:
 *   dry-run success    → audit fields set, Status stays PENDING_EXPORT
 *   live success       → SapInvoiceDocEntry persisted, Status='EXPORTED'
 *   failure (any mode) → SapWriteLastError set, Status NOT advanced
 *
 * Like the DN helper: idempotency is "do not undo prior live success" —
 * a dry-run replay on an already-EXPORTED invoice keeps the live state.
 *
 * Pure helper, exported for unit tests.
 */
export function _applyWriteResultToInv(inv, wr) {
  if (!inv || !wr) return;
  if (wr.ok && wr.payload) {
    const now = new Date().toISOString();
    inv.LastDryRunPayloadAt = now;
    inv.LastDryRunPayloadPreview = JSON.stringify(wr.payload).slice(0, 1000);
    inv.SapWriteLastError = null;
    if (wr.dryRun === false && wr.sapDocEntry != null) {
      inv.SapInvoiceDocEntry = wr.sapDocEntry;
      inv.SapInvoiceDocNum = wr.sapDocNum != null ? wr.sapDocNum : null;
      inv.Status = 'EXPORTED';
      inv.ExportedAt = now;
      inv.SentToSapAt = now;
    }
  } else if (!wr.ok) {
    inv.SapWriteLastError = wr.error
      || (wr.dryRun === false ? 'unknown live write failure' : 'unknown dry-run failure');
    // Status stays unchanged (PENDING_EXPORT) — caller can retry by re-running
    // the flush after fixing whatever broke. DN that already succeeded is NOT
    // affected — the DN call already returned before this Invoice attempt.
  }
}

// Phase A2-2: became `async` so it can `await writeDeliveryNote()` in dry-run
// mode. Every caller must use `await store.flushAggregateDocsForRun(...)`.
// The write happens AFTER the DN is committed to the local store, so a
// SAP failure cannot leave a half-state.
//
// Phase A2c-4a (2026-05-16): the call to writeDeliveryNote now respects
// `options.liveWrite`. Default is false — every existing caller (including
// /api/runs/:id/flush-aggregate-docs) continues to get dryRun:true behaviour
// with NO change. Only callers that explicitly pass { liveWrite: true } get
// dryRun:false. The A2c-1 whitelist gate inside writeDeliveryNote will still
// block live writes if SAP_WRITE_ENABLED!=true or whitelist mismatch.
export async function flushAggregateDocsForRun(runId, options = {}) {
  const s = ensureDocsStore();
  const runIdNum = Number(runId);

  const ordersInRun = (s.runOrders || []).filter((o) => {
    const stop = s.stops?.find((st) => st.StopId === o.StopId);
    return stop && Number(stop.RunId) === runIdNum;
  });

  // Refuse to flush if ANY order is unapproved — the operator is about to
  // mint a chain-level DN; we don't want a pending row sneaking in later.
  const unapproved = ordersInRun.filter((o) => !o.QcApproved);
  if (unapproved.length) {
    const err = new Error(
      `יש ${unapproved.length} הזמנות לא מאושרות ב-run. אשר את כולן לפני הפקת מסמכים מאוחדים.`
    );
    err.status = 422;
    err.code = 'UNAPPROVED_ORDERS';
    err.unapproved = unapproved.map((o) => ({
      RunOrderId: o.RunOrderId,
      SapDocNum: o.SapDocNum,
      SapCardName: o.SapCardName,
    }));
    throw err;
  }

  const pending = ordersInRun.filter((o) => o.AggregatePending && !o.DeliveryNoteId && !o.InvoiceId);
  const skipped = ordersInRun
    .filter((o) => o.AggregatePending && (o.DeliveryNoteId || o.InvoiceId))
    .map((o) => ({ RunOrderId: o.RunOrderId, reason: 'already_flushed' }));

  if (!pending.length) {
    return { docsCreated: [], invoicesCreated: [], skipped, ordersTouched: 0 };
  }

  // Phase A2-3: refuse to flush if ANY pending order has no DocPolicy.
  // Without a policy we can't decide whether to emit a DN, an INV, or
  // both — and we must NOT silently fall back to a default, because that
  // would create a document the customer's accounting flow doesn't
  // expect. Operator decision: 422 + DOC_POLICY_MISSING.
  const missingPolicy = pending.filter((o) => {
    const pr = _policyForOrder(o);
    return !pr || !pr.policy;
  });
  if (missingPolicy.length) {
    const err = new Error(
      `יש ${missingPolicy.length} הזמנות ללא מדיניות מסמכים. הגדר מדיניות לכל לקוח לפני flush.`
    );
    err.status = 422;
    err.code = 'DOC_POLICY_MISSING';
    err.missingPolicy = missingPolicy.map((o) => ({
      RunOrderId: o.RunOrderId,
      SapDocNum: o.SapDocNum,
      SapCardCode: o.SapCardCode,
      SapCardName: o.SapCardName,
      CompanyCode: o.CompanyCode,
    }));
    throw err;
  }

  // Group orders by their aggregation key — same key = same consolidated DN.
  const groups = new Map();
  for (const o of pending) {
    const key = o.AggregationKey || `card:${o.SapCardCode}:${o.CompanyCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const docsCreated = [];
  const invoicesCreated = [];

  for (const [groupKey, orders] of groups.entries()) {
    // All orders in a group share the same DocPolicy by construction (the
    // key is derived from it). Sniff the first order's policy to decide
    // whether to emit a DN, an INV, or both.
    const policyResult = _policyForOrder(orders[0]);
    const policy = policyResult?.policy;
    if (!policy) continue;
    const emitDN  = policy.aggregateDeliveryNote === 'yes';
    const emitINV = policy.aggregateInvoice === 'yes';
    if (!emitDN && !emitINV) continue;

    // Collapse picked lines across the group by ItemCode so the consolidated
    // DN has one row per item even if 3 stores ordered the same SKU.
    const byItem = new Map();
    const allShortages = [];
    let totalOrdered = 0;
    let totalPicked = 0;
    const sourceOrders = [];
    let anyPartial = false;

    for (const o of orders) {
      const fulfillment = _computeOrderFulfillment(o);
      totalOrdered += fulfillment.totalOrdered;
      totalPicked += fulfillment.totalPicked;
      if (fulfillment.isPartial) anyPartial = true;

      for (const ln of fulfillment.lines) {
        if (ln.Picked > 0) {
          const existing = byItem.get(ln.ItemCode);
          if (existing) {
            existing.Picked += ln.Picked;
            existing.Ordered += ln.Ordered;
            existing.SourceRunOrderIds.push(o.RunOrderId);
          } else {
            byItem.set(ln.ItemCode, {
              ItemCode: ln.ItemCode,
              ItemName: ln.ItemName,
              Ordered: ln.Ordered,
              Picked: ln.Picked,
              SourceRunOrderIds: [o.RunOrderId],
            });
          }
        }
        if (ln.Missing > 0) {
          allShortages.push({
            RunOrderId: o.RunOrderId,
            SapDocNum: o.SapDocNum,
            ItemCode: ln.ItemCode,
            ItemName: ln.ItemName,
            Ordered: ln.Ordered,
            Picked: ln.Picked,
            Missing: ln.Missing,
          });
        }
      }

      sourceOrders.push({
        RunOrderId: o.RunOrderId,
        SapDocEntry: o.SapDocEntry,
        SapDocNum: o.SapDocNum,
        SapCardCode: o.SapCardCode,
        SapCardName: o.SapCardName,
        OrderTotal: o.OrderTotal,
        LinesCount: o.LinesCount,
      });
    }

    const pickedLines = Array.from(byItem.values());
    const firstOrder = orders[0];
    const firstStop = _findStopOfOrder(firstOrder);

    let dn = null;
    if (emitDN) {
      dn = {
        DeliveryNoteId: s.nextDeliveryNoteId++,
        DocNumber: `DN-AGG-${runIdNum}-${firstOrder.CompanyCode}-${String(s.nextDeliveryNoteId).padStart(4, '0')}`,
        StopId: null, // aggregate — spans multiple stops
        RunId: runIdNum,
        RunOrderId: null, // aggregate — spans multiple orders
        CompanyCode: firstOrder.CompanyCode,
        CompanyName: firstOrder.CompanyName,
        SapCardCode: policyResult.source === 'parent' ? null : firstOrder.SapCardCode,
        SapCardName: policyResult.source === 'parent'
          ? parentNameOf(firstOrder.SapCardName)
          : firstOrder.SapCardName,
        SourceOrders: sourceOrders,
        TotalAmount: sourceOrders.reduce((sum, x) => sum + Number(x.OrderTotal || 0), 0),
        LineCount: pickedLines.length,
        IsAggregate: true,
        IsPartial: anyPartial,
        AggregationKey: groupKey,
        AggregationSource: policyResult.source,
        TotalOrdered: totalOrdered,
        TotalPicked: totalPicked,
        Lines: pickedLines,
        Shortages: allShortages,
        Status: 'PENDING_EXPORT',
        SapDeliveryDocEntry: null,
        SapDeliveryDocNum: null,
        ExportedAt: null,
        SentToSapAt: null,
        ConfirmedAt: null,
        ErrorMessage: null,
        // A2 audit fields — see A2-1 for rationale. A2-2 populates them.
        LastDryRunPayloadAt: null,
        LastDryRunPayloadPreview: null,
        SapWriteAttempts: 0,
        SapWriteAttemptedAt: null,
        SapWriteLastError: null,
        Notes: null,
        Address: firstStop ? {
          Street: firstStop.Street, BuildingNumber: firstStop.BuildingNumber,
          City: firstStop.City, BranchName: firstStop.BranchName,
        } : null,
        DeliveryDate: new Date().toISOString().slice(0, 10),
        CreatedAt: new Date().toISOString(),
        Method: options.method || 'AUTO_AGGREGATE_FLUSH',
      };
      s.deliveryNotes.push(dn);
      docsCreated.push(dn);

      // Link every order in the group to this DN.
      for (const o of orders) {
        o.DeliveryNoteId = dn.DeliveryNoteId;
        if (anyPartial) o.PartialFulfillment = true;
      }

      // Phase A2-2 (dry-run write) + A2c-4a (optional live write).
      // Default options.liveWrite=false → dryRun:true (no SAP HTTP). When
      // a caller explicitly opts in with { liveWrite: true }, dryRun:false
      // is passed to writeDeliveryNote — but the A2c-1 whitelist gate
      // there will still block the actual POST unless SAP_WRITE_ENABLED=
      // true AND the configured DBs are in SAP_LIVE_WRITE_DB_WHITELIST.
      // Audit fields are populated regardless of mode.
      dn.SapWriteAttempts = (dn.SapWriteAttempts || 0) + 1;
      dn.SapWriteAttemptedAt = new Date().toISOString();
      const liveWrite = options.liveWrite === true;
      try {
        const wr = await writeDeliveryNote(dn, { dryRun: !liveWrite });
        // Phase A2-3: validate critical payload fields BEFORE applying the
        // result. SAP would reject a /DeliveryNotes POST that's missing
        // CardCode, DocDate, or DocumentLines, so we catch it locally and
        // surface 422 with the exact missing fields. Same in both modes.
        if (wr.ok && wr.payload) {
          const missing = [];
          if (!wr.payload.CardCode) missing.push('CardCode');
          if (!wr.payload.DocDate)  missing.push('DocDate');
          if (!Array.isArray(wr.payload.DocumentLines) || wr.payload.DocumentLines.length === 0) {
            missing.push('DocumentLines');
          }
          if (missing.length) {
            const e = new Error(
              `תעודה ${dn.DocNumber} חסרה שדות קריטיים ב-payload: ${missing.join(', ')}`
            );
            e.status = 422;
            e.code = 'INVALID_PAYLOAD';
            e.missingFields = missing;
            e.docNumber = dn.DocNumber;
            throw e;
          }
        }
        // A2c-4a: apply the result (dry-run or live) via the pure helper.
        _applyWriteResultToDn(dn, wr);
      } catch (err) {
        dn.SapWriteLastError = err?.message || String(err);
        // Re-throw structured payload errors so the caller sees 422.
        if (err?.code === 'INVALID_PAYLOAD') throw err;
      }
    }

    if (emitINV && dn) {
      const inv = generateInvoiceFromDeliveryNote(dn.DeliveryNoteId, {
        method: options.method || 'AUTO_AGGREGATE_FLUSH',
      });
      if (inv) {
        invoicesCreated.push(inv);
        for (const o of orders) o.InvoiceId = inv.InvoiceId;
        // A2d (2026-05-19): mirror of the DN write block above. Default
        // options.liveWrite=false → dryRun:true. The A2c-1 whitelist gate
        // inside writeInvoice still blocks the actual POST unless
        // SAP_WRITE_ENABLED=true AND the configured DBs are in the
        // whitelist. Audit fields are populated regardless of mode.
        // A live DN write earlier in this iteration will have set
        // dn.SapDeliveryDocEntry — writeInvoice picks that up automatically
        // and switches to BaseType=15 payload. Otherwise it falls back to
        // a standalone ItemCode/Quantity payload built from dn.Lines.
        inv.SapWriteAttempts = (inv.SapWriteAttempts || 0) + 1;
        inv.SapWriteAttemptedAt = new Date().toISOString();
        try {
          const wr = await writeInvoice(inv, dn, { dryRun: !liveWrite });
          if (wr.ok && wr.payload) {
            const missing = [];
            if (!wr.payload.CardCode) missing.push('CardCode');
            if (!wr.payload.DocDate)  missing.push('DocDate');
            if (!Array.isArray(wr.payload.DocumentLines) || wr.payload.DocumentLines.length === 0) {
              missing.push('DocumentLines');
            }
            if (missing.length) {
              const e = new Error(
                `חשבונית ${inv.DocNumber} חסרה שדות קריטיים ב-payload: ${missing.join(', ')}`
              );
              e.status = 422;
              e.code = 'INVALID_PAYLOAD';
              e.missingFields = missing;
              e.docNumber = inv.DocNumber;
              throw e;
            }
          }
          _applyWriteResultToInv(inv, wr);
        } catch (err) {
          // Scope rule 4: a writeInvoice failure must NOT disturb the DN
          // that already went through its dry-run/apply step. Record the
          // error on the Invoice and continue. Re-throw only the structured
          // 422 INVALID_PAYLOAD so the operator sees which field broke.
          inv.SapWriteLastError = err?.message || String(err);
          if (err?.code === 'INVALID_PAYLOAD') throw err;
        }
      }
    } else if (emitINV && !dn) {
      // INV without DN — rare but legal: chain wants only consolidated INV
      // without a DN. Build INV directly from the picked lines.
      const inv = {
        InvoiceId: s.nextInvoiceId++,
        DocNumber: `INV-AGG-${runIdNum}-${firstOrder.CompanyCode}-${String(s.nextInvoiceId).padStart(4, '0')}`,
        RunId: runIdNum,
        DeliveryNoteId: null,
        CompanyCode: firstOrder.CompanyCode,
        SapCardCode: policyResult.source === 'parent' ? null : firstOrder.SapCardCode,
        SapCardName: policyResult.source === 'parent'
          ? parentNameOf(firstOrder.SapCardName)
          : firstOrder.SapCardName,
        SourceOrders: sourceOrders,
        TotalAmount: sourceOrders.reduce((sum, x) => sum + Number(x.OrderTotal || 0), 0),
        IsAggregate: true,
        AggregationKey: groupKey,
        Lines: pickedLines,
        Status: 'PENDING_EXPORT',
        SapInvoiceDocEntry: null,
        SapInvoiceDocNum: null,
        ExportedAt: null,
        SentToSapAt: null,
        ConfirmedAt: null,
        // A2d audit fields (mirror of generateInvoiceFromDeliveryNote).
        LastDryRunPayloadAt: null,
        LastDryRunPayloadPreview: null,
        SapWriteAttempts: 0,
        SapWriteAttemptedAt: null,
        SapWriteLastError: null,
        CreatedAt: new Date().toISOString(),
        Method: options.method || 'AUTO_AGGREGATE_FLUSH',
      };
      s.invoices.push(inv);
      invoicesCreated.push(inv);
      for (const o of orders) o.InvoiceId = inv.InvoiceId;
      // A2d: dry-run / live write for the INV-without-DN path. writeInvoice
      // sees no dn → falls back to inv.Lines for the standalone payload.
      inv.SapWriteAttempts = (inv.SapWriteAttempts || 0) + 1;
      inv.SapWriteAttemptedAt = new Date().toISOString();
      try {
        const wr = await writeInvoice(inv, null, { dryRun: !liveWrite });
        if (wr.ok && wr.payload) {
          const missing = [];
          if (!wr.payload.CardCode) missing.push('CardCode');
          if (!wr.payload.DocDate)  missing.push('DocDate');
          if (!Array.isArray(wr.payload.DocumentLines) || wr.payload.DocumentLines.length === 0) {
            missing.push('DocumentLines');
          }
          if (missing.length) {
            const e = new Error(
              `חשבונית ${inv.DocNumber} חסרה שדות קריטיים ב-payload: ${missing.join(', ')}`
            );
            e.status = 422;
            e.code = 'INVALID_PAYLOAD';
            e.missingFields = missing;
            e.docNumber = inv.DocNumber;
            throw e;
          }
        }
        _applyWriteResultToInv(inv, wr);
      } catch (err) {
        inv.SapWriteLastError = err?.message || String(err);
        if (err?.code === 'INVALID_PAYLOAD') throw err;
      }
    }

    // Clear the pending flag now that the docs are written.
    for (const o of orders) {
      o.AggregatePending = false;
    }
  }

  save();
  return {
    docsCreated,
    invoicesCreated,
    skipped,
    ordersTouched: pending.length,
  };
}

export function markDocsExported(docIds, type = 'deliveryNote') {
  const s = ensureDocsStore();
  const collection = type === 'invoice' ? s.invoices : s.deliveryNotes;
  const ids = docIds.map(Number);
  for (const doc of collection) {
    if (ids.includes(doc[type === 'invoice' ? 'InvoiceId' : 'DeliveryNoteId'])) {
      doc.Status = 'EXPORTED';
      doc.ExportedAt = new Date().toISOString();
    }
  }
  save();
}

// Minimum plausible SAP DocEntry. Real SAP TEST_OIG values seen in this
// environment: DN starts ~42000, OINV ~77000-86000. Any "real" SAP install
// also crosses 100 within hours of setup. Values < 100 are practically
// guaranteed to be operator-typed placeholders (1, 2, 3 etc. — we already
// have 3 such records in store: DN-40, DN-83, DN-84). Make the floor
// CONFIRM_SAP_MIN_DOCENTRY so a fresh test fixture can override it.
export const CONFIRM_SAP_MIN_DOCENTRY = 100;

// DEV.13: pure-function guard used by both `revertSapConfirmation` and the
// tests. Takes the raw doc and the field name to read DocEntry from, so the
// same logic serves both deliveryNote (SapDeliveryDocEntry) and invoice
// (SapInvoiceDocEntry). Returns {ok:true} or a structured error so the
// caller can map to HTTP / surface a UI message. Kept pure (no store
// access) so unit tests can drive every branch with hand-built fixtures
// without touching the real store.
export function canRevertConfirmation(doc, sapDocEntryField) {
  if (!doc || typeof doc !== 'object') {
    return { error: 'DOC_NOT_FOUND' };
  }
  if (doc.Status !== 'SAP_CONFIRMED') {
    return { error: 'NOT_SAP_CONFIRMED', current: doc.Status };
  }
  const currentDE = Number(doc[sapDocEntryField]);
  if (!Number.isInteger(currentDE) || currentDE < 1 || currentDE >= CONFIRM_SAP_MIN_DOCENTRY) {
    // Real SAP DocEntries are ≥ CONFIRM_SAP_MIN_DOCENTRY. Anything else is
    // either a placeholder (1, 0) or already a real ID we MUST NOT touch
    // through this endpoint — reverting a real confirmation needs a
    // different, more deliberate flow with stronger guards.
    return {
      error: 'NOT_SUSPICIOUS',
      currentDocEntry: doc[sapDocEntryField],
      floor: CONFIRM_SAP_MIN_DOCENTRY,
    };
  }
  return { ok: true };
}

// DEV.13: undo a placeholder/typo SAP confirmation by resetting the local
// fields back to the pre-confirm state. Only allowed for SAP_CONFIRMED
// rows whose SapDocEntry is a placeholder (< CONFIRM_SAP_MIN_DOCENTRY) —
// i.e. exactly the rows the audit identifies as suspicious. Does NOT touch
// SAP itself; this is a local-store-only correction. Returns:
//   null                       — doc id not found
//   { error, ... }             — guard rejected the operation
//   { doc, previous }          — success, with previous values for audit
export function revertSapConfirmation(type, docId) {
  const s = ensureDocsStore();
  const arr = type === 'invoice' ? s.invoices : s.deliveryNotes;
  const idKey = type === 'invoice' ? 'InvoiceId' : 'DeliveryNoteId';
  const deKey = type === 'invoice' ? 'SapInvoiceDocEntry' : 'SapDeliveryDocEntry';
  const dnKey = type === 'invoice' ? 'SapInvoiceDocNum'  : 'SapDeliveryDocNum';

  const doc = arr.find((d) => d[idKey] === Number(docId));
  if (!doc) return null;

  const guard = canRevertConfirmation(doc, deKey);
  if (guard.error) return guard;

  // Capture pre-mutation values for the audit log + response. Snapshotting
  // here, AFTER the guard, ensures we never return previous values for a
  // rejected revert.
  const previous = {
    SapDocEntry: doc[deKey],
    SapDocNum: doc[dnKey],
    ConfirmedAt: doc.ConfirmedAt,
  };

  doc.Status = 'PENDING_EXPORT';
  doc[deKey] = null;
  doc[dnKey] = null;
  doc.ConfirmedAt = null;
  save();

  return { doc, previous };
}

export function confirmSapDocument(docId, type, sapDocEntry, sapDocNum) {
  // 2026-05-24 safeguard: reject placeholder/typo DocEntries that produced
  // 3 fake SAP_CONFIRMED records in our store. Returns a structured error
  // object (not an exception, not null) so the route can map to HTTP 400
  // distinctly from "document not found" (null → 404).
  const numEntry = Number(sapDocEntry);
  if (!Number.isInteger(numEntry) || numEntry < CONFIRM_SAP_MIN_DOCENTRY) {
    return {
      error: 'INVALID_SAP_DOC_ENTRY',
      message: `sapDocEntry must be an integer ≥ ${CONFIRM_SAP_MIN_DOCENTRY} (got ${JSON.stringify(sapDocEntry)}). Real SAP DocEntries are 4-5+ digits; values below the floor are placeholders.`,
      provided: { sapDocEntry, sapDocNum },
      floor: CONFIRM_SAP_MIN_DOCENTRY,
    };
  }
  const numDocNum = Number(sapDocNum);
  if (!Number.isInteger(numDocNum) || numDocNum <= 0) {
    return {
      error: 'INVALID_SAP_DOC_NUM',
      message: `sapDocNum must be a positive integer (got ${JSON.stringify(sapDocNum)}).`,
      provided: { sapDocEntry, sapDocNum },
    };
  }
  const s = ensureDocsStore();
  if (type === 'deliveryNote') {
    const dn = s.deliveryNotes.find((d) => d.DeliveryNoteId === Number(docId));
    if (!dn) return null;
    dn.Status = 'SAP_CONFIRMED';
    dn.SapDeliveryDocEntry = numEntry;
    dn.SapDeliveryDocNum = numDocNum;
    dn.ConfirmedAt = new Date().toISOString();
    save();
    return dn;
  } else {
    const inv = s.invoices.find((d) => d.InvoiceId === Number(docId));
    if (!inv) return null;
    inv.Status = 'SAP_CONFIRMED';
    inv.SapInvoiceDocEntry = numEntry;
    inv.SapInvoiceDocNum = numDocNum;
    inv.ConfirmedAt = new Date().toISOString();
    save();
    return inv;
  }
}

export function listDeliveryNotes({ runId, stopId, companyCode, status, runDate } = {}) {
  const s = ensureDocsStore();
  let result = [...s.deliveryNotes];
  if (runId) result = result.filter((d) => d.RunId === Number(runId));
  if (stopId) result = result.filter((d) => d.StopId === Number(stopId));
  if (companyCode) result = result.filter((d) => d.CompanyCode === companyCode);
  if (status) result = result.filter((d) => d.Status === status);
  if (runDate) {
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    result = result.filter((d) => runIds.includes(d.RunId));
  }
  return result.sort((a, b) => b.DeliveryNoteId - a.DeliveryNoteId);
}

export function listInvoices({ runId, stopId, companyCode, status, runDate } = {}) {
  const s = ensureDocsStore();
  let result = [...s.invoices];
  if (runId) result = result.filter((d) => d.RunId === Number(runId));
  if (stopId) result = result.filter((d) => d.StopId === Number(stopId));
  if (companyCode) result = result.filter((d) => d.CompanyCode === companyCode);
  if (status) result = result.filter((d) => d.Status === status);
  if (runDate) {
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    result = result.filter((d) => runIds.includes(d.RunId));
  }
  return result.sort((a, b) => b.InvoiceId - a.InvoiceId);
}

/**
 * A2e (2026-05-20): pure aggregate over the A2-1 + A2d audit fields.
 *
 * Surfaces three things operators need to see at a glance:
 *
 *   - withErrors:  how many DNs/INVs currently carry a SapWriteLastError.
 *     This is the "stuck writes" counter. Includes both dry-run validation
 *     failures (rare — INVALID_PAYLOAD only) and live HTTP failures (will
 *     start happening once SAP_WRITE_ENABLED flips). When > 0, operator
 *     should inspect the offending docs before approving more flushes.
 *
 *   - totalAttempts: cumulative SapWriteAttempts across all docs. A
 *     proxy for writer activity — useful to spot a runaway retry loop
 *     or to confirm that a flush actually ran.
 *
 *   - lastWriteAttemptAt: most recent LastDryRunPayloadAt across BOTH
 *     doc types. Tells the operator when the SAP writer last produced
 *     a payload (dry-run OR live). Helps detect a dead writer.
 *
 * Pure function — takes arrays in, no env, no store reads. Exported as
 * _computeAuditSummary for unit tests in persistentStore.auditSummary.test.js.
 */
export function _computeAuditSummary(deliveryNotes, invoices) {
  const dns = Array.isArray(deliveryNotes) ? deliveryNotes : [];
  const invs = Array.isArray(invoices) ? invoices : [];

  const dnWithErrors = dns.filter((d) => d && d.SapWriteLastError).length;
  const invWithErrors = invs.filter((d) => d && d.SapWriteLastError).length;
  // `Number('not-a-number') || 0` evaluates to NaN (because the string is
  // truthy, so the || never fires), which poisons the sum. Coerce then
  // gate on Number.isFinite so anything non-numeric contributes 0.
  const toCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const dnAttempts = dns.reduce((sum, d) => sum + toCount(d?.SapWriteAttempts), 0);
  const invAttempts = invs.reduce((sum, d) => sum + toCount(d?.SapWriteAttempts), 0);

  // Most recent LastDryRunPayloadAt across both doc types. We treat the
  // strings as ISO-8601 (which is the format used everywhere the field is
  // set), so lexicographic max == chronological max. null/undefined entries
  // are skipped.
  let lastAt = null;
  for (const d of dns) {
    if (d?.LastDryRunPayloadAt && (lastAt == null || d.LastDryRunPayloadAt > lastAt)) {
      lastAt = d.LastDryRunPayloadAt;
    }
  }
  for (const d of invs) {
    if (d?.LastDryRunPayloadAt && (lastAt == null || d.LastDryRunPayloadAt > lastAt)) {
      lastAt = d.LastDryRunPayloadAt;
    }
  }

  return {
    deliveryNotes: { withErrors: dnWithErrors, totalAttempts: dnAttempts },
    invoices:      { withErrors: invWithErrors, totalAttempts: invAttempts },
    lastWriteAttemptAt: lastAt,
    combinedErrorsCount: dnWithErrors + invWithErrors,
  };
}

export function getDocumentStats({ runDate } = {}) {
  const s = ensureDocsStore();
  const filterByDate = (docs) => {
    if (!runDate) return docs;
    const runIds = s.runs.filter((r) => r.RunDate === runDate).map((r) => r.RunId);
    return docs.filter((d) => runIds.includes(d.RunId));
  };

  const dns = filterByDate(s.deliveryNotes);
  const invs = filterByDate(s.invoices);

  return {
    deliveryNotes: {
      total: dns.length,
      byCompany: {
        A: dns.filter((d) => d.CompanyCode === 'A').length,
        B: dns.filter((d) => d.CompanyCode === 'B').length,
      },
      byStatus: {
        pendingExport: dns.filter((d) => d.Status === 'PENDING_EXPORT').length,
        exported: dns.filter((d) => d.Status === 'EXPORTED').length,
        confirmed: dns.filter((d) => d.Status === 'SAP_CONFIRMED').length,
        failed: dns.filter((d) => d.Status === 'FAILED').length,
      },
      totalAmount: dns.reduce((sum, d) => sum + Number(d.TotalAmount || 0), 0),
    },
    invoices: {
      total: invs.length,
      byCompany: {
        A: invs.filter((d) => d.CompanyCode === 'A').length,
        B: invs.filter((d) => d.CompanyCode === 'B').length,
      },
      byStatus: {
        pendingExport: invs.filter((d) => d.Status === 'PENDING_EXPORT').length,
        exported: invs.filter((d) => d.Status === 'EXPORTED').length,
        confirmed: invs.filter((d) => d.Status === 'SAP_CONFIRMED').length,
      },
      totalAmount: invs.reduce((sum, d) => sum + Number(d.TotalAmount || 0), 0),
      vatAmount: invs.reduce((sum, d) => sum + Number(d.VatAmount || 0), 0),
      grossAmount: invs.reduce((sum, d) => sum + Number(d.GrossAmount || 0), 0),
    },
    // A2e: audit summary over A2-1 + A2d audit fields. Additive — existing
    // consumers ignore this block.
    audit: _computeAuditSummary(dns, invs),
  };
}

// =====================================================================
// Customer Delivery Profiles — loaded from OIG + UNICO master xlsx via
// scripts/load_customer_profiles.py. Each profile carries the canonical
// zone, optional sub-zone, and the customer's weekly delivery days.
// =====================================================================
function _profiles() {
  return load().customerDeliveryProfiles || [];
}

/** Return all profiles, optionally filtered. */
export function getCustomerProfiles({ zone, day, company, issue } = {}) {
  let rows = _profiles();
  if (zone)    rows = rows.filter((p) => p.Zone === zone);
  if (company) rows = rows.filter((p) => p.Company === company);
  if (day)     rows = rows.filter((p) => Array.isArray(p.DeliveryDays) && p.DeliveryDays.includes(day));
  if (issue === 'true')  rows = rows.filter((p) => !!p.Issue);
  if (issue === 'false') rows = rows.filter((p) => !p.Issue);
  return rows;
}

/** Find a single profile by CardCode (+ optional Company disambiguation). */
export function getCustomerProfile(cardCode, company) {
  const key = String(cardCode || '').trim();
  if (!key) return null;
  const rows = _profiles().filter((p) => String(p.CardCode) === key);
  if (rows.length === 0) return null;
  if (company) {
    const exact = rows.find((p) => p.Company === company);
    if (exact) return exact;
  }
  return rows[0];
}

/** Update the DocPolicy of a single profile. Returns the updated profile or null. */
const ALLOWED_POLICY_VALUES = new Set(['yes', 'no', 'na', '']);
const POLICY_KEYS = ['perOrderDeliveryNote', 'perOrderInvoice', 'aggregateDeliveryNote', 'aggregateInvoice'];

export function setCustomerProfilePolicy(cardCode, company, patch) {
  const key = String(cardCode || '').trim();
  if (!key) return null;
  const data = load();
  const rows = (data.customerDeliveryProfiles || []).filter((p) => String(p.CardCode) === key);
  if (rows.length === 0) return null;
  const target = (company && rows.find((p) => p.Company === company)) || rows[0];

  if (!target.DocPolicy) {
    target.DocPolicy = { perOrderDeliveryNote: '', perOrderInvoice: '', aggregateDeliveryNote: '', aggregateInvoice: '', notes: '' };
  }
  for (const k of POLICY_KEYS) {
    if (k in (patch || {})) {
      const v = String(patch[k] || '').toLowerCase();
      if (!ALLOWED_POLICY_VALUES.has(v)) {
        const err = new Error(`Invalid value for ${k}: ${patch[k]}. Allowed: yes/no/na/empty`);
        err.status = 400;
        throw err;
      }
      target.DocPolicy[k] = v;
    }
  }
  if (typeof patch?.notes === 'string') {
    target.DocPolicy.notes = patch.notes.slice(0, 500);
  }
  target.DocPolicy.updatedAt = new Date().toISOString();
  save();
  return target;
}

/** Summary counts by zone / day / issue rate, for the planning dashboard. */
export function getCustomerProfileStats() {
  const rows = _profiles();
  const byZone = {};
  const byDay  = {};
  const byCompany = {};
  let issues = 0;
  for (const p of rows) {
    if (p.Issue) { issues++; continue; }
    byZone[p.Zone] = (byZone[p.Zone] || 0) + 1;
    byCompany[p.Company] = (byCompany[p.Company] || 0) + 1;
    for (const d of (p.DeliveryDays || [])) {
      byDay[d] = (byDay[d] || 0) + 1;
    }
  }
  return { total: rows.length, withIssues: issues, byZone, byDay, byCompany };
}

// =====================================================================
// QC Control — P3 (2026-05-26)
//
// Per-order QC review for the post-picking control screen. Two new pure
// functions:
//   - listQcPendingOrders(filters): orders sitting in waves that the
//     picker submitted to QC and that haven't been approved or rejected.
//   - rejectOrderQc(runOrderId, opts): marks an order as QcRejected with
//     a reason; the wave stays in PENDING_QC for other orders.
//
// Approval reuses the existing generateDocsForRunOrder() (creates DN/INV
// per the customer's DocPolicy, idempotent). No SAP HTTP; LOCAL ONLY.
// =====================================================================

/**
 * List orders pending QC approval. Returns one row per RunOrder whose
 * wave is in PENDING_QC and which doesn't already have a DN/INV (= not
 * yet approved) and isn't QC-rejected.
 *
 * Filters (all optional):
 *   - runDate:  'YYYY-MM-DD' — match run.RunDate
 *   - pickerId: number       — match wave.AssignedPickerId
 *   - zoneCode: string       — match run.ZoneCode
 *   - status:   string       — override the default wave status filter
 *                              (default: only PENDING_QC waves)
 */
export function listQcPendingOrders(filters = {}) {
  const s = load();
  const waves     = s.waves || [];
  const stops     = s.stops || [];
  const runs      = s.runs || [];
  const runOrders = s.runOrders || [];

  // Index for O(1) lookups.
  const wavesByRun = new Map();
  for (const w of waves) {
    if (!wavesByRun.has(w.RunId)) wavesByRun.set(w.RunId, []);
    wavesByRun.get(w.RunId).push(w);
  }
  const stopsByRun = new Map();
  for (const st of stops) {
    if (!stopsByRun.has(st.RunId)) stopsByRun.set(st.RunId, []);
    stopsByRun.get(st.RunId).push(st);
  }
  const ordersByStop = new Map();
  for (const o of runOrders) {
    if (!ordersByStop.has(o.StopId)) ordersByStop.set(o.StopId, []);
    ordersByStop.get(o.StopId).push(o);
  }

  const targetStatus = filters.status || 'PENDING_QC';
  const out = [];

  for (const run of runs) {
    if (filters.runDate && run.RunDate !== filters.runDate) continue;
    if (filters.zoneCode && run.ZoneCode !== filters.zoneCode) continue;

    const runWaves = (wavesByRun.get(run.RunId) || []).filter((w) => {
      if (w.Status !== targetStatus) return false;
      if (filters.pickerId != null && w.AssignedPickerId !== filters.pickerId) return false;
      return true;
    });
    if (runWaves.length === 0) continue;

    const runStops = stopsByRun.get(run.RunId) || [];
    for (const stop of runStops) {
      const orders = ordersByStop.get(stop.StopId) || [];
      for (const order of orders) {
        // Skip already-approved (has DN/INV) and already-rejected.
        if (order.DeliveryNoteId || order.InvoiceId) continue;
        if (order.QcRejected) continue;
        // The QC controller needs every wave that holds this stop's orders;
        // we surface only the first matching wave per (run,stop) — usually
        // there's exactly one wave per run anyway.
        const wave = runWaves[0];
        out.push({
          RunOrderId:        order.RunOrderId,
          SapCardCode:       order.SapCardCode,
          SapCardName:       order.SapCardName,
          SapDocNum:         order.SapDocNum,
          SapDocEntry:       order.SapDocEntry,
          OrderTotal:        order.OrderTotal,
          LinesCount:        order.LinesCount,
          StopId:            stop.StopId,
          StopSequence:      stop.Sequence || null,
          StopAddress:       stop.Address || null,
          RunId:             run.RunId,
          RunNumber:         run.RunNumber,
          RunDate:           run.RunDate,
          ZoneCode:          run.ZoneCode,
          ZoneName:          run.ZoneName,
          DriverName:        run.DriverName || null,
          WaveId:            wave.WaveId,
          WaveNumber:        wave.WaveNumber,
          WaveStatus:        wave.Status,
          AssignedPickerId:  wave.AssignedPickerId || null,
          AssignedPickerName: wave.AssignedPickerName || null,
          PickedByName:      wave.PickedByName || null,
          QcSubmittedAt:     wave.CompletedAt || wave.UpdatedAt || null,
        });
      }
    }
  }
  return out;
}

/**
 * Reject a per-order QC. Marks the order with QcRejected=true plus a
 * reason and a timestamp. The wave stays in PENDING_QC so other orders
 * in the same wave can still be approved. The rejected order keeps its
 * picking allocations — operator can re-pick or escalate manually.
 *
 * Returns:
 *   { ok: true, order }                                 — success
 *   { error: 'ORDER_NOT_FOUND' }                        — bad id → 404 caller
 *   { error: 'ALREADY_APPROVED', message }              — has DN → 400
 *   { error: 'ALREADY_REJECTED', current: {...} }       — duplicate → 400
 */
export function rejectOrderQc(runOrderId, opts = {}) {
  const s = load();
  const order = (s.runOrders || []).find((o) => o.RunOrderId === Number(runOrderId));
  if (!order) return { error: 'ORDER_NOT_FOUND' };
  if (order.DeliveryNoteId || order.InvoiceId) {
    return {
      error: 'ALREADY_APPROVED',
      message: 'ההזמנה כבר אושרה ויש לה תעודות; אי אפשר לדחות עכשיו',
    };
  }
  if (order.QcRejected) {
    return {
      error: 'ALREADY_REJECTED',
      current: {
        reason: order.QcRejectionReason || null,
        at: order.QcRejectedAt || null,
        by: order.QcRejectedBy || null,
      },
    };
  }
  order.QcRejected        = true;
  order.QcRejectionReason = opts.reason || null;
  order.QcRejectedBy      = opts.rejectedBy || null;
  order.QcRejectedAt      = new Date().toISOString();
  save();
  return { ok: true, order };
}
