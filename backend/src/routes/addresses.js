/**
 * Normalized addresses - time windows, contact info, zone assignments.
 */
import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/logisticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const address = await db.queryOne(
      `SELECT a.*, z.Name AS ZoneName, z.ColorHex AS ZoneColor
       FROM dbo.NormalizedAddresses a
       LEFT JOIN dbo.Zones z ON z.ZoneId = a.ZoneId
       WHERE a.AddressId = @id`,
      { id: Number(req.params.id) }
    );
    if (!address) return res.status(404).json({ error: 'Address not found' });

    // Also return linked customers (SAP CardCodes)
    const links = await db.query(
      `SELECT cal.SapCardCode, cal.SapAddressName, c.Code AS CompanyCode, c.Name AS CompanyName
       FROM dbo.CustomerAddressLinks cal
       INNER JOIN dbo.Companies c ON c.CompanyId = cal.CompanyId
       WHERE cal.AddressId = @id`,
      { id: Number(req.params.id) }
    );

    res.json({ address, links });
  })
);

const updateSchema = z.object({
  zoneId: z.number().nullable().optional(),
  branchName: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  contactEmail: z.string().email().nullable().optional().or(z.literal('')),
  smsOptIn: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
  deliveryWindowStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional().or(z.literal('')),
  deliveryWindowEnd:   z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional().or(z.literal('')),
  deliveryDays: z.string().nullable().optional(),
  deliveryNotes: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
});

router.patch(
  '/:id',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const id = Number(req.params.id);

    const sets = [];
    const params = { id };
    const map = {
      zoneId: 'ZoneId = @zoneId',
      branchName: 'BranchName = @branchName',
      contactName: 'ContactName = @contactName',
      contactPhone: 'ContactPhone = @contactPhone',
      contactEmail: 'ContactEmail = @contactEmail',
      smsOptIn: 'SmsOptIn = @smsOptIn',
      emailOptIn: 'EmailOptIn = @emailOptIn',
      deliveryWindowStart: 'DeliveryWindowStart = @deliveryWindowStart',
      deliveryWindowEnd: 'DeliveryWindowEnd = @deliveryWindowEnd',
      deliveryDays: 'DeliveryDays = @deliveryDays',
      deliveryNotes: 'DeliveryNotes = @deliveryNotes',
      latitude: 'Latitude = @latitude',
      longitude: 'Longitude = @longitude',
    };

    for (const [key, sqlFrag] of Object.entries(map)) {
      if (data[key] !== undefined) {
        sets.push(sqlFrag);
        let val = data[key];
        if (val === '') val = null;
        params[key] = val;
      }
    }

    if (sets.length === 0) return res.json({ ok: true, unchanged: true });

    await db.execute(
      `UPDATE dbo.NormalizedAddresses SET ${sets.join(', ')} WHERE AddressId = @id`,
      params
    );

    res.json({ ok: true });
  })
);

export default router;
