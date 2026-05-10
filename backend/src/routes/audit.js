import { Router } from 'express';
import { getAuditTrail } from '../services/auditLog.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
// Audit trail includes password-reset markers, role changes, and edit history
// for every entity. ADMIN-only (security-analysis F8).
router.use(requireAuth, requireRole('ADMIN'));

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
