import { Router } from 'express';
import { getAuditTrail } from '../services/auditLog.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/:entityType/:entityId',
  asyncHandler(async (req, res) => {
    const trail = await getAuditTrail(
      req.params.entityType,
      Number(req.params.entityId)
    );
    res.json({ trail });
  })
);

export default router;
