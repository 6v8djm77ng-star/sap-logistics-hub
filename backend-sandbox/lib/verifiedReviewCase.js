// =====================================================================
// verifiedReviewCase.js — deterministic review-case engine
// (Sandbox Experiment 4 — implementation phase).
//
// Same architectural contract as the other verified-data engines:
//   - Pure JavaScript. No LLM, no estimation.
//   - Same input + same source files + same REVIEW_VERSION + same
//     REPORT_VERSION → byte-identical output (modulo timestamps).
//   - Validation errors fail closed (no LLM call downstream).
//   - Missing source = `review_state: insufficient_data`, NEVER an estimate.
//   - All review_state transitions are owned by code, never by the AI.
//
// In Experiment 4 the LLM's job is to *prepare a review packet*: annotate
// the closed-enum decision options with applicability + justification,
// surface engine-flagged risks for operator attention, and (optionally)
// recommend escalation as advisory. The LLM does NOT decide. It does NOT
// transition state. It does NOT execute.
//
// Cases v1:
//   - delivery_run_review: triggered when verifiedReport produces a run
//     with any high-criticality section (failed stop, low completion rate,
//     etc.) — extending Exp 3.
//
// See: docs/architecture-review/experiment-4-operator-review-architecture.md
// =====================================================================

import { computeReport, REPORT_VERSION } from './verifiedReport.js';
import {
  REVIEW_VERSION,
  REVIEW_STATES,
  DECISION_OPTIONS_BY_CASE_KIND,
  VIP_CUSTOMER_NAMES,
  appendAudit,
  evaluateDualReviewTriggers,
  requiredElevationForCase,
} from './reviewWorkflowPolicy.js';

// =====================================================================
// VIP detection — pure function over a verified report.
// Returns array of customer names from the report that match VIP table.
// =====================================================================
function findVipCustomersInReport(report) {
  const found = new Set();
  if (!report || !Array.isArray(report.sections)) return [];
  // Look across all sections; any record with a customer_name matching
  // VIP_CUSTOMER_NAMES counts.
  for (const sec of report.sections) {
    for (const r of (sec.records || [])) {
      if (r.customer_name && VIP_CUSTOMER_NAMES.includes(r.customer_name)) {
        found.add(r.customer_name);
      }
    }
    for (const row of (sec.rows || [])) {
      for (const cn of (row.customer_names || [])) {
        if (VIP_CUSTOMER_NAMES.includes(cn)) found.add(cn);
      }
    }
  }
  return [...found];
}

// =====================================================================
// Build engine_risk_flags from a verifiedReport output.
// Each flag is deterministic; the AI's role is to explain them, not to
// invent or omit.
// =====================================================================
function buildEngineRiskFlags(report) {
  const flags = [];

  // Risk: high failure rate (completion_rate_pct < 80 — the high band)
  const runSummary = (report.sections || []).find((s) => s.id === 'run_summary');
  const completion = runSummary?.kpis?.find((k) => k.id === 'completion_rate_pct');
  if (completion && typeof completion.value === 'number') {
    const t = completion.thresholds || {};
    if (typeof t.high_below === 'number' && completion.value < t.high_below) {
      flags.push({
        id: 'risk_high_failure_rate',
        title_he: 'שיעור כשל גבוה',
        engine_criticality: 'high',
        explanation_he: `אחוז ההשלמה ${completion.value} נמוך מסף ${t.high_below}, מה שמסמן את הסבב כקריטי`,
        supporting_id: 'completion_rate_pct',
      });
    } else if (typeof t.medium_below === 'number' && completion.value < t.medium_below) {
      flags.push({
        id: 'risk_moderate_failure_rate',
        title_he: 'שיעור כשל בינוני',
        engine_criticality: 'medium',
        explanation_he: `אחוז ההשלמה ${completion.value} נמוך מסף ${t.medium_below}`,
        supporting_id: 'completion_rate_pct',
      });
    }
  }

  // Risk: any FAILED stop with high engine criticality (record-level flag)
  const flagged = (report.sections || []).find((s) => s.id === 'flagged_stops');
  for (const r of (flagged?.records || [])) {
    if (r.engine_criticality === 'high') {
      flags.push({
        id: `risk_failed_stop_${r.stop_id}`,
        title_he: `כשל בעצירה ${r.stop_id}`,
        engine_criticality: 'high',
        explanation_he: `עצירה ${r.stop_id} (${r.customer_name || ''}) במצב ${r.status}; סיבה: ${r.failure_reason_label_he || r.failure_reason_code || 'לא ידועה'}`,
        supporting_id: r.record_id,
      });
    }
  }

  // Risk: VIP customer affected (deterministic VIP table lookup)
  const vips = findVipCustomersInReport(report);
  for (const vip of vips) {
    flags.push({
      id: 'risk_vip_customer_affected',
      title_he: 'לקוח VIP מושפע',
      engine_criticality: 'high',
      explanation_he: `הלקוח VIP "${vip}" מושפע מסבב זה`,
      supporting_id: vip,   // customer name is in valid id set
    });
    // Only emit one VIP flag per case (not one per customer); the
    // explanation can list multiple, but the trigger is binary.
    break;
  }

  // Risk: dead_stock-style customer concentration check could go here
  // for v2; not implemented in v1.

  return flags;
}

