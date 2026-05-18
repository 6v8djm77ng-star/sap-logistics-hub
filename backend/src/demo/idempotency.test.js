// Unit tests for the Idempotency-Key cache + Express middleware factory.
// No I/O, no Express, no SAP — uses a mock req/res to exercise the
// middleware end-to-end.
//
// Run:
//   cd backend && node --test src/demo/idempotency.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdempotencyCache,
  hashPayload,
  idempotencyMiddleware,
} from './idempotency.js';

// ──────────────────────────────────────────────────────────────────────
// Mock req/res helpers
// ──────────────────────────────────────────────────────────────────────
function mockReq({ headers = {}, body = {} } = {}) {
  // Normalize header names to lowercase the way Express does.
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v;
  return { headers: normalized, body };
}

function mockRes() {
  const listeners = {};
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    sent: false,
    status(code) { this.statusCode = code; return this; },
    set(name, val) { this.headers[String(name).toLowerCase()] = val; return this; },
    json(body) {
      this.body = body;
      this.sent = true;
      // Mirror what Express does — invoke 'finish' after sending.
      if (listeners.finish) listeners.finish();
      return this;
    },
    on(event, fn) {
      listeners[event] = fn;
      return this;
    },
  };
  return res;
}

// Drives the middleware once. If next() is called, runs the handler.
// Returns res.
async function runMiddleware(middleware, req, handler = null) {
  const res = mockRes();
  let nextCalled = false;
  middleware(req, res, () => {
    nextCalled = true;
  });
  if (nextCalled && handler) {
    await handler(req, res);
  }
  return res;
}

// ──────────────────────────────────────────────────────────────────────
// Cache primitive — set/get/TTL/inflight
// ──────────────────────────────────────────────────────────────────────

test('cache: set → get round-trip', () => {
  const cache = createIdempotencyCache();
  cache.set('k1', 'h1', 200, { ok: true });
  const entry = cache.get('k1');
  assert.equal(entry.status, 200);
  assert.deepEqual(entry.body, { ok: true });
  assert.equal(entry.payloadHash, 'h1');
});

test('cache: get returns null for missing key', () => {
  const cache = createIdempotencyCache();
  assert.equal(cache.get('nope'), null);
});

test('cache: TTL expires entries (injected clock)', () => {
  let t = 1000;
  const cache = createIdempotencyCache({ ttlMs: 5000, now: () => t });
  cache.set('k1', 'h1', 200, { ok: true });
  t = 4000;
  assert.notEqual(cache.get('k1'), null);
  t = 6001; // past expiry
  assert.equal(cache.get('k1'), null);
  // And the expired entry should be evicted, not just hidden
  assert.equal(cache._size(), 0);
});

test('cache: inflight tracking', () => {
  const cache = createIdempotencyCache();
  assert.equal(cache.isInflight('k1'), false);
  cache.markInflight('k1');
  assert.equal(cache.isInflight('k1'), true);
  cache.clearInflight('k1');
  assert.equal(cache.isInflight('k1'), false);
});

test('hashPayload: stable for equal objects, different for different ones', () => {
  assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ a: 1, b: 2 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  // null / undefined are coerced to {} so they all hash the same
  assert.equal(hashPayload(null), hashPayload({}));
  assert.equal(hashPayload(undefined), hashPayload({}));
});

// ──────────────────────────────────────────────────────────────────────
// Middleware behavior
// ──────────────────────────────────────────────────────────────────────

test('middleware: no Idempotency-Key header → pass through (next called, no cache touched)', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');
  const req = mockReq({ body: { foo: 1 } });
  const res = await runMiddleware(mw, req, (req2, res2) => {
    res2.status(200).json({ ok: true, fresh: true });
  });
  assert.equal(res.sent, true);
  assert.equal(res.body.fresh, true);
  // Cache must remain empty when no key is present.
  assert.equal(cache._size(), 0);
});

test('middleware: same key + same payload → second request replays cached response', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');

  // First request — populates the cache.
  const req1 = mockReq({ headers: { 'Idempotency-Key': 'abc' }, body: { foo: 1 } });
  const res1 = await runMiddleware(mw, req1, (req, res) => {
    res.status(200).json({ ok: true, n: 1 });
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.n, 1);
  assert.equal(res1.headers['x-idempotent-replay'], undefined);
  assert.equal(cache._size(), 1);

  // Second request — same key, same payload, DIFFERENT handler. Should
  // replay the first response WITHOUT invoking the handler.
  const req2 = mockReq({ headers: { 'Idempotency-Key': 'abc' }, body: { foo: 1 } });
  let handler2Called = false;
  const res2 = await runMiddleware(mw, req2, (req, res) => {
    handler2Called = true;
    res.status(500).json({ should: 'not be called' });
  });
  assert.equal(handler2Called, false, 'cached path must not invoke handler');
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.n, 1);
  assert.equal(res2.headers['x-idempotent-replay'], 'true');
  // Cache must still hold exactly one entry — no double mutation.
  assert.equal(cache._size(), 1);
});

