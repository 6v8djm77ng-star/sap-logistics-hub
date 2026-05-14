// =====================================================================
// verifiedAnomalies.js — deterministic anomaly engine (Sandbox Experiment 2)
//
// Sister module to verifiedMetrics.js. Same architectural contract:
//
//   - Pure JavaScript. No LLM, no estimation.
//   - Same input + same source files → byte-identical output (modulo
//     the detected_at timestamp).
//   - Validation errors fail closed (no LLM call downstream).
//   - Missing source = `confidence: 'insufficient_data'`, NEVER an estimate.
//
// In Experiment 2 the LLM's job is to *interpret* anomalies (business
// significance, suggested actions). It MUST NOT:
//   - invent anomalies
//   - change severity
//   - introduce new threshold values
//   - compute new aggregates
//
// All those decisions are made here, deterministically.
//
// Detectors (v1):
//   1. revenue_dod_drop      — day-over-day revenue drop ≥ 15%
//   2. revenue_dod_spike     — day-over-day revenue spike ≥ 20%
//   3. revenue_iqr_outlier   — daily revenue outside [Q1-1.5·IQR, Q3+1.5·IQR]
//   4. customer_concentration — top-3 share ≥ 20%
//   5. item_low_margin       — item margin < 30%
//   6. dead_stock_present    — dead-stock count ≥ 1
//
// See: docs/architecture-review/experiment-2-anomaly-architecture.md
// =====================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.resolve(__dirname, '..', 'mock-data');

// =====================================================================
// Detector version. Increment whenever thresholds, severity bands, or
// detector logic changes — this is part of the deterministic contract:
// the same (input, source files, detector_version) tuple must produce
// the same output forever. A bumped version is the audit trail.
// =====================================================================
export const DETECTOR_VERSION = 1;

// =====================================================================
// Default thresholds. Locked in code; NOT configurable at runtime to
// preserve reproducibility. Override only via a code change + bump.
// =====================================================================
export const THRESHOLDS = Object.freeze({
  revenue_dod_drop:        { low: 15, medium: 20, high: 25 },   // %
  revenue_dod_spike:       { low: 20, medium: 30, high: 40 },   // %
  revenue_iqr_outlier:     { iqr_multiplier: 1.5 },             // Tukey
  customer_concentration:  { low: 20, medium: 25, high: 30 },   // % of total
  item_low_margin:         { high_below: 20, medium_below: 25, low_below: 30 }, // % margin
  dead_stock_present:      { low: 1, medium: 2, high: 5 },       // count
});

// =====================================================================
// Source loader (mirrors verifiedMetrics.js — kept local intentionally
// to avoid coupling the two modules' internals).
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
// Schemas (loosely shared with verifiedMetrics.js — copied so each
// module can be audited as a unit)
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
// Severity-band classifier — deterministic mapping.
// Returns { severity, severity_reason } for an upper-bound or
// lower-bound triggered breach.
// =====================================================================
function classifyAscending(observed, bands) {
  // bands: { low: a, medium: b, high: c } where higher = worse
  if (observed >= bands.high)   return { severity: 'high',   severity_reason: `observed ${observed} ≥ high threshold ${bands.high}` };
  if (observed >= bands.medium) return { severity: 'medium', severity_reason: `observed ${observed} ≥ medium threshold ${bands.medium}` };
  if (observed >= bands.low)    return { severity: 'low',    severity_reason: `observed ${observed} ≥ low threshold ${bands.low}` };
  return null;
}

function classifyDescending(observed, bands) {
  // bands: { high_below: a, medium_below: b, low_below: c } where lower = worse
  if (observed < bands.high_below)   return { severity: 'high',   severity_reason: `observed ${observed} < high threshold ${bands.high_below}` };
  if (observed < bands.medium_below) return { severity: 'medium', severity_reason: `observed ${observed} < medium threshold ${bands.medium_below}` };
  if (observed < bands.low_below)    return { severity: 'low',    severity_reason: `observed ${observed} < low threshold ${bands.low_below}` };
  return null;
}

