// =====================================================================
// registry.js — sandbox agent + tool registry
// Registers all 4 first-pass agents from ai-sandbox-plan.md §7.
// Each agent declares: name, description, prompt, tools, optional submitTool.
// =====================================================================
import { allFinancialTools } from './tools/financialReadOnly.js';
import { allAnalyticsTools } from './tools/analyticsReadOnly.js';
import { computeCeoBriefMetrics, collectVerifiedValueSet, findUnverifiedNumbers } from '../lib/verifiedMetrics.js';
import { computeAnomalies, collectAnomalyValueSet } from '../lib/verifiedAnomalies.js';
import {
  ALLOWED_TIME_HORIZON_IDS,
  classifyNarrativeText,
  validateStructuredRecommendation,
  timeHorizonChoicesForPrompt,
} from '../lib/sandboxPolicy.js';
import {
  evaluateCoverage,
  COVERAGE_LABELS,
  applyConfidenceCap,
  coveragePolicyForPrompt,
} from '../lib/coveragePolicy.js';
import { computeReport, collectReportValueSet, localIdsForSection } from '../lib/verifiedReport.js';
import {
  evaluateReportCoverage,
  REPORT_COVERAGE_LABELS,
  reportCoveragePolicyForPrompt,
} from '../lib/reportCoveragePolicy.js';
import { computeReviewCase, collectReviewCaseValueSet } from '../lib/verifiedReviewCase.js';
import {
  REVIEW_STATES,
  REVIEW_COVERAGE_LABELS,
  APPLICABILITY_VALUES,
  ESCALATION_TARGET_ROLES,
  evaluateReviewCoverage,
  appendAudit,
  reviewPolicyForPrompt,
} from '../lib/reviewWorkflowPolicy.js';

