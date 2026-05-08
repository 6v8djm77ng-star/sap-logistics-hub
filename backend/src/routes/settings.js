import { Router } from 'express';
import { z } from 'zod';
import * as systemSettings from '../services/systemSettings.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { category } = req.query;
    const settings = await systemSettings.getAll({ category });
    res.json({ settings });
  })
);

router.put(
  '/:key',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { value } = z.object({ value: z.any() }).parse(req.body);
    const result = await systemSettings.set(req.params.key, value, req.user.sub);
    res.json(result);
  })
);

export default router;
