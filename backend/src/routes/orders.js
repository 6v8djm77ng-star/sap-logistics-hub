import { Router } from 'express';
import { z } from 'zod';
import * as unif from '../services/orderUnification.js';
import * as sapSql from '../services/sap/sqlReader.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth);

/**
 * List open orders from both companies, flat.
 */
router.get(
  '/open',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const orders = await unif.fetchOpenOrdersBothCompanies({ fromDate, toDate });
    res.json({ orders, count: orders.length });
  })
);

/**
 * Get unified view: orders grouped by normalized delivery address.
 * This is what the planner sees.
 */
router.get(
  '/unified',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const groups = await unif.unifyOrdersByAddress({ fromDate, toDate });
    res.json({ groups, count: groups.length });
  })
);

/**
 * Stats - merger savings over a date range.
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const stats = await unif.getUnificationStats({ fromDate, toDate });
    res.json(stats);
  })
);

/**
 * Get lines of a specific SAP order.
 */
router.get(
  '/:company/:docEntry/lines',
  asyncHandler(async (req, res) => {
    const { company, docEntry } = req.params;
    const lines = await sapSql.getOrderLines(company, Number(docEntry));
    res.json({ lines });
  })
);

export default router;
