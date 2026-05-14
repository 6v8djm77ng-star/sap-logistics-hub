// =====================================================================
// verifiedMetrics.js — deterministic CEO Brief metrics calculator
//
// Pure JavaScript. No LLM, no estimation, no extrapolation.
// Reads mock JSON files (or live SAP later) and produces a structured
// `verified` object that the LLM consumes as INPUT — never modifies.
//
// Design contract:
//   - Same input + same source files → byte-identical output (modulo timestamp)
//   - Validation errors fail closed (no LLM call downstream)
//   - Missing source = `confidence: 'insufficient_data'`, NEVER an estimate
//
// See: docs/architecture-review/verified-metrics-architecture.md
// =====================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.resolve(__dirname, '..', 'mock-data');

// =====================================================================
// Source loaders — strict validation; missing returns null + warning
// =====================================================================

function loadSource(filename) {
  const filepath = path.join(MOCK_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return { ok: false, code: 'mock_missing', message: `${filename} not present in mock-data/` };
  }
  let raw;
  try { raw = fs.readFileSync(filepath, 'utf8'); }
  catch (e) { return { ok: false, code: 'mock_read_error', message: e.message }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, code: 'mock_parse_error', message: e.message }; }
  return { ok: true, data: parsed };
}

// =====================================================================
// Schema validation per source — refuses garbage data
// =====================================================================

const dailySalesRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  revenue_ils: z.number().nonnegative(),
  orders_count: z.number().int().nonnegative(),
});

const topCustomerRowSchema = z.object({
  card_code: z.string(),
  card_name: z.string(),
  revenue_ils: z.number().nonnegative(),
  orders: z.number().int().nonnegative(),
});

const topItemRowSchema = z.object({
  item_code: z.string(),
  item_name: z.string(),
  qty_sold: z.number().int().nonnegative(),
  revenue_ils: z.number().nonnegative(),
  margin_pct: z.number(),
});

const deadStockSchema = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  threshold_days: z.number().int().positive(),
  total_items_no_sales: z.number().int().nonnegative(),
  items: z.array(z.object({
    item_code: z.string(),
    item_name: z.string(),
    stock_qty: z.number().nonnegative(),
    days_since: z.number().int().nonnegative(),
  })),
});

// =====================================================================
// Pure computations
// =====================================================================

function sumByKey(rows, key) {
  return rows.reduce((acc, r) => acc + r[key], 0);
}

function dayOverDayDrops(rows, threshold_pct = 15) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const drops = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.revenue_ils === 0) continue;
    const drop_pct = ((prev.revenue_ils - cur.revenue_ils) / prev.revenue_ils) * 100;
    if (drop_pct >= threshold_pct) {
      drops.push({
        from_date: prev.date,
        to_date: cur.date,
        from_revenue: prev.revenue_ils,
        to_revenue: cur.revenue_ils,
        drop_pct: Number(drop_pct.toFixed(2)),
      });
    }
  }
  return drops;
}

function customerConcentration(customers, top_n = 3) {
  const sorted = [...customers].sort((a, b) => b.revenue_ils - a.revenue_ils);
  const top = sorted.slice(0, top_n);
  const top_sum = sumByKey(top, 'revenue_ils');
  const all_sum = sumByKey(sorted, 'revenue_ils');
  return {
    top_customers: top.map((c) => ({ card_code: c.card_code, card_name: c.card_name, revenue_ils: c.revenue_ils })),
    top_sum,
    all_sum,
    pct_of_all: all_sum > 0 ? Number(((top_sum / all_sum) * 100).toFixed(2)) : null,
  };
}

function lowMarginItems(items, threshold_pct = 30) {
  return items.filter((i) => i.margin_pct < threshold_pct);
}

// =====================================================================
// Date-range filter (for filtering daily-sales to the requested window)
// =====================================================================

function filterDateRange(rows, dateFrom, dateTo) {
  return rows.filter((r) => r.date >= dateFrom && r.date <= dateTo);
}

// =====================================================================
// Main entry: compute CEO Brief metrics
// =====================================================================

