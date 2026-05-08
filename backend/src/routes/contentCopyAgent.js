/**
 * Content & Copy Agent — Express route.
 *
 * POST /api/agents/content-copy/run
 *   Body: see contentCopy/schema.js (inputSchema)
 *   Auth: ADMIN only (MVP)
 *   Returns: see contentCopy/schema.js (outputSchema)
 *
 * Stateless. No DB writes. No prompt / output / API key is logged.
 */
import { Router } from 'express';
import { agentsConfigured } from '../config/env.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { runContentCopyAgent } from '../agents/contentCopy/contentCopyAgent.js';

const router = Router();

router.use(requireAuth);

router.post(
  '/run',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    if (!agentsConfigured) {
      return res.status(503).json({ error: 'Agent not configured' });
    }

    try {
      const output = await runContentCopyAgent(req.body || {});
      return res.json(output);
    } catch (err) {
      const status = err.statusHint || 500;
      const body = { error: err.code || 'internal_error' };
      if (status === 400 && err.details) body.details = err.details;
      return res.status(status).json(body);
    }
  })
);

export default router;
