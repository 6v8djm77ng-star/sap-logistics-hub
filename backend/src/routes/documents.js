/**
 * Documents routes — Phase A2g-1 (2026-05-20).
 *
 * Restores /api/documents/stats parity from demoServer.js (L3572) onto the
 * hardened src/server.js. Read-only over persistentStore helpers; the
 * response shape matches demoServer.js exactly so the existing
 * DocumentsPage + A2f SapWriteAuditBanner consume it without change.
 *
 * Why this lives in src/routes/ and not demoServer.js: ecosystem.config.cjs
 * has been pinned to src/server.js since 2026-05-05 (Phase 2 hardening:
 * per-route requireAuth, Helmet CSP, scoped CORS). The demo-only routes
 * were never ported, leaving DocumentsPage + A2d/A2e/A2f silently broken
 * in production — surfaced by the 2026-05-20 A2f smoke when PM2 finally
 * spun up sap-logistics. This file is the first of 4 A2g commits.
 *
 * Scope of THIS file: GET /api/documents/stats only.
 *   - Returns the same shape as getDocumentStats() — includes the
 *     `audit` block added in A2e (combinedErrorsCount, totalAttempts,
 *     lastWriteAttemptAt, per-doc-type withErrors+totalAttempts).
 *
 * Out of scope (deferred to other A2g commits):
 *   - POST /documents/:type/:id/confirm-sap (mutation; A2g-1 is read-only)
 *   - POST /documents/mark-exported       (mutation)
 */
import { Router } from 'express';
import { getDocumentStats } from '../demo/persistentStore.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * Document statistics + A2e audit summary.
 * Query: { runDate? }
 * Response: see getDocumentStats() in persistentStore.js.
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    res.json(getDocumentStats(req.query));
  })
);

export default router;
