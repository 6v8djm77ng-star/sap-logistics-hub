// Phase A2g-FIX-WRITER-STATUS regression tests.
//
// Background: getWriterStatus() called parseWhitelist(...) but parseWhitelist
// was only re-exported, never imported into local scope. Every request to
// /api/sap/writer/status threw ReferenceError, which froze the A2f banner.
// These tests guarantee the function runs end-to-end and returns the shape
// the banner expects, across the env states that matter.
//
// The function reads process.env directly, so each test snapshots the keys
// it touches and restores them after — no ambient state leaks between
// tests or files.
//
// Run:
//   cd backend && node --test src/demo/sapWriter.writerStatus.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWriterStatus } from './sapWriter.js';

const KEYS = [
  'SAP_WRITE_ENABLED',
  'SAP_LIVE_WRITE_DB_WHITELIST',
  'SAP_SL_URL',
  'SAP_SERVICE_LAYER_URL',
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ============================================================================
// Smoke: getWriterStatus must NOT throw — that's the whole point of the fix.
// ============================================================================

test('A2g-FIX-WS / no-throw: getWriterStatus runs with empty env', () => {
  withEnv({}, () => {
    assert.doesNotThrow(() => getWriterStatus());
  });
});

test('A2g-FIX-WS / no-throw: getWriterStatus runs with SAP_WRITE_ENABLED=true', () => {
  withEnv({ SAP_WRITE_ENABLED: 'true' }, () => {
    assert.doesNotThrow(() => getWriterStatus());
  });
});

test('A2g-FIX-WS / no-throw: getWriterStatus runs with a populated whitelist', () => {
  withEnv({ SAP_LIVE_WRITE_DB_WHITELIST: 'Test_OIG,Test_Unico' }, () => {
    assert.doesNotThrow(() => getWriterStatus());
  });
});

// ============================================================================
// whitelist must always be an array — the banner does `.length` on it.
// ============================================================================

test('A2g-FIX-WS / whitelist is [] when env is unset', () => {
  withEnv({}, () => {
    const s = getWriterStatus();
    assert.ok(Array.isArray(s.whitelist), 'whitelist must be an array');
    assert.equal(s.whitelist.length, 0);
  });
});

test('A2g-FIX-WS / whitelist parses comma-separated DBs into an array', () => {
  withEnv({ SAP_LIVE_WRITE_DB_WHITELIST: 'Test_OIG,Test_Unico' }, () => {
    const s = getWriterStatus();
    assert.ok(Array.isArray(s.whitelist));
    assert.deepEqual(s.whitelist, ['Test_OIG', 'Test_Unico']);
  });
});

test('A2g-FIX-WS / whitelist tolerates whitespace + trailing commas', () => {
  withEnv({ SAP_LIVE_WRITE_DB_WHITELIST: '  Test_OIG , Test_Unico , ' }, () => {
    const s = getWriterStatus();
    assert.deepEqual(s.whitelist, ['Test_OIG', 'Test_Unico']);
  });
});

// ============================================================================
// SAP_WRITE_ENABLED unset/!=true → mode reflects DRY-RUN + writeEnabled=false.
// This is what the A2f banner uses to render the green badge.
// ============================================================================

test('A2g-FIX-WS / unset SAP_WRITE_ENABLED → mode=DRY-RUN, writeEnabled=false', () => {
  withEnv({}, () => {
    const s = getWriterStatus();
    assert.equal(s.writeEnabled, false);
    assert.equal(s.mode, 'DRY-RUN');
    assert.equal(s.canWrite, false);
  });
});

test('A2g-FIX-WS / SAP_WRITE_ENABLED=false-ish → still DRY-RUN', () => {
  withEnv({ SAP_WRITE_ENABLED: 'false' }, () => {
    const s = getWriterStatus();
    assert.equal(s.writeEnabled, false);
    assert.equal(s.mode, 'DRY-RUN');
    assert.equal(s.canWrite, false);
  });
});

test('A2g-FIX-WS / SAP_WRITE_ENABLED=true but no SL URL → mode=DRY-RUN', () => {
  withEnv({ SAP_WRITE_ENABLED: 'true' }, () => {
    const s = getWriterStatus();
    assert.equal(s.writeEnabled, true, 'env reflected');
    assert.equal(s.mode, 'DRY-RUN', 'no URL means cannot actually write');
    assert.equal(s.canWrite, false);
  });
});

test('A2g-FIX-WS / SAP_WRITE_ENABLED=true + SAP_SL_URL set → mode=LIVE', () => {
  withEnv({
    SAP_WRITE_ENABLED: 'true',
    SAP_SL_URL: 'https://192.168.0.220:50000/b1s/v1',
  }, () => {
    const s = getWriterStatus();
    assert.equal(s.writeEnabled, true);
    assert.equal(s.mode, 'LIVE');
    assert.equal(s.canWrite, true);
    assert.equal(s.serviceLayerConfigured, true);
  });
});

// ============================================================================
// Shape contract — exact keys the A2f banner reads.
// ============================================================================

test('A2g-FIX-WS / response shape matches the A2f banner contract', () => {
  withEnv({}, () => {
    const s = getWriterStatus();
    for (const key of ['serviceLayerConfigured', 'writeEnabled', 'canWrite', 'mode', 'logFile', 'whitelist']) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, key), `missing key: ${key}`);
    }
    assert.ok(['DRY-RUN', 'LIVE'].includes(s.mode), `mode should be DRY-RUN or LIVE, got ${s.mode}`);
    assert.equal(typeof s.logFile, 'string');
  });
});
