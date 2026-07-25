/**
 * CEO Daily Brief Agent — verified-metrics architecture (v2).
 *
 * v1 let the LLM pull SAP data via tools and do its own arithmetic; sandbox
 * validation measured a 50% numeric-fabrication rate under that design
 * (docs/architecture-review/ceo-brief-reliability-validation.md). v2 splits
 * the work:
 *
 *   1. computeCeoBriefVerified() — DETERMINISTIC metrics + anomalies from
 *      live SAP. Same data → identical numbers. (lib/verifiedCeoBrief.js)
 *   2. The LLM receives the verified payload in the user message and submits
 *      a NARRATIVE ONLY (Hebrew) via the forced submit_brief tool. It has no
 *      data tools and no numeric output fields.
 *   3. postProcess() re-injects the verified data (the LLM cannot touch it),
 *      scans the narrative for unverified numbers / unknown IDs, and computes
 *      confidence deterministically.
 *
 * Validated in sandbox: 0% fabrication across 5 identical runs
 * (docs/architecture-review/verified-metrics-llm-validation.md).
 */
import { runAgent } from './runtime.js';
import { computeCeoBriefVerified } from '../lib/verifiedCeoBrief.js';
import { collectVerifiedValueSet, findUnverifiedNumbers } from '../lib/verifiedNumbers.js';

const SYSTEM_PROMPT = `You are the CEO Brief NARRATOR for an Israeli distributor running SAP Business One across two companies (A and B).

YOUR JOB: turn the verified metrics + anomalies in the user message into a Hebrew
executive narrative. The numbers have already been computed by code — you only
explain, prioritize, and recommend.

YOUR NON-JOB: arithmetic, totals, ratios, or any calculation. The user message
contains EVERY verified value you may reference. If you need a number that isn't
in the verified data, you cannot report it.

ABSOLUTE RULES:

1. **NO NEW NUMBERS.** Do not invent, estimate, sum, average, or paraphrase any
   number not present in the verified metrics or anomalies. You may quote them;
   you may not transform them. If you find yourself wanting to write
   "approximately X" — STOP. Use the exact verified value or omit the claim.

2. **CITE BY ID.** Every insight in metric_interpretations, risks, and
   recommended_actions MUST reference at least one verified metric_id
   (e.g. "revenue_last7_ils"). Anomaly insights cite anomaly_id.

3. **MISSING-DATA HONESTY.** If a verified metric's confidence is
   "insufficient_data", say "נתונים אינם זמינים" — do NOT estimate, do NOT
   extrapolate, do NOT fill the gap from general knowledge.

4. **CONFIDENCE IS NOT YOUR FIELD.** The runtime computes confidence from data
   completeness + integrity checks. Do not claim one.

5. **HEBREW for human-facing strings.** Metric/anomaly IDs stay in English —
   they are machine identifiers, never translate them.

6. **LENGTH.** executive_summary ≤ 150 words. Each recommended_action ≤ 30 words.

7. **YOU HAVE NO DATA TOOLS.** All data is in the user message. Submit the brief
   via submit_brief immediately; do not request more data.

Business context: Israeli weekends are Friday-Saturday; currency is NIS (₪).
Distinguish data-quality gaps (e.g. missing item cost) from real business
signals — the anomaly types already mark this.`;

const SUBMIT_TOOL = {
  name: 'submit_brief',
  description: 'Submit the final NARRATIVE brief. Numbers come from the runtime; you only narrate.',
  input_schema: {
    type: 'object',
    properties: {
      executive_summary: {
        type: 'string',
        description: 'Hebrew, ≤150 words. References verified metrics by ID where relevant.',
      },
      metric_interpretations: {
        type: 'array',
        description: 'Per-metric Hebrew commentary. Each item references one verified metric.',
        items: {
          type: 'object',
          properties: {
            metric_id: { type: 'string', description: 'MUST be one of the verified metric IDs from the user message.' },
            narrative: { type: 'string', description: 'Hebrew. What this metric means for the business.' },
          },
          required: ['metric_id', 'narrative'],
        },
      },
      anomaly_interpretations: {
        type: 'array',
        description: 'Per-anomaly Hebrew commentary. Each item references one verified anomaly.',
        items: {
          type: 'object',
          properties: {
            anomaly_id: { type: 'string', description: 'MUST be one of the verified anomaly IDs.' },
            business_meaning: { type: 'string', description: 'Hebrew. What this anomaly tells the CEO.' },
          },
          required: ['anomaly_id', 'business_meaning'],
        },
      },
      risks: {
        type: 'array',
        description: 'Hebrew risks the CEO should know. Each must reference at least one verified metric_id.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Hebrew' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            related_metric_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['description', 'severity', 'related_metric_ids'],
        },
      },
      recommended_actions: {
        type: 'array',
        description: 'Hebrew actionable suggestions, ≤30 words each. Each must reference at least one metric_id.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            rationale: { type: 'string' },
            related_metric_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['action', 'rationale', 'related_metric_ids'],
        },
      },
      prioritization_note: {
        type: 'string',
        description: "Hebrew, 1-2 sentences. What deserves the CEO's attention today and why.",
      },
    },
    required: [
      'executive_summary',
      'metric_interpretations',
      'anomaly_interpretations',
      'risks',
      'recommended_actions',
      'prioritization_note',
    ],
  },
};