// =====================================================================
// Pure stats helpers
// =====================================================================
function quartiles(sortedNums) {
  const n = sortedNums.length;
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedNums[lo];
    return sortedNums[lo] + (sortedNums[hi] - sortedNums[lo]) * (idx - lo);
  };
  return { q1: q(0.25), q3: q(0.75) };
}

function dayOverDayChanges(rows) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (prev.revenue_ils === 0) continue;
    const change_pct = ((cur.revenue_ils - prev.revenue_ils) / prev.revenue_ils) * 100;
    out.push({
      from_date: prev.date,
      to_date: cur.date,
      from_revenue: prev.revenue_ils,
      to_revenue: cur.revenue_ils,
      change_pct: Number(change_pct.toFixed(2)),
    });
  }
  return out;
}

function filterDateRange(rows, dateFrom, dateTo) {
  return rows.filter((r) => r.date >= dateFrom && r.date <= dateTo);
}

// =====================================================================
// Per-anomaly confidence — purely a function of source data quality.
// NEVER reflects "the LLM is unsure"; it reflects "the data is sparse".
// =====================================================================
function dataConfidence(inputs_count) {
  if (inputs_count >= 5) return 'high';
  if (inputs_count >= 2) return 'medium';
  if (inputs_count === 1) return 'low';
  return 'insufficient_data';
}

// =====================================================================
// Detector 1 — day-over-day drop
// =====================================================================
function detectRevenueDoDDrop(dailyRows) {
  const out = [];
  for (const ch of dayOverDayChanges(dailyRows)) {
    if (ch.change_pct >= 0) continue; // not a drop
    const drop = Math.abs(ch.change_pct);
    const cls = classifyAscending(drop, THRESHOLDS.revenue_dod_drop);
    if (!cls) continue;
    out.push({
      id: `revenue_dod_drop_${ch.to_date}`,
      type: 'revenue_dod_drop',
      detector: 'day_over_day_change',
      detector_version: DETECTOR_VERSION,
      severity: cls.severity,
      severity_reason: cls.severity_reason,
      description: `הכנסות יומיות ירדו ב-${drop.toFixed(2)}% מ-${ch.from_date} (${ch.from_revenue} ILS) ל-${ch.to_date} (${ch.to_revenue} ILS)`,
      threshold_used: {
        metric: 'daily_revenue_ils',
        direction: 'down',
        thresholds_pct: THRESHOLDS.revenue_dod_drop,
        observed_pct: Number(drop.toFixed(2)),
      },
      observed: { from_date: ch.from_date, to_date: ch.to_date, from_revenue: ch.from_revenue, to_revenue: ch.to_revenue },
      related_metric_ids: ['total_revenue_ils'],
      related_records: [],
      source: 'mock-data/daily-sales.json',
      confidence: dataConfidence(dailyRows.length),
    });
  }
  return out;
}

// =====================================================================
// Detector 2 — day-over-day spike
// =====================================================================
function detectRevenueDoDSpike(dailyRows) {
  const out = [];
  for (const ch of dayOverDayChanges(dailyRows)) {
    if (ch.change_pct <= 0) continue;
    const cls = classifyAscending(ch.change_pct, THRESHOLDS.revenue_dod_spike);
    if (!cls) continue;
    out.push({
      id: `revenue_dod_spike_${ch.to_date}`,
      type: 'revenue_dod_spike',
      detector: 'day_over_day_change',
      detector_version: DETECTOR_VERSION,
      severity: cls.severity,
      severity_reason: cls.severity_reason,
      description: `הכנסות יומיות זינקו ב-${ch.change_pct.toFixed(2)}% מ-${ch.from_date} (${ch.from_revenue} ILS) ל-${ch.to_date} (${ch.to_revenue} ILS)`,
      threshold_used: {
        metric: 'daily_revenue_ils',
        direction: 'up',
        thresholds_pct: THRESHOLDS.revenue_dod_spike,
        observed_pct: Number(ch.change_pct.toFixed(2)),
      },
      observed: { from_date: ch.from_date, to_date: ch.to_date, from_revenue: ch.from_revenue, to_revenue: ch.to_revenue },
      related_metric_ids: ['total_revenue_ils', 'peak_revenue_value'],
      related_records: [],
      source: 'mock-data/daily-sales.json',
      confidence: dataConfidence(dailyRows.length),
    });
  }
  return out;
}

