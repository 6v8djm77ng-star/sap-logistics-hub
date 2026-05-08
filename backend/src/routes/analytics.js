import { Router } from 'express';
import { format, subDays } from 'date-fns';
import * as analytics from '../services/analytics.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

function dateRange(req) {
  const toDate = req.query.toDate || format(new Date(), 'yyyy-MM-dd');
  const fromDate = req.query.fromDate || format(subDays(new Date(toDate), 29), 'yyyy-MM-dd');
  return { fromDate, toDate };
}

router.get(
  '/summary',
  requireRole('ADMIN', 'PLANNER'),
  asyncHandler(async (req, res) => {
    const summary = await analytics.getDashboardSummary(dateRange(req));
    res.json(summary);
  })
);

router.get('/overall', asyncHandler(async (req, res) => {
  res.json(await analytics.getOverallKpis(dateRange(req)));
}));

router.get('/daily', asyncHandler(async (req, res) => {
  const rows = await analytics.getDailyTrend(dateRange(req));
  res.json({ days: rows });
}));

router.get('/drivers', asyncHandler(async (req, res) => {
  const rows = await analytics.getDriverPerformance(dateRange(req));
  res.json({ drivers: rows });
}));

router.get('/zones', asyncHandler(async (req, res) => {
  const rows = await analytics.getZonePerformance(dateRange(req));
  res.json({ zones: rows });
}));

router.get('/failures', asyncHandler(async (req, res) => {
  const rows = await analytics.getFailureBreakdown(dateRange(req));
  res.json({ failures: rows });
}));

router.get('/sap-health', asyncHandler(async (req, res) => {
  res.json(await analytics.getSapSyncHealth());
}));

export default router;
