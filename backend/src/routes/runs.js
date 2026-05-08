import { Router } from 'express';
import { z } from 'zod';
import * as runs from '../services/deliveryRuns.js';
import * as waves from '../services/wavePicking.js';
import * as trackingTokens from '../services/trackingTokens.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

const createRunSchema = z.object({
  runDate: z.string(),
  zoneId: z.number(),
  driverId: z.number().optional(),
  notes: z.string().optional(),
});

const autoPlanSchema = z.object({ runDate: z.string() });

const statusSchema = z.object({
  status: z.enum(['OPEN', 'PLANNED', 'PICKING', 'LOADED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED']),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const list = await runs.listRuns(req.query);
    res.json({ runs: list });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const run = await runs.getRunDetails(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  })
);

router.post(
  '/',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const data = createRunSchema.parse(req.body);
    const run = await runs.createRun({ ...data, createdBy: req.user.sub });
    const io = req.app.get('io');
    io?.emit('run:created', run);
    res.status(201).json(run);
  })
);

router.post(
  '/auto-plan',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const { runDate } = autoPlanSchema.parse(req.body);
    const result = await runs.autoPlanDay({ runDate, createdBy: req.user.sub });
    const io = req.app.get('io');
    io?.emit('runs:auto-planned', { runDate, count: result.runsCreated.length });
    res.json(result);
  })
);

router.patch(
  '/:id/status',
  requireRole('ADMIN', 'PLANNER', 'DRIVER'),
  asyncHandler(async (req, res) => {
    const { status } = statusSchema.parse(req.body);
    const result = await runs.updateRunStatus(Number(req.params.id), status);
    const io = req.app.get('io');
    io?.emit('run:status-changed', result);
    res.json(result);
  })
);

router.post(
  '/:id/optimize-order',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const run = await runs.optimizeStopOrder(Number(req.params.id));
    const io = req.app.get('io');
    io?.emit('run:updated', { runId: run.RunId });
    res.json(run);
  })
);

// ---------- Wave Picking ----------

router.post(
  '/:id/wave',
  requireRole('ADMIN', 'PLANNER', 'WAREHOUSE'),
  asyncHandler(async (req, res) => {
    const wave = await waves.buildWaveForRun(Number(req.params.id));
    const io = req.app.get('io');
    io?.emit('wave:created', wave);
    res.status(201).json(wave);
  })
);

router.get(
  '/:id/wave',
  asyncHandler(async (req, res) => {
    const runId = Number(req.params.id);
    const wave = await (async () => {
      const row = await (await import('../db/logisticsDb.js')).queryOne(
        `SELECT TOP 1 WaveId FROM dbo.PickingWaves
         WHERE RunId = @runId AND Status <> 'CANCELLED'
         ORDER BY CreatedAt DESC`,
        { runId }
      );
      return row ? waves.getWaveDetails(row.WaveId) : null;
    })();
    if (!wave) return res.status(404).json({ error: 'No active wave' });
    res.json(wave);
  })
);

/**
 * Get a tracking link for a specific stop (to share with customer via SMS).
 */
router.post(
  '/stops/:stopId/tracking-link',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const token = await trackingTokens.createTokenForStop(Number(req.params.stopId));
    res.json({
      token,
      url: trackingTokens.getTrackingUrl(token),
    });
  })
);

export default router;