// =====================================================================
// Detector 3 — IQR outlier on daily revenue (Tukey)
// Surfaces days that fall outside [Q1 - k·IQR, Q3 + k·IQR]. Severity is
// "high" only for extreme outliers (>3·IQR), "medium" otherwise.
// =====================================================================
function detectRevenueIqrOutlier(dailyRows) {
  const out = [];
  if (dailyRows.length < 5) return out; // insufficient distribution
  const sorted = [...dailyRows].map((r) => r.revenue_ils).sort((a, b) => a - b);
  const { q1, q3 } = quartiles(sorted);
  const iqr = q3 - q1;
  if (iqr <= 0) return out; // all-same series; outliers undefined
  const k = THRESHOLDS.revenue_iqr_outlier.iqr_multiplier;
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;

  for (const r of dailyRows) {
    if (r.revenue_ils >= lo && r.revenue_ils <= hi) continue;
    const distance = r.revenue_ils > hi ? (r.revenue_ils - hi) : (lo - r.revenue_ils);
    const extreme = distance > 1.5 * iqr; // > 3·IQR total from quartile
    out.push({
      id: `revenue_iqr_outlier_${r.date}`,
      type: 'revenue_iqr_outlier',
      detector: 'tukey_iqr',
      detector_version: DETECTOR_VERSION,
      severity: extreme ? 'high' : 'medium',
      severity_reason: extreme
        ? `observed ${r.revenue_ils} > 3·IQR from quartile boundary`
        : `observed ${r.revenue_ils} outside [Q1-${k}·IQR, Q3+${k}·IQR] = [${lo.toFixed(0)}, ${hi.toFixed(0)}]`,
      description: `הכנסה יומית של ${r.revenue_ils} ILS ב-${r.date} חורגת מתחום הרבעונים [${lo.toFixed(0)}, ${hi.toFixed(0)}]`,
      threshold_used: {
        metric: 'daily_revenue_ils',
        method: 'tukey_iqr',
        iqr_multiplier: k,
        q1: Number(q1.toFixed(2)),
        q3: Number(q3.toFixed(2)),
        iqr: Number(iqr.toFixed(2)),
        bounds: { lo: Number(lo.toFixed(2)), hi: Number(hi.toFixed(2)) },
        observed: r.revenue_ils,
      },
      observed: { date: r.date, revenue_ils: r.revenue_ils },
      related_metric_ids: ['avg_daily_revenue_ils', 'peak_revenue_value'],
      related_records: [],
      source: 'mock-data/daily-sales.json',
      confidence: dataConfidence(dailyRows.length),
    });
  }
  return out;
}

// =====================================================================
// Detector 4 — top-3 customer concentration
// =====================================================================
function detectCustomerConcentration(customers) {
  if (customers.length === 0) return [];
  const sorted = [...customers].sort((a, b) => b.revenue_ils - a.revenue_ils);
  const top3 = sorted.slice(0, 3);
  const top_sum = top3.reduce((acc, c) => acc + c.revenue_ils, 0);
  const all_sum = sorted.reduce((acc, c) => acc + c.revenue_ils, 0);
  if (all_sum <= 0) return [];
  const pct = (top_sum / all_sum) * 100;
  const cls = classifyAscending(pct, THRESHOLDS.customer_concentration);
  if (!cls) return [];
  return [{
    id: 'customer_concentration_top3',
    type: 'customer_concentration',
    detector: 'top_n_share',
    detector_version: DETECTOR_VERSION,
    severity: cls.severity,
    severity_reason: cls.severity_reason,
    description: `שלושת הלקוחות המובילים (${top3.map((c) => c.card_name).join(', ')}) מהווים ${pct.toFixed(2)}% מהמחזור (${top_sum} מתוך ${all_sum} ILS)`,
    threshold_used: {
      metric: 'top3_share_pct',
      direction: 'up',
      thresholds_pct: THRESHOLDS.customer_concentration,
      observed_pct: Number(pct.toFixed(2)),
    },
    observed: { top_sum, all_sum, top_customer_codes: top3.map((c) => c.card_code) },
    related_metric_ids: ['top3_customer_concentration_pct', 'top3_customer_revenue_sum_ils'],
    related_records: top3.map((c) => ({ kind: 'customer', card_code: c.card_code, card_name: c.card_name })),
    source: 'mock-data/top-customers.json',
    confidence: dataConfidence(customers.length),
  }];
}

