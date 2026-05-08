import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/logisticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const zones = await db.query(
      `SELECT * FROM dbo.Zones WHERE IsActive = 1 ORDER BY SortOrder`
    );
    res.json({ zones });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const zone = await db.queryOne(
      `SELECT * FROM dbo.Zones WHERE ZoneId = @id`,
      { id: Number(req.params.id) }
    );
    if (!zone) return res.status(404).json({ error: 'Zone not found' });
    res.json(zone);
  })
);

const zoneSchema = z.object({
  code: z.string().max(20),
  name: z.string().max(100),
  description: z.string().optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  sortOrder: z.number().int().default(0),
});

router.post(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const data = zoneSchema.parse(req.body);
    const zone = await db.queryOne(
      `INSERT INTO dbo.Zones (Code, Name, Description, ColorHex, SortOrder, IsActive)
       OUTPUT INSERTED.*
       VALUES (@code, @name, @desc, @color, @order, 1)`,
      {
        code: data.code,
        name: data.name,
        desc: data.description || null,
        color: data.colorHex || null,
        order: data.sortOrder,
      }
    );
    res.status(201).json(zone);
  })
);

/**
 * Assign an address to a zone (manual override).
 */
router.post(
  '/:id/assign-address/:addressId',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    await db.execute(
      `UPDATE dbo.NormalizedAddresses SET ZoneId = @zoneId WHERE AddressId = @addressId`,
      { zoneId: Number(req.params.id), addressId: Number(req.params.addressId) }
    );
    res.json({ ok: true });
  })
);

export default router;
