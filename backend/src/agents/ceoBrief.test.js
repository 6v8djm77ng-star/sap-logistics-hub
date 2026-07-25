/**
 * Tests for the CEO Brief v2 narrative post-processor and prompt builder.
 * No LLM calls — postProcess and buildUserMessage are pure.
 */
process.env.JWT_SECRET ||= 'test-secret-0123456789';
process.env.LOGISTICS_SQL_HOST ||= 'localhost';
process.env.LOGISTICS_SQL_USER ||= 'test';
process.env.LOGISTICS_SQL_PASSWORD ||= 'test';

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { postProcess, buildUserMessage } = await import('./ceoBrief.js');

const T = '2026-07-22T04:00:00.000Z';

const verified = {
  metrics: [
    { id: 'revenue_last7_ils', label_he: 'הכנסות 7 ימים אחרונים', value: 10500, unit: 'ILS', source: 's', formula: 'f', confidence: 'high', inputs_count: 7, computed_at: T },
    { id: 'revenue_wow_delta_pct', label_he: 'שינוי שבועי', value: -25, unit: 'pct', source: 's', formula: 'f', confidence: 'high', inputs_count: 14, computed_at: T },
    { id: 'top_customer_name', label_he: 'הלקוח המוביל', value: 'לקוח אחד', unit: 'string', source: 's', formula: 'f', confidence: 'high', inputs_count: 4, computed_at: T },
    { id: 'churn_risk_count', label_he: 'סיכון נטישה', value: null, unit: 'count', source: 's', formula: 'f', confidence: 'insufficient_data', inputs_count: 0, computed_at: T },
  ],
  anomalies: [
    { id: 'rev_drop_wow', type: 'week_over_week_drop', description: 'Weekly revenue dropped 25%: 10500 ILS vs 14000 ILS', severity: 'high', related_metric_ids: ['revenue_last7_ils'], source: 's', threshold_used: { drop_pct_threshold: 15, observed_pct: -25 } },
  ],
  warnings: [],
  errors: [],
  meta: { computed_at: T, anchor_date: '2026-07-22', sources_completeness: 1, windows: {} },
};

const cleanNarrative = {
  executive_summary: 'ההכנסות השבועיות (revenue_last7_ils) עמדו על 10,500 ש"ח — ירידה של 25% מהשבוע הקודם.',
  metric_interpretations: [
    { metric_id: 'revenue_last7_ils', narrative: 'שבוע חלש ביחס לקודם.' },
  ],
  anomaly_interpretations: [
    { anomaly_id: 'rev_drop_wow', business_meaning: 'הירידה השבועית דורשת בדיקה מול לקוח אחד.' },
  ],
  risks: [
    { description: 'המשך ירידה שבועית', severity: 'high', related_metric_ids: ['revenue_wow_delta_pct'] },
  ],
  recommended_actions: [
    { action: 'לבדוק את הלקוחות הגדולים', rationale: 'הירידה מרוכזת', related_metric_ids: ['revenue_last7_ils'] },
  ],
  prioritization_note: 'הירידה השבועית היא הנושא המרכזי היום.',
};

describe('postProcess — clean narrative', () => {
  const out = postProcess(cleanNarrative, verified);

  test('injects verified data untouched and reports high confidence', () => {
    assert.deepEqual(out.verified_metrics, verified.metrics);
    assert.deepEqual(out.verified_anomalies, verified.anomalies);
    assert.equal(out.confidence.overall, 'high');
    assert.equal(out.integrity.integrity_score, 1);
    assert.deepEqual(out.integrity.unverified_numbers_in_text, []);
    assert.equal(out.schema_version, 2);
    assert.equal(out.anchor_date, '2026-07-22');
  });

  test('LLM cannot smuggle its own verified_metrics field', () => {
    const tampered = { ...cleanNarrative, verified_metrics: [{ id: 'fake', value: 1 }] };
    const res = postProcess(tampered, verified);
    assert.deepEqual(res.verified_metrics, verified.metrics);
  });
});

describe('postProcess — integrity violations', () => {
  test('fabricated number in narrative drops confidence', () => {
    const fabricated = {
      ...cleanNarrative,
      executive_summary: 'ההכנסות היו בערך 12,000 ש"ח השבוע.',
    };
    const out = postProcess(fabricated, verified);
    assert.equal(out.integrity.unverified_numbers_in_text.length, 1);
    assert.equal(out.integrity.unverified_numbers_in_text[0].normalized, 12000);
    assert.equal(out.confidence.overall, 'medium'); // integrity 0.75
  });

  test('unknown metric reference is recorded', () => {
    const unknownRef = {
      ...cleanNarrative,
      metric_interpretations: [{ metric_id: 'made_up_metric', narrative: 'טקסט' }],
    };
    const out = postProcess(unknownRef, verified);
    assert.equal(out.integrity.unknown_metric_ids.length, 1);
    assert.equal(out.integrity.unknown_metric_ids[0].ref, 'made_up_metric');
  });

  test('unknown anomaly reference is recorded', () => {
    const unknownRef = {
      ...cleanNarrative,
      anomaly_interpretations: [{ anomaly_id: 'ghost_anomaly', business_meaning: 'טקסט' }],
    };
    const out = postProcess(unknownRef, verified);
    assert.deepEqual(out.integrity.unknown_anomaly_ids, ['ghost_anomaly']);
  });

  test('JSON-encoded string arrays are coerced, not crashed on', () => {
    const stringified = {
      ...cleanNarrative,
      risks: JSON.stringify(cleanNarrative.risks),
    };
    const out = postProcess(stringified, verified);
    assert.equal(out.narrative.risks.length, 1);
    assert.deepEqual(out.integrity.schema_coercions, ['risks']);
  });
});

describe('buildUserMessage', () => {
  test('embeds verified metrics, anomalies and windows', () => {
    const msg = buildUserMessage(verified);
    assert.ok(msg.includes('revenue_last7_ils: 10500'));
    assert.ok(msg.includes('rev_drop_wow [high/week_over_week_drop]'));
    assert.ok(msg.includes('anchor date 2026-07-22'));
    assert.ok(msg.includes('confidence=insufficient_data'));
  });
});
