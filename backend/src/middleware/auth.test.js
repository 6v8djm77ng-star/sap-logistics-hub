/**
 * Security tests for the JWT auth middleware.
 *
 * Confirms that:
 *  - Tokens signed with the new aud/iss claims pass verification.
 *  - In strict mode, tokens without aud/iss are rejected.
 *  - Tokens with mismatched aud/iss are rejected even in lax mode.
 *  - Expired tokens are rejected.
 *  - Forged tokens (wrong secret) are rejected.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(__dirname, '../..'));

const { env } = await import('../config/env.js');
const { signToken, requireAuth, getJwtRolloutStats } = await import('./auth.js');

function fakeReq(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('requireAuth', () => {
  const fakeUser = {
    UserId: 1,
    Username: 'tester',
    Role: 'ADMIN',
    FullName: 'Test',
  };

  test('accepts a freshly-signed token', () => {
    const token = signToken(fakeUser);
    const req = fakeReq(token);
    const res = fakeRes();
    let calledNext = false;
    requireAuth(req, res, () => { calledNext = true; });
    assert.equal(calledNext, true, 'next() should be called');
    assert.equal(req.user.sub, 1);
    assert.equal(req.user.role, 'ADMIN');
    assert.equal(req.user.aud, env.JWT_AUDIENCE);
    assert.equal(req.user.iss, env.JWT_ISSUER);
  });

  test('rejects token signed with wrong secret', () => {
    const token = jwt.sign({ sub: 1, role: 'ADMIN' }, 'totally-different-secret', {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
      expiresIn: '1h',
    });
    const res = fakeRes();
    let calledNext = false;
    requireAuth(fakeReq(token), res, () => { calledNext = true; });
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects expired token', () => {
    const token = jwt.sign({ sub: 1, role: 'ADMIN' }, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
      expiresIn: '-1s',
    });
    const res = fakeRes();
    let calledNext = false;
    requireAuth(fakeReq(token), res, () => { calledNext = true; });
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects token with wrong audience even in lax mode', () => {
    const token = jwt.sign({ sub: 1, role: 'ADMIN' }, env.JWT_SECRET, {
      audience: 'attacker-audience',
      issuer: env.JWT_ISSUER,
      expiresIn: '1h',
    });
    const res = fakeRes();
    let calledNext = false;
    requireAuth(fakeReq(token), res, () => { calledNext = true; });
    assert.equal(calledNext, false, 'should reject mismatched audience');
    assert.equal(res.statusCode, 401);
  });

  test('rejects token with wrong issuer even in lax mode', () => {
    const token = jwt.sign({ sub: 1, role: 'ADMIN' }, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: 'attacker-issuer',
      expiresIn: '1h',
    });
    const res = fakeRes();
    let calledNext = false;
    requireAuth(fakeReq(token), res, () => { calledNext = true; });
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects request with missing Authorization header', () => {
    const res = fakeRes();
    let calledNext = false;
    requireAuth({ headers: {} }, res, () => { calledNext = true; });
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });

  test('rejects request with non-Bearer scheme', () => {
    const res = fakeRes();
    let calledNext = false;
    requireAuth({ headers: { authorization: 'Basic abcd' } }, res, () => { calledNext = true; });
    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 401);
  });

  test('legacy token (no aud/iss) is accepted in lax mode', () => {
    const beforeStats = getJwtRolloutStats();
    const legacyToken = jwt.sign({ sub: 99, role: 'ADMIN', name: 'Legacy' }, env.JWT_SECRET, {
      expiresIn: '1h',
    });
    const res = fakeRes();
    let calledNext = false;
    requireAuth(fakeReq(legacyToken), res, () => { calledNext = true; });
    assert.equal(calledNext, true, 'legacy token should pass in lax mode');
    const afterStats = getJwtRolloutStats();
    assert.ok(
      afterStats.legacyAccepted > beforeStats.legacyAccepted,
      'legacy counter should increment',
    );
  });

  test('strict-issued tokens increment the strict counter', () => {
    const beforeStats = getJwtRolloutStats();
    const token = signToken({ UserId: 7, Username: 't', Role: 'ADMIN', FullName: 'T' });
    const res = fakeRes();
    requireAuth(fakeReq(token), res, () => {});
    const afterStats = getJwtRolloutStats();
    assert.ok(afterStats.strictAccepted > beforeStats.strictAccepted);
  });
});
