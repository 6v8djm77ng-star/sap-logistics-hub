import { Router } from 'express';
import { z } from 'zod';
import * as gps from '../services/gpsTracking.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const positionSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().optional(),
  heading: z.number().min(0).max(360).optional(),
  speedKmh: z.number().nonnegative().optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
  runId: z.number().optional(),
});

/**
 * Driver reports position. Called periodically from mobile.
 */
router.post(
  '/position',
  asyncHandler(async (req, res) => {
    const data = positionSchema.parse(req.body);
    const driverId = req.user.driverId;
    if (!driverId) return res.status(403).json({ error: 'Driver token required' });

    await gps.recordPosition({ driverId, ...data });

    const io = req.app.get('io');
    io?.to('planner').emit('driver:position', { driverId, ...data, at: new Date() });

    res.json({ ok: true });
  })
);

/**
 * Planner view - all active drivers' current positions.
 */
router.get(
  '/drivers',
  asyncHandler(async (req, res) => {
    const locations = await gps.getAllDriverLocations();
    res.json({ locations });
  })
);

/**
 * Historical trail for a driver's run.
 */
router.get(
  '/drivers/:id/trail',
  asyncHandler(async (req, res) => {
    const trail = await gps.getDriverTrail(Number(req.params.id), req.query);
    res.json({ trail });
  })
);

export default router;
