/**
 * Tests for the deterministic CEO Brief calculator (live-SAP port of the
 * sandbox verified-metrics architecture). All SAP readers are stubbed.
 */
process.env.JWT_SECRET ||= 'test-secret-0123456789';
process.env.LOGISTICS_SQL_HOST ||= 'localhost';
process.env.LOGISTICS_SQL_USER ||= 'test';
process.env.LOGISTICS_SQL_PASSWORD ||= 'test';

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { briefWindows, computeCeoBriefVerified } = await import('./verifiedCeoBrief.js');

// Anchor: Wednesday 2026-07-22 → yesterday is Tuesday 2026-07-21 (business day)
const ANCHOR = '2026-07-22';

function dailyRow(date, company, revenue, orders = 1) {
  return { DocDate: new Date(`${date}T00:00:00`), CompanyCode: company, OrderCount: orders, Revenue: revenue, AvgOrderValue: revenue };
}

function pad(n) { return String(n).padStart(2, '0'); }

/** June 1-21: A 1000/day. July 1-14: A 2000/day. July 15-21: A 1000 + B 500. */
function buildDailyTuples() {
  const tuples = [];
  for (let d = 1; d <= 21; d++) tuples.push([`2026-06-${pad(d)}`, 'A', 1000]);
  for (let d = 1; d <= 14; d++) tuples.push([`2026-07-${pad(d)}`, 'A', 2000]);
  for (let d = 15; d <= 21; d++) {
    tuples.push([`2026-07-${pad(d)}`, 'A', 1000]);
    tuples.push([`2026-07-${pad(d)}`, 'B', 500]);
  }
  return tuples;
}

function buildDailyRows({ excludeDate, onlyFrom } = {}) {
  return buildDailyTuples()
    .filter(([date]) => date !== excludeDate && (!onlyFrom || date >= onlyFrom))
    .map(([date, company, revenue]) => dailyRow(date, company, revenue));
}

const happyReaders = {
  getDailySales: async () => buildDailyRows(),
  getTopCustomers: async () => [
    { CardCode: 'C1', CardName: 'לקוח אחד', CompanyCode: 'A', Revenue: 6000, OrderCount: 3 },
    { CardCode: 'C2', CardName: 'לקוח שניים', CompanyCode: 'B', Revenue: 3000, OrderCount: 2 },
    { CardCode: 'C3', CardName: 'לקוח שלוש', CompanyCode: 'A', Revenue: 1000, OrderCount: 1 },
    { CardCode: 'C4', CardName: 'לקוח ארבע', CompanyCode: 'A', Revenue: 500, OrderCount: 1 },
  ],
  getTopItems: async () => [
    { ItemCode: 'I1', ItemName: 'פריט מוביל', CompanyCode: 'A', QtySold: 100, Revenue: 8000, OrderCount: 5 },
    { ItemCode: 'I2', ItemName: 'פריט שני', CompanyCode: 'B', QtySold: 40, Revenue: 2000, OrderCount: 2 },
  ],
  getMarginByItem: async () => [
    { ItemCode: 'M1', ItemName: 'מרווח נמוך', CompanyCode: 'A', Revenue: 1000, Cost: 900, GrossMargin: 100, MarginPct: 10 },
    { ItemCode: 'M2', ItemName: 'בלי עלות', CompanyCode: 'A', Revenue: 1000, Cost: 0, GrossMargin: 1000, MarginPct: 100 },
    { ItemCode: 'M3', ItemName: 'מרווח תקין', CompanyCode: 'B', Revenue: 1000, Cost: 600, GrossMargin: 400, MarginPct: 40 },
  ],
  getDeadStock: async () => [],       // legitimately empty → verified zero
  getLowStockItems: async () => [
    { ItemCode: 'L1', ItemName: 'חסר', CompanyCode: 'A', OnHand: 2, Committed: 1, Available: 1, MinLevel: 10 },
    { ItemCode: 'L2', ItemName: 'חסר 2', CompanyCode: 'B', OnHand: 0, Committed: 0, Available: 0, MinLevel: 5 },
  ],
  getChurnRiskCustomers: async () => { throw new Error('SAP timeout'); },
};

const metricById = (result, id) => result.metrics.find((m) => m.id === id);
const anomalyById = (result, id) => result.anomalies.find((a) => a.id === id);

describe('briefWindows', () => {
  test('computes the comparison windows for an anchor date', () => {
    const w = briefWindows(ANCHOR);
    assert.equal(w.yesterday, '2026-07-21');
    assert.equal(w.yesterdayWeekday, 2); // Tuesday
    assert.deepEqual(w.last7, { from: '2026-07-15', to: '2026-07-21' });
    assert.deepEqual(w.prior7, { from: '2026-07-08', to: '2026-07-14' });
    assert.deepEqual(w.mtd, { from: '2026-07-01', to: '2026-07-21' });
    assert.deepEqual(w.priorMtd, { from: '2026-06-01', to: '2026-06-21' });
  });
});

