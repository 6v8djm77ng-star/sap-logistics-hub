import { Router } from 'express';
import { z } from 'zod';
import * as ret from '../services/returnRequests.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  companyCode: z.enum(['A', 'B']),
  cardCode: z.string(),
  cardName: z.string().optional(),
  addressId: z.number(),
  requestedDate: z.string(),
  reason: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(
    z.object({
      itemCode: z.string(),
      itemName: z.string().optional(),
      quantity: z.number().positive(),
      reasonCode: z.string().optional(),
      reasonText: z.string().optional(),
    })
  ).min(1),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const list = await ret.listPendingReturns(req.query);
    res.json({ returns: list });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const r = await ret.getReturnDetails(Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  })
);

router.post(
  '/',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const r = await ret.createReturnRequest(data);
    const io = req.app.get('io');
    io?.emit('return:created', r);
    res.status(201).json(r);
  })
);

router.post(
  '/:id/assign-to-run/:runId',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const result = await ret.assignReturnToRun(
      Number(req.params.id),
      Number(req.params.runId)
    );
    const io = req.app.get('io');
    io?.emit('return:assigned', result);
    res.json(result);
  })
);

router.post(
  '/:id/pickup',
  requireRole('ADMIN', 'DRIVER'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      actualLines: z.array(z.object({
        returnLineId: z.number(),
        actualQuantity: z.number().nonnegative(),
      })).default([]),
    });
    const { actualLines } = schema.parse(req.body);
    const result = await ret.markReturnPickedUp(Number(req.params.id), { actualLines });
    const io = req.app.get('io');
    io?.emit('return:picked-up', result);
    res.json(result);
  })
);

export default router;
