// =====================================================================
// financialReadOnly.js — sandbox tool wrappers for SAP financial reads
// EVERY tool here MUST set is_read_only:true (loader enforces).
// All tools fall back to mock JSON when SANDBOX_USE_MOCK=true (default).
// =====================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { config } from '../../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.resolve(__dirname, '..', '..', 'mock-data');

function loadMock(name) {
  const file = path.join(MOCK_DIR, name);
  if (!fs.existsSync(file)) {
    return { _mock_missing: true, file: name, hint: `Drop a JSON file at backend-sandbox/mock-data/${name}` };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// =====================================================================
// get_daily_sales(date_from, date_to)
// =====================================================================
export const get_daily_sales = {
  name: 'get_daily_sales',
  description: 'Returns daily revenue totals for a date range. Read-only against SAP. Currency: ILS.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', description: 'YYYY-MM-DD' },
      date_to:   { type: 'string', description: 'YYYY-MM-DD' },
    },
    required: ['date_from', 'date_to'],
  },
  handler: async (input) => {
    const schema = z.object({
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      date_to:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    });
    const { date_from, date_to } = schema.parse(input);

    if (config.USE_MOCK) {
      const data = loadMock('daily-sales.json');
      // Filter to the requested range if data is an array of {date, revenue}
      if (Array.isArray(data)) {
        return data.filter((d) => d.date >= date_from && d.date <= date_to);
      }
      return data;
    }

    // Live SAP path — intentionally not implemented in sandbox skeleton.
    // Operator must add an mssql query here if SANDBOX_USE_MOCK=false.
    throw new Error('Live SAP read not implemented in sandbox skeleton. Set SANDBOX_USE_MOCK=true.');
  },
};

// =====================================================================
// get_top_customers(days, limit)
// =====================================================================
export const get_top_customers = {
  name: 'get_top_customers',
  description: 'Top N customers by revenue over the last N days. Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: {
      days:  { type: 'integer', minimum: 1, maximum: 365 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['days', 'limit'],
  },
  handler: async (input) => {
    const schema = z.object({
      days:  z.number().int().min(1).max(365),
      limit: z.number().int().min(1).max(50),
    });
    const { limit } = schema.parse(input);

    if (config.USE_MOCK) {
      const data = loadMock('top-customers.json');
      if (Array.isArray(data)) return data.slice(0, limit);
      return data;
    }
    throw new Error('Live SAP read not implemented in sandbox skeleton.');
  },
};

// =====================================================================
// get_top_items(days, limit)
// =====================================================================
export const get_top_items = {
  name: 'get_top_items',
  description: 'Top N items by sales volume over the last N days. Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: {
      days:  { type: 'integer', minimum: 1, maximum: 365 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['days', 'limit'],
  },
  handler: async (input) => {
    const schema = z.object({
      days:  z.number().int().min(1).max(365),
      limit: z.number().int().min(1).max(50),
    });
    const { limit } = schema.parse(input);

    if (config.USE_MOCK) {
      const data = loadMock('top-items.json');
      if (Array.isArray(data)) return data.slice(0, limit);
      return data;
    }
    throw new Error('Live SAP read not implemented in sandbox skeleton.');
  },
};

// =====================================================================
// get_dead_stock(days_threshold)
// =====================================================================
export const get_dead_stock = {
  name: 'get_dead_stock',
  description: 'Items with no sales activity for >N days. Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: { days_threshold: { type: 'integer', minimum: 30, maximum: 365 } },
    required: ['days_threshold'],
  },
  handler: async (input) => {
    z.object({ days_threshold: z.number().int().min(30).max(365) }).parse(input);
    if (config.USE_MOCK) {
      return loadMock('dead-stock.json');
    }
    throw new Error('Live SAP read not implemented in sandbox skeleton.');
  },
};

export const allFinancialTools = [get_daily_sales, get_top_customers, get_top_items, get_dead_stock];
