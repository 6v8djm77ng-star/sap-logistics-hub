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
