// =====================================================================
// coveragePolicy.js — deterministic coverage enforcement for executive
// interpretation outputs.
//
// Premise: in executive-facing systems, omission risk is operationally
// equivalent to fabrication risk. A summary that silently drops a
// high-severity anomaly is not "safer than" a summary that invents a
// number — the operator just doesn't know what they don't know.
//
// This module owns the policy and the evaluator. Both are deterministic.
// The LLM cannot influence what counts as "covered".
//
// Sandbox-only. No production runtime, no autonomous execution.
//
// See: docs/architecture-review/experiment-2-coverage-hardening.md
// =====================================================================

// =====================================================================
// Policy. Locked in code. Changing any value here requires a code change
// + a re-validation pass (analogous to DETECTOR_VERSION discipline in
// verifiedAnomalies.js).
// =====================================================================
export const COVERAGE_POLICY = Object.freeze({
  // Fraction of anomalies of a given severity that MUST be covered.
  // 1.0 = every anomaly of that severity must have an interpretation
  //       AND a structured recommended_action.
  required_coverage_by_severity: Object.freeze({
    high:   1.0,
    medium: 1.0,
    low:    0.5,
  }),

  // Each interpretation MUST include a structured recommended_action
  // (object with owner / target / action / supporting_id / time_horizon),
  // not a legacy free-text string.
  require_structured_recommendation: true,

  // If verified anomalies exist AND the LLM submits zero interpretations,
  // the run is rejected outright. This is the silent-omission case.
  fail_on_empty_interpretations_when_anomalies_exist: true,

  // If ANY high-severity anomaly is uncovered, the run is rejected.
  // (1.0 required coverage on high already captures this; the explicit
  // flag is for clarity in the failure code.)
  fail_on_uncovered_high_severity: true,

  // Whether non-structured (string) recommended_action triggers a
  // coverage failure even if the anomaly_id is present.
  fail_on_non_structured_recommendation: true,
});

// =====================================================================
// Coverage safety labels (severity-ordered, worst-first)
// =====================================================================
export const COVERAGE_LABELS = Object.freeze({
  FAIL_CLOSED:          'fail_closed_silent_omission',
  UNSAFE_INCOMPLETE:    'unsafe_incomplete_coverage',
  PARTIAL_LOW_UNCOVERED: 'partial_low_severity_uncovered',
  COMPLETE:             'complete',
});

