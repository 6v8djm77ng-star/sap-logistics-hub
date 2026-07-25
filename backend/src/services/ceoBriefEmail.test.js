/**
 * Tests for the CEO Brief HTML email renderer.
 */
process.env.JWT_SECRET ||= 'test-secret-0123456789';
process.env.LOGISTICS_SQL_HOST ||= 'localhost';
process.env.LOGISTICS_SQL_USER ||= 'test';
process.env.LOGISTICS_SQL_PASSWORD ||= 'test';

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { renderCeoBriefHtml } = await import('./ceoBriefEmail.js');

const T = '2026-07-22T04:00:00.000Z';

const brief = {
  schema_version: 2,
  anchor_date: '2026-07-22',
  computed_at: T,
  verified_metrics: [
    { id: 'revenue_yesterday_ils', label_he: 'הכנסות אתמול', value: 1500, unit: 'ILS', confidence: 'high' },
    { id: 'revenue_last7_ils', label_he: 'הכנסות 7 ימים אחרונים', value: 10500.5, unit: 'ILS', confidence: 'high' },
    { id: 'revenue_wow_delta_pct', label_he: 'שינוי שבועי בהכנסות', value: -25, unit: 'pct', confidence: 'high' },
    { id: 'revenue_mtd_ils', label_he: 'הכנסות מתחילת החודש', value: null, unit: 'ILS', confidence: 'insufficient_data' },
  ],
  verified_anomalies: [
    { id: 'rev_drop_wow', severity: 'high', type: 'week_over_week_drop', description: 'dropped' },
  ],
  verified_metrics_warnings: [],
  narrative: {
    executive_summary: 'שבוע חלש. <script>alert(1)</script>',
    metric_interpretations: [],
    anomaly_interpretations: [
      { anomaly_id: 'rev_drop_wow', business_meaning: 'ירידה שבועית חדה' },
    ],
    risks: [{ description: 'סיכון המשך ירידה', severity: 'medium', related_metric_ids: [] }],
    recommended_actions: [{ action: 'לבדוק לקוחות', rationale: 'ריכוזיות', related_metric_ids: [] }],
    prioritization_note: 'להתמקד בירידה השבועית.',
  },
  integrity: {
    unknown_metric_ids: [],
    unknown_anomaly_ids: [],
    unverified_numbers_in_text: [],
    validation_errors: [],
    sources_completeness: 0.86,
    integrity_score: 1,
    schema_coercions: [],
  },
  confidence: { overall: 'medium', computed_from: 'deterministic' },
};

describe('renderCeoBriefHtml', () => {
  const html = renderCeoBriefHtml(brief);

  test('renders RTL with the anchor date and confidence', () => {
    assert.ok(html.includes('dir="rtl"'));
    assert.ok(html.includes('2026-07-22'));
    assert.ok(html.includes('בינונית'));
  });

  test('formats ILS and percent values, insufficient data in Hebrew', () => {
    assert.ok(html.includes('₪'));
    assert.ok(html.includes('%'));
    assert.ok(html.includes('נתונים אינם זמינים'));
  });

  test('escapes HTML in narrative strings', () => {
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('includes anomaly, risk, action and prioritization sections', () => {
    assert.ok(html.includes('ירידה שבועית חדה'));
    assert.ok(html.includes('סיכון המשך ירידה'));
    assert.ok(html.includes('לבדוק לקוחות'));
    assert.ok(html.includes('להתמקד בירידה השבועית.'));
    assert.ok(html.includes('86%'));
  });
});
