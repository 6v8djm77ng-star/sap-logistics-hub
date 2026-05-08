/**
 * DAVO Mix Tracker — read-only product-mix endpoints.
 * Powers the Q1 2026 60/40 rebalancing dashboard.
 */
import { Router } from 'express';
import * as davoMix from '../services/davoMix.js';
import { runWeeklyReport, buildWeeklyReport, renderReportHtml } from '../services/davoMixWeeklyReport.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/summary', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(await davoMix.getMixSummary({ days }));
}));

router.get('/categories', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(await davoMix.getCategoryBreakdown({ days }));
}));

router.get('/attach', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(await davoMix.getAttachRate({ days }));
}));

router.get('/attach/top-items', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  const limit = Number(req.query.limit) || 15;
  res.json(await davoMix.getTopAttachItems({ days, limit }));
}));

router.get('/buyers', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  const limit = Number(req.query.limit) || 10;
  const rows = await davoMix.getTopDavoBuyers({ days, limit });
  res.json({ buyers: rows });
}));

router.get('/buyers/:cardCode', asyncHandler(async (req, res) => {
  const days = Number(req.query.days) || 90;
  const breakdown = await davoMix.getBuyerBreakdown({ cardCode: req.params.cardCode, days });
  if (!breakdown.found) return res.status(404).json({ error: 'No DAVO sales found for this buyer in the window' });
  res.json(breakdown);
}));

/**
 * Preview the weekly report HTML without sending email.
 * GET /api/davo-mix/weekly-report/preview
 */
router.get('/weekly-report/preview', asyncHandler(async (req, res) => {
  const report = await buildWeeklyReport();
  const html = renderReportHtml(report);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}));

/**
 * Manually trigger the weekly report (sends to configured recipients).
 * Admin only. POST /api/davo-mix/weekly-report/run
 */
router.post('/weekly-report/run',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const result = await runWeeklyReport({ triggerType: 'manual' });
    res.json({
      sent: result.sent,
      recipients: result.recipients,
      failures: result.failures || 0,
      summary: {
        nonMixerShare: result.report.headline.nonMixerShare,
        attachRate: result.report.attach.rate,
        totalRev: result.report.headline.totalRev,
      },
    });
  })
);

export default router;
