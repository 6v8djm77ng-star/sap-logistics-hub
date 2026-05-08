import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import * as db from '../db/logisticsDb.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const drivers = await db.query(
      `SELECT d.DriverId, d.Code, d.FullName, d.Phone, d.Email, d.VehiclePlate,
              d.VehicleCapacity, d.IsActive, d.LastLoginAt,
              (SELECT STRING_AGG(z.Code, ',') FROM dbo.DriverZones dz
                INNER JOIN dbo.Zones z ON z.ZoneId = dz.ZoneId
                WHERE dz.DriverId = d.DriverId) AS Zones
       FROM dbo.Drivers d
       ORDER BY d.Code`
    );
    res.json({ drivers });
  })
);

const driverSchema = z.object({
  code: z.string().max(20),
  fullName: z.string().max(100),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  vehiclePlate: z.string().optional(),
  vehicleCapacity: z.number().int().positive().optional(),
  // Driver password is set by admins on creation; honor PASSWORD_MIN_LENGTH so
  // it stays consistent with user passwords.
  password: z.string().min(env.PASSWORD_MIN_LENGTH).optional(),
  zoneIds: z.array(z.number()).optional(),
});

router.post(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const data = driverSchema.parse(req.body);
    const passwordHash = data.password ? await bcrypt.hash(data.password, env.BCRYPT_COST) : null;

    const driver = await db.queryOne(
      `INSERT INTO dbo.Drivers
         (Code, FullName, Phone, Email, VehiclePlate, VehicleCapacity, PasswordHash, IsActive)
       OUTPUT INSERTED.*
       VALUES (@code, @name, @phone, @email, @plate, @capacity, @hash, 1)`,
      {
        code: data.code,
        name: data.fullName,
        phone: data.phone || null,
        email: data.email || null,
        plate: data.vehiclePlate || null,
        capacity: data.vehicleCapacity || null,
        hash: passwordHash,
      }
    );

    if (data.zoneIds?.length) {
      for (const zoneId of data.zoneIds) {
        await db.execute(
          `INSERT INTO dbo.DriverZones (DriverId, ZoneId, Priority)
           VALUES (@driverId, @zoneId, 1)`,
          { driverId: driver.DriverId, zoneId }
        );
      }
    }
    res.status(201).json(driver);
  })
);

router.patch(
  '/:id/zones',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { zoneIds } = z.object({ zoneIds: z.array(z.number()) }).parse(req.body);
    const driverId = Number(req.params.id);
    await db.execute(`DELETE FROM dbo.DriverZones WHERE DriverId = @id`, { id: driverId });
    for (const zid of zoneIds) {
      await db.execute(
        `INSERT INTO dbo.DriverZones (DriverId, ZoneId, Priority) VALUES (@d, @z, 1)`,
        { d: driverId, z: zid }
      );
    }
    res.json({ ok: true });
  })
);

export default router;
