/**
 * Unit tests for the A2c-1 SAP write whitelist gate.
 *
 * Strategy: _checkLiveWriteWhitelist is a pure function that takes its
 * inputs explicitly (writeEnabled, whitelist string, dbA, dbB) instead of
 * reading process.env. This keeps the tests fully deterministic — no
 * environment manipulation, no module reloading.
 *
 * Run: cd backend && node --test src/demo/sapWriter.whitelist.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _checkLiveWriteWhitelist, parseWhitelist } from './sapWriter.js';

// ============================================================================
// parseWhitelist
// ============================================================================

test('parseWhitelist: empty / undefined / null → []', () => {
  assert.deepEqual(parseWhitelist(''), []);
  assert.deepEqual(parseWhitelist(undefined), []);
  assert.deepEqual(parseWhitelist(null), []);
});

test('parseWhitelist: trims whitespace + drops empty entries', () => {
  assert.deepEqual(parseWhitelist(' SAP_OIG_TEST_290724 , Test_Unico ,  '),
    ['SAP_OIG_TEST_290724', 'Test_Unico']);
});

test('parseWhitelist: single entry, no comma', () => {
  assert.deepEqual(parseWhitelist('SAP_OIG_TEST_290724'), ['SAP_OIG_TEST_290724']);
});

// ============================================================================
// _checkLiveWriteWhitelist — write disabled (dry-run)
// ============================================================================

test('A2c-1: writeEnabled=false → ok regardless of anything else', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: false,
    whitelist: '',  // intentionally empty
    dbA: 'SAP_OIG', // intentionally production-y
    dbB: 'SAP_Unico',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'WRITE_DISABLED');
});

test('A2c-1: writeEnabled missing/undefined treated as not-true', () => {
  // Any value other than literal `true` should be treated as disabled.
  assert.equal(_checkLiveWriteWhitelist({ writeEnabled: undefined }).ok, true);
  assert.equal(_checkLiveWriteWhitelist({ writeEnabled: 'true' /* string */ }).ok, true);
  assert.equal(_checkLiveWriteWhitelist({ writeEnabled: 1 }).ok, true);
  assert.equal(_checkLiveWriteWhitelist({ writeEnabled: null }).ok, true);
});

// ============================================================================
// _checkLiveWriteWhitelist — write enabled, whitelist enforcement
// ============================================================================

test('A2c-1: writeEnabled=true + empty whitelist → FAIL (whitelist required)', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: '',
    dbA: 'SAP_OIG_TEST_290724',
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WHITELIST_REQUIRED');
  assert.match(r.message, /SAP_LIVE_WRITE_DB_WHITELIST/);
});

test('A2c-1: writeEnabled=true + missing whitelist (undefined) → FAIL', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: undefined,
    dbA: 'SAP_OIG_TEST_290724',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'WHITELIST_REQUIRED');
});

test('A2c-1: writeEnabled=true + whitelist matches BOTH DBs → OK', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'SAP_OIG_TEST_290724,Test_Unico',
    dbA: 'SAP_OIG_TEST_290724',
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'WHITELISTED');
  assert.deepEqual(r.whitelist, ['SAP_OIG_TEST_290724', 'Test_Unico']);
});

test('A2c-1: writeEnabled=true + DB A NOT in whitelist → FAIL with details', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'SAP_OIG_TEST_290724,Test_Unico',
    dbA: 'SAP_OIG',  // production — not in whitelist
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.deepEqual(r.offenders, [{ company: 'A', db: 'SAP_OIG' }]);
  assert.match(r.message, /SAP_OIG/);
});

test('A2c-1: writeEnabled=true + DB B NOT in whitelist → FAIL with details', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'SAP_OIG_TEST_290724',
    dbA: 'SAP_OIG_TEST_290724',
    dbB: 'SAP_Unico',  // production — not in whitelist
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.deepEqual(r.offenders, [{ company: 'B', db: 'SAP_Unico' }]);
});

test('A2c-1: writeEnabled=true + BOTH DBs NOT in whitelist → FAIL with both offenders', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'OnlyOne',
    dbA: 'SAP_OIG',
    dbB: 'SAP_Unico',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
  assert.equal(r.offenders.length, 2);
});

test('A2c-1: writeEnabled=true + only DB A configured + in whitelist → OK', () => {
  // Company B not configured at all (e.g. only OIG enabled). Should still pass.
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'SAP_OIG_TEST_290724',
    dbA: 'SAP_OIG_TEST_290724',
    dbB: undefined,
  });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'WHITELISTED');
});

test('A2c-1: whitelist tolerates whitespace around entries', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: ' SAP_OIG_TEST_290724 ,   Test_Unico  ',
    dbA: 'SAP_OIG_TEST_290724',
    dbB: 'Test_Unico',
  });
  assert.equal(r.ok, true);
});

test('A2c-1: whitelist matching is case-sensitive (SAP DB names are)', () => {
  const r = _checkLiveWriteWhitelist({
    writeEnabled: true,
    whitelist: 'sap_oig_test_290724',
    dbA: 'SAP_OIG_TEST_290724',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'DB_NOT_WHITELISTED');
});