// =====================================================================
// Detector 5 — item with low margin
// =====================================================================
function detectItemLowMargin(items) {
  const out = [];
  for (const it of items) {
    const cls = classifyDescending(it.margin_pct, THRESHOLDS.item_low_margin);
    if (!cls) continue;
    out.push({
      id: `item_low_margin_${it.item_code}`,
      type: 'item_low_margin',
      detector: 'threshold_compare',
      detector_version: DETECTOR_VERSION,
      severity: cls.severity,
      severity_reason: cls.severity_reason,
      description: `פריט ${it.item_code} (${it.item_name}) במרווח ${it.margin_pct}%, מתחת לסף 30%`,
      threshold_used: {
        metric: 'item_margin_pct',
        direction: 'down',
        thresholds_pct: THRESHOLDS.item_low_margin,
        observed_pct: it.margin_pct,
      },
      observed: { item_code: it.item_code, margin_pct: it.margin_pct, qty_sold: it.qty_sold, revenue_ils: it.revenue_ils },
      related_metric_ids: ['top_item_code', 'top_item_revenue_ils'],
      related_records: [{ kind: 'item', item_code: it.item_code, item_name: it.item_name }],
      source: 'mock-data/top-items.json',
      confidence: dataConfidence(items.length),
    });
  }
  return out;
}

// =====================================================================
// Detector 6 — dead-stock present
// =====================================================================
function detectDeadStock(dead) {
  if (dead.total_items_no_sales <= 0) return [];
  const cls = classifyAscending(dead.total_items_no_sales, THRESHOLDS.dead_stock_present);
  if (!cls) return [];
  return [{
    id: 'dead_stock_present',
    type: 'dead_stock_present',
    detector: 'threshold_compare',
    detector_version: DETECTOR_VERSION,
    severity: cls.severity,
    severity_reason: cls.severity_reason,
    description: `${dead.total_items_no_sales} פריטים ללא מכירות במשך ≥${dead.threshold_days} ימים נכון ל-${dead.as_of}`,
    threshold_used: {
      metric: 'dead_stock_count',
      direction: 'up',
      thresholds_count: THRESHOLDS.dead_stock_present,
      observed_count: dead.total_items_no_sales,
    },
    observed: { count: dead.total_items_no_sales, threshold_days: dead.threshold_days, as_of: dead.as_of },
    related_metric_ids: ['dead_stock_count', 'dead_stock_threshold_days'],
    related_records: dead.items.map((it) => ({ kind: 'item', item_code: it.item_code, item_name: it.item_name, days_since: it.days_since })),
    source: 'mock-data/dead-stock.json',
    confidence: dataConfidence(dead.items.length),
  }];
}

