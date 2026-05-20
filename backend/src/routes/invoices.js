/**
 * Invoices routes — Phase A2g-1 (2026-05-20).
 *
 * Restores GET /api/invoices parity from demoServer.js (L3565) onto
 * src/server.js. Read-only listing; response shape `{ invoices: [...] }`
 * matches demoServer exactly so frontend docsApi.listInvoices
 * (which expects r.data.invoices) works without change.
 *
 * Scope of THIS file: GET / only (list with filters).
 * Out of scope (deferred):
 *   - any invoice mutation / SAP write
 */
import { Router } from 'express';
import { listInvoices } from '../demo/persistentStore.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * List invoices with optional filters.
 * Query: { runId?, stopId?, companyCode?, status?, runDate? }
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ invoices: listInvoices(req.query) });
  })
);

export default router;
