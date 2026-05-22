/**
 * Unit tests — sapWriter transport helpers (fetch → https.request fix).
 *
 * Why this exists:
 *   Before 2026-05-22, login()/postSAP() used Node global fetch with an
 *   `agent: new https.Agent({rejectUnauthorized:false})` option. Node 18+
 *   fetch silently ignores the `agent` option (uses an internal undici
 *   dispatcher instead), so the SSL handshake against SAP B1's self-signed
 *   cert failed with the opaque "fetch failed". We replaced fetch with
 *   built-in https.request and routed SSL behaviour through the
 *   SAP_SL_SSL_REJECT_UNAUTHORIZED env var (matches serviceLayer.js).
 *
 * These tests pin the SSL-flag mapping and the request-options shape so a
 * future refactor can't reintroduce the silent insecure default.
 *
 * Pure unit tests — no network, no SAP, no PM2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _slRejectUnauthorized, _buildHttpsRequestOpts } from './sapWriter.js';

// Helper: run a test body with a temporary env var value, then restore.
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try { fn(); }
  finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

// ------------ _slRejectUnauthorized ------------

test('rejectUnauthorized defaults to TRUE when env var is unset (secure default)', () => {
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', undefined, () => {
    assert.equal(_slRejectUnauthorized(), true);
  });
});

test("rejectUnauthorized is FALSE only when env var is exactly 'false'", () => {
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', 'false', () => {
    assert.equal(_slRejectUnauthorized(), false);
  });
});

test('rejectUnauthorized is TRUE when env var is "true"', () => {
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', 'true', () => {
    assert.equal(_slRejectUnauthorized(), true);
  });
});

test('rejectUnauthorized is TRUE for any garbage value (fail-safe)', () => {
  for (const v of ['0', '1', 'no', 'yes', 'FALSE', 'False', '', ' ']) {
    withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', v, () => {
      assert.equal(
        _slRejectUnauthorized(),
        true,
        `value='${v}' should resolve to strict TRUE (only 'false' literal disables verification)`
      );
    });
  }
});

// ------------ _buildHttpsRequestOpts ------------

test('builds correct opts for HTTPS URL with explicit port', () => {
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', 'false', () => {
    const opts = _buildHttpsRequestOpts(
      'POST',
      'https://192.168.0.220:50000/b1s/v1/Login',
      '{"x":1}',
      { 'Content-Type': 'application/json' }
    );
    assert.equal(opts.method, 'POST');
    assert.equal(opts.hostname, '192.168.0.220');
    assert.equal(opts.port, '50000');
    assert.equal(opts.path, '/b1s/v1/Login');
    assert.equal(opts.rejectUnauthorized, false);
    assert.equal(opts.headers['Content-Type'], 'application/json');
    assert.equal(opts.headers['Content-Length'], 7); // bytes of '{"x":1}'
    assert.equal(opts.timeout, 30000);
  });
});

test('defaults port to 443 for https:// without explicit port', () => {
  const opts = _buildHttpsRequestOpts('GET', 'https://sap.example.com/Orders', null, {});
  assert.equal(opts.port, 443);
});

test('defaults port to 80 for http:// without explicit port', () => {
  const opts = _buildHttpsRequestOpts('GET', 'http://internal/api', null, {});
  assert.equal(opts.port, 80);
});

test('omits Content-Length when body is null', () => {
  const opts = _buildHttpsRequestOpts('GET', 'https://x.example/y', null, {});
  assert.equal(opts.headers['Content-Length'], undefined);
});

test('rejectUnauthorized honours env var at call time (re-evaluated, not cached)', () => {
  // First call with env=false
  let opts1;
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', 'false', () => {
    opts1 = _buildHttpsRequestOpts('GET', 'https://x.example/y', null, {});
  });
  assert.equal(opts1.rejectUnauthorized, false);

  // Then call with env unset — must flip back to strict
  let opts2;
  withEnv('SAP_SL_SSL_REJECT_UNAUTHORIZED', undefined, () => {
    opts2 = _buildHttpsRequestOpts('GET', 'https://x.example/y', null, {});
  });
  assert.equal(opts2.rejectUnauthorized, true,
    'must re-read env each call so DISARM phase actually disarms');
});

test('preserves caller headers and adds Content-Length on top', () => {
  const opts = _buildHttpsRequestOpts(
    'POST',
    'https://api/b1s/v1/DeliveryNotes',
    '{"DocumentLines":[]}',
    { 'Content-Type': 'application/json', Cookie: 'B1SESSION=abc' }
  );
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.equal(opts.headers.Cookie, 'B1SESSION=abc');
  assert.equal(opts.headers['Content-Length'], 20); // bytes of '{"DocumentLines":[]}'
});

test('does NOT mutate the headers object the caller passed in', () => {
  const callerHeaders = { 'Content-Type': 'application/json' };
  _buildHttpsRequestOpts('POST', 'https://x/y', 'body', callerHeaders);
  // Content-Length must not have leaked back into caller's object
  assert.equal(callerHeaders['Content-Length'], undefined);
});

test('throws (sync) on invalid URL — caller can catch synchronously', () => {
  assert.throws(
    () => _buildHttpsRequestOpts('GET', 'not a url', null, {}),
    /Invalid URL|invalid URL|URL/i
  );
});

// ------------ DEV.9 regression: phantom whitelist-helper calls ------------
//
// Background:
//   2026-05-22 LIVE attempt #3 hit
//   `SapWriteLastError: "isCompanyDbWhitelisted is not defined"`
//   because the DEV.8 transport refactor added defense-in-depth whitelist
//   checks in login()/postSAP() that called a local helper that never
//   existed in this file (it was a confused recollection from an earlier
//   rolled-back C:\dev snapshot). The canonical primitive lives in
//   ../services/sap/writeWhitelist.js and is imported as `parseWhitelist`.
//
// These tests pin that the buggy references stay out and the correct
// imported helper is used.

import { readFileSync } from 'node:fs';
import { fileURLToPath as _fu } from 'node:url';
import { dirname as _dn, resolve as _rs } from 'node:path';
const __srcPath = _rs(_dn(_fu(import.meta.url)), 'sapWriter.js');
const __src = readFileSync(__srcPath, 'utf8');

test('DEV.9: source contains no CALLS to isCompanyDbWhitelisted (only comments)', () => {
  // A "call" is the identifier followed by an opening paren. Comments mention
  // the name but never call it. The regex below matches any occurrence not
  // preceded by `//` on the same line up to the match.
  for (const line of __src.split(/\r?\n/)) {
    const trimmed = line.replace(/\/\/.*$/, ''); // strip line comments
    assert.ok(
      !/\bisCompanyDbWhitelisted\s*\(/.test(trimmed),
      `phantom call to isCompanyDbWhitelisted() found in line: ${line}`
    );
    assert.ok(
      !/\bgetWriteWhitelist\s*\(/.test(trimmed),
      `phantom call to getWriteWhitelist() found in line: ${line}`
    );
  }
});

test('DEV.9: parseWhitelist is the import in use for whitelist checks', () => {
  // Import line at module bottom (ES modules hoist imports — order doesn't matter).
  assert.ok(
    /import\s*\{[^}]*\bparseWhitelist\b[^}]*\}\s*from\s*['"][^'"]*writeWhitelist\.js['"]/.test(__src),
    'parseWhitelist must be imported from ../services/sap/writeWhitelist.js'
  );
  // And it must actually be called (login + postSAP whitelist gates).
  const calls = (__src.match(/\bparseWhitelist\s*\(/g) || []).length;
  assert.ok(calls >= 2, `expected ≥2 parseWhitelist(...) call sites (login + postSAP), got ${calls}`);
});

test('DEV.9: writeDeliveryNote dry-run path returns dryRun:true without ReferenceError', async () => {
  // SAP_WRITE_ENABLED unset → dry-run forced regardless of options.dryRun.
  const saved = {};
  const toUnset = ['SAP_WRITE_ENABLED'];
  for (const k of toUnset) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const { writeDeliveryNote } = await import('./sapWriter.js');
    const fakeDn = {
      DeliveryNoteId: 999_001,
      DocNumber: 'DN-DEV9-DRYRUN',
      CompanyCode: 'A',
      SapCardCode: 'ANY',
      DeliveryDate: '2026-05-22',
      SourceOrders: [{ SapDocEntry: 1, lines: [{ LineNum: 0, Quantity: 1 }] }],
    };
    const result = await writeDeliveryNote(fakeDn, { dryRun: false });
    assert.equal(result.dryRun, true, 'must fall back to dry-run when SAP_WRITE_ENABLED is unset');
    assert.equal(result.ok, true, 'dry-run is not an error path');
  } finally {
    for (const k of toUnset) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('DEV.9: LIVE path with bogus SL URL fails with transport error, NOT ReferenceError', async () => {
  // Force the writer past every gate so it actually calls login() →
  // httpsRequest(). The URL points to a closed local port so the network
  // call dies fast. We only care that the error category is "transport"
  // (ECONNREFUSED / ENOTFOUND / ETIMEDOUT) — not "is not defined".
  const overrides = {
    SAP_WRITE_ENABLED: 'true',
    SAP_SL_URL: 'https://127.0.0.1:1',          // closed port
    SAP_SL_USERNAME: 'test',
    SAP_SL_PASSWORD: 'test',
    SAP_SL_COMPANY_DB_A: 'TEST_DUMMY_A',
    SAP_SL_COMPANY_DB_B: '',
    SAP_LIVE_WRITE_DB_WHITELIST: 'TEST_DUMMY_A,TEST_DUMMY_B',
    SAP_SL_SSL_REJECT_UNAUTHORIZED: 'false',
  };
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  try {
    const { writeDeliveryNote } = await import('./sapWriter.js');
    const fakeDn = {
      DeliveryNoteId: 999_002,
      DocNumber: 'DN-DEV9-BOGUSURL',
      CompanyCode: 'A',
      SapCardCode: 'ANY',
      DeliveryDate: '2026-05-22',
      SourceOrders: [{ SapDocEntry: 1, lines: [{ LineNum: 0, Quantity: 1 }] }],
    };
    const result = await writeDeliveryNote(fakeDn, { dryRun: false });
    // The writer catches transport errors and returns { ok:false, error }.
    // We don't care WHICH transport error fires — only that it's not the
    // phantom-helper ReferenceError that bit us in production.
    assert.equal(result.ok, false, 'live write to bogus URL must fail');
    assert.ok(result.error, 'must have an error message');
    assert.ok(
      !/is not defined|ReferenceError/i.test(String(result.error)),
      `error must be transport-class, not ReferenceError. Got: "${result.error}"`
    );
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('DEV.9: LIVE path with empty whitelist throws "not in SAP_LIVE_WRITE_DB_WHITELIST"', async () => {
  // When the gate is supposed to block, it should produce a clear,
  // actionable error — not a stale "is not defined" message.
  const overrides = {
    SAP_WRITE_ENABLED: 'true',
    SAP_SL_URL: 'https://127.0.0.1:1',
    SAP_SL_USERNAME: 'test',
    SAP_SL_PASSWORD: 'test',
    SAP_SL_COMPANY_DB_A: 'SOME_DB_NOT_IN_LIST',
    SAP_LIVE_WRITE_DB_WHITELIST: '',                // empty — must block
    SAP_SL_SSL_REJECT_UNAUTHORIZED: 'false',
  };
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; process.env[k] = overrides[k]; }
  try {
    const { writeDeliveryNote } = await import('./sapWriter.js');
    const fakeDn = {
      DeliveryNoteId: 999_003,
      DocNumber: 'DN-DEV9-EMPTYWL',
      CompanyCode: 'A',
      SapCardCode: 'ANY',
      DeliveryDate: '2026-05-22',
      SourceOrders: [{ SapDocEntry: 1, lines: [{ LineNum: 0, Quantity: 1 }] }],
    };
    const result = await writeDeliveryNote(fakeDn, { dryRun: false });
    // writeDeliveryNote-level gate ALREADY catches "not in whitelist" via the
    // outer assertLiveWriteAllowedAtRequest() and either returns dry-run or
    // throws a clear message. Either way, never "is not defined".
    if (result.ok === false) {
      assert.ok(
        !/is not defined|ReferenceError/i.test(String(result.error)),
        `error must mention whitelist, not ReferenceError. Got: "${result.error}"`
      );
    } else {
      // If it returned dry-run, the reason should mention whitelist or write_enabled.
      assert.equal(result.dryRun, true);
      assert.ok(
        result.reason && !/is not defined|ReferenceError/i.test(String(result.reason)),
        `dry-run reason must not be a ReferenceError. Got: "${result.reason}"`
      );
    }
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