// =====================================================================
// Main entry
// =====================================================================
export function computeAnomalies(input) {
  const detected_at = new Date().toISOString();
  const anomalies = [];
  const warnings = [];
  const errors = [];
  const sources_consulted = [];
  const sources_returning_data = [];
  const sources_missing = [];
  const detectors_run = [];

  const date_from = input?.date_from;
  const date_to   = input?.date_to;

  if (!date_from || !date_to || !/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
    errors.push({ code: 'bad_input', message: 'date_from and date_to must be YYYY-MM-DD strings' });
    return finalize();
  }
  if (date_from > date_to) {
    errors.push({ code: 'bad_input', message: 'date_from must be <= date_to' });
    return finalize();
  }

  // --- daily-sales detectors -----------------------------------------
  sources_consulted.push('mock-data/daily-sales.json');
  detectors_run.push('revenue_dod_drop', 'revenue_dod_spike', 'revenue_iqr_outlier');
  const dailySrc = loadSource('daily-sales.json');
  if (!dailySrc.ok) {
    sources_missing.push('mock-data/daily-sales.json');
    warnings.push({ code: dailySrc.code, message: dailySrc.message, source: 'mock-data/daily-sales.json' });
  } else {
    let rows;
    try { rows = z.array(dailySalesRowSchema).parse(dailySrc.data); }
    catch (e) {
      errors.push({ code: 'schema_violation', message: `daily-sales.json failed validation: ${e.message}`, source: 'mock-data/daily-sales.json' });
      return finalize();
    }
    const inWindow = filterDateRange(rows, date_from, date_to);
    if (inWindow.length === 0) {
      warnings.push({ code: 'empty_window', message: `No daily-sales rows fall within ${date_from}..${date_to}`, source: 'mock-data/daily-sales.json' });
    } else {
      sources_returning_data.push('mock-data/daily-sales.json');
      anomalies.push(...detectRevenueDoDDrop(inWindow));
      anomalies.push(...detectRevenueDoDSpike(inWindow));
      anomalies.push(...detectRevenueIqrOutlier(inWindow));
    }
  }

  // --- top-customers detector ----------------------------------------
  sources_consulted.push('mock-data/top-customers.json');
  detectors_run.push('customer_concentration');
  const custSrc = loadSource('top-customers.json');
  if (!custSrc.ok) {
    sources_missing.push('mock-data/top-customers.json');
    warnings.push({ code: custSrc.code, message: custSrc.message, source: 'mock-data/top-customers.json' });
  } else {
    let customers;
    try { customers = z.array(topCustomerRowSchema).parse(custSrc.data); }
    catch (e) {
      errors.push({ code: 'schema_violation', message: `top-customers.json failed validation: ${e.message}`, source: 'mock-data/top-customers.json' });
      return finalize();
    }
    if (customers.length > 0) sources_returning_data.push('mock-data/top-customers.json');
    anomalies.push(...detectCustomerConcentration(customers));
  }

  // --- top-items detector --------------------------------------------
  sources_consulted.push('mock-data/top-items.json');
  detectors_run.push('item_low_margin');
  const itemsSrc = loadSource('top-items.json');
  if (!itemsSrc.ok) {
    sources_missing.push('mock-data/top-items.json');
    warnings.push({ code: itemsSrc.code, message: itemsSrc.message, source: 'mock-data/top-items.json' });
  } else {
    let items;
    try { items = z.array(topItemRowSchema).parse(itemsSrc.data); }
    catch (e) {
      errors.push({ code: 'schema_violation', message: `top-items.json failed validation: ${e.message}`, source: 'mock-data/top-items.json' });
      return finalize();
    }
    if (items.length > 0) sources_returning_data.push('mock-data/top-items.json');
    anomalies.push(...detectItemLowMargin(items));
  }

  // --- dead-stock detector -------------------------------------------
  sources_consulted.push('mock-data/dead-stock.json');
  detectors_run.push('dead_stock_present');
  const deadSrc = loadSource('dead-stock.json');
  if (!deadSrc.ok) {
    sources_missing.push('mock-data/dead-stock.json');
    warnings.push({ code: deadSrc.code, message: deadSrc.message, source: 'mock-data/dead-stock.json' });
  } else {
    let dead;
    try { dead = deadStockSchema.parse(deadSrc.data); }
    catch (e) {
      errors.push({ code: 'schema_violation', message: `dead-stock.json failed validation: ${e.message}`, source: 'mock-data/dead-stock.json' });
      return finalize();
    }
    sources_returning_data.push('mock-data/dead-stock.json');
    anomalies.push(...detectDeadStock(dead));
  }

  return finalize();

  // ------------------------------------------------------------------
  function finalize() {
    // Summarize for quick downstream inspection
    const by_severity = { high: 0, medium: 0, low: 0 };
    const by_type = {};
    for (const a of anomalies) {
      by_severity[a.severity] = (by_severity[a.severity] || 0) + 1;
      by_type[a.type]         = (by_type[a.type]         || 0) + 1;
    }

    // Sort deterministically: by severity (high→low), then by id ascending.
    const sevRank = { high: 0, medium: 1, low: 2 };
    anomalies.sort((a, b) => {
      const ds = (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3);
      if (ds !== 0) return ds;
      return a.id.localeCompare(b.id);
    });

    return {
      anomalies,
      summary: { total: anomalies.length, by_severity, by_type },
      warnings,
      errors,
      meta: {
        detected_at,
        detector_version: DETECTOR_VERSION,
        detectors_run,
        sources_consulted,
        sources_returning_data,
        sources_missing,
        sources_completeness: sources_consulted.length === 0 ? 0
          : Number((sources_returning_data.length / sources_consulted.length).toFixed(2)),
        date_from,
        date_to,
      },
    };
  }
}

