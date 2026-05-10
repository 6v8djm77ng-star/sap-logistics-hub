import { Router } from 'express';
import { generateDriverManifestPdf } from '../services/reports/driverManifest.js';
import { generatePickingListExcel } from '../services/reports/pickingList.js';
import { getExceptionsReport } from '../services/reports/exceptions.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
// Manifest PDFs and picking XLSX expose full customer addresses, phones, and
// route detail. Restrict to ADMIN/PLANNER/WAREHOUSE (security-analysis F9).
// NOTE: per-driver manifests for the driver's *own* run still need a
// non-shared download path — see deferred items in PR description.
router.use(requireAuth, requireRole('ADMIN', 'PLANNER', 'WAREHOUSE'));

/**
 * GET /api/reports/runs/:id/manifest.pdf
 * Returns PDF stream of driver manifest.
 */
router.get(
  '/runs/:id/manifest.pdf',
  asyncHandler(async (req, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="manifest-${req.params.id}.pdf"`);
    const pdf = await generateDriverManifestPdf(Number(req.params.id));
    pdf.pipe(res);
  })
);

/**
 * GET /api/reports/waves/:id/picking.xlsx
 * Returns Excel file of picking list.
 */
router.get(
  '/waves/:id/picking.xlsx',
  asyncHandler(async (req, res) => {
    const wb = await generatePickingListExcel(Number(req.params.id));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="picking-${req.params.id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);

/**
 * GET /api/reports/exceptions
 * JSON report of items requiring manual intervention.
 */
router.get(
  '/exceptions',
  asyncHandler(async (req, res) => {
    const report = await getExceptionsReport(req.query);
    res.json(report);
  })
);

export default router;
