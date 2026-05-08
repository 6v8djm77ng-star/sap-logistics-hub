/**
 * Agent endpoints — manual triggers + read-only access to run history.
 *
 * POST /api/agents/ceo-brief/run    — kick off a CEO Daily Brief synchronously, returns the brief
 * GET  /api/agents/runs             — list recent runs (across all agents)
 * GET  /api/agents/runs/:id         — full run detail (messages, tool calls, output)
 *
 * Requires ADMIN role. Returns 503 if ANTHROPIC_API_KEY is not configured.
 */
import { Router } from 'express';
import { z } from 'zod';
import { agentsConfigured } from '../config/env.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { runCeoBrief } from '../agents/ceoBrief.js';
import * as store from '../agents/store.js';

const router = Router();
router.use(requireAuth);

router.use((req, res, next) => {
  if (!agentsConfigured) {
    return res.status(503).json({
      error: 'Agents are not configured. Set ANTHROPIC_API_KEY in .env to enable.',
    });
  }
  next();
});

const runCeoBriefSchema = z.object({
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post(
  '/ceo-brief/run',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const body = runCeoBriefSchema.parse(req.body || {});
    const result = await runCeoBrief({
      anchorDate: body.anchorDate,
      triggerType: 'manual',
      createdBy: req.user?.username || `user-${req.user?.sub}`,
    });
    res.json(result);
  })
);

router.get(
  '/runs',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const agentName = typeof req.query.agentName === 'string' ? req.query.agentName : undefined;
    const runs = await store.listRuns({ agentName, limit });
    res.json({ runs });
  })
);

router.get(
  '/runs/:id',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid run id' });
    }
    const run = await store.getRun(id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  })
);

export default router;