describe('computeCeoBriefVerified — happy path', () => {
  test('metrics are deterministic sums over the right windows', async () => {
    const r = await computeCeoBriefVerified({ anchorDate: ANCHOR, readers: happyReaders });

    assert.equal(metricById(r, 'revenue_yesterday_ils').value, 1500);
    assert.equal(metricById(r, 'revenue_last7_ils').value, 10500);
    assert.equal(metricById(r, 'revenue_prior7_ils').value, 14000);
    assert.equal(metricById(r, 'revenue_wow_delta_pct').value, -25);
    assert.equal(metricById(r, 'revenue_mtd_ils').value, 38500);
    assert.equal(metricById(r, 'revenue_prior_mtd_ils').value, 21000);
    assert.equal(metricById(r, 'revenue_mtd_delta_pct').value, 83.33);
    assert.equal(metricById(r, 'revenue_last7_company_a_ils').value, 7000);
    assert.equal(metricById(r, 'revenue_last7_company_b_ils').value, 3500);
    assert.equal(metricById(r, 'top_customer_name').value, 'לקוח אחד');
    assert.equal(metricById(r, 'top3_customer_concentration_pct').value, 95.24);
    assert.equal(metricById(r, 'top_item_code').value, 'I1');
    assert.equal(metricById(r, 'top_item_revenue_ils').value, 8000);
    assert.equal(metricById(r, 'low_margin_items_count').value, 1);
    assert.equal(metricById(r, 'cost_data_missing_count').value, 1);
    assert.equal(metricById(r, 'low_stock_count').value, 2);
    assert.equal(r.errors.length, 0);
  });

  test('rule-based anomalies fire with recorded thresholds', async () => {
    const r = await computeCeoBriefVerified({ anchorDate: ANCHOR, readers: happyReaders });

    const wow = anomalyById(r, 'rev_drop_wow');
    assert.equal(wow.severity, 'high'); // exactly -25% hits the high cut-off
    assert.equal(wow.threshold_used.observed_pct, -25);

    assert.equal(anomalyById(r, 'high_customer_concentration').severity, 'high');
    assert.ok(anomalyById(r, 'low_margin_M1'));
    assert.ok(anomalyById(r, 'cost_data_missing'));
    assert.ok(anomalyById(r, 'low_stock_present'));

    // MTD grew, yesterday had revenue, churn source failed → none of these
    assert.equal(anomalyById(r, 'rev_drop_mtd'), undefined);
    assert.equal(anomalyById(r, 'zero_revenue_yesterday'), undefined);
    assert.equal(anomalyById(r, 'churn_risk_present'), undefined);
  });

  test('empty dead-stock is a verified zero, failed churn is insufficient', async () => {
    const r = await computeCeoBriefVerified({ anchorDate: ANCHOR, readers: happyReaders });

    const dead = metricById(r, 'dead_stock_count');
    assert.equal(dead.value, 0);
    assert.equal(dead.confidence, 'high');

    const churn = metricById(r, 'churn_risk_count');
    assert.equal(churn.value, null);
    assert.equal(churn.confidence, 'insufficient_data');

    // 6 of 7 sources returned data (churn failed)
    assert.equal(r.meta.sources_completeness, 0.86);
    assert.ok(r.meta.sources_missing.includes('sap:OINV.churn_risk'));
    assert.ok(r.warnings.some((w) => w.code === 'source_error' && w.source === 'sap:OINV.churn_risk'));
  });
});

describe('computeCeoBriefVerified — degraded data', () => {
  test('zero revenue on a business day raises a high anomaly', async () => {
    const rows = buildDailyRows({ excludeDate: '2026-07-21' });
    const r = await computeCeoBriefVerified({
      anchorDate: ANCHOR,
      readers: { ...happyReaders, getDailySales: async () => rows },
    });
    assert.equal(metricById(r, 'revenue_yesterday_ils').value, 0);
    assert.equal(anomalyById(r, 'zero_revenue_yesterday').severity, 'high');
  });

  test('zero revenue on Saturday does not raise the anomaly', async () => {
    // Anchor Sunday 2026-07-19 → yesterday Saturday 2026-07-18
    const rows = buildDailyRows({ excludeDate: '2026-07-18' });
    const r = await computeCeoBriefVerified({
      anchorDate: '2026-07-19',
      readers: { ...happyReaders, getDailySales: async () => rows },
    });
    assert.equal(metricById(r, 'revenue_yesterday_ils').value, 0);
    assert.equal(anomalyById(r, 'zero_revenue_yesterday'), undefined);
  });

  test('a completely failed daily source degrades to insufficient placeholders', async () => {
    const r = await computeCeoBriefVerified({
      anchorDate: ANCHOR,
      readers: { ...happyReaders, getDailySales: async () => { throw new Error('SAP down'); } },
    });
    const rev = metricById(r, 'revenue_last7_ils');
    assert.equal(rev.value, null);
    assert.equal(rev.confidence, 'insufficient_data');
    assert.equal(anomalyById(r, 'rev_drop_wow'), undefined);
    assert.ok(r.meta.sources_missing.includes('sap:OINV.daily_sales'));
  });

  test('zero prior-period revenue yields insufficient delta, never a division', async () => {
    const julyOnly = buildDailyRows({ onlyFrom: '2026-07-15' });
    const r = await computeCeoBriefVerified({
      anchorDate: ANCHOR,
      readers: { ...happyReaders, getDailySales: async () => julyOnly },
    });
    assert.equal(metricById(r, 'revenue_wow_delta_pct').confidence, 'insufficient_data');
    assert.equal(metricById(r, 'revenue_mtd_delta_pct').confidence, 'insufficient_data');
  });
});
