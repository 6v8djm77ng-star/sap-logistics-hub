// In-memory Idempotency-Key cache + Express middleware factory.
//
// Scope (Commit 2, Phase 2 v2):
//   - Read `Idempotency-Key` header on POST /api/runs/from-selected-orders
//     and the matching /preview endpoint.
//   - Cache the response by (method+path+key) for 10 minutes.
//   - Replay the cached response when the same key arrives with the same
//     payload — so an accidental double-click does not double-create runs.
//   - Return 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD when the
//     same key arrives with a different payload — operator must regenerate
//     the key for a new operation, otherwise it's an obvious bug to surface.
//   - Return 409 IDEMPOTENCY_IN_FLIGHT while a request with the same key is
//     still being processed — prevents a real race where two parallel
//     submits both pass the ALREADY_ASSIGNED check.
//
// Not in scope:
//   - No persistence (in-memory only — survives within a single PM2 process,
//     wiped on reload; that is acceptable for a 10-minute window).
//   - No store schema change.
//   - No frontend integration (caller decides whether to send the header).

'use strict';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Factory so tests can inject their own `now` clock and TTL.
export function createIdempotencyCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const cache = new Map();    // fullKey → { payloadHash, status, body, expiresAt }
  const inflight = new Set(); // fullKeys currently being processed

  return {
    get(fullKey) {
      const entry = cache.get(fullKey);
      if (!entry) return null;
      if (now() >= entry.expiresAt) {
        cache.delete(fullKey);
        return null;
      }
      return entry;
    },
    set(fullKey, payloadHash, status, body) {
      cache.set(fullKey, { payloadHash, status, body, expiresAt: now() + ttlMs });
    },
    isInflight(fullKey) { return inflight.has(fullKey); },
    markInflight(fullKey) { inflight.add(fullKey); },
    clearInflight(fullKey) { inflight.delete(fullKey); },
    // Test helpers — never use these from production code.
    _clear() { cache.clear(); inflight.clear(); },
    _size() { return cache.size; },
    _inflightSize() { return inflight.size; },
  };
}

// Stable hash of a JSON-serializable payload. JSON.stringify is enough at
// our scale (collisions across a 10-minute window are not a real concern);
// upgrading to a crypto digest would buy nothing and add a dependency.
export function hashPayload(payload) {
  return JSON.stringify(payload || {});
}

// Express middleware. `methodPath` scopes the cache key so the same
// Idempotency-Key from a client can be reused across different endpoints
// without collision (e.g. preview vs real run creation).
export function idempotencyMiddleware(cache, methodPath) {
  return function idempotency(req, res, next) {
    const rawKey = req.headers && req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') return next();

    const fullKey = `${methodPath}:${rawKey}`;
    const payloadHash = hashPayload(req.body);

    const cached = cache.get(fullKey);
    if (cached) {
      if (cached.payloadHash === payloadHash) {
        res.set('X-Idempotent-Replay', 'true');
        return res.status(cached.status).json(cached.body);
      }
      return res.status(409).json({
        error: 'idempotency key reused with a different payload',
        code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
      });
    }

    if (cache.isInflight(fullKey)) {
      return res.status(409).json({
        error: 'request with this idempotency key is still in progress',
        code: 'IDEMPOTENCY_IN_FLIGHT',
      });
    }

    cache.markInflight(fullKey);

    // Wrap res.json so we capture status + body right before they ship out.
    // We DO NOT also wrap res.send — both endpoints use res.json exclusively.
    const origJson = res.json.bind(res);
    res.json = (body) => {
      cache.set(fullKey, payloadHash, res.statusCode || 200, body);
      cache.clearInflight(fullKey);
      return origJson(body);
    };
    // Belt + suspenders for the case where the handler errors out without
    // calling res.json (e.g. the global error handler closes the socket).
    res.on('close', () => cache.clearInflight(fullKey));
    res.on('finish', () => cache.clearInflight(fullKey));

    return next();
  };
}
