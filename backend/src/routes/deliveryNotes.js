/**
 * Delivery Notes routes — Phase A2g-1 (2026-05-20).
 *
 * Restores GET /api/delivery-notes parity from demoServer.js (L3558) onto
 * src/server.js. Read-only listing; response shape `{ deliveryNotes: [...] }`
 * matches demoServer exactly so frontend docsApi.listDeliveryNotes
 * (which expects r.data.deliveryNotes) works without change.
 *
 * Scope of THIS file: GET / only (list with filters).
 * Out of scope (deferred):
 *   - POST /:id/generate-invoice (mutation)
 *   - any DN write paths
 */
import { Router } from 'express';
import { listDeliveryNotes } from '../demo/persistentStore.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * List delivery notes with optional filters.
 * Query: { runId?, stopId?, companyCode?, status?, runDate? }
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ deliveryNotes: listDeliveryNotes(req.query) });
  })
);

export default router;
