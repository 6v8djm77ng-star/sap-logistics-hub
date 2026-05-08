/**
 * User management - CRUD for planner/admin users + alert subscriptions.
 * Admin-only.
 */
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import * as db from '../db/logisticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logAudit } from '../services/auditLog.js';
import { env } from '../config/env.js';

const router = Router();
router.use(requireAuth);

const ROLES = ['ADMIN', 'PLANNER', 'WAREHOUSE', 'DRIVER', 'VIEWER'];

// Reusable password schema. Existing accounts keep working (bcrypt verifies
// against the stored hash regardless of policy) — only NEW or CHANGED passwords
// must satisfy this. Tunable via PASSWORD_MIN_LENGTH env var.
const passwordSchema = z
  .string()
  .min(env.PASSWORD_MIN_LENGTH, `Password must be at least ${env.PASSWORD_MIN_LENGTH} characters`);

router.get(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const users = await db.query(
      `SELECT UserId, Username, FullName, Email, Phone, Role,
              IsActive, LastLoginAt, PreferredLanguage, CreatedAt
       FROM dbo.Users
       ORDER BY IsActive DESC, FullName`
    );
    res.json({ users });
  })
);

router.get(
  '/me/subscriptions',
  asyncHandler(async (req, res) => {
    const subs = await db.query(
      `SELECT SubscriptionId, EventType, Channel, IsActive
       FROM dbo.AlertSubscriptions
       WHERE UserId = @userId`,
      { userId: req.user.sub }
    );
    res.json({ subscriptions: subs });
  })
);

router.put(
  '/me/subscriptions',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      subscriptions: z.array(z.object({
        eventType: z.string(),
        channel: z.enum(['EMAIL', 'SMS', 'IN_APP']),
        isActive: z.boolean(),
      })),
    });
    const { subscriptions } = schema.parse(req.body);
    const userId = req.user.sub;

    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM dbo.AlertSubscriptions WHERE UserId = @userId`, { userId });
      for (const s of subscriptions.filter((x) => x.isActive)) {
        await tx.query(
          `INSERT INTO dbo.AlertSubscriptions (UserId, EventType, Channel, IsActive)
           VALUES (@userId, @event, @channel, 1)`,
          { userId, event: s.eventType, channel: s.channel }
        );
      }
    });

    res.json({ ok: true });
  })
);

const createUserSchema = z.object({
  username: z.string().min(3).max(50),
  fullName: z.string().min(2).max(100),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: passwordSchema,
  role: z.enum(ROLES),
  preferredLanguage: z.enum(['he', 'en', 'ar']).default('he'),
});

router.post(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const data = createUserSchema.parse(req.body);
    const hash = await bcrypt.hash(data.password, env.BCRYPT_COST);

    const user = await db.queryOne(
      `INSERT INTO dbo.Users
         (Username, FullName, Email, Phone, PasswordHash, Role, PreferredLanguage, IsActive)
       OUTPUT INSERTED.UserId, INSERTED.Username, INSERTED.FullName, INSERTED.Email, INSERTED.Role
       VALUES (@username, @name, @email, @phone, @hash, @role, @lang, 1)`,
      {
        username: data.username,
        name: data.fullName,
        email: data.email || null,
        phone: data.phone || null,
        hash,
        role: data.role,
        lang: data.preferredLanguage,
      }
    );

    await logAudit({
      entityType: 'User',
      entityId: user.UserId,
      action: 'CREATE',
      userId: req.user.sub,
      newValue: { username: user.Username, role: user.Role },
    });

    res.status(201).json(user);
  })
);

const updateUserSchema = z.object({
  fullName: z.string().min(2).max(100).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  preferredLanguage: z.enum(['he', 'en', 'ar']).optional(),
});

router.patch(
  '/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const data = updateUserSchema.parse(req.body);
    const userId = Number(req.params.id);

    // Prevent admin from demoting themselves
    if (userId === req.user.sub && data.role && data.role !== 'ADMIN') {
      return res.status(400).json({ error: 'לא ניתן לשנות את תפקידך שלך' });
    }

    const existing = await db.queryOne(
      `SELECT * FROM dbo.Users WHERE UserId = @id`,
      { id: userId }
    );
    if (!existing) return res.status(404).json({ error: 'User not found' });

    const sets = [];
    const params = { id: userId };
    if (data.fullName !== undefined) { sets.push('FullName = @name'); params.name = data.fullName; }
    if (data.email !== undefined) { sets.push('Email = @email'); params.email = data.email; }
    if (data.phone !== undefined) { sets.push('Phone = @phone'); params.phone = data.phone; }
    if (data.role !== undefined) { sets.push('Role = @role'); params.role = data.role; }
    if (data.isActive !== undefined) { sets.push('IsActive = @active'); params.active = data.isActive; }
    if (data.preferredLanguage !== undefined) { sets.push('PreferredLanguage = @lang'); params.lang = data.preferredLanguage; }

    if (sets.length === 0) return res.json({ ok: true, unchanged: true });

    await db.execute(
      `UPDATE dbo.Users SET ${sets.join(', ')} WHERE UserId = @id`,
      params
    );

    await logAudit({
      entityType: 'User',
      entityId: userId,
      action: 'UPDATE',
      userId: req.user.sub,
      oldValue: { role: existing.Role, isActive: existing.IsActive },
      newValue: data,
    });

    res.json({ ok: true });
  })
);

router.post(
  '/:id/reset-password',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { password } = z.object({ password: passwordSchema }).parse(req.body);
    const hash = await bcrypt.hash(password, env.BCRYPT_COST);

    await db.execute(
      `UPDATE dbo.Users SET PasswordHash = @hash WHERE UserId = @id`,
      { id: Number(req.params.id), hash }
    );

    await logAudit({
      entityType: 'User',
      entityId: Number(req.params.id),
      action: 'UPDATE',
      userId: req.user.sub,
      newValue: { passwordReset: true },
    });

    res.json({ ok: true });
  })
);

router.post(
  '/me/change-password',
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = z.object({
      oldPassword: z.string(),
      newPassword: passwordSchema,
    }).parse(req.body);

    const user = await db.queryOne(
      `SELECT PasswordHash FROM dbo.Users WHERE UserId = @id`,
      { id: req.user.sub }
    );
    const ok = await bcrypt.compare(oldPassword, user.PasswordHash);
    if (!ok) return res.status(401).json({ error: 'סיסמה קיימת שגויה' });

    const hash = await bcrypt.hash(newPassword, env.BCRYPT_COST);
    await db.execute(
      `UPDATE dbo.Users SET PasswordHash = @hash WHERE UserId = @id`,
      { id: req.user.sub, hash }
    );
    res.json({ ok: true });
  })
);

export default router;
