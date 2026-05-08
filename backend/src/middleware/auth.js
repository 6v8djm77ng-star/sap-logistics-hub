/**
 * JWT auth middleware - protects routes and attaches req.user.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';

// Track legacy-token usage during the JWT_STRICT_VERIFY rollout. Counts are
// logged at most once a minute so a steady stream of legacy tokens doesn't
// flood the log. Once these counters drop to zero, JWT_STRICT_VERIFY can be
// flipped to true safely.
let _legacyAcceptedCount = 0;
let _strictAcceptedCount = 0;
let _lastLegacyLogAt = 0;

function noteTokenShape(decoded) {
  const isLegacy = !decoded.aud && !decoded.iss;
  if (isLegacy) _legacyAcceptedCount++;
  else _strictAcceptedCount++;

  const now = Date.now();
  if (isLegacy && now - _lastLegacyLogAt > 60_000) {
    _lastLegacyLogAt = now;
    apiLogger.warn('Accepted legacy JWT (no aud/iss claims)', {
      sub: decoded.sub,
      role: decoded.role,
      legacyTotal: _legacyAcceptedCount,
      strictTotal: _strictAcceptedCount,
      hint: 'Will be rejected once JWT_STRICT_VERIFY=true is rolled out.',
    });
  }
}

export function getJwtRolloutStats() {
  return {
    legacyAccepted: _legacyAcceptedCount,
    strictAccepted: _strictAcceptedCount,
    strictMode: env.JWT_STRICT_VERIFY,
  };
}

const SIGN_OPTIONS_BASE = {
  audience: env.JWT_AUDIENCE,
  issuer: env.JWT_ISSUER,
};

export function signToken(user) {
  return jwt.sign(
    { sub: user.UserId, username: user.Username, role: user.Role, name: user.FullName },
    env.JWT_SECRET,
    { ...SIGN_OPTIONS_BASE, expiresIn: env.JWT_EXPIRES_IN }
  );
}

export function signDriverToken(driver) {
  return jwt.sign(
    { sub: `driver-${driver.DriverId}`, driverId: driver.DriverId, role: 'DRIVER', name: driver.FullName },
    env.JWT_SECRET,
    { ...SIGN_OPTIONS_BASE, expiresIn: env.JWT_DRIVER_EXPIRES_IN }
  );
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = header.slice(7);
  // Strict mode requires aud/iss; lax mode (default during rollout) accepts both
  // legacy tokens (no claims) and new tokens (with claims).
  const verifyOptions = env.JWT_STRICT_VERIFY
    ? { audience: env.JWT_AUDIENCE, issuer: env.JWT_ISSUER }
    : {};
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, verifyOptions);
    // In lax mode, if claims are present they must still match — prevents an
    // attacker from forging a token with a wrong aud/iss against our secret.
    if (!env.JWT_STRICT_VERIFY) {
      if (decoded.aud && decoded.aud !== env.JWT_AUDIENCE) throw new Error('aud mismatch');
      if (decoded.iss && decoded.iss !== env.JWT_ISSUER) throw new Error('iss mismatch');
      // Record whether this token was issued before the aud/iss rollout so
      // we can tell when it's safe to flip JWT_STRICT_VERIFY=true.
      noteTokenShape(decoded);
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
