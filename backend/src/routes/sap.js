import { Router } from 'express';
import * as diagnostic from '../services/sapDiagnostic.js';
import * as sample from '../services/sapSampleData.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /api/sap/diagnose - run full connectivity check.
 */
router.get(
  '/diagnose',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const result = await diagnostic.runFullDiagnostic();
    res.json(result);
  })
);

/**
 * GET /api/sap/test/sql/:company - test a specific SQL connection.
 */
router.get(
  '/test/sql/:company',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const result = await diagnostic.checkSapSql(req.params.company.toUpperCase());
    res.json(result);
  })
);

/**
 * GET /api/sap/test/sl/:company - test Service Layer for a company.
 */
router.get(
  '/test/sl/:company',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const result = await diagnostic.checkServiceLayer(req.params.company.toUpperCase());
    res.json(result);
  })
);

/**
 * GET /api/sap/sample/:company - sample data preview.
 */
router.get(
  '/sample/:company',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const data = await sample.getSamplePreview(req.params.company.toUpperCase());
    res.json(data);
  })
);

export default router;