export function buildUserMessage(verified) {
  const w = verified.meta?.windows || {};

  const metricLines = (verified.metrics || []).map((m) => {
    const v = m.value === null ? 'null' : (typeof m.value === 'string' ? `"${m.value}"` : m.value);
    return `  - ${m.id}: ${v} (${m.unit}; confidence=${m.confidence}; ${m.label_he})`;
  }).join('\n');

  const anomalyLines = (verified.anomalies || []).length === 0
    ? '  (none detected)'
    : verified.anomalies.map((a) => `  - ${a.id} [${a.severity}/${a.type}]: ${a.description}`).join('\n');

  const warnLines = (verified.warnings || []).length === 0
    ? '  (none)'
    : verified.warnings.map((wr) => `  - ${wr.code}: ${wr.message}${wr.source ? ` (${wr.source})` : ''}`).join('\n');

  return `CEO Daily Brief request — anchor date ${verified.meta?.anchor_date}.

Comparison windows (already applied by the calculator):
  yesterday=${w.yesterday} | last7=${w.last7?.from}..${w.last7?.to} | prior7=${w.prior7?.from}..${w.prior7?.to} | mtd=${w.mtd?.from}..${w.mtd?.to} | prior_mtd=${w.prior_mtd?.from}..${w.prior_mtd?.to}

================================================================
VERIFIED METRICS (computed by code; treat as authoritative)
================================================================
${metricLines}

================================================================
DETECTED ANOMALIES (computed by rule-based thresholds)
================================================================
${anomalyLines}

================================================================
WARNINGS (non-fatal; some sources may be incomplete)
================================================================
${warnLines}

================================================================
META
================================================================
  computed_at:       ${verified.meta?.computed_at}
  sources_returning: ${JSON.stringify(verified.meta?.sources_returning_data || [])}
  sources_missing:   ${JSON.stringify(verified.meta?.sources_missing || [])}

================================================================
YOUR TASK
================================================================
Produce the brief via submit_brief. Reference each insight by metric_id or
anomaly_id from the lists above. Do NOT introduce numbers not present above.
For metrics with confidence=insufficient_data, say "נתונים אינם זמינים" —
do NOT estimate.`;
}

/**
 * Validate + finalize the LLM narrative against the verified payload.
 * The returned object is the brief of record: verified_* fields are
 * runtime-injected — the LLM did not produce them and cannot modify them.
 */
