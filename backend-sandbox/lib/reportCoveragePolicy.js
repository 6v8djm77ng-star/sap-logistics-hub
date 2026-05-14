// =====================================================================
// reportCoveragePolicy.js — deterministic coverage enforcement for
// the reportExplainer agent. Sister module to coveragePolicy.js
// (which serves anomalySummary).
//
// Premise (architecture §8): reports are presented as comprehensive
// operational documents. A missing section LOOKS like the system thinks
// the topic doesn't matter, even when the engine flagged it. That's a
// worse signal than a missing anomaly interpretation.
//
// Sandbox-only. No autonomous execution.
// =====================================================================

// =====================================================================
// Policy. Locked in code; analogous to COVERAGE_POLICY in
// coveragePolicy.js. Bumping any value requires re-validation.
// =====================================================================
export const REPORT_COVERAGE_POLICY = Object.freeze({
  // Section coverage by criticality.
  // v1 keeps low at 100% because the section taxonomy is small (4 kinds);
  // when v2 expands, the 100%-low rule may be relaxed via threshold change.
  required_section_coverage_by_criticality: Object.freeze({
    high:   1.0,
    medium: 1.0,
    low:    1.0,
    info:   0.5,
  }),

  // Record coverage by engine_criticality (within sections that carry records).
  required_record_coverage_by_criticality: Object.freeze({
    high:   1.0,
    medium: 1.0,
    low:    0.5,
  }),

  // Each high-criticality section MUST have ≥1 recommendation referencing
  // it (via supporting_id). Medium recommendations optional.
  require_recommendation_per_high_section: true,

  // Each section_explanation MUST have ≥1 key_observations entry.
  require_at_least_one_observation_per_section: true,

  // Each section_explanation.narrative MUST cite at least one in-section id
  // (KPI id, record id, customer name, reason code, or label_he).
  require_in_section_id_reference: true,

  // Each recommendation MUST be a structured object with all 5 fields
  // (owner / target / action / supporting_id / time_horizon).
  require_structured_recommendation: true,

  // Empty section_explanations on a non-empty verified.sections set →
  // FAIL_CLOSED (mirrors anomalySummary's empty-array rule).
  fail_on_empty_section_explanations_when_sections_exist: true,

  // Any uncovered HIGH-criticality section → FAIL_CLOSED.
  fail_on_uncovered_high_criticality_section: true,

  // Any uncovered HIGH-engine_criticality record → FAIL_CLOSED.
  fail_on_uncovered_high_criticality_record: true,
});

// =====================================================================
// Coverage safety labels (severity-ordered, worst-first).
// Same vocabulary as coveragePolicy.js — keeps downstream consumers
// working with one safety taxonomy.
// =====================================================================
export const REPORT_COVERAGE_LABELS = Object.freeze({
  FAIL_CLOSED:           'fail_closed_silent_omission',
  UNSAFE_INCOMPLETE:     'unsafe_incomplete_coverage',
  PARTIAL_LOW_UNCOVERED: 'partial_low_severity_uncovered',
  COMPLETE:              'complete',
});