export function computeCeoBriefMetrics(input) {
  const computed_at = new Date().toISOString();
  const metrics = [];
  const anomalies = [];
  const warnings = [];
  const errors = [];
  const sources_consulted = [];
  const sources_returning_data = [];
  const sources_missing = [];

  const date_from = input?.date_from;
  const date_to = input?.date_to;

  // Validate input
  if (!date_from || !date_to || !/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    errors.push({
      code: 'bad_input',
      message: 'date_from and date_to must be YYYY-MM-DD strings',
    });
    return { metrics: [], anomalies: [], warnings: [], errors,
             meta: { computed_at, sources_consulted: [], sources_returning_data: [], sources_missing: [] } };
  }
  if (date_from > date_to) {
    errors.push({ code: 'bad_input', message: 'date_from must be <= date_to' });
    return { metrics: [], anomalies: [], warnings: [], errors,
             meta: { computed_at, sources_consulted: [], sources_returning_data: [], sources_missing: [] } };
  }

  // ---------------------------------------------------------------
  // SOURCE 1 — daily-sales.json
  // ---------------------------------------------------------------
  sources_consulted.push('mock-data/daily-sales.json');
  const dailySrc = loadSource('daily-sales.json');
  if (!dailySrc.ok) {
    sources_missing.push('mock-data/daily-sales.json');
    warnings.push({ code: dailySrc.code, message: dailySrc.message, source: 'mock-data/daily-sales.json' });
    metrics.push(insufficient('total_revenue_ils', 'סך הכנסות', 'ILS',
      'mock-data/daily-sales.json', 'SUM(daily_sales[].revenue_ils)', computed_at));
    metrics.push(insufficient('total_orders', 'סך הזמנות', 'count',
      'mock-data/daily-sales.json', 'SUM(daily_sales[].orders_count)', computed_at));
    metrics.push(insufficient('avg_daily_revenue_ils', 'הכנסה יומית ממוצעת', 'ILS',
      'mock-data/daily-sales.json', 'MEAN(daily_sales[].revenue_ils)', computed_at));
    metrics.push(insufficient('peak_revenue_day', 'יום שיא הכנסות', 'date',
      'mock-data/daily-sales.json', 'ARGMAX(daily_sales[].revenue_ils)', computed_at));
  } else {
    // Validate row schema — fail closed on shape error (different from missing)
    let rows;
    try {
      rows = z.array(dailySalesRowSchema).parse(dailySrc.data);
    } catch (e) {
      errors.push({
        code: 'schema_violation',
        message: `daily-sales.json failed validation: ${e.message}`,
        source: 'mock-data/daily-sales.json',
      });
      return { metrics: [], anomalies: [], warnings, errors,
               meta: { computed_at, sources_consulted, sources_returning_data, sources_missing } };
    }

    // Filter to requested window
    const inWindow = filterDateRange(rows, date_from, date_to);
    if (inWindow.length === 0) {
      warnings.push({
        code: 'empty_window',
        message: `No daily-sales rows fall within ${date_from}..${date_to}`,
        source: 'mock-data/daily-sales.json',
      });
      metrics.push(insufficient('total_revenue_ils', 'סך הכנסות', 'ILS',
        'mock-data/daily-sales.json', 'SUM(daily_sales[].revenue_ils)', computed_at));
      metrics.push(insufficient('total_orders', 'סך הזמנות', 'count',
        'mock-data/daily-sales.json', 'SUM(daily_sales[].orders_count)', computed_at));
    } else {
      sources_returning_data.push('mock-data/daily-sales.json');
      const total_revenue = sumByKey(inWindow, 'revenue_ils');
      const total_orders = sumByKey(inWindow, 'orders_count');
      const avg_daily_revenue = total_revenue / inWindow.length;
      const sorted_by_rev = [...inWindow].sort((a, b) => b.revenue_ils - a.revenue_ils);
      const peak = sorted_by_rev[0];

      metrics.push({
        id: 'total_revenue_ils',
        label_he: 'סך הכנסות',
        value: total_revenue,
        unit: 'ILS',
        source: 'mock-data/daily-sales.json',
        formula: `SUM(daily_sales[].revenue_ils where date in [${date_from}..${date_to}])`,
        confidence: 'high',
        inputs_count: inWindow.length,
        computed_at,
      });
      metrics.push({
        id: 'total_orders',
        label_he: 'סך הזמנות',
        value: total_orders,
        unit: 'count',
        source: 'mock-data/daily-sales.json',
        formula: `SUM(daily_sales[].orders_count where date in [${date_from}..${date_to}])`,
        confidence: 'high',
        inputs_count: inWindow.length,
        computed_at,
      });
      metrics.push({
        id: 'avg_daily_revenue_ils',
        label_he: 'הכנסה יומית ממוצעת',
        value: Number(avg_daily_revenue.toFixed(2)),
        unit: 'ILS',
        source: 'mock-data/daily-sales.json',
        formula: 'total_revenue_ils / inputs_count',
        confidence: 'high',
        inputs_count: inWindow.length,
        computed_at,
      });
      metrics.push({
        id: 'peak_revenue_day',
        label_he: 'יום שיא הכנסות',
        value: peak.date,
        unit: 'date',
        source: 'mock-data/daily-sales.json',
        formula: 'ARGMAX(daily_sales[].revenue_ils)',
        confidence: 'high',
        inputs_count: inWindow.length,
        computed_at,
      });
      metrics.push({
        id: 'peak_revenue_value',
        label_he: 'הכנסת יום השיא',
        value: peak.revenue_ils,
        unit: 'ILS',
        source: 'mock-data/daily-sales.json',
        formula: 'MAX(daily_sales[].revenue_ils)',
        confidence: 'high',
        inputs_count: inWindow.length,
        computed_at,
      });

      // Anomalies: day-over-day drops
      const drops = dayOverDayDrops(inWindow, 15);
      for (const d of drops) {
        anomalies.push({
          id: `rev_drop_${d.to_date}`,
          type: 'day_over_day_drop',
          description: `Revenue dropped ${d.drop_pct}% from ${d.from_date} (${d.from_revenue} ILS) to ${d.to_date} (${d.to_revenue} ILS)`,
          severity: d.drop_pct >= 25 ? 'high' : 'medium',
          related_metric_ids: ['total_revenue_ils', 'peak_revenue_day'],
          source: 'mock-data/daily-sales.json',
          threshold_used: { drop_pct_threshold: 15, observed_pct: d.drop_pct },
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 2 — top-customers.json
  // ---------------------------------------------------------------
  sources_consulted.push('mock-data/top-customers.json');
  const custSrc = loadSource('top-customers.json');
  if (!custSrc.ok) {
    sources_missing.push('mock-data/top-customers.json');
    warnings.push({ code: custSrc.code, message: custSrc.message, source: 'mock-data/top-customers.json' });
    metrics.push(insufficient('top_customer_revenue_ils', 'הכנסת הלקוח המוביל', 'ILS',
      'mock-data/top-customers.json', 'MAX(top_customers[].revenue_ils)', computed_at));
    metrics.push(insufficient('top3_customer_concentration_pct', 'ריכוזיות 3 לקוחות מובילים', 'pct',
      'mock-data/top-customers.json', '(SUM(top3.revenue_ils) / SUM(all.revenue_ils)) * 100', computed_at));
  } else {
    let customers;
    try {
      customers = z.array(topCustomerRowSchema).parse(custSrc.data);
    } catch (e) {
      errors.push({
        code: 'schema_violation',
        message: `top-customers.json failed validation: ${e.message}`,
        source: 'mock-data/top-customers.json',
      });
      return { metrics: [], anomalies: [], warnings, errors,
               meta: { computed_at, sources_consulted, sources_returning_data, sources_missing } };
    }
    if (customers.length === 0) {
      warnings.push({ code: 'empty_source', message: 'top-customers.json is empty array',
                      source: 'mock-data/top-customers.json' });
    } else {
      sources_returning_data.push('mock-data/top-customers.json');
      const conc = customerConcentration(customers, 3);

      metrics.push({
        id: 'top_customer_revenue_ils',
        label_he: 'הכנסת הלקוח המוביל',
        value: conc.top_customers[0]?.revenue_ils ?? null,
        unit: 'ILS',
        source: 'mock-data/top-customers.json',
        formula: 'MAX(top_customers[].revenue_ils)',
        confidence: 'high',
        inputs_count: customers.length,
        computed_at,
      });
      metrics.push({
        id: 'top_customer_name',
        label_he: 'שם הלקוח המוביל',
        value: conc.top_customers[0]?.card_name ?? null,
        unit: 'string',
        source: 'mock-data/top-customers.json',
        formula: 'ARGMAX(top_customers[].revenue_ils).card_name',
        confidence: 'high',
        inputs_count: customers.length,
        computed_at,
      });
      metrics.push({
        id: 'top3_customer_concentration_pct',
        label_he: 'ריכוזיות 3 לקוחות מובילים',
        value: conc.pct_of_all,
        unit: 'pct',
        source: 'mock-data/top-customers.json',
        formula: '(SUM(top3.revenue_ils) / SUM(all.revenue_ils)) * 100',
        confidence: 'high',
        inputs_count: customers.length,
        computed_at,
      });
      metrics.push({
        id: 'top3_customer_revenue_sum_ils',
        label_he: 'סך הכנסות מ-3 הלקוחות המובילים',
        value: conc.top_sum,
        unit: 'ILS',
        source: 'mock-data/top-customers.json',
        formula: 'SUM(top3.revenue_ils)',
        confidence: 'high',
        inputs_count: customers.length,
        computed_at,
      });

      // Anomaly: high concentration
      if (conc.pct_of_all !== null && conc.pct_of_all >= 20) {
        anomalies.push({
          id: 'high_customer_concentration',
          type: 'concentration',
          description: `Top 3 customers (${conc.top_customers.map((c) => c.card_name).join(', ')}) represent ${conc.pct_of_all}% of customer revenue (${conc.top_sum} of ${conc.all_sum} ILS)`,
          severity: conc.pct_of_all >= 30 ? 'high' : 'medium',
          related_metric_ids: ['top3_customer_concentration_pct', 'top3_customer_revenue_sum_ils'],
          source: 'mock-data/top-customers.json',
          threshold_used: { concentration_pct_threshold: 20, observed_pct: conc.pct_of_all },
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 3 — top-items.json
  // ---------------------------------------------------------------
  sources_consulted.push('mock-data/top-items.json');
  const itemsSrc = loadSource('top-items.json');
  if (!itemsSrc.ok) {
    sources_missing.push('mock-data/top-items.json');
    warnings.push({ code: itemsSrc.code, message: itemsSrc.message, source: 'mock-data/top-items.json' });
    metrics.push(insufficient('top_item_revenue_ils', 'הכנסת המוצר המוביל', 'ILS',
      'mock-data/top-items.json', 'MAX(top_items[].revenue_ils)', computed_at));
  } else {
    let items;
    try {
      items = z.array(topItemRowSchema).parse(itemsSrc.data);
    } catch (e) {
      errors.push({
        code: 'schema_violation',
        message: `top-items.json failed validation: ${e.message}`,
        source: 'mock-data/top-items.json',
      });
      return { metrics: [], anomalies: [], warnings, errors,
               meta: { computed_at, sources_consulted, sources_returning_data, sources_missing } };
    }
    if (items.length === 0) {
      warnings.push({ code: 'empty_source', message: 'top-items.json is empty array',
                      source: 'mock-data/top-items.json' });
    } else {
      sources_returning_data.push('mock-data/top-items.json');
      const sortedByRev = [...items].sort((a, b) => b.revenue_ils - a.revenue_ils);
      const topItem = sortedByRev[0];

      metrics.push({
        id: 'top_item_code',
        label_he: 'קוד המוצר המוביל',
        value: topItem.item_code,
        unit: 'string',
        source: 'mock-data/top-items.json',
        formula: 'ARGMAX(top_items[].revenue_ils).item_code',
        confidence: 'high',
        inputs_count: items.length,
        computed_at,
      });
      metrics.push({
        id: 'top_item_revenue_ils',
        label_he: 'הכנסת המוצר המוביל',
        value: topItem.revenue_ils,
        unit: 'ILS',
        source: 'mock-data/top-items.json',
        formula: 'MAX(top_items[].revenue_ils)',
        confidence: 'high',
        inputs_count: items.length,
        computed_at,
      });
      metrics.push({
        id: 'top_item_qty_sold',
        label_he: 'כמות המוצר המוביל',
        value: topItem.qty_sold,
        unit: 'count',
        source: 'mock-data/top-items.json',
        formula: 'ARGMAX(top_items[].revenue_ils).qty_sold',
        confidence: 'high',
        inputs_count: items.length,
        computed_at,
      });

      // Anomaly: low margin items
      const lowMargin = lowMarginItems(items, 30);
      for (const li of lowMargin) {
        anomalies.push({
          id: `low_margin_${li.item_code}`,
          type: 'low_margin',
          description: `Item ${li.item_code} (${li.item_name}) has margin ${li.margin_pct}%, below 30% threshold`,
          severity: li.margin_pct < 25 ? 'high' : 'medium',
          related_metric_ids: ['top_item_code'],
          source: 'mock-data/top-items.json',
          threshold_used: { margin_pct_threshold: 30, observed_pct: li.margin_pct },
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 4 — dead-stock.json
  // ---------------------------------------------------------------
  sources_consulted.push('mock-data/dead-stock.json');
  const deadSrc = loadSource('dead-stock.json');
  if (!deadSrc.ok) {
    sources_missing.push('mock-data/dead-stock.json');
    warnings.push({ code: deadSrc.code, message: deadSrc.message, source: 'mock-data/dead-stock.json' });
    metrics.push(insufficient('dead_stock_count', 'פריטי מלאי מת', 'count',
      'mock-data/dead-stock.json', 'dead_stock.total_items_no_sales', computed_at));
  } else {
    let dead;
    try {
      dead = deadStockSchema.parse(deadSrc.data);
    } catch (e) {
      errors.push({
        code: 'schema_violation',
        message: `dead-stock.json failed validation: ${e.message}`,
        source: 'mock-data/dead-stock.json',
      });
      return { metrics: [], anomalies: [], warnings, errors,
               meta: { computed_at, sources_consulted, sources_returning_data, sources_missing } };
    }
    sources_returning_data.push('mock-data/dead-stock.json');
    metrics.push({
      id: 'dead_stock_count',
      label_he: 'פריטי מלאי מת',
      value: dead.total_items_no_sales,
      unit: 'count',
      source: 'mock-data/dead-stock.json',
      formula: 'dead_stock.total_items_no_sales',
      confidence: 'high',
      inputs_count: dead.items.length,
      computed_at,
    });
    metrics.push({
      id: 'dead_stock_threshold_days',
      label_he: 'סף ימי מלאי מת',
      value: dead.threshold_days,
      unit: 'days',
      source: 'mock-data/dead-stock.json',
      formula: 'dead_stock.threshold_days',
      confidence: 'high',
      inputs_count: 1,
      computed_at,
    });

    if (dead.total_items_no_sales > 0) {
      anomalies.push({
        id: 'dead_stock_present',
        type: 'dead_stock',
        description: `${dead.total_items_no_sales} items had no sales for ≥${dead.threshold_days} days as of ${dead.as_of}`,
        severity: dead.total_items_no_sales >= 5 ? 'high' : 'medium',
        related_metric_ids: ['dead_stock_count', 'dead_stock_threshold_days'],
        source: 'mock-data/dead-stock.json',
        threshold_used: { days_threshold: dead.threshold_days, observed_count: dead.total_items_no_sales },
      });
    }
  }

  // ---------------------------------------------------------------
  // Final meta
  // ---------------------------------------------------------------
  return {
    metrics,
    anomalies,
    warnings,
    errors,
    meta: {
      computed_at,
      sources_consulted,
      sources_returning_data,
      sources_missing,
      sources_completeness: sources_consulted.length === 0 ? 0
        : Number((sources_returning_data.length / sources_consulted.length).toFixed(2)),
    },
  };
}

// =====================================================================
// Helper: emit an `insufficient_data` metric placeholder
// =====================================================================
function insufficient(id, label_he, unit, source, formula, computed_at) {
  return {
    id,
    label_he,
    value: null,
    unit,
    source,
    formula,
    confidence: 'insufficient_data',
    inputs_count: 0,
    computed_at,
  };
}

// =====================================================================
// Shared regex — used by BOTH the harvester (collectVerifiedValueSet) and
// the narrative scanner (findUnverifiedNumbers). Keeping these in sync is
// load-bearing: every literal a deterministic string emits MUST be findable
// the same way the LLM's narrative gets scanned, otherwise the verified set
// silently under-indexes and the operator drowns in false positives.
//
// Patterns:
//   1. thousands-grouped: 1,283,000 / 1.283.000 / 5,000.5
//   2. K/M/B suffix:      1.18M / 5K
//   3. percent:           21% / 25.6%
//   4. plain 4+ digits:   89500 / 2026
//
// Trailing-boundary note: the original regex used `\b` after `%` and
// `[KkMmBb]`, which silently fails when followed by Hebrew or whitespace
// (both non-word in JS regex → no word/non-word transition → no match).
// We use suffix-character terminators with explicit no-letter lookaheads
// instead. This was a real defect: percent literals in Hebrew narrative
// went unscanned in the prior validation run.
// =====================================================================
const NUMBER_LITERAL_RE = /\b\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?[KkMmBb](?![A-Za-z])|\b\d+(?:\.\d+)?%|\b\d{4,}\b/g;

// =====================================================================
// Helper: collect all numeric + string values from the verified payload.
// Used by post-processor to validate narrative numbers/names.
//
// What goes into `numbers`:
//   - metric.value (when numeric)
//   - every numeric literal that appears in an anomaly.description
//     (descriptions are computed deterministically — quoting them is safe)
//   - every numeric value in anomaly.threshold_used
//   - inputs_count and threshold_days where they're surfaced as data
//
// What goes into `strings`:
//   - metric.value (when string)
//   - metric.id   (so the LLM may quote IDs like "low_margin_MOCK-DAVO-MIXER-PRO")
//   - anomaly.id  (same)
//
// The `strings` set is used by the narrative scanner to suppress false
// positives where a number is inside a verified identifier (e.g. the "2026"
// inside "rev_drop_2026-05-09").
// =====================================================================
export function collectVerifiedValueSet(verified) {
  const numbers = new Set();
  const strings = new Set();

  // Harvest every numeric literal from a deterministic free-text string.
  // Same regex shape as the narrative scanner — keeps the two in lock-step.
  const harvest = (text) => {
    if (typeof text !== 'string' || !text) return;
    // Use a fresh regex to avoid stateful lastIndex leaking between calls
    const re = new RegExp(NUMBER_LITERAL_RE.source, 'g');
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const norm = normalizeNumberLiteral(mm[0]);
      if (norm !== null) numbers.add(norm);
    }
  };

  for (const m of (verified.metrics || [])) {
    if (typeof m.value === 'number') {
      numbers.add(m.value);
    } else if (typeof m.value === 'string') {
      strings.add(m.value);
    }
    if (m.id) strings.add(m.id);
  }

  for (const a of (verified.anomalies || [])) {
    if (a.id) strings.add(a.id);
    // Description is deterministic → its numbers are part of verified truth
    harvest(a.description);
    if (a.threshold_used && typeof a.threshold_used === 'object') {
      for (const v of Object.values(a.threshold_used)) {
        if (typeof v === 'number') numbers.add(v);
      }
    }
  }

  return { numbers, strings };
}

// =====================================================================
// Helper: scan narrative text for numeric literals not present in the
// verified set. False-positive suppression rules:
//
//   A. number falls inside a known verified identifier string
//      (e.g. "2026" inside "rev_drop_2026-05-09")
//   B. plain 4-digit number in [1900..2099] — treated as a year
//      (years rarely cause business harm if hallucinated; surfacing them
//      as integrity violations buries the actually dangerous fabrications)
//
// Anything not suppressed AND not in `numbers` is reported.
// =====================================================================
export function findUnverifiedNumbers(text, numbers, strings = new Set()) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  // Pre-compute identifier spans so we don't re-scan for every match
  const idSpans = computeIdSpans(text, strings);

  const re = new RegExp(NUMBER_LITERAL_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const idx = m.index;

    // Rule A — match falls inside a verified identifier
    if (idSpans.some(([s, e]) => idx >= s && (idx + raw.length) <= e)) continue;

    // Rule B — plain 4-digit year-like number
    if (/^\d{4}$/.test(raw)) {
      const n = Number(raw);
      if (n >= 1900 && n <= 2099) continue;
    }

    const normalized = normalizeNumberLiteral(raw);
    if (normalized === null) continue;
    if (!numbers.has(normalized)) {
      matches.push({ raw, normalized });
    }
  }
  return matches;
}

// Returns array of [start, end] pairs marking every occurrence of every
// verified identifier string inside `text`. Linear in text × |strings|.
function computeIdSpans(text, strings) {
  const spans = [];
  for (const id of strings) {
    if (typeof id !== 'string' || id.length < 4) continue;
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(id, from);
      if (at === -1) break;
      spans.push([at, at + id.length]);
      from = at + 1;
    }
  }
  return spans;
}

function normalizeNumberLiteral(s) {
  // "1,283,000" → 1283000
  // "1.28M"     → 1280000
  // "21%"       → 21
  // "5,000"     → 5000
  let str = s.trim();
  let isPct = str.endsWith('%');
  if (isPct) str = str.slice(0, -1).trim();
  let mult = 1;
  if (/[Mm]$/.test(str)) { mult = 1_000_000; str = str.slice(0, -1).trim(); }
  else if (/[Kk]$/.test(str)) { mult = 1_000; str = str.slice(0, -1).trim(); }
  else if (/[Bb]$/.test(str)) { mult = 1_000_000_000; str = str.slice(0, -1).trim(); }
  // Determine if "," is thousands or decimal
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/,/g, '');
  } else if (str.includes(',')) {
    // Israeli convention: comma is usually thousands separator
    str = str.replace(/,/g, '');
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return n * mult;
}
