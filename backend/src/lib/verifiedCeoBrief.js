/**
 * verifiedCeoBrief.js — deterministic CEO Brief metrics from live SAP data.
 *
 * Production port of the sandbox verified-metrics architecture
 * (backend-sandbox/lib/verifiedMetrics.js, validated in
 * docs/architecture-review/verified-metrics-llm-validation.md).
 *
 * Design contract:
 *   - All numbers are computed HERE, in code. The LLM narrates; it never
 *     calculates. Same SAP data → identical metric values.
 *   - A failed SAP source produces `confidence: 'insufficient_data'`
 *     placeholders — NEVER an estimate.
 *   - Anomalies are rule-based with explicit thresholds recorded on each one.
 *
 * Every metric: { id, label_he, value, unit, source, formula, confidence,
 *                 inputs_count, computed_at }
 * Every anomaly: { id, type, description, severity, related_metric_ids,
 *                  source, threshold_used }
 */
import { format, subDays, getDay } from 'date-fns';
import * as fr from '../services/sap/financialReader.js';

const fmt = (d) => format(d, 'yyyy-MM-dd');

/** Comparison windows for an anchor date. Pure; exported for tests. */
export function briefWindows(anchorDate) {
  const anchor = anchorDate ? new Date(`${anchorDate}T00:00:00`) : new Date();
  const yesterday = fmt(subDays(anchor, 1));
  const last7 = { from: fmt(subDays(anchor, 7)), to: yesterday };
  const prior7 = { from: fmt(subDays(anchor, 14)), to: fmt(subDays(anchor, 8)) };

  const mtdStart = fmt(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const priorMonthDays = new Date(anchor.getFullYear(), anchor.getMonth(), 0).getDate();
  const priorMtdEndDay = Math.min(Math.max(anchor.getDate() - 1, 1), priorMonthDays);
  const priorMtd = {
    from: fmt(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)),
    to: fmt(new Date(anchor.getFullYear(), anchor.getMonth() - 1, priorMtdEndDay)),
  };

  return {
    anchor: fmt(anchor),
    yesterday,
    yesterdayWeekday: getDay(subDays(anchor, 1)), // 0=Sunday .. 6=Saturday
    last7,
    prior7,
    mtd: { from: mtdStart, to: yesterday },
    priorMtd,
  };
}

