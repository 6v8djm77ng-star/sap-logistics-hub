import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as db from '../db/logisticsDb.js';
import { signToken, signDriverToken, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { apiLogger } from '../utils/logger.js';

const router = Router();

// Rate limiter for login endpoints — counts ALL attempts (including successful).
// Counting successes prevents account-enumeration via timing-channel: previously
// `skipSuccessfulRequests: true` made the limiter reset on each correct password,
// letting an attacker pin known-valid usernames apart from invalid ones.
// 20 attempts / 15min / IP is generous for legitimate users juggling typos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות כניסה. נסה שוב בעוד 15 דקות.' },
  handler: (req, res, _next, options) => {
    apiLogger.warn('Login rate limit exceeded', { ip: req.ip, path: req.path });
    res.status(options.statusCode).json(options.message);
  },
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);

    const user = await db.queryOne(
      `SELECT UserId, Username, FullName, PasswordHash, Role, IsActive
       FROM dbo.Users WHERE Username = @username`,
      { username }
    );

    if (!user || !user.IsActive) {
      apiLogger.info('Login failed - unknown or inactive user', { username, ip: req.ip });
      // Intentionally vague - don't tell attacker which part is wrong
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }

    const ok = await bcrypt.compare(password, user.PasswordHash);
    if (!ok) {
      apiLogger.info('Login failed - bad password', { username, ip: req.ip });
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    }

    await db.execute(
      `UPDATE dbo.Users SET LastLoginAt = SYSUTCDATETIME() WHERE UserId = @id`,
      { id: user.UserId }
    );

    apiLogger.info('Login success', { username, role: user.Role });

    res.json({
      token: signToken(user),
      user: { id: user.UserId, username: user.Username, name: user.FullName, role: user.Role },
    });
  })
);

router.post(
  '/driver-login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { code, password } = z.object({
      code: z.string().min(1),
      password: z.string().min(1),
    }).parse(req.body);

    const driver = await db.queryOne(
      `SELECT DriverId, Code, FullName, Phone, PasswordHash, IsActive
       FROM dbo.Drivers WHERE Code = @code`,
      { code }
    );

    if (!driver || !driver.IsActive || !driver.PasswordHash) {
      apiLogger.info('Driver login failed - unknown or inactive', { code, ip: req.ip });
      return res.status(401).json({ error: 'קוד נהג או סיסמה שגויים' });
    }

    const ok = await bcrypt.compare(password, driver.PasswordHash);
    if (!ok) {
      apiLogger.info('Driver login failed - bad password', { code, ip: req.ip });
      return res.status(401).json({ error: 'קוד נהג או סיסמה שגויים' });
    }

    await db.execute(
      `UPDATE dbo.Drivers SET LastLoginAt = SYSUTCDATETIME() WHERE DriverId = @id`,
      { id: driver.DriverId }
    );

    res.json({
      token: signDriverToken(driver),
      driver: { id: driver.DriverId, code: driver.Code, name: driver.FullName, phone: driver.Phone },
    });
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
