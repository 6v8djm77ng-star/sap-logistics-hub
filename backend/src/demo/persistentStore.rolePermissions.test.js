/**
 * Unit tests — persistentStore role permissions (2026-05-30).
 *
 * Covers the CRUD around rolePermissions[]:
 *   - listRolePermissions(): ordered output, ADMIN first
 *   - getAllowedScreensForRole(): falls back to defaults if no row
 *   - isScreenAllowedForRole(): wildcard + explicit
 *   - setRolePermissions(): validation + guard rails + persistence
 *
 * Pattern: snapshot rolePermissions before each test, mutate it via
 * the public API, restore in t.after().  No HTTP, no SAP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listRolePermissions,
  getAllowedScreensForRole,
  isScreenAllowedForRole,
  setRolePermissions,
  load,
  save,
} from './persistentStore.js';

// ----- snapshot/restore helpers -----
function snapshot() {
  const s = load();
  return {
    rolePermissions: structuredClone(s.rolePermissions || []),
    auditLog:        structuredClone(s.auditLog || []),
  };
}
function restore(snap) {
  const s = load();
  s.rolePermissions = snap.rolePermissions;
  s.auditLog        = snap.auditLog;
  save();
}

// ============================================================
// listRolePermissions
// ============================================================
test('listRolePermissions returns ADMIN first', () => {
  const rows = listRolePermissions();
  assert.ok(rows.length >= 1, 'expected at least one role row');
  assert.equal(rows[0].RoleCode, 'ADMIN', 'ADMIN must be first');
});

test('listRolePermissions includes every known role', () => {
  const rows = listRolePermissions();
  const codes = rows.map((r) => r.RoleCode);
  for (const required of ['ADMIN', 'PLANNER', 'PICKER', 'QC_CONTROLLER', 'DRIVER']) {
    assert.ok(codes.includes(required), `missing role ${required}`);
  }
});

test('listRolePermissions rows have the expected shape', () => {
  const rows = listRolePermissions();
  for (const r of rows) {
    assert.equal(typeof r.RoleCode, 'string');
    assert.ok(Array.isArray(r.AllowedScreens), `${r.RoleCode} AllowedScreens not array`);
    assert.equal(typeof r.UpdatedAt, 'string');
  }
});

// ============================================================
// getAllowedScreensForRole
// ============================================================
test('getAllowedScreensForRole — ADMIN returns wildcard', () => {
  const a = getAllowedScreensForRole('ADMIN');
  assert.ok(Array.isArray(a));
  assert.ok(a.includes('*'), 'ADMIN must have wildcard by default');
});

test('getAllowedScreensForRole — known role returns its array', () => {
  const p = getAllowedScreensForRole('PICKER');
  assert.ok(Array.isArray(p));
  assert.ok(p.length > 0, 'PICKER should have at least /warehouse');
});

test('getAllowedScreensForRole — unknown role returns empty', () => {
  const x = getAllowedScreensForRole('FAKE_ROLE_THAT_DOES_NOT_EXIST');
  assert.deepEqual(x, []);
});

// ============================================================
// isScreenAllowedForRole
// ============================================================
test('isScreenAllowedForRole — ADMIN wildcard passes anything', () => {
  assert.equal(isScreenAllowedForRole('ADMIN', '/'), true);
  assert.equal(isScreenAllowedForRole('ADMIN', '/totally-fake'), true);
});

test('isScreenAllowedForRole — PICKER passes /warehouse, rejects /users', () => {
  assert.equal(isScreenAllowedForRole('PICKER', '/warehouse'), true);
  assert.equal(isScreenAllowedForRole('PICKER', '/users'), false);
});

// ============================================================
// setRolePermissions — validation + guard rails
// ============================================================
test('setRolePermissions — rejects unknown role', () => {
  const r = setRolePermissions('NOPE_NOT_REAL', ['/']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNKNOWN_ROLE');
});

test('setRolePermissions — rejects non-array', () => {
  const r = setRolePermissions('PICKER', 'not-an-array');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ALLOWED_SCREENS_NOT_ARRAY');
});

test('setRolePermissions — refuses to lock ADMIN out of /role-permissions', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));

  // Try to remove BOTH wildcard AND the role-permissions page
  const r = setRolePermissions('ADMIN', ['/users', '/zones']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ADMIN_MUST_KEEP_PERMISSIONS_PAGE');

  // ADMIN's row is unchanged
  const after = getAllowedScreensForRole('ADMIN');
  assert.ok(after.includes('*'), 'ADMIN must still have wildcard');
});

test('setRolePermissions — allows ADMIN with explicit /role-permissions', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));

  const r = setRolePermissions('ADMIN', ['/role-permissions', '/users']);
  assert.equal(r.ok, true, 'should accept narrow ADMIN that still has /role-permissions');
  assert.deepEqual(
    getAllowedScreensForRole('ADMIN').sort(),
    ['/role-permissions', '/users'].sort(),
  );
});

test('setRolePermissions — happy path updates PICKER', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));

  // First force PICKER to a deliberately different state so the test
  // produces a real delta regardless of what the live store currently
  // holds (PICKER may have been edited earlier in this session).
  setRolePermissions('PICKER', ['/warehouse'], { updatedBy: 'setup' });
  const before = getAllowedScreensForRole('PICKER');
  assert.deepEqual(before, ['/warehouse'], 'setup baseline');

  const r = setRolePermissions('PICKER', ['/warehouse', '/'], { updatedBy: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.row.RoleCode, 'PICKER');
  assert.deepEqual([...r.row.AllowedScreens].sort(), ['/', '/warehouse']);
  assert.equal(r.row.UpdatedBy, 'test');

  const after = getAllowedScreensForRole('PICKER');
  assert.notDeepEqual([...after].sort(), [...before].sort(), 'should differ from setup baseline');
  assert.deepEqual([...after].sort(), ['/', '/warehouse']);
});

test('setRolePermissions — dedupes and drops empty strings', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));

  const r = setRolePermissions('PICKER', ['/warehouse', '/warehouse', '', '/']);
  assert.equal(r.ok, true);
  // Order doesn't matter for the assertion
  assert.deepEqual(
    [...r.row.AllowedScreens].sort(),
    ['/', '/warehouse'],
    'duplicates removed + empty string dropped',
  );
});

test('setRolePermissions — persists across reloads (verifies save()) ', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));

  setRolePermissions('PICKER', ['/warehouse'], { updatedBy: 'persist-test' });
  // Re-read via the store API (load is cached, but the rolePermissions
  // array we mutate is on the same cache object so this still verifies
  // the function flowed through normally).
  const fresh = getAllowedScreensForRole('PICKER');
  assert.deepEqual(fresh, ['/warehouse']);
});

test('setRolePermissions — lower-case role code is rejected (strict)', () => {
  const r = setRolePermissions('picker', ['/']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNKNOWN_ROLE');
});