const round2 = (n) => Number(n.toFixed(2));
const sumBy = (rows, key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
const rowDate = (r) => (r.DocDate instanceof Date ? fmt(r.DocDate) : String(r.DocDate).slice(0, 10));

function metric(id, label_he, value, unit, source, formula, inputs_count, computed_at) {
  return { id, label_he, value, unit, source, formula, confidence: 'high', inputs_count, computed_at };
}

function insufficient(id, label_he, unit, source, formula, computed_at) {
  return { id, label_he, value: null, unit, source, formula, confidence: 'insufficient_data', inputs_count: 0, computed_at };
}

const SOURCES = {
  daily: 'sap:OINV.daily_sales',
  customers: 'sap:OINV.top_customers',
  items: 'sap:INV1.top_items',
  margin: 'sap:INV1.margin_by_item',
  dead: 'sap:OITW.dead_stock',
  low: 'sap:OITW.low_stock',
  churn: 'sap:OINV.churn_risk',
};

// Metric-id placeholders emitted when a source fails, so downstream consumers
// always see the full metric taxonomy regardless of source health.
const PLACEHOLDERS = {
  daily: [
    ['revenue_yesterday_ils', 'הכנסות אתמול', 'ILS', 'SUM(daily.Revenue where date=yesterday)'],
    ['orders_yesterday', 'חשבוניות אתמול', 'count', 'SUM(daily.OrderCount where date=yesterday)'],
    ['revenue_last7_ils', 'הכנסות 7 ימים אחרונים', 'ILS', 'SUM(daily.Revenue in last7)'],
    ['orders_last7', 'חשבוניות 7 ימים אחרונים', 'count', 'SUM(daily.OrderCount in last7)'],
    ['revenue_prior7_ils', 'הכנסות 7 ימים קודמים', 'ILS', 'SUM(daily.Revenue in prior7)'],
    ['revenue_wow_delta_pct', 'שינוי שבועי בהכנסות', 'pct', '(last7-prior7)/prior7*100'],
    ['revenue_mtd_ils', 'הכנסות מתחילת החודש', 'ILS', 'SUM(daily.Revenue in mtd)'],
    ['revenue_prior_mtd_ils', 'הכנסות תקופה מקבילה בחודש קודם', 'ILS', 'SUM(daily.Revenue in priorMtd)'],
    ['revenue_mtd_delta_pct', 'שינוי חודשי בהכנסות', 'pct', '(mtd-priorMtd)/priorMtd*100'],
    ['revenue_last7_company_a_ils', 'הכנסות 7 ימים — חברה A', 'ILS', 'SUM(daily.Revenue in last7 where company=A)'],
    ['revenue_last7_company_b_ils', 'הכנסות 7 ימים — חברה B', 'ILS', 'SUM(daily.Revenue in last7 where company=B)'],
  ],
  customers: [
    ['top_customer_name', 'הלקוח המוביל (7 ימים)', 'string', 'ARGMAX(customers.Revenue).CardName'],
    ['top_customer_revenue_ils', 'הכנסת הלקוח המוביל (7 ימים)', 'ILS', 'MAX(customers.Revenue)'],
    ['top3_customer_revenue_sum_ils', 'סך הכנסות 3 הלקוחות המובילים', 'ILS', 'SUM(top3.Revenue)'],
    ['top3_customer_concentration_pct', 'ריכוזיות 3 לקוחות מתוך 10 המובילים', 'pct', 'SUM(top3.Revenue)/SUM(top10.Revenue)*100'],
  ],
  items: [
    ['top_item_code', 'קוד הפריט המוביל (7 ימים)', 'string', 'ARGMAX(items.Revenue).ItemCode'],
    ['top_item_name', 'שם הפריט המוביל (7 ימים)', 'string', 'ARGMAX(items.Revenue).ItemName'],
    ['top_item_revenue_ils', 'הכנסת הפריט המוביל (7 ימים)', 'ILS', 'MAX(items.Revenue)'],
    ['top_item_qty_sold', 'כמות הפריט המוביל (7 ימים)', 'count', 'ARGMAX(items.Revenue).QtySold'],
  ],
  margin: [
    ['low_margin_items_count', 'פריטים במרווח נמוך (מתוך 30 המובילים)', 'count', 'COUNT(margin.MarginPct < 15)'],
    ['cost_data_missing_count', 'פריטים ללא עלות מתוחזקת', 'count', 'COUNT(margin.Cost = 0)'],
  ],
  dead: [
    ['dead_stock_count', 'פריטי מלאי מת (90 יום, עד 30 מוצגים)', 'count', 'COUNT(dead_stock rows)'],
  ],
  low: [
    ['low_stock_count', 'פריטים מתחת למינימום (עד 50 מוצגים)', 'count', 'COUNT(low_stock rows)'],
  ],
  churn: [
    ['churn_risk_count', 'לקוחות בסיכון נטישה (עד 20 מוצגים)', 'count', 'COUNT(churn_risk rows)'],
  ],
};

/**
 * Compute the verified CEO-brief payload from live SAP.
 *
 * @param {object} opts
 * @param {string} [opts.anchorDate] YYYY-MM-DD; defaults to today.
 * @param {object} [opts.readers]    financialReader overrides (tests).
 * @returns {Promise<{metrics, anomalies, warnings, errors, meta}>}
 */
export async function computeCeoBriefVerified({ anchorDate, readers } = {}) {
  const r = { ...fr, ...(readers || {}) };
  const computed_at = new Date().toISOString();
  const w = briefWindows(anchorDate);

  const metrics = [];
  const anomalies = [];
  const warnings = [];
  const errors = [];
  const sources_consulted = [];
  const sources_returning_data = [];
  const sources_missing = [];

  // A source that throws (or returns nothing) degrades to insufficient_data
  // placeholders — the brief still runs on whatever sources are healthy.
  async function fetchSource(key, fetcher) {
    sources_consulted.push(SOURCES[key]);
    try {
      const rows = await fetcher();
      if (!Array.isArray(rows) || rows.length === 0) {
        sources_missing.push(SOURCES[key]);
        warnings.push({ code: 'empty_source', message: `${SOURCES[key]} returned no rows`, source: SOURCES[key] });
        for (const [id, label, unit, formula] of PLACEHOLDERS[key]) {
          metrics.push(insufficient(id, label, unit, SOURCES[key], formula, computed_at));
        }
        return null;
      }
      sources_returning_data.push(SOURCES[key]);
      return rows;
    } catch (err) {
      sources_missing.push(SOURCES[key]);
      warnings.push({ code: 'source_error', message: err.message, source: SOURCES[key] });
      for (const [id, label, unit, formula] of PLACEHOLDERS[key]) {
        metrics.push(insufficient(id, label, unit, SOURCES[key], formula, computed_at));
      }
      return null;
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 1 — daily sales, one fetch covering every comparison window
  // ---------------------------------------------------------------
  const earliestFrom = [w.prior7.from, w.priorMtd.from].sort()[0];
  const daily = await fetchSource('daily', () =>
    r.getDailySales({ fromDate: earliestFrom, toDate: w.yesterday }));

  if (daily) {
    const inRange = (row, range) => rowDate(row) >= range.from && rowDate(row) <= range.to;
    const yesterdayRows = daily.filter((row) => rowDate(row) === w.yesterday);
    const last7Rows = daily.filter((row) => inRange(row, w.last7));
    const prior7Rows = daily.filter((row) => inRange(row, w.prior7));
    const mtdRows = daily.filter((row) => inRange(row, w.mtd));
    const priorMtdRows = daily.filter((row) => inRange(row, w.priorMtd));

    const revYesterday = round2(sumBy(yesterdayRows, 'Revenue'));
    const revLast7 = round2(sumBy(last7Rows, 'Revenue'));
    const revPrior7 = round2(sumBy(prior7Rows, 'Revenue'));
    const revMtd = round2(sumBy(mtdRows, 'Revenue'));
    const revPriorMtd = round2(sumBy(priorMtdRows, 'Revenue'));

    const src = SOURCES.daily;
    metrics.push(metric('revenue_yesterday_ils', 'הכנסות אתמול', revYesterday, 'ILS', src,
      `SUM(daily.Revenue where date=${w.yesterday})`, yesterdayRows.length, computed_at));
    metrics.push(metric('orders_yesterday', 'חשבוניות אתמול', sumBy(yesterdayRows, 'OrderCount'), 'count', src,
      `SUM(daily.OrderCount where date=${w.yesterday})`, yesterdayRows.length, computed_at));
    metrics.push(metric('revenue_last7_ils', 'הכנסות 7 ימים אחרונים', revLast7, 'ILS', src,
      `SUM(daily.Revenue where date in [${w.last7.from}..${w.last7.to}])`, last7Rows.length, computed_at));
    metrics.push(metric('orders_last7', 'חשבוניות 7 ימים אחרונים', sumBy(last7Rows, 'OrderCount'), 'count', src,
      `SUM(daily.OrderCount where date in [${w.last7.from}..${w.last7.to}])`, last7Rows.length, computed_at));
    metrics.push(metric('revenue_prior7_ils', 'הכנסות 7 ימים קודמים', revPrior7, 'ILS', src,
      `SUM(daily.Revenue where date in [${w.prior7.from}..${w.prior7.to}])`, prior7Rows.length, computed_at));
    metrics.push(metric('revenue_mtd_ils', 'הכנסות מתחילת החודש', revMtd, 'ILS', src,
      `SUM(daily.Revenue where date in [${w.mtd.from}..${w.mtd.to}])`, mtdRows.length, computed_at));
    metrics.push(metric('revenue_prior_mtd_ils', 'הכנסות תקופה מקבילה בחודש קודם', revPriorMtd, 'ILS', src,
      `SUM(daily.Revenue where date in [${w.priorMtd.from}..${w.priorMtd.to}])`, priorMtdRows.length, computed_at));

    for (const [id, code, label] of [
      ['revenue_last7_company_a_ils', 'A', 'הכנסות 7 ימים — חברה A'],
      ['revenue_last7_company_b_ils', 'B', 'הכנסות 7 ימים — חברה B'],
    ]) {
      const companyRows = last7Rows.filter((row) => row.CompanyCode === code);
      metrics.push(metric(id, label, round2(sumBy(companyRows, 'Revenue')), 'ILS', src,
        `SUM(daily.Revenue in last7 where company=${code})`, companyRows.length, computed_at));
    }

    if (revPrior7 > 0) {
      const wow = round2(((revLast7 - revPrior7) / revPrior7) * 100);
      metrics.push(metric('revenue_wow_delta_pct', 'שינוי שבועי בהכנסות', wow, 'pct', src,
        '(revenue_last7_ils - revenue_prior7_ils) / revenue_prior7_ils * 100', last7Rows.length + prior7Rows.length, computed_at));
      if (wow <= -15) {
        anomalies.push({
          id: 'rev_drop_wow',
          type: 'week_over_week_drop',
          description: `Weekly revenue dropped ${Math.abs(wow)}%: ${revLast7} ILS in [${w.last7.from}..${w.last7.to}] vs ${revPrior7} ILS in [${w.prior7.from}..${w.prior7.to}]`,
          severity: wow <= -25 ? 'high' : 'medium',
          related_metric_ids: ['revenue_last7_ils', 'revenue_prior7_ils', 'revenue_wow_delta_pct'],
          source: src,
          threshold_used: { drop_pct_threshold: 15, observed_pct: wow },
        });
      }
    } else {
      metrics.push(insufficient('revenue_wow_delta_pct', 'שינוי שבועי בהכנסות', 'pct', src,
        '(last7-prior7)/prior7*100 — prior7 is zero', computed_at));
    }

    if (revPriorMtd > 0) {
      const mtdDelta = round2(((revMtd - revPriorMtd) / revPriorMtd) * 100);
      metrics.push(metric('revenue_mtd_delta_pct', 'שינוי חודשי בהכנסות', mtdDelta, 'pct', src,
        '(revenue_mtd_ils - revenue_prior_mtd_ils) / revenue_prior_mtd_ils * 100', mtdRows.length + priorMtdRows.length, computed_at));
      if (mtdDelta <= -15) {
        anomalies.push({
          id: 'rev_drop_mtd',
          type: 'mtd_drop',
          description: `MTD revenue is down ${Math.abs(mtdDelta)}%: ${revMtd} ILS in [${w.mtd.from}..${w.mtd.to}] vs ${revPriorMtd} ILS in [${w.priorMtd.from}..${w.priorMtd.to}]`,
          severity: mtdDelta <= -25 ? 'high' : 'medium',
          related_metric_ids: ['revenue_mtd_ils', 'revenue_prior_mtd_ils', 'revenue_mtd_delta_pct'],
          source: src,
          threshold_used: { drop_pct_threshold: 15, observed_pct: mtdDelta },
        });
      }
    } else {
      metrics.push(insufficient('revenue_mtd_delta_pct', 'שינוי חודשי בהכנסות', 'pct', src,
        '(mtd-priorMtd)/priorMtd*100 — priorMtd is zero', computed_at));
    }

    // Sunday(0)..Thursday(4) is an Israeli business day
    if (revYesterday === 0 && w.yesterdayWeekday >= 0 && w.yesterdayWeekday <= 4) {
      anomalies.push({
        id: 'zero_revenue_yesterday',
        type: 'zero_revenue_business_day',
        description: `Zero invoiced revenue on ${w.yesterday}, a business day (Sun-Thu). Possible invoicing halt, sync gap, or holiday.`,
        severity: 'high',
        related_metric_ids: ['revenue_yesterday_ils', 'orders_yesterday'],
        source: src,
        threshold_used: { expected_revenue_gt: 0, observed: 0 },
      });
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 2 — top customers (last 7 days)
  // ---------------------------------------------------------------
  const customers = await fetchSource('customers', () =>
    r.getTopCustomers({ fromDate: w.last7.from, toDate: w.last7.to, limit: 10 }));

  if (customers) {
    const src = SOURCES.customers;
    const sorted = [...customers].sort((a, b) => (Number(b.Revenue) || 0) - (Number(a.Revenue) || 0));
    const top = sorted[0];
    const top3Sum = round2(sumBy(sorted.slice(0, 3), 'Revenue'));
    const allSum = sumBy(sorted, 'Revenue');
    metrics.push(metric('top_customer_name', 'הלקוח המוביל (7 ימים)', String(top.CardName), 'string', src,
      'ARGMAX(customers.Revenue).CardName', sorted.length, computed_at));
    metrics.push(metric('top_customer_revenue_ils', 'הכנסת הלקוח המוביל (7 ימים)', round2(Number(top.Revenue)), 'ILS', src,
      'MAX(customers.Revenue)', sorted.length, computed_at));
    metrics.push(metric('top3_customer_revenue_sum_ils', 'סך הכנסות 3 הלקוחות המובילים', top3Sum, 'ILS', src,
      'SUM(top3.Revenue)', sorted.length, computed_at));
    if (allSum > 0) {
      const conc = round2((top3Sum / allSum) * 100);
      metrics.push(metric('top3_customer_concentration_pct', 'ריכוזיות 3 לקוחות מתוך 10 המובילים', conc, 'pct', src,
        'SUM(top3.Revenue) / SUM(top10.Revenue) * 100', sorted.length, computed_at));
      // Concentration measured within the top-10 set, hence high cut-offs
      if (conc >= 60) {
        anomalies.push({
          id: 'high_customer_concentration',
          type: 'concentration',
          description: `Top 3 customers (${sorted.slice(0, 3).map((c) => c.CardName).join(', ')}) represent ${conc}% of top-10 customer revenue`,
          severity: conc >= 75 ? 'high' : 'medium',
          related_metric_ids: ['top3_customer_concentration_pct', 'top3_customer_revenue_sum_ils'],
          source: src,
          threshold_used: { concentration_pct_threshold: 60, observed_pct: conc },
        });
      }
    } else {
      metrics.push(insufficient('top3_customer_concentration_pct', 'ריכוזיות 3 לקוחות מתוך 10 המובילים', 'pct', src,
        'SUM(top3.Revenue)/SUM(top10.Revenue)*100 — total is zero', computed_at));
    }
  }

  // ---------------------------------------------------------------
  // SOURCE 3 — top items (last 7 days)
  // ---------------------------------------------------------------
  const items = await fetchSource('items', () =>
    r.getTopItems({ fromDate: w.last7.from, toDate: w.last7.to, limit: 10 }));

  if (items) {
    const src = SOURCES.items;
    const sorted = [...items].sort((a, b) => (Number(b.Revenue) || 0) - (Number(a.Revenue) || 0));
    const top = sorted[0];
    metrics.push(metric('top_item_code', 'קוד הפריט המוביל (7 ימים)', String(top.ItemCode), 'string', src,
      'ARGMAX(items.Revenue).ItemCode', sorted.length, computed_at));
    metrics.push(metric('top_item_name', 'שם הפריט המוביל (7 ימים)', String(top.ItemName), 'string', src,
      'ARGMAX(items.Revenue).ItemName', sorted.length, computed_at));
    metrics.push(metric('top_item_revenue_ils', 'הכנסת הפריט המוביל (7 ימים)', round2(Number(top.Revenue)), 'ILS', src,
      'MAX(items.Revenue)', sorted.length, computed_at));
    metrics.push(metric('top_item_qty_sold', 'כמות הפריט המוביל (7 ימים)', Number(top.QtySold), 'count', src,
      'ARGMAX(items.Revenue).QtySold', sorted.length, computed_at));
  }

  // ---------------------------------------------------------------
  // SOURCE 4 — margin by item (last 7 days, top 30 by revenue)
  // ---------------------------------------------------------------
  const margins = await fetchSource('margin', () =>
    r.getMarginByItem({ fromDate: w.last7.from, toDate: w.last7.to, limit: 30 }));

  if (margins) {
    const src = SOURCES.margin;
    // Cost=0 means moving-average cost isn't maintained — a data-quality gap,
    // not a 100%-margin item. Exclude from the low-margin scan.
    const costMissing = margins.filter((m) => (Number(m.Cost) || 0) === 0);
    const withCost = margins.filter((m) => (Number(m.Cost) || 0) > 0 && m.MarginPct != null);
    const lowMargin = withCost.filter((m) => Number(m.MarginPct) < 15);

    metrics.push(metric('low_margin_items_count', 'פריטים במרווח נמוך (מתוך 30 המובילים)', lowMargin.length, 'count', src,
      'COUNT(margin.MarginPct < 15 and margin.Cost > 0)', withCost.length, computed_at));
    metrics.push(metric('cost_data_missing_count', 'פריטים ללא עלות מתוחזקת', costMissing.length, 'count', src,
      'COUNT(margin.Cost = 0)', margins.length, computed_at));

    for (const li of lowMargin.slice(0, 5)) {
      const pct = round2(Number(li.MarginPct));
      anomalies.push({
        id: `low_margin_${li.ItemCode}`,
        type: 'low_margin',
        description: `Item ${li.ItemCode} (${li.ItemName}, company ${li.CompanyCode}) has margin ${pct}%, below 15% threshold`,
        severity: pct < 5 ? 'high' : 'medium',
        related_metric_ids: ['low_margin_items_count'],
        source: src,
        threshold_used: { margin_pct_threshold: 15, observed_pct: pct },
      });
    }
    if (costMissing.length > 0) {
      anomalies.push({
        id: 'cost_data_missing',
        type: 'data_quality',
        description: `${costMissing.length} of the top-30 revenue items have no moving-average cost in OITM — margin cannot be trusted for them`,
        severity: 'medium',
        related_metric_ids: ['cost_data_missing_count'],
        source: src,
        threshold_used: { cost_equals: 0, observed_count: costMissing.length },
      });
    }
  }

  // ---------------------------------------------------------------
  // SOURCES 5-7 — inventory + churn counts
  // ---------------------------------------------------------------
  const dead = await fetchSource('dead', () => r.getDeadStock({}));
  if (dead) {
    metrics.push(metric('dead_stock_count', 'פריטי מלאי מת (90 יום, עד 30 מוצגים)', dead.length, 'count', SOURCES.dead,
      'COUNT(dead_stock rows), capped at 30', dead.length, computed_at));
    anomalies.push({
      id: 'dead_stock_present',
      type: 'dead_stock',
      description: `${dead.length} items with stock on hand had no sales for ≥90 days (list capped at 30)`,
      severity: dead.length >= 20 ? 'high' : 'medium',
      related_metric_ids: ['dead_stock_count'],
      source: SOURCES.dead,
      threshold_used: { days_threshold: 90, observed_count: dead.length },
    });
  }

  const low = await fetchSource('low', () => r.getLowStockItems({}));
  if (low) {
    metrics.push(metric('low_stock_count', 'פריטים מתחת למינימום (עד 50 מוצגים)', low.length, 'count', SOURCES.low,
      'COUNT(low_stock rows), capped at 50', low.length, computed_at));
    anomalies.push({
      id: 'low_stock_present',
      type: 'low_stock',
      description: `${low.length} sell items are below their MinLevel reorder point (list capped at 50)`,
      severity: low.length >= 15 ? 'high' : 'medium',
      related_metric_ids: ['low_stock_count'],
      source: SOURCES.low,
      threshold_used: { min_level_multiplier: 1.0, observed_count: low.length },
    });
  }

  const churn = await fetchSource('churn', () => r.getChurnRiskCustomers({}));
  if (churn) {
    const names = churn.slice(0, 3).map((c) => c.CardName).join(', ');
    metrics.push(metric('churn_risk_count', 'לקוחות בסיכון נטישה (עד 20 מוצגים)', churn.length, 'count', SOURCES.churn,
      'COUNT(churn_risk rows), capped at 20', churn.length, computed_at));
    anomalies.push({
      id: 'churn_risk_present',
      type: 'churn_risk',
      description: `${churn.length} regular customers went silent for 30+ days (top by prior revenue: ${names})`,
      severity: churn.length >= 10 ? 'high' : 'medium',
      related_metric_ids: ['churn_risk_count'],
      source: SOURCES.churn,
      threshold_used: { silent_days: 30, prior_orders_min: 3, observed_count: churn.length },
    });
  }

  // Empty-source counts are legitimately zero, not missing: an empty dead-stock
  // query means "no dead stock". Re-emit those three as verified zeros.
  for (const key of ['dead', 'low', 'churn']) {
    const [id, label, unit, formula] = PLACEHOLDERS[key][0];
    const placeholderIdx = metrics.findIndex((m) => m.id === id && m.confidence === 'insufficient_data');
    const wasEmpty = warnings.some((wr) => wr.source === SOURCES[key] && wr.code === 'empty_source');
    if (placeholderIdx !== -1 && wasEmpty) {
      metrics[placeholderIdx] = metric(id, label, 0, unit, SOURCES[key], formula, 0, computed_at);
      const mi = sources_missing.indexOf(SOURCES[key]);
      if (mi !== -1) sources_missing.splice(mi, 1);
      sources_returning_data.push(SOURCES[key]);
      const wi = warnings.findIndex((wr) => wr.source === SOURCES[key] && wr.code === 'empty_source');
      if (wi !== -1) warnings.splice(wi, 1);
    }
  }

  return {
    metrics,
    anomalies,
    warnings,
    errors,
    meta: {
      computed_at,
      anchor_date: w.anchor,
      windows: { yesterday: w.yesterday, last7: w.last7, prior7: w.prior7, mtd: w.mtd, prior_mtd: w.priorMtd },
      sources_consulted,
      sources_returning_data,
      sources_missing,
      sources_completeness: sources_consulted.length === 0 ? 0
        : Number((sources_returning_data.length / sources_consulted.length).toFixed(2)),
    },
  };
}
