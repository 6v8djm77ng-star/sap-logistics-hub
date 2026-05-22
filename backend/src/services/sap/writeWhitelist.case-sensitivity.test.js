/**
 * Unit tests — SAP_LIVE_WRITE_DB_WHITELIST case-sensitivity guarantees.
 *
 * Why this exists:
 *   parseWhitelist() relies on String.prototype.includes via Array.includes,
 *   which is case-sensitive in JS. SAP B1 company DB names are also case-
 *   sensitive when passed to the Service Layer Login body. So a whitelist
 *   entry of 'TEST_OIG' must NOT match a CompanyDB of 'Test_OIG'. This
 *   guarantee was actively broken in B1 attempt #1 (2026-05-21) when the
 *   .env had mixed-case 'Test_OIG' while sys.databases held 'TEST_OIG'.
 *
 * These tests pin that contract so a future refactor can't silently
 * introduce case-folding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _checkLiveWriteWhitelist, parseWhitelist } from './writeWhitelist.js';

test('parseWhitelist: CSV → array, trims whitespace, drops empty', () => {
  assert.deepEqual(parseWhitelist('TEST_OIG,Test_Unico'), ['TEST_OIG', 'Test_Unico']);
  assert.deepEqual(parseWhitelist(' TEST_OIG , Test_Unico '), ['TEST_OIG', 'Test_Unico']);
  assert.deepEqual(parseWhitelist('TEST_OIG,,Test_Unico,'), ['TEST_OIG', 'Test_Unico']);
  assert.deepEqual(parseWhitelist(''), []);
  assert.deepEqual(parseWhitelist(null), []);
  assert.deepEqual(parseWhitelist(undefined), []);
});

test('writeEnabled=false → ok regardless of whitelist / DBs (dry-run bypass)', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: false,
    whitelist: '',
    dbA: 'SAP_OIG',
    dbB: 'SAP_Unico',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'WRITE_DISABLED');
});

test('writeEnabled=true + empty whitelist → fail with WHITELIST_REQUIRED', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: '',
    dbA: 'TEST_OIG',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WHITELIST_REQUIRED');
});

test('exact-case match → ok', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_Unico',
    dbA: 'TEST_OIG',
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'WHITELISTED');
  assert.deepEqual(r.whitelist, ['TEST_OIG', 'Test_Unico']);
});

test('case mismatch on dbA (Test_OIG vs whitelist TEST_OIG) → fail', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_Unico',
    dbA: 'Test_OIG',          // mixed case ≠ whitelist uppercase
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.equal(r.offenders.length, 1);
  assert.equal(r.offenders[0].company, 'A');
  assert.equal(r.offenders[0].db, 'Test_OIG');
});

test('case mismatch on dbB (test_unico vs whitelist Test_Unico) → fail', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_Unico',
    dbA: 'TEST_OIG',
    dbB: 'test_unico',         // lowercase ≠ Test_Unico
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.equal(r.offenders.length, 1);
  assert.equal(r.offenders[0].company, 'B');
});

test('production DBs (SAP_OIG / SAP_Unico) blocked even if test DBs whitelisted', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_Unico',
    dbA: 'SAP_OIG',
    dbB: 'SAP_Unico',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.equal(r.offenders.length, 2);
});

test('only one DB configured (no dbB) → check only the configured one', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG',
    dbA: 'TEST_OIG',
    dbB: '',
  });
  assert.equal(r.ok, true);
});

test('no case-folding via mixed-case whitelist entry', () => {
  // Whitelist contains lowercase 'test_oig' — must NOT match TEST_OIG
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'test_oig',
    dbA: 'TEST_OIG',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
});

test('whitelist with both cases listed → either case matches its own entry', () => {
  // If operator hedges by putting both, each exact match works
  const r1 = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_OIG',
    dbA: 'TEST_OIG',
  });
  assert.equal(r1.ok, true);
  const r2 = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'TEST_OIG,Test_OIG',
    dbA: 'Test_OIG',
  });
  assert.equal(r2.ok, true);
});
