/**
 * Unit tests — screenRegistry (2026-05-30).
 *
 * Covers the pure-data exports + the small helper isScreenAllowedForList.
 * No store, no I/O, no async. Run:
 *   cd backend && node --test src/demo/screenRegistry.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCREENS,
  ROLE_CODES,
  DEFAULT_ROLE_PERMISSIONS,
  isScreenAllowedForList,
} from './screenRegistry.js';

test('SCREENS contains every section + has unique codes', () => {
  assert.ok(SCREENS.length >= 20, 'expected at least 20 registered screens');
  const sections = new Set(SCREENS.map((s) => s.section));
  for (const required of ['workflow', 'reports', 'settings', 'standalone']) {
    assert.ok(sections.has(required), `missing section "${required}"`);
  }
  const codes = SCREENS.map((s) => s.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate screen codes');
});

test('SCREENS every entry has the required shape', () => {
  for (const s of SCREENS) {
    assert.equal(typeof s.code, 'string', `${JSON.stringify(s)} bad code`);
    assert.ok(s.code.startsWith('/'), `${s.code} should start with "/"`);
    assert.equal(typeof s.label, 'string', `${s.code} missing label`);
    assert.ok(s.label.length > 0, `${s.code} empty label`);
    assert.equal(typeof s.section, 'string', `${s.code} missing section`);
  }
});

test('ROLE_CODES includes the operational roles', () => {
  for (const required of ['ADMIN', 'PLANNER', 'PICKER', 'QC_CONTROLLER', 'DRIVER']) {
    assert.ok(ROLE_CODES.includes(required), `missing role ${required}`);
  }
});

test('DEFAULT_ROLE_PERMISSIONS — ADMIN is wildcard', () => {
  assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.ADMIN, ['*']);
});

test('DEFAULT_ROLE_PERMISSIONS — PICKER is narrow (warehouse only)', () => {
  assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.PICKER, ['/warehouse']);
});

test('DEFAULT_ROLE_PERMISSIONS — QC_CONTROLLER sees picking + qc + dashboard', () => {
  const p = DEFAULT_ROLE_PERMISSIONS.QC_CONTROLLER;
  assert.ok(p.includes('/warehouse'), 'QC needs picking access');
  assert.ok(p.includes('/qc-control'), 'QC needs its own page');
  assert.ok(p.includes('/'), 'QC needs dashboard');
  // Critical: must NOT see admin pages
  assert.equal(p.includes('/users'), false, 'QC must not access user management');
  assert.equal(p.includes('/role-permissions'), false, 'QC must not edit perms');
});

test('DEFAULT_ROLE_PERMISSIONS — every ROLE_CODES entry has a default', () => {
  for (const code of ROLE_CODES) {
    assert.ok(
      DEFAULT_ROLE_PERMISSIONS[code] !== undefined,
      `${code} missing from DEFAULT_ROLE_PERMISSIONS`,
    );
    assert.ok(
      Array.isArray(DEFAULT_ROLE_PERMISSIONS[code]),
      `${code} default is not an array`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────
// isScreenAllowedForList — the core membership check
// ─────────────────────────────────────────────────────────────────────
test('isScreenAllowedForList — wildcard matches anything', () => {
  assert.equal(isScreenAllowedForList(['*'], '/anything'), true);
  assert.equal(isScreenAllowedForList(['*'], '/users'), true);
  assert.equal(isScreenAllowedForList(['*'], '/totally-unknown'), true);
});

test('isScreenAllowedForList — explicit list matches member', () => {
  assert.equal(isScreenAllowedForList(['/warehouse', '/qc-control'], '/warehouse'), true);
  assert.equal(isScreenAllowedForList(['/warehouse', '/qc-control'], '/qc-control'), true);
});

test('isScreenAllowedForList — explicit list rejects non-member', () => {
  assert.equal(isScreenAllowedForList(['/warehouse'], '/users'), false);
  assert.equal(isScreenAllowedForList(['/warehouse'], '/'), false);
});

test('isScreenAllowedForList — empty list rejects everything', () => {
  assert.equal(isScreenAllowedForList([], '/'), false);
  assert.equal(isScreenAllowedForList([], '/warehouse'), false);
});

test('isScreenAllowedForList — non-array input rejects safely', () => {
  assert.equal(isScreenAllowedForList(null, '/'), false);
  assert.equal(isScreenAllowedForList(undefined, '/'), false);
  assert.equal(isScreenAllowedForList('*', '/'), false); // string, not array
});