// =====================================================================
// evaluateReportCoverage(verified, narrative)
//
// Inputs:
//   verified.sections                        — array (engine output)
//   narrative.section_explanations           — array (LLM output)
//   narrative.flagged_record_explanations    — array (LLM output)
//   narrative.recommendations                — array (LLM output)
//
// Returns:
//   {
//     section_coverage: { ratio, total, covered, uncovered_by_criticality },
//     record_coverage:  { ratio, total, covered, uncovered_by_criticality },
//     recommendation_coverage: { high_section_ids_with_rec, missing },
//     uncovered_section_ids,
//     uncovered_record_ids,
//     missing_observations,                 // section_ids missing key_observations
//     missing_in_section_id_refs,           // section_ids whose narrative cites no in-section id
//     unknown_section_ids,                  // referenced section_id not in verified
//     unknown_record_ids,                   // referenced record_id not in verified
//     non_structured_recommendation_indexes,
//     recommendation_supporting_id_unknown,
//     recommendation_time_horizon_invalid,
//     coverage_failures,                    // list of failure codes
//     coverage_safety_label,                // FAIL_CLOSED | UNSAFE_INCOMPLETE | PARTIAL_LOW_UNCOVERED | COMPLETE
//     applied_policy,
//     enforcement: { fail_closed: bool, cap_confidence_to: 'medium' | 'low' | null }
//   }
// =====================================================================
export function evaluateReportCoverage(verified, narrative, opts = {}) {
  const sections = (verified && Array.isArray(verified.sections)) ? verified.sections : [];
  const sectionExplanations = (narrative && Array.isArray(narrative.section_explanations))
    ? narrative.section_explanations : [];
  const recordExplanations  = (narrative && Array.isArray(narrative.flagged_record_explanations))
    ? narrative.flagged_record_explanations : [];
  const recommendations     = (narrative && Array.isArray(narrative.recommendations))
    ? narrative.recommendations : [];

  // Build verified id maps
  const verifiedSectionById = new Map();
  for (const s of sections) if (s && s.id) verifiedSectionById.set(s.id, s);

  const verifiedRecordById = new Map();
  const verifiedRecordCriticalityById = new Map();
  for (const s of sections) {
    for (const r of (s.records || [])) {
      if (r && r.record_id) {
        verifiedRecordById.set(r.record_id, r);
        verifiedRecordCriticalityById.set(r.record_id, r.engine_criticality || 'low');
      }
    }
  }

  // Collect ALL valid ids the LLM may reference in supporting_id
  // (section ids + KPI ids + record ids — the deterministic id surface).
  const validSupportingIds = new Set();
  for (const s of sections) {
    if (s.id) validSupportingIds.add(s.id);
    for (const k of (s.kpis || [])) if (k.id) validSupportingIds.add(k.id);
    for (const r of (s.records || [])) if (r.record_id) validSupportingIds.add(r.record_id);
  }

  // ALLOWED_TIME_HORIZON_IDS — passed in by caller (decoupling from
  // sandboxPolicy.js so this module can be reused independently)
  const allowed_time_horizons = (opts && Array.isArray(opts.allowed_time_horizons))
    ? new Set(opts.allowed_time_horizons)
    : new Set(['immediate', 'today', 'this_week', 'next_review_cycle', 'not_specified']);

  // ----- Section coverage --------------------------------------------
  const explainedSectionIds = new Set();
  const unknown_section_ids = [];
  for (const e of sectionExplanations) {
    if (!e || !e.section_id) continue;
    if (verifiedSectionById.has(e.section_id)) explainedSectionIds.add(e.section_id);
    else                                       unknown_section_ids.push(e.section_id);
  }

  const uncovered_section_ids = [];
  const uncovered_section_by_criticality = { high: [], medium: [], low: [], info: [] };
  for (const s of sections) {
    if (!explainedSectionIds.has(s.id)) {
      uncovered_section_ids.push(s.id);
      const c = (s.criticality in uncovered_section_by_criticality) ? s.criticality : 'low';
      uncovered_section_by_criticality[c].push(s.id);
    }
  }

  const total_sections = sections.length;
  const section_ratio = total_sections === 0 ? 1
                      : Number(((total_sections - uncovered_section_ids.length) / total_sections).toFixed(4));

  // ----- Record coverage ---------------------------------------------
  const explainedRecordIds = new Set();
  const unknown_record_ids = [];
  for (const e of recordExplanations) {
    if (!e || !e.record_id) continue;
    if (verifiedRecordById.has(e.record_id)) explainedRecordIds.add(e.record_id);
    else                                     unknown_record_ids.push(e.record_id);
  }

  const uncovered_record_ids = [];
  const uncovered_record_by_criticality = { high: [], medium: [], low: [] };
  for (const [rid, crit] of verifiedRecordCriticalityById.entries()) {
    if (!explainedRecordIds.has(rid)) {
      uncovered_record_ids.push(rid);
      const c = (crit in uncovered_record_by_criticality) ? crit : 'low';
      uncovered_record_by_criticality[c].push(rid);
    }
  }

  const total_records = verifiedRecordById.size;
  const record_ratio = total_records === 0 ? 1
                     : Number(((total_records - uncovered_record_ids.length) / total_records).toFixed(4));

  // ----- Recommendation coverage -------------------------------------
  const non_structured_recommendation_indexes = [];
  const recommendation_supporting_id_unknown  = [];
  const recommendation_time_horizon_invalid   = [];
  const recommendation_owner_missing          = [];
  const recommendation_action_missing         = [];

  recommendations.forEach((rec, idx) => {
    if (rec === null || rec === undefined || typeof rec !== 'object' || Array.isArray(rec)) {
      non_structured_recommendation_indexes.push(idx);
      return;
    }
    const need = ['owner', 'target', 'action', 'supporting_id', 'time_horizon'];
    for (const k of need) {
      if (rec[k] === undefined || rec[k] === null || String(rec[k]).trim().length === 0) {
        if (k === 'owner') recommendation_owner_missing.push(idx);
        if (k === 'action') recommendation_action_missing.push(idx);
      }
    }
    if (rec.supporting_id && !validSupportingIds.has(rec.supporting_id)) {
      recommendation_supporting_id_unknown.push({ index: idx, supporting_id: rec.supporting_id });
    }
    if (rec.time_horizon && !allowed_time_horizons.has(rec.time_horizon)) {
      recommendation_time_horizon_invalid.push({ index: idx, time_horizon: rec.time_horizon });
    }
  });

  // High-section recommendation requirement.
  //
  // F5 (Experiment 3 rerun-2): a recommendation whose supporting_id matches
  // a record_id INSIDE a section credits that section. Operator intent
  // ("address stop_5003") is reasonably understood as addressing the
  // parent section that surfaced the record (flagged_stops). Without this,
  // the LLM in det-1/2/4/5 was producing high-quality, structured
  // recommendations on records but those weren't counted toward
  // section coverage — a coverage-rule strictness defect, not a
  // weakening of integrity.
  //
  // NOT a relaxation: a recommendation still must be structured, must
  // have a valid supporting_id, AND must credit a real high section.
  const recsBySupportingId = new Set();
  for (const r of recommendations) {
    if (!r || typeof r !== 'object' || !r.supporting_id) continue;
    recsBySupportingId.add(r.supporting_id);
    // Walk verified sections; if any section's records contain the
    // supporting_id, credit that section's id.
    for (const sec of sections) {
      if ((sec.records || []).some((rec) => rec && rec.record_id === r.supporting_id)) {
        recsBySupportingId.add(sec.id);
      }
    }
  }

  const high_sections = sections.filter((s) => s.criticality === 'high');
  const high_section_ids_with_rec    = high_sections.filter((s) => recsBySupportingId.has(s.id)).map((s) => s.id);
  const high_section_ids_without_rec = high_sections.filter((s) => !recsBySupportingId.has(s.id)).map((s) => s.id);

  // ----- Per-section narrative requirements --------------------------
  const missing_observations = [];
  const missing_in_section_id_refs = [];
  for (const e of sectionExplanations) {
    if (!e || !e.section_id || !verifiedSectionById.has(e.section_id)) continue;
    if (REPORT_COVERAGE_POLICY.require_at_least_one_observation_per_section) {
      const obs = Array.isArray(e.key_observations) ? e.key_observations.filter(Boolean) : [];
      if (obs.length === 0) missing_observations.push(e.section_id);
    }
    if (REPORT_COVERAGE_POLICY.require_in_section_id_reference) {
      // The local-id set for this section is computed from the verified section.
      const sec = verifiedSectionById.get(e.section_id);
      const localIds = collectLocalIds(sec);
      const text = `${e.narrative || ''} ${(e.key_observations || []).join(' ')}`;
      const cited = [...localIds].some((id) => typeof id === 'string' && id.length >= 3 && text.includes(id));
      if (!cited) missing_in_section_id_refs.push(e.section_id);
    }
  }

  // ----- Failure codes -----------------------------------------------
  const coverage_failures = [];

  if (sections.length > 0 && sectionExplanations.length === 0
      && REPORT_COVERAGE_POLICY.fail_on_empty_section_explanations_when_sections_exist) {
    coverage_failures.push('empty_section_explanations_with_verified_sections');
  }

  for (const id of uncovered_section_by_criticality.high)
    coverage_failures.push(`uncovered_section:high:${id}`);
  for (const id of uncovered_section_by_criticality.medium)
    coverage_failures.push(`uncovered_section:medium:${id}`);
  for (const id of uncovered_section_by_criticality.low)
    coverage_failures.push(`uncovered_section:low:${id}`);
  // Info sections are tolerated below 100%; check threshold
  {
    const info_total = sections.filter((s) => s.criticality === 'info').length;
    if (info_total > 0) {
      const info_uncovered = uncovered_section_by_criticality.info.length;
      const info_ratio = (info_total - info_uncovered) / info_total;
      const required = REPORT_COVERAGE_POLICY.required_section_coverage_by_criticality.info;
      if (info_ratio < required) {
        coverage_failures.push(
          `info_section_coverage_below_threshold:${info_ratio.toFixed(2)}<${required}`
        );
      }
    }
  }

  for (const id of uncovered_record_by_criticality.high)
    coverage_failures.push(`uncovered_record:high:${id}`);
  for (const id of uncovered_record_by_criticality.medium)
    coverage_failures.push(`uncovered_record:medium:${id}`);
  // Low records: threshold rule
  {
    const low_total = [...verifiedRecordCriticalityById.values()].filter((c) => c === 'low').length;
    if (low_total > 0) {
      const low_uncovered = uncovered_record_by_criticality.low.length;
      const low_ratio = (low_total - low_uncovered) / low_total;
      const required = REPORT_COVERAGE_POLICY.required_record_coverage_by_criticality.low;
      if (low_ratio < required) {
        coverage_failures.push(
          `record_coverage_below_low_threshold:${low_ratio.toFixed(2)}<${required}`
        );
      }
    }
  }

  for (const id of unknown_section_ids)  coverage_failures.push(`unknown_section_id:${id}`);
  for (const id of unknown_record_ids)   coverage_failures.push(`unknown_record_id:${id}`);
  for (const id of missing_observations) coverage_failures.push(`missing_observations:${id}`);
  for (const id of missing_in_section_id_refs) coverage_failures.push(`narrative_no_in_section_id_ref:${id}`);

  if (REPORT_COVERAGE_POLICY.require_recommendation_per_high_section) {
    for (const id of high_section_ids_without_rec) {
      coverage_failures.push(`missing_recommendation_for_high_section:${id}`);
    }
  }
  for (const idx of non_structured_recommendation_indexes)
    coverage_failures.push(`non_structured_recommendation:${idx}`);
  for (const item of recommendation_supporting_id_unknown)
    coverage_failures.push(`recommendation_supporting_id_unknown:${item.supporting_id}`);
  for (const item of recommendation_time_horizon_invalid)
    coverage_failures.push(`recommendation_time_horizon_invalid:${item.time_horizon}`);
  for (const idx of recommendation_owner_missing)
    coverage_failures.push(`recommendation_owner_missing:${idx}`);
  for (const idx of recommendation_action_missing)
    coverage_failures.push(`recommendation_action_missing:${idx}`);

  // ----- Determine label + enforcement -------------------------------
  let coverage_safety_label = REPORT_COVERAGE_LABELS.COMPLETE;
  let fail_closed = false;
  let cap_confidence_to = null;

  // FAIL_CLOSED triggers
  if (
    coverage_failures.includes('empty_section_explanations_with_verified_sections') ||
    coverage_failures.some((c) => c.startsWith('uncovered_section:high:')) ||
    coverage_failures.some((c) => c.startsWith('uncovered_record:high:'))
  ) {
    coverage_safety_label = REPORT_COVERAGE_LABELS.FAIL_CLOSED;
    fail_closed = true;
    cap_confidence_to = 'low';
  }
  // UNSAFE_INCOMPLETE triggers (anything else that's a failure)
  else if (coverage_failures.length > 0) {
    coverage_safety_label = REPORT_COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    cap_confidence_to = 'medium';
  }
  // PARTIAL_LOW_UNCOVERED — only low-record gaps within threshold
  else if (uncovered_record_by_criticality.low.length > 0) {
    coverage_safety_label = REPORT_COVERAGE_LABELS.PARTIAL_LOW_UNCOVERED;
    cap_confidence_to = 'medium';
  }
  // else COMPLETE

  return {
    section_coverage: {
      ratio: section_ratio,
      total: total_sections,
      covered: total_sections - uncovered_section_ids.length,
      uncovered_by_criticality: uncovered_section_by_criticality,
    },
    record_coverage: {
      ratio: record_ratio,
      total: total_records,
      covered: total_records - uncovered_record_ids.length,
      uncovered_by_criticality: uncovered_record_by_criticality,
    },
    recommendation_coverage: {
      high_section_ids_with_rec,
      high_section_ids_without_rec,
    },
    uncovered_section_ids,
    uncovered_record_ids,
    missing_observations,
    missing_in_section_id_refs,
    unknown_section_ids,
    unknown_record_ids,
    non_structured_recommendation_indexes,
    recommendation_supporting_id_unknown,
    recommendation_time_horizon_invalid,
    recommendation_owner_missing,
    recommendation_action_missing,
    coverage_failures,
    coverage_safety_label,
    applied_policy: REPORT_COVERAGE_POLICY,
    enforcement: { fail_closed, cap_confidence_to },
  };
}

