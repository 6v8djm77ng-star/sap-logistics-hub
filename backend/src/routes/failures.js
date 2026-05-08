import { Router } from 'express';
import { z } from 'zod';
import * as failures from '../services/failures.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/reasons',
  asyncHandler(async (req, res) => {
    const reasons = await failures.listReasons();
    res.json({ reasons });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const list = await failures.listOpenFailures({
      includeResolved: req.query.includeResolved === 'true',
    });
    res.json({ failures: list });
  })
);

const reportSchema = z.object({
  stopId: z.number(),
  reasonCode: z.string(),
  notes: z.string().optional(),
  photoDataUrl: z.string().optional(),
});

router.post(
  '/report',
  asyncHandler(async (req, res) => {
    const data = reportSchema.parse(req.body);
    const driverId = req.user.driverId || null;
    const result = await failures.reportFailure({ ...data, driverId });

    const io = req.app.get('io');
    io?.to('planner').emit('failure:reported', result);
    res.status(201).json(result);
  })
);

router.post(
  '/:id/reschedule',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const { targetRunId, notes } = z.object({
      targetRunId: z.number(),
      notes: z.string().optional(),
    }).parse(req.body);

    const result = await failures.rescheduleFailure(
      Number(req.params.id),
      { targetRunId, notes, userId: req.user.sub }
    );

    const io = req.app.get('io');
    io?.emit('failure:rescheduled', result);
    res.json(result);
  })
);

router.post(
  '/:id/resolve',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const { status, notes } = z.object({
      status: z.enum(['RESOLVED', 'CANCELLED']),
      notes: z.string().optional(),
    }).parse(req.body);

    const result = await failures.resolveFailure(
      Number(req.params.id),
      { status, notes, userId: req.user.sub }
    );

    const io = req.app.get('io');
    io?.emit('failure:resolved', result);
    res.json(result);
  })
);

export default router;
