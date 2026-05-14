// =====================================================================
// analyticsReadOnly.js — sandbox tool wrappers for operational analytics
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
// get_anomalies_summary(days)
// =====================================================================
export const get_anomalies_summary = {
  name: 'get_anomalies_summary',
  description: 'List of anomalies (unusual deliveries, pricing, returns) over last N days. Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
    required: ['days'],
  },
  handler: async (input) => {
    z.object({ days: z.number().int().min(1).max(90) }).parse(input);
    if (config.USE_MOCK) {
      return loadMock('anomalies.json');
    }
    throw new Error('Live anomaly fetch not implemented in sandbox skeleton.');
  },
};

// =====================================================================
// get_run_details(run_id) — for the report explainer
// =====================================================================
export const get_run_details = {
  name: 'get_run_details',
  description: 'Returns the manifest data for a specific delivery run (driver, stops, orders, failures). Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: { run_id: { type: 'integer' } },
    required: ['run_id'],
  },
  handler: async (input) => {
    const { run_id } = z.object({ run_id: z.number().int() }).parse(input);
    if (config.USE_MOCK) {
      const data = loadMock('runs.json');
      if (Array.isArray(data)) {
        const found = data.find((r) => r.RunId === run_id);
        return found || { _not_found: true, run_id };
      }
      return data;
    }
    throw new Error('Live run fetch not implemented in sandbox skeleton.');
  },
};

// =====================================================================
// get_failure_breakdown(days) — for explainer + sales insights
// =====================================================================
export const get_failure_breakdown = {
  name: 'get_failure_breakdown',
  description: 'Counts of delivery failures by reason code over last N days. Read-only.',
  is_read_only: true,
  input_schema: {
    type: 'object',
    properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
    required: ['days'],
  },
  handler: async (input) => {
    z.object({ days: z.number().int().min(1).max(90) }).parse(input);
    if (config.USE_MOCK) {
      return loadMock('failures.json');
    }
    throw new Error('Live failure-fetch not implemented in sandbox skeleton.');
  },
};

export const allAnalyticsTools = [get_anomalies_summary, get_run_details, get_failure_breakdown];