// =====================================================================
// collectLocalIds — internal duplicate of localIdsForSection from
// verifiedReport.js. Kept inline so this module can be audited as a
// single file (analogous to the duplicate normalizeNumberLiteral in
// verifiedAnomalies.js).
// =====================================================================
function collectLocalIds(section) {
  const ids = new Set();
  if (!section) return ids;
  if (section.id) ids.add(section.id);
  for (const k of (section.kpis || [])) if (k.id) ids.add(k.id);
  for (const r of (section.rows || [])) {
    if (r.reason_code)     ids.add(r.reason_code);
    if (r.reason_label_he) ids.add(r.reason_label_he);
    for (const sid of (r.stop_ids || [])) ids.add(`stop_${sid}`);
    for (const cn of (r.customer_names || [])) ids.add(cn);
  }
  for (const rec of (section.records || [])) {
    if (rec.record_id) ids.add(rec.record_id);
    if (rec.customer_name) ids.add(rec.customer_name);
    if (rec.failure_reason_code) ids.add(rec.failure_reason_code);
    if (rec.failure_reason_label_he) ids.add(rec.failure_reason_label_he);
  }
  return ids;
}

// =====================================================================
// Prompt helper (analogous to coveragePolicyForPrompt)
// =====================================================================
export function reportCoveragePolicyForPrompt() {
  const sec = REPORT_COVERAGE_POLICY.required_section_coverage_by_criticality;
  const rec = REPORT_COVERAGE_POLICY.required_record_coverage_by_criticality;
  return [
    `      sections — high:    ${(sec.high * 100).toFixed(0)}% required (uncovered → FAIL_CLOSED)`,
    `      sections — medium:  ${(sec.medium * 100).toFixed(0)}% required`,
    `      sections — low:     ${(sec.low * 100).toFixed(0)}% required`,
    `      sections — info:    ${(sec.info * 100).toFixed(0)}% required`,
    `      records  — high:    ${(rec.high * 100).toFixed(0)}% required (uncovered → FAIL_CLOSED)`,
    `      records  — medium:  ${(rec.medium * 100).toFixed(0)}% required`,
    `      records  — low:     ${(rec.low * 100).toFixed(0)}% required`,
    `      every section_explanation MUST cite ≥1 in-section id (KPI id, record id, customer name, or failure_reason_label_he)`,
    `      every section_explanation MUST include ≥1 key_observation`,
    `      every high-criticality section MUST have ≥1 recommendation`,
    `      every recommendation MUST be structured (owner/target/action/supporting_id/time_horizon)`,
    `      empty section_explanations on a non-empty verified.sections → FAIL_CLOSED`,
  ].join('\n');
}