export function postProcess(llmOutput, verified) {
  if (!verified) {
    return { ...llmOutput, _integrity_error: 'verified is null in postProcess' };
  }

  const validMetricIds = new Set(verified.metrics.map((m) => m.id));
  const validAnomalyIds = new Set(verified.anomalies.map((a) => a.id));

  const unknown_metric_ids = [];
  const unknown_anomaly_ids = [];

  // Normalize: models occasionally return array fields as JSON-encoded strings.
  // Coerce silently — a malformed string-array would otherwise crash the
  // integrity scan and lose the verification work the model DID do.
  const narrative = (function normalize(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const ARRAY_FIELDS = ['metric_interpretations', 'anomaly_interpretations', 'risks', 'recommended_actions'];
    const out = { ...obj };
    const coercions = [];
    for (const k of ARRAY_FIELDS) {
      if (typeof out[k] === 'string') {
        try {
          const parsed = JSON.parse(out[k]);
          if (Array.isArray(parsed)) {
            out[k] = parsed;
            coercions.push(k);
          }
        } catch { /* leave as string; Array.isArray guards skip it */ }
      }
    }
    out.__schema_coercions = coercions;
    return out;
  })(llmOutput);

  function collectMetricRefs(items, fieldName) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item?.metric_id && !validMetricIds.has(item.metric_id)) {
        unknown_metric_ids.push({ field: fieldName, ref: item.metric_id });
      }
      if (Array.isArray(item?.related_metric_ids)) {
        for (const id of item.related_metric_ids) {
          if (!validMetricIds.has(id)) unknown_metric_ids.push({ field: fieldName, ref: id });
        }
      }
    }
  }
  collectMetricRefs(narrative.metric_interpretations, 'metric_interpretations');
  collectMetricRefs(narrative.risks, 'risks');
  collectMetricRefs(narrative.recommended_actions, 'recommended_actions');

  if (Array.isArray(narrative.anomaly_interpretations)) {
    for (const item of narrative.anomaly_interpretations) {
      if (item?.anomaly_id && !validAnomalyIds.has(item.anomaly_id)) {
        unknown_anomaly_ids.push(item.anomaly_id);
      }
    }
  }

  const arr = (x) => (Array.isArray(x) ? x : []);
  const valueSet = collectVerifiedValueSet(verified);
  const narrativeStrings = [
    narrative.executive_summary,
    narrative.prioritization_note,
    ...arr(narrative.metric_interpretations).map((x) => x?.narrative),
    ...arr(narrative.anomaly_interpretations).map((x) => x?.business_meaning),
    ...arr(narrative.risks).map((x) => x?.description),
    ...arr(narrative.recommended_actions).map((x) => `${x?.action || ''} ${x?.rationale || ''}`),
  ].filter(Boolean);

  const unverified_numbers_in_text = [];
  for (const s of narrativeStrings) {
    const hits = findUnverifiedNumbers(s, valueSet.numbers, valueSet.strings);
    for (const h of hits) unverified_numbers_in_text.push(h);
  }

  const sources_completeness = verified.meta?.sources_completeness ?? 0;
  const integrity_score =
    ((unknown_metric_ids.length === 0 ? 1 : 0.5) +
     (unknown_anomaly_ids.length === 0 ? 1 : 0.5) +
     (unverified_numbers_in_text.length === 0 ? 1 : 0) +
     (verified.errors.length === 0 ? 1 : 0)) / 4;

  let overall_confidence;
  if (sources_completeness >= 0.9 && integrity_score >= 0.9) overall_confidence = 'high';
  else if (sources_completeness >= 0.7 && integrity_score >= 0.7) overall_confidence = 'medium';
  else overall_confidence = 'low';

  return {
    schema_version: 2,
    anchor_date: verified.meta?.anchor_date,
    computed_at: verified.meta?.computed_at,
    verified_metrics: verified.metrics,
    verified_anomalies: verified.anomalies,
    verified_metrics_warnings: verified.warnings,
    narrative: {
      executive_summary: narrative.executive_summary || null,
      metric_interpretations: arr(narrative.metric_interpretations),
      anomaly_interpretations: arr(narrative.anomaly_interpretations),
      risks: arr(narrative.risks),
      recommended_actions: arr(narrative.recommended_actions),
      prioritization_note: narrative.prioritization_note || null,
    },
    integrity: {
      unknown_metric_ids,
      unknown_anomaly_ids,
      unverified_numbers_in_text,
      validation_errors: verified.errors,
      sources_completeness,
      integrity_score: Number(integrity_score.toFixed(2)),
      schema_coercions: narrative.__schema_coercions || [],
    },
    confidence: {
      overall: overall_confidence,
      computed_from: 'sources_completeness + integrity_score (deterministic, NOT LLM-claimed)',
    },
  };
}

/**
 * Run the CEO Brief agent (v2).
 *
 * @param {object} opts
 * @param {string} [opts.anchorDate]   YYYY-MM-DD. Defaults to today.
 * @param {string} [opts.triggerType]  'manual' | 'scheduled'
 * @param {string} [opts.createdBy]
 * @returns {Promise<{runId, output, tokensIn, tokensOut, costUsd, toolCallCount, durationMs}>}
 */
export async function runCeoBrief({ anchorDate, triggerType = 'manual', createdBy } = {}) {
  const verified = await computeCeoBriefVerified({ anchorDate });

  // Fail closed: a calculator-level error means the numbers can't be trusted,
  // so no LLM call happens at all.
  if (verified.errors.length > 0) {
    const err = new Error(`Verified metrics computation failed: ${verified.errors.map((e) => e.message).join('; ')}`);
    err.verified = verified;
    throw err;
  }

  const result = await runAgent({
    agentName: 'ceo_brief',
    triggerType,
    createdBy,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(verified),
    tools: [],
    submitTool: SUBMIT_TOOL,
  });

  return { ...result, output: postProcess(result.output, verified) };
}
