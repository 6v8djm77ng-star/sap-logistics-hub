/**
 * Tool definitions exposed to LLM agents for SAP financial / commercial data.
 * Each tool wraps a single function from services/sap/financialReader.js
 * and declares its JSON Schema so the model can call it correctly.
 *
 * Schemas use ISO date strings (YYYY-MM-DD).
 */
import * as fr from '../../services/sap/financialReader.js';

const dateRange = {
  fromDate: { type: 'string', description: 'Start date (inclusive), YYYY-MM-DD.' },
  toDate:   { type: 'string', description: 'End date (inclusive), YYYY-MM-DD.' },
};

export const financialTools = [
  {
    name: 'get_daily_sales',
    description: 'Daily sales totals (invoiced revenue and order count) per company, in a date range. Use to compare day-vs-day, week-vs-week, MTD-vs-prior-MTD trends.',
    input_schema: {
      type: 'object',
      properties: dateRange,
      required: ['fromDate', 'toDate'],
    },
    handler: ({ fromDate, toDate }) => fr.getDailySales({ fromDate, toDate }),
  },
  {
    name: 'get_top_items',
    description: 'Top selling items by revenue in a date range, per company. Use to identify revenue concentration or movers.',
    input_schema: {
      type: 'object',
      properties: {
        ...dateRange,
        limit: { type: 'integer', description: 'How many items to return (1-100).', minimum: 1, maximum: 100 },
      },
      required: ['fromDate', 'toDate'],
    },
    handler: ({ fromDate, toDate, limit }) => fr.getTopItems({ fromDate, toDate, limit }),
  },
  {
    name: 'get_low_stock_items',
    description: 'Items where available stock is below their MinLevel reorder point. Use to flag stockout risks.',
    input_schema: {
      type: 'object',
      properties: {
        thresholdMultiplier: { type: 'number', description: '1.0 = at-or-below MinLevel. Use 1.5 to also catch borderline.', minimum: 0.1, maximum: 5 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: [],
    },
    handler: ({ thresholdMultiplier, limit }) => fr.getLowStockItems({ thresholdMultiplier, limit }),
  },
  {
    name: 'get_dead_stock',
    description: 'Items with high OnHand but no sales for N days. Use to flag dead stock / capital tied up.',
    input_schema: {
      type: 'object',
      properties: {
        daysWithoutSale: { type: 'integer', description: 'No sales in last N days (default 90).', minimum: 7, maximum: 730 },
        minOnHand: { type: 'integer', description: 'Minimum on-hand qty to qualify (default 10).', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: [],
    },
    handler: ({ daysWithoutSale, minOnHand, limit }) => fr.getDeadStock({ daysWithoutSale, minOnHand, limit }),
  },
  {
    name: 'get_margin_by_item',
    description: 'Per-item gross margin (revenue, cost, margin %, using OITM moving-avg cost) in a date range. Use to spot pricing errors, margin compression, or unprofitable items.',
    input_schema: {
      type: 'object',
      properties: {
        ...dateRange,
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['fromDate', 'toDate'],
    },
    handler: ({ fromDate, toDate, limit }) => fr.getMarginByItem({ fromDate, toDate, limit }),
  },
  {
    name: 'get_top_customers',
    description: 'Top customers by revenue in a date range. Use for revenue concentration analysis.',
    input_schema: {
      type: 'object',
      properties: {
        ...dateRange,
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['fromDate', 'toDate'],
    },
    handler: ({ fromDate, toDate, limit }) => fr.getTopCustomers({ fromDate, toDate, limit }),
  },
  {
    name: 'get_churn_risk_customers',
    description: 'Customers who used to buy regularly but have been silent recently. Use to spot churn signals worth retention outreach.',
    input_schema: {
      type: 'object',
      properties: {
        silentDays: { type: 'integer', description: 'Days with no orders to count as silent (default 30).', minimum: 7, maximum: 365 },
        lookbackDays: { type: 'integer', description: 'Window to measure prior buying behavior (default 90).', minimum: 30, maximum: 730 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: [],
    },
    handler: ({ silentDays, lookbackDays, limit }) => fr.getChurnRiskCustomers({ silentDays, lookbackDays, limit }),
  },
];