test('middleware: same key + DIFFERENT payload → 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');

  const req1 = mockReq({ headers: { 'Idempotency-Key': 'abc' }, body: { foo: 1 } });
  await runMiddleware(mw, req1, (req, res) => res.status(200).json({ ok: true }));

  const req2 = mockReq({ headers: { 'Idempotency-Key': 'abc' }, body: { foo: 999 } });
  let handler2Called = false;
  const res2 = await runMiddleware(mw, req2, () => { handler2Called = true; });
  assert.equal(handler2Called, false);
  assert.equal(res2.statusCode, 409);
  assert.equal(res2.body.code, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
});

test('middleware: cache key includes method+path → same key on different endpoints does NOT collide', async () => {
  const cache = createIdempotencyCache();
  const mwA = idempotencyMiddleware(cache, 'POST /api/runs/from-selected-orders');
  const mwB = idempotencyMiddleware(cache, 'POST /api/runs/from-selected-orders/preview');

  const req1 = mockReq({ headers: { 'Idempotency-Key': 'shared' }, body: { foo: 1 } });
  const res1 = await runMiddleware(mwA, req1, (req, res) => res.status(200).json({ from: 'A' }));
  const req2 = mockReq({ headers: { 'Idempotency-Key': 'shared' }, body: { foo: 1 } });
  const res2 = await runMiddleware(mwB, req2, (req, res) => res.status(200).json({ from: 'B' }));
  assert.equal(res1.body.from, 'A');
  assert.equal(res2.body.from, 'B');
  // Two distinct cache entries
  assert.equal(cache._size(), 2);
});

test('middleware: empty / whitespace Idempotency-Key is ignored (pass-through)', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');
  const req = mockReq({ headers: { 'Idempotency-Key': '   ' }, body: { foo: 1 } });
  const res = await runMiddleware(mw, req, (req2, res2) => res2.status(200).json({ ok: true }));
  assert.equal(res.body.ok, true);
  assert.equal(cache._size(), 0);
});

test('middleware: 4xx response also gets cached (replay returns same 4xx)', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');

  // First request — handler returns 400.
  const req1 = mockReq({ headers: { 'Idempotency-Key': 'err1' }, body: { foo: 1 } });
  const res1 = await runMiddleware(mw, req1, (req, res) =>
    res.status(400).json({ error: 'bad', code: 'NO_ORDERS' })
  );
  assert.equal(res1.statusCode, 400);

  // Second — same key, same payload, different handler (would return 200).
  const req2 = mockReq({ headers: { 'Idempotency-Key': 'err1' }, body: { foo: 1 } });
  const res2 = await runMiddleware(mw, req2, (req, res) => res.status(200).json({ ok: true }));
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.code, 'NO_ORDERS');
  assert.equal(res2.headers['x-idempotent-replay'], 'true');
});

test('middleware: handler exception leaves the entry uncached (so caller can retry)', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');
  const req = mockReq({ headers: { 'Idempotency-Key': 'oops' }, body: { foo: 1 } });
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  // Handler does NOT call res.json — simulates an exception bubbling out
  // before the response is sent. Cache must remain empty.
  assert.equal(nextCalled, true);
  assert.equal(cache._size(), 0);
});

test('middleware: in-flight duplicate while first still pending → 409 IDEMPOTENCY_IN_FLIGHT', () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');

  // First request — call middleware but DO NOT have the handler send a
  // response yet. This leaves the key in the inflight set.
  const req1 = mockReq({ headers: { 'Idempotency-Key': 'race' }, body: { foo: 1 } });
  const res1 = mockRes();
  let next1Called = false;
  mw(req1, res1, () => { next1Called = true; });
  assert.equal(next1Called, true);
  assert.equal(cache.isInflight('POST /x:race'), true);

  // Second request — should see in-flight → 409 IDEMPOTENCY_IN_FLIGHT.
  const req2 = mockReq({ headers: { 'Idempotency-Key': 'race' }, body: { foo: 1 } });
  const res2 = mockRes();
  let next2Called = false;
  mw(req2, res2, () => { next2Called = true; });
  assert.equal(next2Called, false);
  assert.equal(res2.statusCode, 409);
  assert.equal(res2.body.code, 'IDEMPOTENCY_IN_FLIGHT');
});

test('middleware: replay does not re-mutate cache (no duplicate-write regression)', async () => {
  const cache = createIdempotencyCache();
  const mw = idempotencyMiddleware(cache, 'POST /x');

  // First request — primes the cache.
  await runMiddleware(mw, mockReq({ headers: { 'Idempotency-Key': 'k1' }, body: { foo: 1 } }),
    (req, res) => res.status(200).json({ ok: true, mark: 'A' }));
  const firstEntry = cache.get('POST /x:k1');
  assert.equal(firstEntry.body.mark, 'A');

  // Three more replays — none of them should overwrite or add entries.
  for (let i = 0; i < 3; i++) {
    const res = await runMiddleware(mw, mockReq({ headers: { 'Idempotency-Key': 'k1' }, body: { foo: 1 } }),
      (req, res) => res.status(500).json({ ok: false, mark: 'OVERWRITE' }));
    assert.equal(res.body.mark, 'A');
  }
  // Cache still has exactly one entry, same as right after the first call.
  assert.equal(cache._size(), 1);
  const stillEntry = cache.get('POST /x:k1');
  assert.equal(stillEntry.body.mark, 'A');
});