// =====================================================================
// Build deterministic case_id. Stable per (case_kind, subject_ref, date).
// =====================================================================
function buildCaseId(caseKind, report) {
  const runId = report?.subject?.run_id;
  const date  = report?.subject?.run_date;
  if (!runId || !date) return null;
  return `case_${caseKind}_${runId}_${date}`;
}

// =====================================================================
// Main entry: computeReviewCase({ run_id, case_kind })
// case_kind defaults to 'delivery_run_review' (the only v1 kind).
// =====================================================================
export function computeReviewCase(input) {
  const computed_at = new Date().toISOString();
  const errors = [];
  const warnings = [];
  let audit_log = [];

  const caseKind = input?.case_kind || 'delivery_run_review';

  // Validate case_kind
  if (!Object.prototype.hasOwnProperty.call(DECISION_OPTIONS_BY_CASE_KIND, caseKind)) {
    errors.push({ code: 'unknown_case_kind', message: `case_kind '${caseKind}' is not in policy enum` });
    return finalize(null, null, REVIEW_STATES.INSUFFICIENT_DATA);
  }

  // Validate run_id (only kind in v1 is delivery_run_review)
  if (caseKind === 'delivery_run_review') {
    if (input?.run_id === undefined || input?.run_id === null || !Number.isFinite(Number(input.run_id))) {
      errors.push({ code: 'bad_input', message: 'run_id (number) is required for case_kind=delivery_run_review' });
      return finalize(null, null, REVIEW_STATES.INSUFFICIENT_DATA);
    }
  }

  // Step 1 — invoke verifiedReport engine.
  const report = computeReport({ run_id: input.run_id });

  if (Array.isArray(report.errors) && report.errors.length > 0) {
    // Engine fail-closed at preCompute. AI never invoked.
    errors.push(...report.errors.map((e) => ({ ...e, source: 'verifiedReport' })));
    audit_log = appendAudit(audit_log, {
      ts: computed_at,
      actor: 'engine',
      event: 'case_creation_failed',
      details: { reason: 'verifiedReport_errors', errors: report.errors.slice(0, 3) },
    });
    return finalize(report, null, REVIEW_STATES.INSUFFICIENT_DATA);
  }

  // Forward the report's warnings as case-level warnings
  for (const w of (report.warnings || [])) {
    warnings.push({ ...w, source: 'verifiedReport' });
  }

  // Step 2 — build engine_risk_flags
  const verified_risk_flags = buildEngineRiskFlags(report);

  // Step 3 — case_id
  const case_id = buildCaseId(caseKind, report);

  // Step 4 — escalation metadata
  const triggers_active = evaluateDualReviewTriggers({ verified_risk_flags });
  const elevation_required = requiredElevationForCase({ verified_risk_flags });

  // Step 5 — initial review_state (code-owned)
  const review_state = REVIEW_STATES.PENDING_REVIEW;

  // Step 6 — audit
  audit_log = appendAudit(audit_log, {
    ts: computed_at,
    actor: 'engine',
    event: 'case_created',
    details: {
      case_id,
      case_kind: caseKind,
      run_id: input.run_id,
      report_version: REPORT_VERSION,
      review_version: REVIEW_VERSION,
      sections_count: (report.sections || []).length,
      verified_risk_flags_count: verified_risk_flags.length,
    },
  });

  return finalize(report, {
    case_id,
    case_kind: caseKind,
    case_version: REVIEW_VERSION,
    subject: report.subject,
    verified_context: report,
    verified_risk_flags,
    decision_options: DECISION_OPTIONS_BY_CASE_KIND[caseKind],
    escalation: {
      triggers_active,
      elevation_required,
      determined_by: 'policy_engine',
    },
    review_state,
  }, review_state);

  // ------------------------------------------------------------------
  function finalize(report, body, finalState) {
    const meta = {
      computed_at,
      case_version: REVIEW_VERSION,
      review_version: REVIEW_VERSION,
      report_version: REPORT_VERSION,
      sources_consulted: report?.meta?.sources_consulted || [],
      sources_returning_data: report?.meta?.sources_returning_data || [],
      sources_missing: report?.meta?.sources_missing || [],
      sources_completeness: report?.meta?.sources_completeness ?? 0,
    };
    if (body) {
      return {
        ...body,
        review_state: finalState,
        audit_log,
        warnings,
        errors,
        meta,
      };
    }
    return {
      case_id: null,
      case_kind: caseKind,
      case_version: REVIEW_VERSION,
      subject: null,
      verified_context: report || null,
      verified_risk_flags: [],
      decision_options: DECISION_OPTIONS_BY_CASE_KIND[caseKind] || [],
      escalation: { triggers_active: [], elevation_required: 'standard', determined_by: 'policy_engine' },
      review_state: finalState,
      audit_log,
      warnings,
      errors,
      meta,
    };
  }
}