// =====================================================================
// Helper: build verified value-set for the post-processor (mirrors the
// shape used by verifiedMetrics.collectVerifiedValueSet, so the same
// findUnverifiedNumbers scanner from verifiedMetrics.js works on the
// anomaly-summary narrative without modification).
// =====================================================================
export function collectAnomalyValueSet(verified) {
  const numbers = new Set();
  const strings = new Set();

  const harvestNumbersFromString = (text) => {
    if (typeof text !== 'string' || !text) return;
    const re = /\b\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?[KkMmBb](?![A-Za-z])|\b\d+(?:\.\d+)?%|\b\d{4,}\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const norm = normalizeNumberLiteral(m[0]);
      if (norm !== null) numbers.add(norm);
    }
  };

  for (const a of (verified.anomalies || [])) {
    if (a.id) strings.add(a.id);
    if (a.type) strings.add(a.type);
    harvestNumbersFromString(a.description);
    if (a.threshold_used && typeof a.threshold_used === 'object') {
      walkNumbers(a.threshold_used, numbers);
    }
    if (a.observed && typeof a.observed === 'object') {
      walkNumbers(a.observed, numbers);
      // observed often holds dates / item codes — keep them so the LLM
      // may quote them without false-positive flags
      walkStrings(a.observed, strings);
    }
    for (const r of (a.related_records || [])) {
      walkStrings(r, strings);
    }
  }

  // Summary counts (1, 2, 3...) are by-design quotable; add them too.
  const s = verified.summary || {};
  if (typeof s.total === 'number') numbers.add(s.total);
  for (const v of Object.values(s.by_severity || {})) {
    if (typeof v === 'number') numbers.add(v);
  }
  for (const v of Object.values(s.by_type || {})) {
    if (typeof v === 'number') numbers.add(v);
  }

  return { numbers, strings };
}

function walkNumbers(obj, target) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') { target.add(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) walkNumbers(v, target); return; }
  if (typeof obj === 'object') { for (const v of Object.values(obj)) walkNumbers(v, target); }
}

function walkStrings(obj, target) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') { if (obj.length >= 4) target.add(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) walkStrings(v, target); return; }
  if (typeof obj === 'object') { for (const v of Object.values(obj)) walkStrings(v, target); }
}

// Re-implemented locally to keep this module self-contained
// (verifiedMetrics.js has the same function — the duplicate is
// intentional: each module should be auditable as a single file).
function normalizeNumberLiteral(s) {
  let str = s.trim();
  const isPct = str.endsWith('%');
  if (isPct) str = str.slice(0, -1).trim();
  let mult = 1;
  if (/[Mm]$/.test(str)) { mult = 1_000_000; str = str.slice(0, -1).trim(); }
  else if (/[Kk]$/.test(str)) { mult = 1_000; str = str.slice(0, -1).trim(); }
  else if (/[Bb]$/.test(str)) { mult = 1_000_000_000; str = str.slice(0, -1).trim(); }
  if (str.includes(',') && str.includes('.')) {
    str = str.replace(/,/g, '');
  } else if (str.includes(',')) {
    str = str.replace(/,/g, '');
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return n * mult;
}
