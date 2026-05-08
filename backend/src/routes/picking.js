import { Router } from 'express';
import { z } from 'zod';
import * as waves from '../services/wavePicking.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const wave = await waves.getWaveDetails(Number(req.params.id));
    if (!wave) return res.status(404).json({ error: 'Wave not found' });
    res.json(wave);
  })
);

router.post(
  '/lines/:lineId/pick',
  requireRole('ADMIN', 'WAREHOUSE'),
  asyncHandler(async (req, res) => {
    const schema = z.object({ pickedQuantity: z.number().positive() });
    const { pickedQuantity } = schema.parse(req.body);

    const result = await waves.recordPick(
      Number(req.params.lineId),
      pickedQuantity,
      req.user.sub
    );
    const io = req.app.get('io');
    io?.emit('picking:line-updated', result);
    res.json(result);
  })
);

export default router;