// =====================================================================
// Helper: collect numbers + strings + causal_safe_phrases for the
// post-processor's qualitative scanner. Mirrors the pattern from
// verifiedReport.collectReportValueSet but for the case-level surface.
// =====================================================================
export function collectReviewCaseValueSet(verifiedCase) {
  const numbers = new Set();
  const strings = new Set();
  const causal_safe_phrases = new Set();

  if (!verifiedCase) return { numbers, strings, causal_safe_phrases };

  // Pull from underlying verifiedReport via its own collector
  // (reused so the ID surface is consistent with Exp 3)
  const report = verifiedCase.verified_context || null;
  if (report && Array.isArray(report.sections)) {
    for (const sec of report.sections) {
      if (sec.id) strings.add(sec.id);
      if (sec.label_he) strings.add(sec.label_he);
      for (const k of (sec.kpis || [])) {
        if (k.id) strings.add(k.id);
        if (typeof k.value === 'number') numbers.add(k.value);
        if (typeof k.value === 'string' && k.value.length >= 3) strings.add(k.value);
        if (k.thresholds && typeof k.thresholds === 'object') {
          for (const v of Object.values(k.thresholds)) if (typeof v === 'number') numbers.add(v);
        }
      }
      for (const row of (sec.rows || [])) {
        if (typeof row.count === 'number') numbers.add(row.count);
        if (typeof row.pct === 'number') numbers.add(row.pct);
        if (row.reason_code) strings.add(row.reason_code);
        if (row.reason_label_he) {
          strings.add(row.reason_label_he);
          causal_safe_phrases.add(row.reason_label_he);
        }
        for (const sid of (row.stop_ids || [])) {
          if (typeof sid === 'number') numbers.add(sid);
          strings.add(`stop_${sid}`);
        }
        for (const cn of (row.customer_names || [])) {
          if (typeof cn === 'string' && cn.length >= 3) strings.add(cn);
        }
      }
      for (const r of (sec.records || [])) {
        if (r.record_id) strings.add(r.record_id);
        if (r.customer_name) strings.add(r.customer_name);
        if (r.city) strings.add(r.city);
        if (r.failure_reason_code) strings.add(r.failure_reason_code);
        if (r.failure_reason_label_he) {
          strings.add(r.failure_reason_label_he);
          causal_safe_phrases.add(r.failure_reason_label_he);
        }
        if (typeof r.stop_id === 'number') numbers.add(r.stop_id);
      }
    }
  }

  // Engine risk flags
  for (const f of (verifiedCase.verified_risk_flags || [])) {
    if (f.id) strings.add(f.id);
    if (f.supporting_id) strings.add(f.supporting_id);
    if (f.title_he) strings.add(f.title_he);
  }

  // Decision options
  for (const o of (verifiedCase.decision_options || [])) {
    if (o.id) strings.add(o.id);
    if (o.label_he) strings.add(o.label_he);
  }

  // Subject
  if (verifiedCase.subject?.run_id) numbers.add(verifiedCase.subject.run_id);
  if (verifiedCase.subject?.run_number) strings.add(verifiedCase.subject.run_number);
  if (verifiedCase.subject?.driver_name) strings.add(verifiedCase.subject.driver_name);

  // Case identity
  if (verifiedCase.case_id) strings.add(verifiedCase.case_id);
  if (verifiedCase.case_kind) strings.add(verifiedCase.case_kind);

  return { numbers, strings, causal_safe_phrases };
}