// Convenience: pull individual tools by name from the tool packs
const allTools = [...allFinancialTools, ...allAnalyticsTools];
const tool = (name) => {
  const t = allTools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not found in registry`);
  return t;
};

// =====================================================================
// EXPERIMENT 1 — CEO Brief summarizer (verified-metrics architecture)
//
// Architecture: docs/architecture-review/verified-metrics-architecture.md
//
// Flow:
//   1. preCompute() → computeCeoBriefMetrics() — DETERMINISTIC numbers
//   2. buildUserMessage() embeds verified metrics in the prompt
//   3. LLM submits NARRATIVE ONLY (no numeric values in submit_brief schema)
//   4. postProcess() injects verified.metrics into output (LLM cannot touch them)
//      + validates metric_id references + scans narrative for unverified numbers
//
// The LLM's job: narrate, prioritize, recommend.
// The LLM's NON-job: arithmetic, totals, source-of-truth values.
// =====================================================================
export const ceoBrief = {
  name: 'ceoBrief',
  description: 'CEO daily brief — deterministic metrics + LLM narrative. NO LLM arithmetic.',
  estimated_cost_per_run_usd: 0.05,

  // -------------------------------------------------------------------
  // PRE-COMPUTE — runs before any LLM call
  // -------------------------------------------------------------------
  preCompute: async (input) => {
    return computeCeoBriefMetrics(input);
  },

  // -------------------------------------------------------------------
  // POST-PROCESS — runs after LLM submits; validates + injects verified data
  // The LLM literally cannot return verified_metrics; runtime overwrites.
  // -------------------------------------------------------------------
  postProcess: (llmOutput, verified) => {
    if (!verified) {
      // Defensive: should never happen because preCompute was defined
      return { ...llmOutput, _integrity_error: 'verified is null in postProcess' };
    }

    // Build set of valid metric/anomaly IDs for reference validation
    const validMetricIds = new Set(verified.metrics.map((m) => m.id));
    const validAnomalyIds = new Set(verified.anomalies.map((a) => a.id));

    // Collect unknown ID references from narrative
    const unknown_metric_ids = [];
    const unknown_anomaly_ids = [];

    // Normalize the LLM payload: occasionally the model returns array-typed
    // fields as JSON-encoded strings instead of native arrays (a schema
    // violation, but observed in practice with haiku). Coerce silently —
    // a malformed string-array would otherwise crash the integrity scan and
    // we'd lose all the verification work the model DID do.
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
          } catch {
            // Leave as string; downstream Array.isArray guards will skip it
          }
        }
      }
      out.__schema_coercions = coercions;
      return out;
    })(llmOutput);

    function collectMetricRefs(arr, fieldName) {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
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

    // Free-floating-number scan over Hebrew/English narrative strings.
    // arr() guards against non-array shapes that survived normalization
    // (e.g. an unparseable string field) — we'd rather scan less than crash.
    const arr = (x) => Array.isArray(x) ? x : [];
    const valueSet = collectVerifiedValueSet(verified);
    // Helper: extract scannable text from a recommended_action that may
    // be either a structured object (anomalySummary v2) or legacy string.
    const recText = (x) => {
      if (!x) return '';
      if (typeof x === 'string') return x;
      if (typeof x === 'object') {
        return [x.action, x.owner, x.target].filter(Boolean).join(' ');
      }
      return '';
    };
    const narrativeStrings = [
      narrative.executive_summary,
      narrative.prioritization_note,
      ...arr(narrative.metric_interpretations).map((x) => x?.narrative),
      ...arr(narrative.anomaly_interpretations).map((x) => x?.business_meaning),
      ...arr(narrative.risks).map((x) => x?.description),
      ...arr(narrative.recommended_actions).map((x) => `${x?.action || ''} ${x?.rationale || ''}`),
      // anomalySummary v2: extract action text from structured recommended_action
      ...arr(narrative.anomaly_interpretations).map((x) => recText(x?.recommended_action)),
    ].filter(Boolean);

    const unverified_numbers_in_text = [];
    for (const s of narrativeStrings) {
      // Pass the strings set too — suppresses false positives where a number
      // appears inside a verified identifier (e.g. "2026" in "rev_drop_2026-05-09")
      const hits = findUnverifiedNumbers(s, valueSet.numbers, valueSet.strings);
      for (const h of hits) unverified_numbers_in_text.push(h);
    }

    // Compute deterministic confidence based on data completeness + integrity
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

    // Compose final output. verified_metrics + verified_anomalies are
    // RUNTIME-INJECTED — the LLM did not produce them and cannot modify them.
    return {
      verified_metrics: verified.metrics,
      verified_anomalies: verified.anomalies,
      verified_metrics_warnings: verified.warnings,
      computed_at: verified.meta?.computed_at,
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
  },

  // -------------------------------------------------------------------
  // SYSTEM PROMPT — narration discipline
  // -------------------------------------------------------------------
  systemPrompt: `You are a CEO Brief sandbox NARRATOR for an Israeli logistics company.

YOUR JOB: turn the verified metrics + anomalies in the user message into a Hebrew
executive narrative. The numbers have already been computed by code — you only
explain, prioritize, and recommend.

YOUR NON-JOB: arithmetic, totals, ratios, or any calculation. The user message
contains EVERY verified value you may reference. If you need a number that isn't
in the verified data, you cannot report it.

ABSOLUTE RULES (violating these is a failed experiment):

1. **NO NEW NUMBERS.** Do not invent, estimate, sum, average, or paraphrase any
   number not present in the verified.metrics or verified.anomalies arrays.
   You may quote them; you may not transform them. If you find yourself
   wanting to write "approximately X" or "about Y" — STOP. Use the exact
   verified value or omit the claim.

2. **CITE BY ID.** Every insight in metric_interpretations, risks,
   recommended_actions MUST reference at least one verified metric_id by name
   (e.g., "total_revenue_ils"). Anomaly insights cite anomaly_id.
   The IDs you may use are listed in the user message.

3. **MISSING-DATA HONESTY.** If a verified metric's confidence is
   "insufficient_data", state that explicitly in your narrative
   ("נתונים אינם זמינים"). Do NOT estimate, do NOT extrapolate, do NOT
   use general knowledge to fill the gap.

4. **CONFIDENCE IS NOT YOUR FIELD.** Do not output a confidence value.
   The runtime computes confidence from data completeness + integrity check.

5. **HEBREW for human-facing strings.** English for metric/anomaly IDs
   (they are machine identifiers, never translate).

6. **LENGTH.** executive_summary ≤ 150 words. Each recommended_action ≤ 30 words.

7. **YOU HAVE NO DATA TOOLS.** All data is in the user message. Submit the
   brief via submit_brief immediately; do not request more data.

The mock data window is whatever the verified.meta says. Trust it.`,

  // -------------------------------------------------------------------
  // BUILD USER MESSAGE — embeds verified data; LLM sees pre-computed numbers
  // -------------------------------------------------------------------
  buildUserMessage: (input, verified) => {
    const from = input?.date_from || '(unspecified)';
    const to   = input?.date_to   || '(unspecified)';

    if (!verified) {
      return `Date range: ${from} → ${to}\n\n(verified data unavailable — submit_brief with all fields empty)`;
    }

    const metricLines = (verified.metrics || []).map((m) => {
      const v = m.value === null ? 'null' : (typeof m.value === 'string' ? `"${m.value}"` : m.value);
      return `  - ${m.id}: ${v} (${m.unit}; confidence=${m.confidence}; source=${m.source}; ${m.label_he})`;
    }).join('\n');

    const anomalyLines = (verified.anomalies || []).length === 0
      ? '  (none detected)'
      : verified.anomalies.map((a) => {
          return `  - ${a.id} [${a.severity}/${a.type}]: ${a.description}`;
        }).join('\n');

    const warnLines = (verified.warnings || []).length === 0
      ? '  (none)'
      : verified.warnings.map((w) => `  - ${w.code}: ${w.message}${w.source ? ` (${w.source})` : ''}`).join('\n');

    return `CEO Brief request — date range ${from} → ${to}.

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
  computed_at:           ${verified.meta?.computed_at}
  sources_consulted:     ${JSON.stringify(verified.meta?.sources_consulted || [])}
  sources_returning:     ${JSON.stringify(verified.meta?.sources_returning_data || [])}
  sources_missing:       ${JSON.stringify(verified.meta?.sources_missing || [])}

================================================================
YOUR TASK
================================================================
Produce the brief via submit_brief. Reference each insight by
metric_id (from VERIFIED METRICS above) or anomaly_id (from DETECTED
ANOMALIES above). Do NOT introduce numbers not present above.
For metrics with confidence=insufficient_data, say "נתונים אינם זמינים"
in narrative; do NOT estimate.`;
  },

  // -------------------------------------------------------------------
  // NO DATA TOOLS — all data comes via the user message
  // -------------------------------------------------------------------
  tools: [],

  // -------------------------------------------------------------------
  // SUBMIT TOOL — narrative-only schema; NO numeric value fields
  // -------------------------------------------------------------------
  submitTool: {
    name: 'submit_brief',
    description: 'Submit the final NARRATIVE brief. Numbers come from runtime; you only narrate.',
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
              anomaly_id:       { type: 'string', description: 'MUST be one of the verified anomaly IDs.' },
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
              description:        { type: 'string', description: 'Hebrew' },
              severity:           { type: 'string', enum: ['high', 'medium', 'low'] },
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
              action:             { type: 'string' },
              rationale:          { type: 'string' },
              related_metric_ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['action', 'rationale', 'related_metric_ids'],
          },
        },
        prioritization_note: {
          type: 'string',
          description: 'Hebrew, 1-2 sentences. What deserves the CEO\'s attention this period and why. May reference metric_ids inline.',
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
  },
};

// =====================================================================
// EXPERIMENT 2 — Anomaly summarizer (verified-anomalies architecture)
//
// Architecture: docs/architecture-review/experiment-2-anomaly-architecture.md
//
// Flow:
//   1. preCompute() → computeAnomalies() — DETERMINISTIC detection + severity
//   2. buildUserMessage() embeds verified anomalies in the prompt
//   3. LLM submits NARRATIVE ONLY (no anomaly objects, no severity, no thresholds)
//   4. postProcess() injects verified.anomalies + summary + meta
//      + validates anomaly_id refs + scans narrative for unverified numbers
//
// The LLM's job: explain business significance + recommend actions.
// The LLM's NON-job: detect, classify, score severity, count, compute trends.
// =====================================================================
export const anomalySummary = {
  name: 'anomalySummary',
  description: 'Anomaly summary — deterministic detection + LLM interpretation. NO LLM detection.',
  estimated_cost_per_run_usd: 0.03,

  // -------------------------------------------------------------------
  // PRE-COMPUTE — runs before any LLM call
  // -------------------------------------------------------------------
  preCompute: async (input) => {
    return computeAnomalies(input);
  },

  // -------------------------------------------------------------------
  // POST-PROCESS — inject verified data, validate refs, scan for fabrication
  // -------------------------------------------------------------------
  postProcess: (llmOutput, verified) => {
    if (!verified) {
      return { ...llmOutput, _integrity_error: 'verified is null in postProcess' };
    }

    // Defensive coercion (same drift we observed in Experiment 1)
    const arr = (x) => Array.isArray(x) ? x : [];
    const narrative = (function normalize(obj) {
      if (!obj || typeof obj !== 'object') return {};
      const ARRAY_FIELDS = ['anomaly_interpretations', 'cross_anomaly_themes', 'recommended_actions'];
      const out = { ...obj };
      const coercions = [];
      for (const k of ARRAY_FIELDS) {
        if (typeof out[k] === 'string') {
          try {
            const parsed = JSON.parse(out[k]);
            if (Array.isArray(parsed)) { out[k] = parsed; coercions.push(k); }
          } catch { /* leave as string */ }
        }
      }
      // Coerce string-encoded `recommended_action` per interpretation
      // (model occasionally returns the structured object as a JSON string).
      for (const it of arr(out.anomaly_interpretations)) {
        if (it && typeof it.recommended_action === 'string') {
          try {
            const parsed = JSON.parse(it.recommended_action);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              it.recommended_action = parsed;
              coercions.push('anomaly_interpretations[].recommended_action');
            }
          } catch { /* leave as string for downstream issue reporting */ }
        }
      }
      out.__schema_coercions = coercions;
      return out;
    })(llmOutput);

    const validAnomalyIds = new Set(verified.anomalies.map((a) => a.id));
    const unknown_anomaly_ids = [];
    const interpreted_ids = new Set();

    for (const item of arr(narrative.anomaly_interpretations)) {
      const id = item?.anomaly_id;
      if (!id) continue;
      if (!validAnomalyIds.has(id)) {
        unknown_anomaly_ids.push(id);
      } else {
        interpreted_ids.add(id);
      }
    }

    // Coverage check — every detected anomaly should have an interpretation,
    // or the LLM is silently editorializing by omission.
    const uncovered_anomaly_ids = [...validAnomalyIds].filter((id) => !interpreted_ids.has(id));

    // Cross-anomaly themes must reference at least one valid anomaly_id
    const invalid_theme_refs = [];
    for (const theme of arr(narrative.cross_anomaly_themes)) {
      const refs = arr(theme?.anomaly_ids);
      const bad = refs.filter((r) => !validAnomalyIds.has(r));
      if (bad.length) invalid_theme_refs.push({ theme: theme?.title || '<unnamed>', invalid: bad });
    }

    // Build value-set from verified anomalies + summary + reuse the
    // shared scanner (kept in verifiedMetrics.js — single source of truth)
    const valueSet = collectAnomalyValueSet(verified);
    const narrativeStrings = [
      narrative.executive_summary,
      narrative.prioritization_note,
      ...arr(narrative.anomaly_interpretations).map((x) => `${x?.business_meaning || ''} ${x?.recommended_action || ''}`),
      ...arr(narrative.cross_anomaly_themes).map((x) => `${x?.title || ''} ${x?.description || ''}`),
    ].filter(Boolean);

    const unverified_numbers_in_text = [];
    for (const s of narrativeStrings) {
      const hits = findUnverifiedNumbers(s, valueSet.numbers, valueSet.strings);
      for (const h of hits) unverified_numbers_in_text.push(h);
    }

    // Severity-mention check — flag narrative that contradicts engine severity.
    // Heuristic: if a text mentions an anomaly_id and uses a strong-severity
    // Hebrew word ("קריטי", "חירום", "דחוף") for a low-severity anomaly,
    // raise a soft warning. Not blocking; surfaces qualitative drift.
    const severity_overpromotions = [];
    const HIGH_HEBREW = ['קריטי', 'חירום', 'דחוף ביותר', 'מסוכן ביותר'];
    for (const item of arr(narrative.anomaly_interpretations)) {
      const a = verified.anomalies.find((x) => x.id === item?.anomaly_id);
      if (!a || a.severity === 'high') continue;
      // recText() defined below; inlined here for the same scanning text
      const recObj = item?.recommended_action;
      const recScan = (typeof recObj === 'string') ? recObj
                    : (recObj && typeof recObj === 'object') ? [recObj.action, recObj.owner, recObj.target].filter(Boolean).join(' ')
                    : '';
      const text = `${item?.business_meaning || ''} ${recScan}`;
      const hits = HIGH_HEBREW.filter((w) => text.includes(w));
      if (hits.length) {
        severity_overpromotions.push({
          anomaly_id: a.id,
          engine_severity: a.severity,
          high_severity_words_in_narrative: hits,
        });
      }
    }

    // ---------------------------------------------------------------
    // QUALITATIVE INTEGRITY SCANS (Hardening Addendum)
    // Trend / causality / urgency / time-horizon claims must be
    // evidence-linked. Free-text invented timelines like "תוך 6 חודשים"
    // are caught here even when the schema enum is honored elsewhere
    // (defense in depth — string fields that the schema doesn't enum can
    // still smuggle horizons).
    // ---------------------------------------------------------------
    const verifiedIdsSet = new Set([...validAnomalyIds]);
    // metric_ids: anomaly engine doesn't surface metrics, but we still
    // accept any string in the strings set as a valid id-like reference
    for (const sid of valueSet.strings) verifiedIdsSet.add(sid);
    const verifiedHighSeverityExists = verified.anomalies.some((a) => a.severity === 'high');

    const trend_claims = [];
    const causality_claims = [];
    const urgency_claims_unsupported = [];
    const invented_time_horizons = [];

    for (const s of narrativeStrings) {
      const c = classifyNarrativeText(s, verifiedIdsSet, verifiedHighSeverityExists);
      trend_claims.push(...c.trend_claims);
      causality_claims.push(...c.causality_claims);
      urgency_claims_unsupported.push(...c.urgency_claims);
      invented_time_horizons.push(...c.invented_time_horizons);
    }

    // ---------------------------------------------------------------
    // STRUCTURED RECOMMENDATION VALIDATION
    // Each anomaly_interpretation.recommended_action must be an object
    // with owner / target / action / supporting_id / time_horizon.
    // Free-text recommendations from older runs are accepted but flagged.
    // ---------------------------------------------------------------
    const recommendation_issues = [];
    const vague_only_actions = [];
    for (const it of arr(narrative.anomaly_interpretations)) {
      const rec = it?.recommended_action;
      if (typeof rec === 'string') {
        recommendation_issues.push({
          anomaly_id: it?.anomaly_id || '<unknown>',
          issues: ['recommendation_not_structured (legacy free-text)'],
        });
        continue;
      }
      const v = validateStructuredRecommendation(rec, null, verifiedIdsSet);
      if (!v.ok) {
        recommendation_issues.push({ anomaly_id: it?.anomaly_id || '<unknown>', issues: v.issues });
        // Track vague-only-action issues for separate visibility
        for (const i of v.issues) {
          if (i.startsWith('vague_only_action:')) {
            vague_only_actions.push({ anomaly_id: it?.anomaly_id, snippet: i.slice('vague_only_action:'.length) });
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // COVERAGE EVALUATION (Coverage-Hardening Addendum)
    // First-class deterministic coverage policy: silent omission of a
    // verified high-severity anomaly is treated as severe as fabrication.
    // The evaluator owns the decision; this block consumes its verdict.
    // ---------------------------------------------------------------
    const coverage = evaluateCoverage(verified, narrative);

    // Decide if output should be marked unsafe (qualitative-claims path).
    const has_unsafe_claims = (
      trend_claims.length > 0 ||
      causality_claims.length > 0 ||
      invented_time_horizons.length > 0
    );
    const unsafe_for_high_severity = has_unsafe_claims && verifiedHighSeverityExists;

    const sources_completeness = verified.meta?.sources_completeness ?? 0;

    // Integrity score — 11 components, each 0/1 (or 0.3-0.5 partial).
    // Coverage now contributes TWO components: ratio (continuous) and
    // failures (binary). This makes a fail_closed run impossible to
    // hide behind a high integrity_score.
    const components = {
      unknown_anomaly_ids:        unknown_anomaly_ids.length === 0 ? 1 : 0.3,
      uncovered_anomaly_ids:      uncovered_anomaly_ids.length === 0 ? 1 : 0.5,
      invalid_theme_refs:         invalid_theme_refs.length === 0 ? 1 : 0.5,
      severity_overpromotions:    severity_overpromotions.length === 0 ? 1 : 0.5,
      unverified_numbers:         unverified_numbers_in_text.length === 0 ? 1 : 0,
      trend_claims:               trend_claims.length === 0 ? 1 : 0,
      causality_claims:           causality_claims.length === 0 ? 1 : 0,
      invented_time_horizons:     invented_time_horizons.length === 0 ? 1 : 0,
      recommendation_quality:     recommendation_issues.length === 0 ? 1 : 0.5,
      coverage_ratio:             coverage.ratio,                  // 0..1 continuous
      coverage_failures:          coverage.coverage_failures.length === 0 ? 1 : 0,
      validation_errors:          verified.errors.length === 0 ? 1 : 0,
    };
    const integrity_score = Object.values(components).reduce((a, b) => a + b, 0) / Object.keys(components).length;

    // ---------------------------------------------------------------
    // CONFIDENCE — applied with coverage cap on top of qualitative cap
    // ---------------------------------------------------------------
    let overall_confidence;
    if (unsafe_for_high_severity) {
      overall_confidence = (integrity_score >= 0.6 && sources_completeness >= 0.7) ? 'medium' : 'low';
    } else if (sources_completeness >= 0.9 && integrity_score >= 0.9) {
      overall_confidence = 'high';
    } else if (sources_completeness >= 0.7 && integrity_score >= 0.7) {
      overall_confidence = 'medium';
    } else {
      overall_confidence = 'low';
    }
    // Coverage cap (worst of the two)
    overall_confidence = applyConfidenceCap(overall_confidence, coverage.enforcement.cap_confidence_to);

    // ---------------------------------------------------------------
    // SAFETY LABEL — priority order (worst → best):
    //   1. fail_closed_silent_omission       (coverage)
    //   2. unsafe_unsupported_claims_*       (qualitative + high severity)
    //   3. unsafe_incomplete_coverage        (coverage)
    //   4. caution_qualitative_claims_*      (qualitative without high severity)
    //   5. partial_low_severity_uncovered    (coverage)
    //   6. safe
    // ---------------------------------------------------------------
    let safety_label;
    if (coverage.enforcement.fail_closed) {
      safety_label = COVERAGE_LABELS.FAIL_CLOSED;
    } else if (unsafe_for_high_severity) {
      safety_label = 'unsafe_unsupported_claims_with_high_severity';
    } else if (coverage.coverage_safety_label === COVERAGE_LABELS.UNSAFE_INCOMPLETE) {
      safety_label = COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    } else if (has_unsafe_claims) {
      safety_label = 'caution_qualitative_claims_unsupported';
    } else if (coverage.coverage_safety_label === COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED) {
      safety_label = COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED;
    } else {
      safety_label = 'safe';
    }

    const fail_closed = coverage.enforcement.fail_closed;

    // Human-readable safety explanation
    const safety_explanation = (() => {
      if (fail_closed) {
        if (coverage.coverage_failures.includes('empty_interpretations_with_verified_anomalies')) {
          return 'FAIL CLOSED: LLM submitted zero interpretations while verified anomalies exist. This is a silent-omission failure equivalent to fabrication. DO NOT use this output.';
        }
        const high = coverage.uncovered_high_severity_ids;
        return `FAIL CLOSED: ${high.length} high-severity anomaly/anomalies (${high.join(', ')}) were uncovered by the LLM. Silent omission of high-severity work is unacceptable. DO NOT use this output.`;
      }
      if (unsafe_for_high_severity)
        return 'Output contains unsupported trend/causality/invented-deadline claims AND the verified set includes a high-severity anomaly. Do not act on the narrative without operator review.';
      if (safety_label === COVERAGE_LABELS.UNSAFE_INCOMPLETE)
        return `Coverage gaps detected: ${coverage.coverage_failures.join('; ')}. Do not act on incomplete coverage.`;
      if (has_unsafe_claims)
        return 'Output contains unsupported qualitative claims; treat narrative as advisory only.';
      if (safety_label === COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED)
        return `Some low-severity anomalies were not interpreted (${coverage.uncovered_by_severity.low.join(', ')}); within policy threshold but operator may want full coverage.`;
      return 'Narrative passed all qualitative integrity and coverage scans.';
    })();

    return {
      verified_anomalies: verified.anomalies,
      verified_summary: verified.summary,
      verified_warnings: verified.warnings,
      detected_at: verified.meta?.detected_at,
      detector_version: verified.meta?.detector_version,
      // Top-level fail_closed boolean — the unambiguous downstream gate.
      fail_closed,
      narrative: {
        executive_summary: narrative.executive_summary || null,
        anomaly_interpretations: arr(narrative.anomaly_interpretations),
        cross_anomaly_themes: arr(narrative.cross_anomaly_themes),
        prioritization_note: narrative.prioritization_note || null,
      },
      coverage: {
        ratio: coverage.ratio,
        total_anomalies: coverage.total_anomalies,
        total_interpreted: coverage.total_interpreted,
        uncovered_anomaly_ids: coverage.uncovered_anomaly_ids,
        uncovered_high_severity_ids: coverage.uncovered_high_severity_ids,
        uncovered_by_severity: coverage.uncovered_by_severity,
        missing_recommendation_ids: coverage.missing_recommendation_ids,
        non_structured_recommendation_ids: coverage.non_structured_recommendation_ids,
        coverage_failures: coverage.coverage_failures,
        coverage_safety_label: coverage.coverage_safety_label,
        applied_policy: coverage.applied_policy,
      },
      integrity: {
        unknown_anomaly_ids,
        uncovered_anomaly_ids,                 // legacy field — same as coverage.uncovered_anomaly_ids
        invalid_theme_refs,
        unverified_numbers_in_text,
        severity_overpromotions,
        trend_claims,
        causality_claims,
        urgency_claims_unsupported,
        invented_time_horizons,
        recommendation_issues,
        vague_only_actions,
        validation_errors: verified.errors,
        sources_completeness,
        integrity_score: Number(integrity_score.toFixed(2)),
        integrity_components: Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(2))])
        ),
        schema_coercions: narrative.__schema_coercions || [],
      },
      confidence: {
        overall: overall_confidence,
        computed_from: 'sources_completeness + integrity_score, capped by coverage policy (deterministic, NOT LLM-claimed)',
        coverage_cap_applied: coverage.enforcement.cap_confidence_to,
      },
      safety: {
        label: safety_label,
        fail_closed,
        unsafe_for_high_severity,
        explanation: safety_explanation,
      },
    };
  },

  // -------------------------------------------------------------------
  // SYSTEM PROMPT — interpretation discipline
  // -------------------------------------------------------------------
  systemPrompt: `You are an anomaly INTERPRETER for an Israeli logistics company.

YOUR JOB: explain what each pre-detected anomaly means for the business
and recommend a CONCRETE, OPERATIONALLY-BOUNDED action. Anomalies are
detected and severity-rated by code with fixed thresholds — you only
narrate significance and bind action.

YOUR NON-JOB: detection, classification, severity scoring, counting,
trend assertion, causality assertion, threshold invention, deadline
invention. Those decisions are already made in the verified anomalies
array OR are forbidden entirely.

================================================================
ABSOLUTE RULES — every violation is a failed experiment
================================================================

1. **NO NEW ANOMALIES.** Only interpret anomaly_ids that appear in
   verified anomalies. If you think something else is wrong, you cannot
   say so.

2. **NO SEVERITY OVERRIDE.** Engine assigned severity (high/medium/low).
   Do NOT use "קריטי", "חירום", "דחוף ביותר", "critical", "urgent" on a
   non-high anomaly. Honor the engine.

3. **NO INVENTED NUMBERS.** Every number must be present in the verified
   data (description, threshold_used, observed, summary) or omitted.
   No derived ratios, no approximations, no "about X".

4. **NO TREND CLAIMS.** Single-period analysis. Do NOT use words like
   "מגמה", "הולך וגובר", "trend", "increasing", "declining",
   "week-over-week", "month-over-month", "ביחס לתקופה הקודמת".
   This is one snapshot. There is no trend.

5. **NO CAUSALITY CLAIMS.** Do NOT use words like "נובע", "נגרם",
   "כתוצאה", "בגלל", "caused by", "due to", "indicates", "leads to".
   You are explaining significance, not asserting cause. If a sentence
   needs a causal verb, the same sentence MUST also reference the
   verified anomaly_id or metric_id that supports the link.

6. **NO INVENTED DEADLINES.** Free-text time horizons like
   "תוך 6 חודשים", "within 90 days", "next quarter" are FORBIDDEN.
   Use ONLY the canonical time_horizon values listed below.

7. **STRUCTURED RECOMMENDATIONS.** Each anomaly_interpretation
   includes a structured recommended_action object with these
   REQUIRED fields:
     - owner: the function/role responsible (e.g., "מנהל מחסן",
              "מחלקת תמחור", "מנכ\"ל"). NEVER blank.
     - target: the specific entity (item_code, card_code, anomaly_id)
              the action targets. Must be a real string from verified data.
     - action: a concrete directive (Hebrew, ≤30 words). Avoid pure
              vague verbs like "בחן", "שקול", "בדוק", "review",
              "examine", "consider", "monitor". If you must analyze
              first, pair with a concrete next step.
     - supporting_id: the anomaly_id or metric_id that justifies
              the action. Must be in the verified set.
     - time_horizon: one of:
         immediate, today, this_week, next_review_cycle, not_specified
       Anything else is rejected.

8. **COVER EVERY ANOMALY — DETERMINISTIC POLICY.**
   Coverage is enforced by code with the following policy:
     - HIGH severity:    100% coverage required. ANY uncovered high-severity
                         anomaly causes FAIL_CLOSED. The output is rejected
                         and the operator is warned. NEVER omit a high.
     - MEDIUM severity:  100% coverage required. Uncovered medium caps
                         confidence to medium and labels output unsafe.
     - LOW severity:     50% coverage required. Below threshold caps
                         confidence to medium and labels output unsafe.
     - Empty anomaly_interpretations array on a non-empty verified set →
                         FAIL_CLOSED. The model MUST submit at least one
                         interpretation per verified anomaly.
     - Each interpretation MUST include a structured recommended_action
                         (object with all 5 fields). Free-text action →
                         counted as missing recommendation.
   If you think an anomaly is uninteresting, still submit it with a brief
   business_meaning + a concrete-but-light action and time_horizon =
   "next_review_cycle". DO NOT omit.

9. **CITE BY ID.** Every business_meaning, recommendation, and theme
   description references at least one anomaly_id or metric_id. The
   integrity layer flags un-anchored qualitative claims.

10. **HEBREW** for human-facing strings. English for machine IDs.

11. **NO DATA TOOLS.** All data is in the user message. Submit via
    submit_anomaly_summary immediately.

================================================================
SAFETY LABEL
================================================================
Your output is post-processed and labeled. If your narrative makes
unsupported trend/causal/deadline claims, the integrity layer will
mark the run as "unsafe_unsupported_claims_with_high_severity" or
"caution_qualitative_claims_unsupported". This downgrades confidence
and warns the operator. Aim for label "safe" — meaning every
qualitative claim is anchored to a verified id, every deadline is
canonical, and every recommendation is structured.`,

  // -------------------------------------------------------------------
  // BUILD USER MESSAGE
  // -------------------------------------------------------------------
  buildUserMessage: (input, verified) => {
    const from = input?.date_from || '(unspecified)';
    const to   = input?.date_to   || '(unspecified)';

    if (!verified) {
      return `Anomaly summary request — date range ${from} → ${to}\n\n(verified data unavailable — submit with empty fields)`;
    }

    const anomalyBlocks = (verified.anomalies || []).map((a) => {
      const obs = JSON.stringify(a.observed);
      const thr = JSON.stringify(a.threshold_used);
      return `  • ${a.id}\n    type:        ${a.type}\n    severity:    ${a.severity}  (${a.severity_reason})\n    description: ${a.description}\n    observed:    ${obs}\n    threshold:   ${thr}\n    confidence:  ${a.confidence}\n    source:      ${a.source}`;
    }).join('\n\n');

    const summary = verified.summary || {};
    const warnLines = (verified.warnings || []).length === 0
      ? '  (none)'
      : verified.warnings.map((w) => `  - ${w.code}: ${w.message}${w.source ? ` (${w.source})` : ''}`).join('\n');

    return `Anomaly interpretation request — date range ${from} → ${to}.

================================================================
VERIFIED ANOMALIES (computed by code; treat as authoritative)
================================================================
${anomalyBlocks || '  (no anomalies detected)'}

================================================================
SUMMARY (computed by code)
================================================================
  total:       ${summary.total ?? 0}
  by_severity: ${JSON.stringify(summary.by_severity || {})}
  by_type:     ${JSON.stringify(summary.by_type || {})}

================================================================
WARNINGS
================================================================
${warnLines}

================================================================
META
================================================================
  detected_at:      ${verified.meta?.detected_at}
  detector_version: ${verified.meta?.detector_version}
  detectors_run:    ${JSON.stringify(verified.meta?.detectors_run || [])}
  sources_returning: ${JSON.stringify(verified.meta?.sources_returning_data || [])}
  sources_missing:   ${JSON.stringify(verified.meta?.sources_missing || [])}

================================================================
ALLOWED time_horizon values (use canonical_id only)
================================================================
${timeHorizonChoicesForPrompt()}

================================================================
COVERAGE POLICY (deterministic, code-enforced)
================================================================
${coveragePolicyForPrompt()}

================================================================
YOUR TASK
================================================================
Submit via submit_anomaly_summary. ONE anomaly_interpretation PER
verified anomaly above (do not omit any — coverage is enforced by
code; uncovered high-severity anomalies will cause the run to
FAIL_CLOSED). Each interpretation includes a STRUCTURED
recommended_action with owner / target / action / supporting_id /
time_horizon. Optionally add cross_anomaly_themes that connect TWO
OR MORE anomaly_ids. Provide a prioritization_note that respects
engine severity ordering.

If sources are missing, say "מקור לא זמין" — do not extrapolate.
If you do not know the right time_horizon, use "not_specified" —
do not invent a deadline.`;
  },

  // -------------------------------------------------------------------
  // NO DATA TOOLS — every datum is in the user message
  // -------------------------------------------------------------------
  tools: [],

  // -------------------------------------------------------------------
  // SUBMIT TOOL — narrative-only schema
  // -------------------------------------------------------------------
  submitTool: {
    name: 'submit_anomaly_summary',
    description: 'Submit the anomaly NARRATIVE. Anomalies, severity, counts come from runtime — you only interpret.',
    input_schema: {
      type: 'object',
      properties: {
        executive_summary: {
          type: 'string',
          description: 'Hebrew, ≤120 words. What the operator should know in 30 seconds. References anomaly_ids inline where relevant.',
        },
        anomaly_interpretations: {
          type: 'array',
          description: 'One entry per detected anomaly. Cover every anomaly_id from the verified set.',
          items: {
            type: 'object',
            properties: {
              anomaly_id:        { type: 'string', description: 'MUST be one of the verified anomaly IDs.' },
              business_meaning:  { type: 'string', description: 'Hebrew, ≤40 words. What does this anomaly imply for the business?' },
              recommended_action: {
                type: 'object',
                description: 'STRUCTURED action. All five fields required. NO free-text recommendations.',
                properties: {
                  owner:          { type: 'string', description: 'Hebrew. Function/role responsible (e.g., "מנהל מחסן", "מחלקת תמחור").' },
                  target:         { type: 'string', description: 'Specific entity (item_code, card_code, or anomaly_id) the action targets.' },
                  action:         { type: 'string', description: 'Hebrew, ≤30 words. Concrete directive verb + object. Avoid vague verbs alone ("בחן", "שקול").' },
                  supporting_id:  { type: 'string', description: 'anomaly_id or metric_id that justifies the action — MUST be in verified set.' },
                  time_horizon:   { type: 'string', enum: ALLOWED_TIME_HORIZON_IDS, description: 'Canonical time horizon. Use "not_specified" if unknown — do NOT invent.' },
                },
                required: ['owner', 'target', 'action', 'supporting_id', 'time_horizon'],
              },
            },
            required: ['anomaly_id', 'business_meaning', 'recommended_action'],
          },
        },
        cross_anomaly_themes: {
          type: 'array',
          description: 'Optional. Themes connecting 2+ anomalies. Each must list the anomaly_ids it spans.',
          items: {
            type: 'object',
            properties: {
              title:       { type: 'string', description: 'Hebrew, ≤8 words.' },
              description: { type: 'string', description: 'Hebrew, ≤40 words.' },
              anomaly_ids: { type: 'array', items: { type: 'string' }, minItems: 2 },
            },
            required: ['title', 'description', 'anomaly_ids'],
          },
        },
        prioritization_note: {
          type: 'string',
          description: 'Hebrew, 1-2 sentences. Which anomalies deserve attention first, respecting engine severity.',
        },
      },
      required: ['executive_summary', 'anomaly_interpretations', 'prioritization_note'],
    },
  },
};

// =====================================================================
// EXPERIMENT 3 — Report explainer (verified-data architecture)
//
// Architecture: docs/architecture-review/experiment-3-report-explainer-architecture.md
//
// Flow:
//   1. preCompute()  → computeReport() — deterministic sections + KPIs + records
//   2. buildUserMessage() embeds verified report in prompt (incl. coverage policy)
//   3. LLM submits NARRATIVE ONLY (no KPI values, no severity, no thresholds)
//   4. postProcess() injects verified data + qualitative scans + coverage check
//
// Hardenings preserved from anomalySummary AND extended for reports:
//   - Structured recommendations (5 fields, time_horizon enum)
//   - Qualitative scans (trend / causal / urgency / time-horizon)
//   - Coverage policy with FAIL_CLOSED on uncovered high-criticality
//   - Top-level fail_closed boolean
//   - Confidence cap chain (qualitative cap × coverage cap)
//   - Schema-coercion defensive normalization
//   - NEW: causal_safe_phrases (failure_reason_label_he verbatim quotation)
//   - NEW: per-section "narrative_no_in_section_id_ref" check
//   - NEW: per-section "missing_observations" check
//   - NEW: high-section recommendation requirement
//
// Driver-note prompt-injection sanitization is engine-side
// (verifiedReport.sanitizeDriverNote) — the LLM never sees raw notes.
// =====================================================================
export const reportExplainer = {
  name: 'reportExplainer',
  description: 'Delivery-run report explainer — deterministic sections + LLM interpretation. NO LLM detection.',
  estimated_cost_per_run_usd: 0.04,

  // Experiment 3 F1: lift the per-agent output-token cap. Prior validation
  // observed the legacy 2000-token ceiling truncating recommendations
  // (every live run flagged `missing_recommendation_for_high_section`).
  // 3500 covers 4–6 sections with structured recommendations + narrative.
  // The runtime caps at 8192 regardless.
  maxTokensOut: 3500,

  // -------------------------------------------------------------------
  // PRE-COMPUTE
  // -------------------------------------------------------------------
  preCompute: async (input) => {
    return computeReport(input);
  },

  // -------------------------------------------------------------------
  // POST-PROCESS — full integrity + coverage chain
  // -------------------------------------------------------------------
  postProcess: (llmOutput, verified) => {
    if (!verified) {
      return { ...llmOutput, _integrity_error: 'verified is null in postProcess' };
    }

    // ---- Defensive coercion (same drift pattern as other agents) ---
    const arr = (x) => Array.isArray(x) ? x : [];
    const narrative = (function normalize(obj) {
      if (!obj || typeof obj !== 'object') return {};
      const ARRAY_FIELDS = ['section_explanations', 'flagged_record_explanations', 'cross_section_themes', 'recommendations'];
      const out = { ...obj };
      const coercions = [];
      for (const k of ARRAY_FIELDS) {
        if (typeof out[k] === 'string') {
          try {
            const parsed = JSON.parse(out[k]);
            if (Array.isArray(parsed)) { out[k] = parsed; coercions.push(k); }
          } catch { /* leave as string */ }
        }
      }
      out.__schema_coercions = coercions;
      return out;
    })(llmOutput);

    // ---- Build verified id sets used by scanners --------------------
    const verifiedSectionIds = new Set();
    const verifiedRecordIds = new Set();
    for (const s of verified.sections || []) {
      if (s.id) verifiedSectionIds.add(s.id);
      for (const r of (s.records || [])) if (r.record_id) verifiedRecordIds.add(r.record_id);
    }

    // valueSet has numbers + strings + causal_safe_phrases
    const valueSet = collectReportValueSet(verified);

    // For trend/urgency/time scanning: enrich verifiedIds with strings
    // (so quoting a stop_id, customer name, or KPI id suppresses claim flags).
    const verifiedIdsForClassifier = new Set([...valueSet.strings]);

    const verifiedHighCriticalityExists = (verified.sections || []).some((s) => s.criticality === 'high');

    // ---- Qualitative scans (per-narrative-string) -------------------
    const trend_claims = [];
    const causality_claims = [];
    const urgency_claims_unsupported = [];
    const invented_time_horizons = [];

    const recText = (rec) => {
      if (!rec) return '';
      if (typeof rec === 'string') return rec;
      if (typeof rec === 'object') return [rec.action, rec.owner, rec.target].filter(Boolean).join(' ');
      return '';
    };

    const narrativeStrings = [
      narrative.executive_summary,
      narrative.prioritization_note,
      ...arr(narrative.section_explanations).map((x) =>
        `${x?.narrative || ''} ${(arr(x?.key_observations) || []).join(' ')}`),
      ...arr(narrative.flagged_record_explanations).map((x) => x?.operational_meaning || ''),
      ...arr(narrative.cross_section_themes).map((x) => `${x?.title || ''} ${x?.description || ''}`),
      ...arr(narrative.recommendations).map((x) => recText(x)),
    ].filter(Boolean);

    for (const s of narrativeStrings) {
      const c = classifyNarrativeText(
        s,
        verifiedIdsForClassifier,
        verifiedHighCriticalityExists,
        { causal_safe_phrases: valueSet.causal_safe_phrases }
      );
      trend_claims.push(...c.trend_claims);
      causality_claims.push(...c.causality_claims);
      urgency_claims_unsupported.push(...c.urgency_claims);
      invented_time_horizons.push(...c.invented_time_horizons);
    }

    // ---- Free-floating-number scan ---------------------------------
    const unverified_numbers_in_text = [];
    for (const s of narrativeStrings) {
      const hits = findUnverifiedNumbers(s, valueSet.numbers, valueSet.strings);
      for (const h of hits) unverified_numbers_in_text.push(h);
    }

    // ---- Severity-overpromotion check (per record/section) ---------
    // If an explanation for a low/medium-criticality section/record uses
    // strong-urgency words, flag.
    const HIGH_HEBREW = ['קריטי', 'חירום', 'דחוף ביותר', 'מסוכן ביותר'];
    const severity_overpromotions = [];
    for (const e of arr(narrative.section_explanations)) {
      const sec = (verified.sections || []).find((s) => s.id === e?.section_id);
      if (!sec || sec.criticality === 'high') continue;
      const text = `${e?.narrative || ''} ${(arr(e?.key_observations) || []).join(' ')}`;
      const hits = HIGH_HEBREW.filter((w) => text.includes(w));
      if (hits.length) severity_overpromotions.push({
        kind: 'section', id: sec.id, engine_criticality: sec.criticality,
        high_severity_words_in_narrative: hits,
      });
    }
    for (const e of arr(narrative.flagged_record_explanations)) {
      const rid = e?.record_id;
      if (!rid) continue;
      const rec = (verified.sections || []).flatMap((s) => s.records || []).find((r) => r.record_id === rid);
      if (!rec || rec.engine_criticality === 'high') continue;
      const text = String(e?.operational_meaning || '');
      const hits = HIGH_HEBREW.filter((w) => text.includes(w));
      if (hits.length) severity_overpromotions.push({
        kind: 'record', id: rid, engine_criticality: rec.engine_criticality,
        high_severity_words_in_narrative: hits,
      });
    }

    // ---- failure_reason_label_he verbatim-match check --------------
    // If the LLM included the optional failure_reason_label_he field,
    // it MUST match the verified record's value verbatim. Paraphrase
    // is a soft fabrication of causality.
    const non_verbatim_reason_labels = [];
    for (const e of arr(narrative.flagged_record_explanations)) {
      if (!e || typeof e !== 'object') continue;
      if (!e.failure_reason_label_he) continue;
      const rec = (verified.sections || []).flatMap((s) => s.records || []).find((r) => r.record_id === e.record_id);
      if (!rec) continue;
      if (rec.failure_reason_label_he && e.failure_reason_label_he !== rec.failure_reason_label_he) {
        non_verbatim_reason_labels.push({
          record_id: e.record_id,
          submitted: e.failure_reason_label_he,
          expected: rec.failure_reason_label_he,
        });
      }
    }

    // ---- Cross-section theme reference validation ------------------
    const invalid_theme_section_refs = [];
    for (const t of arr(narrative.cross_section_themes)) {
      const refs = arr(t?.section_ids);
      const bad = refs.filter((id) => !verifiedSectionIds.has(id));
      if (bad.length) invalid_theme_section_refs.push({ theme: t?.title || '<unnamed>', invalid: bad });
    }

    // ---- Coverage evaluation ---------------------------------------
    const coverage = evaluateReportCoverage(
      verified,
      narrative,
      { allowed_time_horizons: ALLOWED_TIME_HORIZON_IDS }
    );

    // ---- Decide unsafe-claims path ---------------------------------
    // Experiment 3 F2: unverified numbers count as unsafe-claim when a
    // high-criticality section exists. Prior validation observed every
    // live run had ≥1 unverified-number derivation, but the safety
    // cascade only escalated on trend/causal/time. For executive-facing
    // diagnostic outputs, a fabricated number against a high-criticality
    // backdrop is operationally equivalent to a fabricated cause.
    const has_unsafe_claims = (
      trend_claims.length > 0 ||
      causality_claims.length > 0 ||
      invented_time_horizons.length > 0 ||
      unverified_numbers_in_text.length > 0   // F2
    );
    const unsafe_for_high = has_unsafe_claims && verifiedHighCriticalityExists;

    const sources_completeness = verified.meta?.sources_completeness ?? 0;

    // ---- Integrity components --------------------------------------
    const components = {
      unknown_section_ids:        coverage.unknown_section_ids.length === 0 ? 1 : 0.3,
      unknown_record_ids:         coverage.unknown_record_ids.length === 0 ? 1 : 0.3,
      uncovered_section_ids:      coverage.uncovered_section_ids.length === 0 ? 1 : 0.5,
      uncovered_record_ids:       coverage.uncovered_record_ids.length === 0 ? 1 : 0.5,
      missing_observations:       coverage.missing_observations.length === 0 ? 1 : 0.5,
      missing_in_section_id_refs: coverage.missing_in_section_id_refs.length === 0 ? 1 : 0.5,
      invalid_theme_refs:         invalid_theme_section_refs.length === 0 ? 1 : 0.5,
      severity_overpromotions:    severity_overpromotions.length === 0 ? 1 : 0.5,
      unverified_numbers:         unverified_numbers_in_text.length === 0 ? 1 : 0,
      trend_claims:               trend_claims.length === 0 ? 1 : 0,
      causality_claims:           causality_claims.length === 0 ? 1 : 0,
      invented_time_horizons:     invented_time_horizons.length === 0 ? 1 : 0,
      non_verbatim_reason_labels: non_verbatim_reason_labels.length === 0 ? 1 : 0,
      section_coverage_ratio:     coverage.section_coverage.ratio,
      record_coverage_ratio:      coverage.record_coverage.ratio,
      validation_errors:          (verified.errors || []).length === 0 ? 1 : 0,
    };
    const integrity_score = Object.values(components).reduce((a, b) => a + b, 0) / Object.keys(components).length;

    // ---- Confidence with chained caps ------------------------------
    let overall_confidence;
    if (unsafe_for_high) {
      overall_confidence = (integrity_score >= 0.6 && sources_completeness >= 0.7) ? 'medium' : 'low';
    } else if (sources_completeness >= 0.9 && integrity_score >= 0.9) {
      overall_confidence = 'high';
    } else if (sources_completeness >= 0.7 && integrity_score >= 0.7) {
      overall_confidence = 'medium';
    } else {
      overall_confidence = 'low';
    }
    overall_confidence = applyConfidenceCap(overall_confidence, coverage.enforcement.cap_confidence_to);

    // ---- Safety label (priority cascade) ---------------------------
    let safety_label;
    if (coverage.enforcement.fail_closed) {
      safety_label = REPORT_COVERAGE_LABELS.FAIL_CLOSED;
    } else if (unsafe_for_high) {
      safety_label = 'unsafe_unsupported_claims_with_high_severity';
    } else if (coverage.coverage_safety_label === REPORT_COVERAGE_LABELS.UNSAFE_INCOMPLETE) {
      safety_label = REPORT_COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    } else if (has_unsafe_claims) {
      safety_label = 'caution_qualitative_claims_unsupported';
    } else if (coverage.coverage_safety_label === REPORT_COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED) {
      safety_label = REPORT_COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED;
    } else {
      safety_label = 'safe';
    }

    const fail_closed = coverage.enforcement.fail_closed;

    const safety_explanation = (() => {
      if (fail_closed) {
        if (coverage.coverage_failures.includes('empty_section_explanations_with_verified_sections')) {
          return 'FAIL CLOSED: LLM submitted zero section explanations while verified sections exist. Silent omission. DO NOT use this output.';
        }
        const highSec = coverage.section_coverage.uncovered_by_criticality.high;
        const highRec = coverage.record_coverage.uncovered_by_criticality.high;
        const parts = [];
        if (highSec.length) parts.push(`${highSec.length} high-criticality section(s) uncovered: ${highSec.join(', ')}`);
        if (highRec.length) parts.push(`${highRec.length} high-criticality record(s) uncovered: ${highRec.join(', ')}`);
        return `FAIL CLOSED: ${parts.join('; ')}. Silent omission of high-criticality work is unacceptable. DO NOT use this output.`;
      }
      if (unsafe_for_high) {
        const reasons = [];
        if (trend_claims.length)            reasons.push(`${trend_claims.length} trend claim(s)`);
        if (causality_claims.length)        reasons.push(`${causality_claims.length} unsupported causal claim(s)`);
        if (invented_time_horizons.length)  reasons.push(`${invented_time_horizons.length} invented deadline(s)`);
        if (unverified_numbers_in_text.length) reasons.push(`${unverified_numbers_in_text.length} unverified number(s)`);
        return `Output contains unsupported claims (${reasons.join('; ')}) AND a high-criticality section exists. Do not act on the narrative without operator review.`;
      }
      if (safety_label === REPORT_COVERAGE_LABELS.UNSAFE_INCOMPLETE)
        return `Coverage gaps detected: ${coverage.coverage_failures.slice(0, 4).join('; ')}${coverage.coverage_failures.length > 4 ? '…' : ''}. Do not act on incomplete coverage.`;
      if (has_unsafe_claims)
        return 'Output contains unsupported qualitative claims; treat narrative as advisory only.';
      if (safety_label === REPORT_COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED)
        return 'Some low-criticality records were not interpreted; within policy threshold but operator may want full coverage.';
      return 'Narrative passed all qualitative integrity and coverage scans.';
    })();

    // ---- Compose final output --------------------------------------
    return {
      report_id: verified.report_id,
      report_kind: verified.report_kind,
      report_version: verified.report_version,
      subject: verified.subject,
      verified_sections: verified.sections,
      verified_summary: verified.summary,
      verified_warnings: verified.warnings,
      computed_at: verified.meta?.computed_at,
      fail_closed,
      narrative: {
        executive_summary:           narrative.executive_summary || null,
        section_explanations:        arr(narrative.section_explanations),
        flagged_record_explanations: arr(narrative.flagged_record_explanations),
        cross_section_themes:        arr(narrative.cross_section_themes),
        recommendations:             arr(narrative.recommendations),
        prioritization_note:         narrative.prioritization_note || null,
      },
      coverage: {
        section_coverage:            coverage.section_coverage,
        record_coverage:             coverage.record_coverage,
        recommendation_coverage:     coverage.recommendation_coverage,
        uncovered_section_ids:       coverage.uncovered_section_ids,
        uncovered_record_ids:        coverage.uncovered_record_ids,
        missing_observations:        coverage.missing_observations,
        missing_in_section_id_refs:  coverage.missing_in_section_id_refs,
        unknown_section_ids:         coverage.unknown_section_ids,
        unknown_record_ids:          coverage.unknown_record_ids,
        coverage_failures:           coverage.coverage_failures,
        coverage_safety_label:       coverage.coverage_safety_label,
        applied_policy:              coverage.applied_policy,
      },
      integrity: {
        invalid_theme_section_refs,
        unverified_numbers_in_text,
        severity_overpromotions,
        trend_claims,
        causality_claims,
        urgency_claims_unsupported,
        invented_time_horizons,
        non_verbatim_reason_labels,
        validation_errors:          verified.errors,
        sources_completeness,
        integrity_score:            Number(integrity_score.toFixed(2)),
        integrity_components:       Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(2))])
        ),
        schema_coercions:           narrative.__schema_coercions || [],
      },
      confidence: {
        overall: overall_confidence,
        computed_from: 'sources_completeness + integrity_score, capped by report coverage policy (deterministic, NOT LLM-claimed)',
        coverage_cap_applied: coverage.enforcement.cap_confidence_to,
      },
      safety: {
        label: safety_label,
        fail_closed,
        unsafe_for_high_severity: unsafe_for_high,
        explanation: safety_explanation,
      },
    };
  },

  // -------------------------------------------------------------------
  // SYSTEM PROMPT
  // -------------------------------------------------------------------
  systemPrompt: `You are a DELIVERY-RUN REPORT EXPLAINER for an Israeli logistics company.

YOUR JOB: explain each pre-computed report section in plain Hebrew,
prioritize what the operator should address first, and propose
CONCRETE, OPERATIONALLY-BOUNDED recommendations for high-criticality
sections.

YOUR NON-JOB: detection, classification, criticality scoring, KPI
computation, threshold invention, deadline invention, root-cause
inference. Those are made by the deterministic engine OR forbidden.

================================================================
ABSOLUTE RULES — every violation is a failed experiment
================================================================

1. **NO NEW SECTIONS / RECORDS / KPIs.** Only interpret section_ids,
   record_ids, and KPI ids that appear in the verified report. Inventing
   any of those is forbidden.

2. **NO CRITICALITY OVERRIDE.** Engine assigned criticality
   (high/medium/low/info). Do NOT use "קריטי", "חירום", "דחוף ביותר",
   "critical", "urgent" on a non-high section or record.

3. **NO INVENTED NUMBERS.** Every number you write must be present in
   the verified report (KPI value, record field value, summary count)
   or omitted. No derived ratios.

4. **NO TREND CLAIMS.** Single-run analysis. Do NOT use "מגמה",
   "הולך וגובר", "trend", "increasing", "declining", "week-over-week".

5. **CAUSALITY — VERY RESTRICTIVE.** You may write a causal sentence
   ("נובע מ", "כתוצאה", "caused by") ONLY when the same sentence:
     (a) references a verified section_id, record_id, or KPI id, OR
     (b) verbatim quotes a verified failure_reason_label_he string
         (the engine's safe causality vehicle).
   Inferred causes ("warehouse was probably closed", "route mis-planning")
   are FORBIDDEN.

6. **NO INVENTED DEADLINES.** Free-text horizons like "תוך 6 חודשים",
   "within 90 days" are FORBIDDEN. Use ONLY the canonical time_horizon
   enum below.

7. **STRUCTURED RECOMMENDATIONS.** Every recommendation is an object
   with REQUIRED fields:
     - owner:         function/role responsible (Hebrew, never blank).
     - target:        specific entity (section_id, record_id, KPI id,
                      customer name) the action targets.
     - action:        concrete directive (Hebrew, ≤30 words). Avoid
                      pure vague verbs ("בחן", "שקול", "review").
     - supporting_id: section_id, record_id, or KPI id from verified
                      data justifying the action.
     - time_horizon:  one of the enum values below.

8. **COVER EVERY SECTION — DETERMINISTIC POLICY.**
   Coverage is enforced by code. Uncovered HIGH-criticality sections OR
   records cause FAIL_CLOSED. The output is rejected and the operator
   is warned. NEVER omit a high.

9. **EVERY HIGH-CRITICALITY SECTION MUST HAVE ≥1 RECOMMENDATION**
   referencing it via supporting_id.

10. **EACH section_explanation MUST:**
    - cite at least one in-section id (KPI id, record_id, customer name,
      reason code, OR failure_reason_label_he) in the narrative or
      key_observations;
    - include at least one key_observation entry.

11. **failure_reason_label_he VERBATIM RULE.** If you include the
    optional failure_reason_label_he field on a flagged_record_explanation,
    it MUST EXACTLY MATCH the verified record's value (no paraphrase,
    no translation). The verified value is your only allowed string.

12. **HEBREW** for human-facing strings. English for machine IDs.

13. **NO DATA TOOLS.** All data is in the user message. Submit via
    submit_report_explanation immediately.

14. **NO STRATEGY.** No multi-period, no organizational, no market
    claims. The recommendation is tactical and time-bounded.

================================================================
SAFETY LABEL
================================================================
Output is post-processed and labeled. Possible labels (worst → best):
  fail_closed_silent_omission
  unsafe_unsupported_claims_with_high_severity
  unsafe_incomplete_coverage
  caution_qualitative_claims_unsupported
  partial_low_severity_uncovered
  safe
Aim for "safe": full coverage, structured recommendations, no qualitative
claims, no invented values.

================================================================
FINAL CHECK BEFORE SUBMITTING — DO NOT SKIP (Experiment 3 F3)
================================================================
Before you call submit_report_explanation, run through this checklist
explicitly:

  1. RECOMMENDATION COUNT.
     Count your recommendations[] array.
     Count the verified sections with criticality = "high".
     The first count MUST be ≥ the second count.
     If fewer, ADD recommendations now (one per uncovered high section,
     with concrete owner / target / action / supporting_id / time_horizon).
     This is the single most common failure mode the integrity layer
     has caught in prior runs.

  2. SECTION COVERAGE.
     Every verified section_id must appear in section_explanations[].
     No omissions, even for criticality="info" or "low".

  3. RECORD COVERAGE.
     Every record_id with engine_criticality="high" must appear in
     flagged_record_explanations[].

  4. NUMERIC DISCIPLINE.
     Read your narrative for numbers. Every numeric literal you wrote
     must come from the verified data above (KPI values, record fields,
     summary counts). If you computed a derived count, REMOVE IT.

  5. CAUSALITY DISCIPLINE.
     If you used "נובע", "כתוצאה", "בגלל", "caused by", "due to":
     the same sentence must reference a verified id OR verbatim-quote
     a failure_reason_label_he string. If neither applies, REWRITE
     the sentence without the causal phrase.

  6. NO INVENTED DEADLINES.
     time_horizon must be one of: immediate / today / this_week /
     next_review_cycle / not_specified. Anything else is rejected.

A REPORT THAT SKIPS A HIGH-CRITICALITY SECTION'S RECOMMENDATION WILL
BE LABELED unsafe_incomplete_coverage AND CAPPED TO confidence=medium.
A REPORT WITH AN UNVERIFIED NUMBER NEAR A HIGH-CRITICALITY SECTION
WILL BE LABELED unsafe_unsupported_claims_with_high_severity.
THE OPERATOR WILL SEE THE FAILURE LABEL.

Submit only after this checklist passes.`,

  // -------------------------------------------------------------------
  // BUILD USER MESSAGE
  // -------------------------------------------------------------------
  buildUserMessage: (input, verified) => {
    const runIdShown = input?.run_id ?? '(unspecified)';

    if (!verified) {
      return `Report explanation request — run_id ${runIdShown}\n\n(verified data unavailable — submit with empty fields)`;
    }

    const sectionBlocks = (verified.sections || []).map((s) => {
      const kpiLines = (s.kpis || []).map((k) =>
        `      - ${k.id}: ${k.value} (${k.unit}; ${k.label_he})`
      ).join('\n');
      const rowLines = (s.rows || []).length === 0 ? '' : '\n    rows:\n' + (s.rows || []).map((r) =>
        `      - ${r.reason_code} (${r.reason_label_he}): count=${r.count}, pct=${r.pct}, stops=${JSON.stringify(r.stop_ids)}, customers=${JSON.stringify(r.customer_names)}`
      ).join('\n');
      const recLines = (s.records || []).length === 0 ? '' : '\n    records:\n' + (s.records || []).map((rec) => {
        const props = Object.entries(rec)
          .filter(([k]) => k !== 'engine_criticality')
          .map(([k, v]) => `        ${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
          .join('\n');
        return `      - record_id: ${rec.record_id} [engine_criticality=${rec.engine_criticality}]\n${props}`;
      }).join('\n');

      return `  • SECTION ${s.id}  [${s.criticality}/${s.kind}]
    label_he: ${s.label_he}
    criticality_reason: ${s.criticality_reason}
    kpis:
${kpiLines}${rowLines}${recLines}
    source: ${s.source}`;
    }).join('\n\n');

    const summary = verified.summary || {};
    const warnLines = (verified.warnings || []).length === 0
      ? '  (none)'
      : verified.warnings.map((w) => `  - ${w.code}: ${w.message}${w.source ? ` (${w.source})` : ''}`).join('\n');

    return `Report explanation request — run_id ${runIdShown}.

================================================================
SUBJECT
================================================================
  kind:        ${verified.subject?.kind}
  run_id:      ${verified.subject?.run_id}
  run_number:  ${verified.subject?.run_number}
  run_date:    ${verified.subject?.run_date}
  driver:      ${verified.subject?.driver_name} (id=${verified.subject?.driver_id})
  status:      ${verified.subject?.status}

================================================================
VERIFIED SECTIONS (computed by code; treat as authoritative)
================================================================
${sectionBlocks || '  (no sections)'}

================================================================
SUMMARY (computed by code)
================================================================
  total_sections:                ${summary.total_sections ?? 0}
  by_criticality:                ${JSON.stringify(summary.by_criticality || {})}
  computed_overall_criticality:  ${summary.computed_overall_criticality}

================================================================
WARNINGS
================================================================
${warnLines}

================================================================
META
================================================================
  computed_at:        ${verified.meta?.computed_at}
  report_version:     ${verified.meta?.report_version}
  sources_returning:  ${JSON.stringify(verified.meta?.sources_returning_data || [])}
  sources_missing:    ${JSON.stringify(verified.meta?.sources_missing || [])}

================================================================
ALLOWED time_horizon values (use canonical_id only)
================================================================
${timeHorizonChoicesForPrompt()}

================================================================
COVERAGE POLICY (deterministic, code-enforced)
================================================================
${reportCoveragePolicyForPrompt()}

================================================================
YOUR TASK
================================================================
Submit via submit_report_explanation.

  - ONE section_explanation per verified section above.
  - For each high-criticality SECTION and high-engine_criticality RECORD:
    submit a flagged_record_explanation AND at least one recommendation
    whose supporting_id points to the section_id or record_id.
  - Optionally add cross_section_themes connecting 2+ sections.
  - Provide an executive_summary that respects engine criticality.
  - Provide a prioritization_note recommending which section to address
    first (by engine criticality).

If a source is missing, say "מקור לא זמין" — do not extrapolate.
If unsure of the right time_horizon, use "not_specified".

REMEMBER:
  - causality is allowed ONLY when supported by an in-sentence verified
    id OR a verbatim failure_reason_label_he quote;
  - failure_reason_label_he must be quoted EXACTLY (no paraphrase).
`;
  },

  // -------------------------------------------------------------------
  // NO DATA TOOLS — all data is in the user message
  // -------------------------------------------------------------------
  tools: [],

  // -------------------------------------------------------------------
  // SUBMIT TOOL — narrative-only schema
  // -------------------------------------------------------------------
  submitTool: {
    name: 'submit_report_explanation',
    description: 'Submit the report NARRATIVE. Verified sections, KPIs, records, criticality come from runtime — you only explain.',
    input_schema: {
      type: 'object',
      properties: {
        executive_summary: {
          type: 'string',
          description: 'Hebrew, ≤120 words. References report_id and the overall criticality.',
        },
        section_explanations: {
          type: 'array',
          description: 'ONE entry per verified section_id. Cover every section.',
          items: {
            type: 'object',
            properties: {
              section_id:       { type: 'string', description: 'MUST be one of verified.sections[*].id.' },
              narrative:        { type: 'string', description: 'Hebrew, ≤80 words. Cite at least one in-section id.' },
              key_observations: {
                type: 'array',
                description: '≤3 short bullets. Each must cite a KPI id or record_id from this section.',
                items: { type: 'string' },
                minItems: 1,
              },
            },
            required: ['section_id', 'narrative', 'key_observations'],
          },
        },
        flagged_record_explanations: {
          type: 'array',
          description: 'ONE entry per high-engine_criticality record. May include medium-criticality records.',
          items: {
            type: 'object',
            properties: {
              record_id:               { type: 'string', description: 'MUST be one of verified.sections[*].records[*].record_id.' },
              operational_meaning:     { type: 'string', description: 'Hebrew, ≤40 words.' },
              failure_reason_label_he: { type: 'string', description: 'OPTIONAL. If included, MUST EXACTLY match verified.records[*].failure_reason_label_he.' },
            },
            required: ['record_id', 'operational_meaning'],
          },
        },
        cross_section_themes: {
          type: 'array',
          description: 'OPTIONAL. Themes connecting 2+ sections.',
          items: {
            type: 'object',
            properties: {
              title:       { type: 'string', description: 'Hebrew, ≤8 words.' },
              description: { type: 'string', description: 'Hebrew, ≤40 words.' },
              section_ids: { type: 'array', items: { type: 'string' }, minItems: 2 },
            },
            required: ['title', 'description', 'section_ids'],
          },
        },
        recommendations: {
          type: 'array',
          description: 'Structured actions. ≥1 per high-criticality section.',
          items: {
            type: 'object',
            properties: {
              owner:         { type: 'string', description: 'Hebrew. Function/role responsible.' },
              target:        { type: 'string', description: 'Specific entity targeted.' },
              action:        { type: 'string', description: 'Hebrew, ≤30 words. Concrete directive.' },
              supporting_id: { type: 'string', description: 'section_id, record_id, or KPI id from verified data.' },
              time_horizon:  { type: 'string', enum: ALLOWED_TIME_HORIZON_IDS, description: 'Canonical time horizon.' },
            },
            required: ['owner', 'target', 'action', 'supporting_id', 'time_horizon'],
          },
        },
        prioritization_note: {
          type: 'string',
          description: 'Hebrew, 1-2 sentences. Which section to address first, respecting engine criticality.',
        },
      },
      required: [
        'executive_summary',
        'section_explanations',
        'flagged_record_explanations',
        'recommendations',
        'prioritization_note',
      ],
    },
  },
};