// =====================================================================
// evaluateCoverage(verified, narrative)
//
// Inputs:
//   verified.anomalies — deterministic engine output (id, severity, ...)
//   narrative.anomaly_interpretations — what the LLM submitted
//
// Returns:
//   {
//     ratio,                          // overall coverage fraction
//     total_anomalies,
//     total_interpreted,
//     uncovered_anomaly_ids,          // all uncovered ids
//     uncovered_by_severity:          // breakdown: { high: [], medium: [], low: [] }
//     uncovered_high_severity_ids,    // convenience alias for uncovered_by_severity.high
//     missing_recommendation_ids,     // covered by interpretation but missing structured rec
//     non_structured_recommendation_ids, // legacy string rec
//     coverage_failures,              // failure codes
//     coverage_safety_label,          // one of COVERAGE_LABELS
//     applied_policy,                 // snapshot of policy used (for audit)
//     enforcement: {
//       fail_closed: boolean,         // if true, downstream MUST treat output as unsafe
//       cap_confidence_to: 'medium' | null,
//     }
//   }
// =====================================================================
export function evaluateCoverage(verified, narrative) {
  const anomalies = (verified && Array.isArray(verified.anomalies)) ? verified.anomalies : [];
  const interps = (narrative && Array.isArray(narrative.anomaly_interpretations))
    ? narrative.anomaly_interpretations : [];

  const total_anomalies = anomalies.length;
  const total_interpreted = interps.length;

  // Index interpretations by anomaly_id (last write wins for duplicates;
  // post-processor should already have deduped — defensive).
  const interpById = new Map();
  for (const it of interps) {
    if (it && typeof it.anomaly_id === 'string') interpById.set(it.anomaly_id, it);
  }

  // Build uncovered + structure-missing lists, broken down by severity.
  const uncovered_by_severity = { high: [], medium: [], low: [] };
  const uncovered_anomaly_ids = [];
  const missing_recommendation_ids = [];
  const non_structured_recommendation_ids = [];

  for (const a of anomalies) {
    const it = interpById.get(a.id);
    const sev = (a.severity in uncovered_by_severity) ? a.severity : 'low';

    if (!it) {
      uncovered_by_severity[sev].push(a.id);
      uncovered_anomaly_ids.push(a.id);
      continue;
    }

    const rec = it.recommended_action;
    if (rec === undefined || rec === null) {
      missing_recommendation_ids.push(a.id);
    } else if (typeof rec === 'string') {
      // Legacy free-text recommendation — counted as non-structured
      if (COVERAGE_POLICY.require_structured_recommendation) {
        non_structured_recommendation_ids.push(a.id);
      }
    } else if (typeof rec === 'object') {
      const required = ['owner', 'target', 'action', 'supporting_id', 'time_horizon'];
      const allPresent = required.every((k) => {
        const v = rec[k];
        return v !== undefined && v !== null && String(v).trim().length > 0;
      });
      if (!allPresent) missing_recommendation_ids.push(a.id);
    } else {
      missing_recommendation_ids.push(a.id);
    }
  }

  const ratio = total_anomalies === 0 ? 1
              : Number(((total_anomalies - uncovered_anomaly_ids.length) / total_anomalies).toFixed(4));

  // ---- Failure codes -----------------------------------------------
  const coverage_failures = [];

  if (total_anomalies > 0 && total_interpreted === 0
      && COVERAGE_POLICY.fail_on_empty_interpretations_when_anomalies_exist) {
    coverage_failures.push('empty_interpretations_with_verified_anomalies');
  }

  for (const id of uncovered_by_severity.high) {
    coverage_failures.push(`uncovered_high_severity:${id}`);
  }
  for (const id of uncovered_by_severity.medium) {
    coverage_failures.push(`uncovered_medium_severity:${id}`);
  }
  // Low: only fail if below threshold ratio
  const low_total = anomalies.filter((a) => a.severity === 'low').length;
  if (low_total > 0) {
    const low_uncovered = uncovered_by_severity.low.length;
    const low_ratio = (low_total - low_uncovered) / low_total;
    if (low_ratio < COVERAGE_POLICY.required_coverage_by_severity.low) {
      coverage_failures.push(
        `low_severity_coverage_below_threshold:${low_ratio.toFixed(2)}<${COVERAGE_POLICY.required_coverage_by_severity.low}`
      );
    }
  }

  for (const id of missing_recommendation_ids) {
    coverage_failures.push(`missing_recommendation:${id}`);
  }
  if (COVERAGE_POLICY.fail_on_non_structured_recommendation) {
    for (const id of non_structured_recommendation_ids) {
      coverage_failures.push(`non_structured_recommendation:${id}`);
    }
  }

  // ---- Determine safety label + enforcement ------------------------
  // Priority (worst → best):
  //   FAIL_CLOSED         (silent omission of high severity OR empty array)
  //   UNSAFE_INCOMPLETE   (uncovered medium / missing rec / non-structured rec)
  //   PARTIAL_LOW_UNCOVERED (only low severity gaps, but within policy)
  //   COMPLETE
  let coverage_safety_label = COVERAGE_LABELS.COMPLETE;
  let fail_closed = false;
  let cap_confidence_to = null;

  // FAIL_CLOSED conditions
  if (
    coverage_failures.some((c) => c === 'empty_interpretations_with_verified_anomalies') ||
    coverage_failures.some((c) => c.startsWith('uncovered_high_severity:'))
  ) {
    coverage_safety_label = COVERAGE_LABELS.FAIL_CLOSED;
    fail_closed = true;
    cap_confidence_to = 'low'; // fail-closed forces low
  }
  // UNSAFE_INCOMPLETE conditions (only if not already fail_closed)
  else if (
    coverage_failures.some((c) => c.startsWith('uncovered_medium_severity:')) ||
    coverage_failures.some((c) => c.startsWith('missing_recommendation:')) ||
    coverage_failures.some((c) => c.startsWith('non_structured_recommendation:')) ||
    coverage_failures.some((c) => c.startsWith('low_severity_coverage_below_threshold:'))
  ) {
    coverage_safety_label = COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    cap_confidence_to = 'medium';
  }
  // PARTIAL_LOW_UNCOVERED — some low uncovered but within policy threshold
  else if (uncovered_by_severity.low.length > 0) {
    coverage_safety_label = COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED;
    cap_confidence_to = 'medium';
  }
  // else COMPLETE — no cap

  return {
    ratio,
    total_anomalies,
    total_interpreted,
    uncovered_anomaly_ids,
    uncovered_by_severity,
    uncovered_high_severity_ids: uncovered_by_severity.high.slice(),
    missing_recommendation_ids,
    non_structured_recommendation_ids,
    coverage_failures,
    coverage_safety_label,
    applied_policy: {
      required_coverage_by_severity: COVERAGE_POLICY.required_coverage_by_severity,
      require_structured_recommendation: COVERAGE_POLICY.require_structured_recommendation,
      fail_on_empty_interpretations_when_anomalies_exist:
        COVERAGE_POLICY.fail_on_empty_interpretations_when_anomalies_exist,
      fail_on_uncovered_high_severity: COVERAGE_POLICY.fail_on_uncovered_high_severity,
    },
    enforcement: { fail_closed, cap_confidence_to },
  };
}

// =====================================================================
// labelForCoverageInPrompt — used by buildUserMessage to show the
// coverage policy to the LLM, so it cannot claim ignorance later.
// =====================================================================
export function coveragePolicyForPrompt() {
  const p = COVERAGE_POLICY.required_coverage_by_severity;
  return [
    `      high severity:    ${(p.high * 100).toFixed(0)}% coverage required`,
    `      medium severity:  ${(p.medium * 100).toFixed(0)}% coverage required`,
    `      low severity:     ${(p.low * 100).toFixed(0)}% coverage required`,
    `      every interpretation MUST include a structured recommended_action`,
    `      empty anomaly_interpretations on a non-empty verified set → fail_closed`,
  ].join('\n');
}

// =====================================================================
// Helper: confidence-cap reconciliation. Given an existing computed
// confidence and a coverage cap, return the worse of the two.
// =====================================================================
const CONF_RANK = { high: 3, medium: 2, low: 1 };
export function applyConfidenceCap(currentConfidence, cap) {
  if (!cap) return currentConfidence;
  const cur = CONF_RANK[currentConfidence] ?? 0;
  const capRank = CONF_RANK[cap] ?? 0;
  return cur <= capRank ? currentConfidence : cap;
}