// =====================================================================
// EXPERIMENT 4 — Sales insights assistant
// Goal: week-over-week change analysis over top items.
// =====================================================================
export const salesInsights = {
  name: 'salesInsights',
  description: 'Week-over-week sales insights. Names specific items + customers.',
  estimated_cost_per_run_usd: 0.06,
  systemPrompt: `You produce a sales-insights report comparing the last 7 days
to the prior 7 days. Cite specific items by code/name and customers by name.
Do NOT invent trends; only mention changes the data clearly shows.

Output structure:
- Top 3 risers (item/customer + delta)
- Top 3 fallers (item/customer + delta)
- 1-2 specific actionable observations

Length: ≤200 words.`,
  buildUserMessage: (input) => `Compare last 7 days vs prior 7 days.`,
  tools: [tool('get_top_items'), tool('get_top_customers'), tool('get_daily_sales')],
  submitTool: null,
};

// =====================================================================
// EXPERIMENT 4 — Operator Review Assistant (verified-data + workflow)
//
// Architecture: docs/architecture-review/experiment-4-operator-review-architecture.md
// Implementation summary: docs/architecture-review/experiment-4-implementation-summary.md
//
// Flow:
//   1. preCompute() → computeReviewCase() — deterministic case construction
//      - Reuses verifiedReport for the underlying delivery-run context
//      - Builds engine_risk_flags (deterministic, NOT LLM)
//      - Sets initial review_state = 'pending_review' (engine actor)
//      - Sets escalation metadata via deterministic VIP / dual-review rules
//      - audit_log[0] = case_created (engine actor)
//
//   2. buildUserMessage() embeds the verified case in the prompt:
//      - subject + verified_context (sections, KPIs, records)
//      - verified_risk_flags (engine-flagged risks)
//      - decision_options (closed enum, with elevation + required inputs)
//      - escalation metadata (already-active triggers)
//      - audit log so far (case_created)
//      - workflow policy (state machine boundaries)
//
//   3. LLM submits NARRATIVE PACKET ONLY:
//      - case_summary (Hebrew)
//      - risk_flag_explanations (one per engine flag)
//      - decision_option_annotations (one per enum option, with applicability)
//      - escalation_recommendation (advisory; never authoritative)
//      - operator_attention_note (Hebrew)
//      LLM cannot output review_state, audit_log, or any decision.
//
//   4. postProcess():
//      - Inject verified case data (LLM cannot mutate)
//      - Validate annotations vs closed enum + supporting_id + required-input echo
//      - Validate risk_flag_explanations cover all high engine flags
//      - Run qualitative scans (trend / causal / urgency / time) reusing
//        sandboxPolicy + the case-level causal_safe_phrases
//      - Compute coverage / integrity / confidence / safety
//      - Set review_state DETERMINISTICALLY:
//          * 'unsafe_output' if integrity layer rejects packet
//          * 'pending_review' otherwise (default, engine-set was preserved)
//      - Append audit entry (postprocess actor): ai_packet_generated
//      - LLM is NEVER an audit-log actor in this output.
//
// The LLM is structurally incapable of:
//   - selecting a decision option
//   - mutating review_state
//   - writing to audit_log
//   - escalating (only recommending; policy engine triggers)
//   - bypassing dual-review
// =====================================================================
export const operatorReviewAssistant = {
  name: 'operatorReviewAssistant',
  description: 'Operator-review packet preparer — annotates closed-enum decision options. NEVER decides. NEVER executes.',
  estimated_cost_per_run_usd: 0.04,

  // Conservative cap; review packet is structured + bounded so 3500 fits.
  maxTokensOut: 3500,

  // -------------------------------------------------------------------
  // PRE-COMPUTE
  // -------------------------------------------------------------------
  preCompute: async (input) => {
    return computeReviewCase(input);
  },

  // -------------------------------------------------------------------
  // POST-PROCESS
  // -------------------------------------------------------------------
  postProcess: (llmOutput, verifiedCase) => {
    if (!verifiedCase) {
      return { ...llmOutput, _integrity_error: 'verified is null in postProcess' };
    }

    // ---- Defensive coercion ----------------------------------------
    const arr = (x) => Array.isArray(x) ? x : [];
    const narrative = (function normalize(obj) {
      if (!obj || typeof obj !== 'object') return {};
      const ARRAY_FIELDS = ['risk_flag_explanations', 'decision_option_annotations'];
      const out = { ...obj };
      const coercions = [];
      for (const k of ARRAY_FIELDS) {
        if (typeof out[k] === 'string') {
          try {
            const parsed = JSON.parse(out[k]);
            if (Array.isArray(parsed)) { out[k] = parsed; coercions.push(k); }
          } catch { /* leave as string */ }
        }
      }
      out.__schema_coercions = coercions;
      return out;
    })(llmOutput);

    // ---- Coverage evaluation (decision options + risk flags) -------
    const coverage = evaluateReviewCoverage(verifiedCase, narrative);

    // ---- Build value-set + qualitative scans -----------------------
    const valueSet = collectReviewCaseValueSet(verifiedCase);
    const verifiedHasHighRisk = (verifiedCase.verified_risk_flags || [])
      .some((f) => f.engine_criticality === 'high');

    // Combine ids: supporting_ids + decision-option ids + customer names + KPI ids
    const verifiedIdsForClassifier = new Set([...valueSet.strings]);

    const recText = (a) => {
      if (!a || typeof a !== 'object') return '';
      return [a.justification, a.option_id, a.supporting_id].filter(Boolean).join(' ');
    };

    const narrativeStrings = [
      narrative.case_summary,
      narrative.operator_attention_note,
      ...arr(narrative.risk_flag_explanations).map((r) => `${r?.explanation_he || r?.explanation || ''} ${r?.title_he || r?.title || ''}`),
      ...arr(narrative.decision_option_annotations).map(recText),
      narrative.escalation_recommendation?.reason || '',
    ].filter(Boolean);

    const trend_claims = [];
    const causality_claims = [];
    const urgency_claims_unsupported = [];
    const invented_time_horizons = [];
    for (const s of narrativeStrings) {
      const c = classifyNarrativeText(
        s,
        verifiedIdsForClassifier,
        verifiedHasHighRisk,
        { causal_safe_phrases: valueSet.causal_safe_phrases }
      );
      trend_claims.push(...c.trend_claims);
      causality_claims.push(...c.causality_claims);
      urgency_claims_unsupported.push(...c.urgency_claims);
      invented_time_horizons.push(...c.invented_time_horizons);
    }

    // ---- Free-floating-number scan ---------------------------------
    const unverified_numbers_in_text = [];
    for (const s of narrativeStrings) {
      const hits = findUnverifiedNumbers(s, valueSet.numbers, valueSet.strings);
      for (const h of hits) unverified_numbers_in_text.push(h);
    }

    // ---- Decide unsafe-claims path ---------------------------------
    const has_unsafe_claims = (
      trend_claims.length > 0 ||
      causality_claims.length > 0 ||
      invented_time_horizons.length > 0 ||
      unverified_numbers_in_text.length > 0
    );
    const unsafe_for_high = has_unsafe_claims && verifiedHasHighRisk;

    const sources_completeness = verifiedCase.meta?.sources_completeness ?? 0;

    // ---- Integrity components --------------------------------------
    const components = {
      coverage_failures:           coverage.coverage_failures.length === 0 ? 1 : 0,
      annotation_count_match:      coverage.enum_options_count === coverage.annotations_count ? 1 : 0.5,
      high_risks_explained:        coverage.high_risks_count === coverage.explained_risks_count ? 1 : 0,
      unverified_numbers:          unverified_numbers_in_text.length === 0 ? 1 : 0,
      trend_claims:                trend_claims.length === 0 ? 1 : 0,
      causality_claims:            causality_claims.length === 0 ? 1 : 0,
      invented_time_horizons:      invented_time_horizons.length === 0 ? 1 : 0,
      urgency_claims_unsupported:  urgency_claims_unsupported.length === 0 ? 1 : 0.5,
      validation_errors:           (verifiedCase.errors || []).length === 0 ? 1 : 0,
    };
    const integrity_score = Object.values(components).reduce((a, b) => a + b, 0) / Object.keys(components).length;

    // ---- Confidence -----------------------------------------------
    let overall_confidence;
    if (unsafe_for_high) {
      overall_confidence = (integrity_score >= 0.6 && sources_completeness >= 0.7) ? 'medium' : 'low';
    } else if (sources_completeness >= 0.9 && integrity_score >= 0.9) {
      overall_confidence = 'high';
    } else if (sources_completeness >= 0.7 && integrity_score >= 0.7) {
      overall_confidence = 'medium';
    } else {
      overall_confidence = 'low';
    }
    overall_confidence = applyConfidenceCap(overall_confidence, coverage.enforcement.cap_confidence_to);

    // ---- Safety label cascade --------------------------------------
    let safety_label;
    if (coverage.enforcement.fail_closed) {
      safety_label = REVIEW_COVERAGE_LABELS.FAIL_CLOSED;
    } else if (unsafe_for_high) {
      safety_label = 'unsafe_unsupported_claims_with_high_severity';
    } else if (coverage.coverage_safety_label === REVIEW_COVERAGE_LABELS.UNSAFE_INCOMPLETE) {
      safety_label = REVIEW_COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    } else if (has_unsafe_claims) {
      safety_label = 'caution_qualitative_claims_unsupported';
    } else {
      safety_label = 'safe';
    }

    const fail_closed = coverage.enforcement.fail_closed;

    // ---- DETERMINISTIC review_state assignment ---------------------
    // The LLM cannot mutate review_state. Only this block can set it,
    // based purely on the integrity verdict.
    let final_review_state = verifiedCase.review_state;  // engine-set default = pending_review
    if (fail_closed) {
      final_review_state = REVIEW_STATES.UNSAFE_OUTPUT;
    }
    // Else: stays at pending_review. Operator action is the next state mutation.

    // ---- Audit append (postprocess actor; NEVER 'ai') --------------
    const audit_log = appendAudit(verifiedCase.audit_log, {
      ts: new Date().toISOString(),
      actor: 'postprocess',
      event: 'ai_packet_generated',
      details: {
        safety: safety_label,
        confidence: overall_confidence,
        integrity_score: Number(integrity_score.toFixed(2)),
        coverage_failures_count: coverage.coverage_failures.length,
        review_state: final_review_state,
        fail_closed,
      },
    });

    // ---- Safety explanation ---------------------------------------
    const safety_explanation = (() => {
      if (fail_closed) {
        if (coverage.coverage_failures.includes('empty_annotations_with_options')) {
          return 'FAIL CLOSED: LLM submitted zero annotations while decision options exist. Silent omission of operator review preparation.';
        }
        const missingHigh = coverage.coverage_failures.filter((c) => c.startsWith('missing_high_risk:'));
        if (missingHigh.length) {
          return `FAIL CLOSED: ${missingHigh.length} high-criticality risk(s) not surfaced by AI. The operator would not see them. DO NOT use this packet.`;
        }
        return 'FAIL CLOSED: coverage policy violated.';
      }
      if (unsafe_for_high) {
        const reasons = [];
        if (trend_claims.length)            reasons.push(`${trend_claims.length} trend claim(s)`);
        if (causality_claims.length)        reasons.push(`${causality_claims.length} unsupported causal claim(s)`);
        if (invented_time_horizons.length)  reasons.push(`${invented_time_horizons.length} invented deadline(s)`);
        if (unverified_numbers_in_text.length) reasons.push(`${unverified_numbers_in_text.length} unverified number(s)`);
        return `Output contains unsupported claims (${reasons.join('; ')}) AND a high-criticality risk exists. Operator should treat the packet as advisory only and verify against verified_context.`;
      }
      if (safety_label === REVIEW_COVERAGE_LABELS.UNSAFE_INCOMPLETE) {
        return `Coverage gaps detected: ${coverage.coverage_failures.slice(0, 4).join('; ')}${coverage.coverage_failures.length > 4 ? '…' : ''}. Operator should verify each decision option independently.`;
      }
      if (has_unsafe_claims)
        return 'Output contains unsupported qualitative claims; treat narrative as advisory only.';
      return 'Packet passed all integrity and coverage scans. Awaiting operator review.';
    })();

    // ---- Compose final operator-facing output ---------------------
    return {
      case_id:           verifiedCase.case_id,
      case_kind:         verifiedCase.case_kind,
      case_version:      verifiedCase.case_version,
      subject:           verifiedCase.subject,
      verified_context:  verifiedCase.verified_context,
      verified_risk_flags: verifiedCase.verified_risk_flags,
      decision_options:  verifiedCase.decision_options,
      escalation:        verifiedCase.escalation,

      // ── DETERMINISTIC, code-owned fields (LLM cannot mutate) ──
      review_state:      final_review_state,
      audit_log,
      fail_closed,

      // ── LLM-produced narrative ──
      narrative: {
        case_summary:                  narrative.case_summary || null,
        risk_flag_explanations:        arr(narrative.risk_flag_explanations),
        decision_option_annotations:   arr(narrative.decision_option_annotations),
        escalation_recommendation:     narrative.escalation_recommendation || null,
        operator_attention_note:       narrative.operator_attention_note || null,
      },

      coverage: {
        coverage_failures:        coverage.coverage_failures,
        coverage_safety_label:    coverage.coverage_safety_label,
        enum_options_count:       coverage.enum_options_count,
        annotations_count:        coverage.annotations_count,
        high_risks_count:         coverage.high_risks_count,
        explained_risks_count:    coverage.explained_risks_count,
        applied_policy:           coverage.applied_policy,
      },
      integrity: {
        unverified_numbers_in_text,
        trend_claims,
        causality_claims,
        urgency_claims_unsupported,
        invented_time_horizons,
        validation_errors:    verifiedCase.errors || [],
        sources_completeness,
        integrity_score:      Number(integrity_score.toFixed(2)),
        integrity_components: Object.fromEntries(
          Object.entries(components).map(([k, v]) => [k, Number(v.toFixed(2))])
        ),
        schema_coercions:     narrative.__schema_coercions || [],
      },
      confidence: {
        overall: overall_confidence,
        computed_from: 'sources_completeness + integrity_score, capped by review coverage policy (deterministic, NOT LLM-claimed)',
        coverage_cap_applied: coverage.enforcement.cap_confidence_to,
      },
      safety: {
        label: safety_label,
        fail_closed,
        unsafe_for_high_severity: unsafe_for_high,
        explanation: safety_explanation,
      },
    };
  },

  // -------------------------------------------------------------------
  // SYSTEM PROMPT
  // -------------------------------------------------------------------
  systemPrompt: `You are an OPERATOR REVIEW ASSISTANT for an Israeli logistics company.

YOUR JOB: prepare a structured review packet for a human operator to
review a delivery-run case. You annotate closed-enum decision options,
explain engine-flagged risks, and recommend (advisory only) whether to
escalate. The OPERATOR decides; you do not.

YOUR NON-JOB: making decisions, executing actions, transitioning case
state, marking cases resolved, escalating (only recommending), creating
new options, or generating authoritative strategy.

================================================================
ABSOLUTE RULES — every violation is a failed experiment
================================================================

1. **NEVER PICK A DECISION.** Your job is to annotate every option in
   the closed enum. The operator chooses. You may rate "applicability"
   (likely_relevant / marginally_relevant / not_applicable / ai_uncertain)
   but you may not say "operator should do X".

2. **NEVER MUTATE STATE.** review_state, audit_log, escalation triggers,
   and case resolution are owned by code. You do not output any of them.

3. **ENUM ONLY.** decision_option_annotations[].option_id must match
   one of the enum ids listed in the user message. Inventing an option
   is FAIL_CLOSED.

4. **EVERY OPTION ANNOTATED.** ONE entry per enum option, even
   "not_applicable" with reason. Missing options → unsafe.

5. **EVERY HIGH RISK SURFACED.** ONE risk_flag_explanation per
   engine-flagged risk with engine_criticality=high. Missing high risks
   → FAIL_CLOSED.

6. **NO INVENTED NUMBERS.** Every number must come from verified_context
   (KPI value, threshold, record field, summary count) or be omitted.

7. **NO TREND CLAIMS.** Single-case analysis. No "מגמה", "trend",
   "increasing", "week-over-week".

8. **CAUSALITY RESTRICTED.** A causal sentence ("נובע", "כתוצאה",
   "caused by", "due to") is allowed ONLY when the same sentence
   references a verified id OR verbatim-quotes a failure_reason_label_he
   string from verified_context. Inferred causes are FORBIDDEN.

9. **NO INVENTED DEADLINES.** Free-text "תוך 6 חודשים" / "within 90
   days" forbidden. Recommendation deadlines are NOT in your schema.

10. **CITE SUPPORTING_ID.** Every annotation and risk explanation MUST
    have a supporting_id pointing to a verified id from the case
    (case_id, run_number, section_id, KPI id, record_id, customer_name,
    risk_flag_id, or decision_option_id).

11. **ECHO REQUIRED INPUTS.** For each annotation, list the
    required_operator_inputs from the policy (echoed verbatim).

12. **APPLICABILITY ENUM.** Use only:
      likely_relevant
      marginally_relevant
      not_applicable
      ai_uncertain

13. **ESCALATION IS ADVISORY.** You may include escalation_recommendation
    with should_consider_escalation + reason + target_role
    (dispatcher | manager | compliance | dual_review). The policy engine
    decides whether actual escalation occurs. Use this field only when
    verified data warrants it; missing it is fine for routine cases.

14. **NO PRESSURE.** Do not write "the operator should clearly choose X".
    Annotation is informational. Operator authority is absolute within
    policy bounds.

15. **HEBREW for human-facing strings.** English for machine IDs.

16. **NO DATA TOOLS.** All data is in the user message. Submit via
    submit_review_packet immediately.

================================================================
SAFETY LABEL
================================================================
The output is post-processed and labeled. Possible labels:
  fail_closed_silent_omission              — coverage gap; do not act
  unsafe_unsupported_claims_with_high_severity — qualitative + high risk
  unsafe_incomplete_coverage               — partial; medium confidence
  caution_qualitative_claims_unsupported   — advisory only
  safe                                     — passed all scans

review_state will be set deterministically:
  pending_review (success path)
  unsafe_output (fail_closed path)

The operator owns the next transition.

================================================================
FINAL CHECK BEFORE SUBMITTING
================================================================
1. Did you annotate EVERY enum decision_option? (count must match)
2. Did you explain EVERY high-criticality verified_risk_flag? (count
   must match high-risk count)
3. Did each annotation cite a real supporting_id?
4. Did each annotation echo the required_operator_inputs list?
5. Did you avoid trend / causal / invented-deadline language?
6. Did you avoid picking a winner among options?

If any answer is "no", revise before submitting.`,

  // -------------------------------------------------------------------
  // BUILD USER MESSAGE
  // -------------------------------------------------------------------
  buildUserMessage: (input, verifiedCase) => {
    const runIdShown = input?.run_id ?? '(unspecified)';
    if (!verifiedCase) {
      return `Operator review packet request — run_id ${runIdShown}\n\n(verified data unavailable — submit with empty fields)`;
    }
    if (verifiedCase.review_state === REVIEW_STATES.INSUFFICIENT_DATA) {
      return `Operator review packet request — run_id ${runIdShown}\n\nEngine produced insufficient data; LLM should not be called. (Visible only as a defensive trace.)`;
    }

    const riskBlocks = (verifiedCase.verified_risk_flags || []).map((f) =>
      `  - ${f.id} [${f.engine_criticality}] supporting=${f.supporting_id}\n    ${f.title_he || f.id}: ${f.explanation_he || ''}`
    ).join('\n');

    const optBlocks = (verifiedCase.decision_options || []).map((o) =>
      `  - ${o.id}\n      label_he:                  ${o.label_he}\n      elevation:                 ${o.elevation}\n      requires_operator_input:   ${JSON.stringify(o.requires_operator_input)}`
    ).join('\n');

    const auditLines = (verifiedCase.audit_log || []).map((a) =>
      `  - [${a.ts}] actor=${a.actor} event=${a.event} ${JSON.stringify(a.details).slice(0, 200)}`
    ).join('\n');

    const reportSummary = (() => {
      const r = verifiedCase.verified_context;
      if (!r || !Array.isArray(r.sections)) return '  (no verified report)';
      return r.sections.map((s) => {
        const kpis = (s.kpis || []).map((k) => `${k.id}=${k.value}`).join(', ');
        return `  - section ${s.id} [${s.criticality}]: ${kpis}`;
      }).join('\n');
    })();

    return `Operator review packet request — run_id ${runIdShown}.

================================================================
CASE IDENTITY (deterministic; engine-owned)
================================================================
  case_id:           ${verifiedCase.case_id}
  case_kind:         ${verifiedCase.case_kind}
  case_version:      ${verifiedCase.case_version}
  review_state:      ${verifiedCase.review_state}    ← code-owned; you cannot change this
  elevation:         ${verifiedCase.escalation?.elevation_required}
  triggers_active:   ${JSON.stringify(verifiedCase.escalation?.triggers_active || [])}

================================================================
SUBJECT
================================================================
  kind:        ${verifiedCase.subject?.kind}
  run_id:      ${verifiedCase.subject?.run_id}
  run_number:  ${verifiedCase.subject?.run_number}
  run_date:    ${verifiedCase.subject?.run_date}
  driver:      ${verifiedCase.subject?.driver_name} (id=${verifiedCase.subject?.driver_id})
  status:      ${verifiedCase.subject?.status}

================================================================
VERIFIED CONTEXT (delivery-run sections — see Exp 3 architecture)
================================================================
${reportSummary}

================================================================
ENGINE RISK FLAGS (deterministic — annotate every high one)
================================================================
${riskBlocks || '  (no engine risk flags)'}

================================================================
DECISION OPTIONS (closed enum — annotate EVERY one)
================================================================
${optBlocks || '  (no options)'}

================================================================
AUDIT LOG (read-only)
================================================================
${auditLines}

================================================================
WORKFLOW POLICY (deterministic, code-enforced)
================================================================
${reviewPolicyForPrompt(verifiedCase.case_kind)}

================================================================
ALLOWED applicability values
================================================================
      ${APPLICABILITY_VALUES.join(' | ')}

================================================================
ALLOWED escalation target_role values
================================================================
      ${ESCALATION_TARGET_ROLES.join(' | ')}

================================================================
YOUR TASK
================================================================
Submit via submit_review_packet:

  - case_summary (Hebrew, ≤120 words; cite case_id and overall risk).
  - risk_flag_explanations[]: ONE per engine risk flag (especially every
    high-criticality flag — missing one is FAIL_CLOSED).
  - decision_option_annotations[]: ONE per decision_option above. Each
    with applicability, justification (cite supporting_id), and the
    required_operator_inputs ECHOED from policy.
  - escalation_recommendation: optional. Advisory only.
  - operator_attention_note (Hebrew, 1-2 sentences).

NEVER:
  - select an option as "the right one"
  - mutate review_state, audit_log, escalation triggers
  - invent numbers, deadlines, sections, risk flags, options
  - fabricate causality (only verbatim failure_reason_label_he or
    in-sentence verified id allowed)`;
  },

  // -------------------------------------------------------------------
  // NO DATA TOOLS — the LLM has no way to reach SAP, no way to mutate
  // anything, no way to trigger escalation. All data is in the user message.
  // -------------------------------------------------------------------
  tools: [],

  // -------------------------------------------------------------------
  // SUBMIT TOOL — narrative-only schema; NO state, NO decision, NO audit
  // -------------------------------------------------------------------
  submitTool: {
    name: 'submit_review_packet',
    description: 'Submit the operator review packet. NO decision, NO state mutation, NO audit. Code owns those.',
    input_schema: {
      type: 'object',
      properties: {
        case_summary: {
          type: 'string',
          description: 'Hebrew, ≤120 words. Cite case_id and overall risk picture.',
        },
        risk_flag_explanations: {
          type: 'array',
          description: 'ONE per engine risk_flag. Cover every high-criticality flag.',
          items: {
            type: 'object',
            properties: {
              id:            { type: 'string', description: 'MUST match a verified_risk_flags[*].id from the case.' },
              title:         { type: 'string', description: 'Hebrew, ≤8 words.' },
              explanation:   { type: 'string', description: 'Hebrew, ≤40 words. Operator-readable.' },
              supporting_id: { type: 'string', description: 'KPI id, record_id, or risk_id supporting the explanation.' },
            },
            required: ['id', 'title', 'explanation', 'supporting_id'],
          },
        },
        decision_option_annotations: {
          type: 'array',
          description: 'ONE per decision_option in the closed enum. Operator picks; you annotate.',
          items: {
            type: 'object',
            properties: {
              option_id:     { type: 'string', description: 'MUST match a decision_options[*].id from the case.' },
              applicability: { type: 'string', enum: APPLICABILITY_VALUES, description: 'Your assessment of relevance — NOT a decision.' },
              justification: { type: 'string', description: 'Hebrew, ≤30 words. Cite supporting_id.' },
              supporting_id: { type: 'string', description: 'Verified id supporting the assessment.' },
              required_operator_inputs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Echo the required_operator_inputs from policy for this option.',
              },
            },
            required: ['option_id', 'applicability', 'justification', 'supporting_id', 'required_operator_inputs'],
          },
        },
        escalation_recommendation: {
          type: 'object',
          description: 'OPTIONAL advisory. Policy engine decides actual escalation.',
          properties: {
            should_consider_escalation: { type: 'boolean' },
            reason:                     { type: 'string', description: 'Hebrew, ≤30 words. Cite supporting_id.' },
            target_role:                { type: 'string', enum: ESCALATION_TARGET_ROLES },
          },
        },
        operator_attention_note: {
          type: 'string',
          description: 'Hebrew, 1-2 sentences. What does the operator most need to notice before deciding?',
        },
      },
      required: [
        'case_summary',
        'risk_flag_explanations',
        'decision_option_annotations',
        'operator_attention_note',
      ],
    },
  },
};

// =====================================================================
// Registry export
// =====================================================================
export const allAgents = {
  ceoBrief,
  anomalySummary,
  reportExplainer,
  salesInsights,
  operatorReviewAssistant,
};

export function listAgents() {
  return Object.entries(allAgents).map(([name, agent]) => ({
    name,
    description: agent.description,
    tools: agent.tools.map((t) => t.name),
    estimated_cost_per_run_usd: agent.estimated_cost_per_run_usd,
    submitTool: agent.submitTool ? agent.submitTool.name : null,
  }));
}
