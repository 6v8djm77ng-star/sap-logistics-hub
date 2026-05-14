// =====================================================================
// reviewWorkflowPolicy.js — workflow policy + state machine for the
// operatorReviewAssistant agent (Sandbox Experiment 4).
//
// Premise (architecture experiment-4 §17): operators have judgment
// authority within policy bounds. AI has narration authority within
// deterministic bounds. Neither has authority over the engine's
// verified data — it is the floor of truth.
//
// This module owns:
//   - REVIEW_VERSION (audit anchor)
//   - REVIEW_STATES (the closed set of state values)
//   - DECISION_OPTIONS_BY_CASE_KIND (closed enum per case-kind)
//   - VIP_CUSTOMER_NAMES (deterministic VIP table)
//   - REVIEW_COVERAGE_POLICY
//   - State-transition guard (`enforceStateTransition`)
//   - Dual-review trigger evaluation (`evaluateDualReviewTriggers`)
//   - Coverage evaluation (`evaluateReviewCoverage`)
//   - Audit-log helper (`appendAudit`)
//
// Sandbox-only. No autonomous execution. No production runtime.
//
// See: docs/architecture-review/experiment-4-operator-review-architecture.md
// =====================================================================

// =====================================================================
// REVIEW_VERSION — increment on ANY change to:
//   - decision-options enums
//   - VIP table
//   - state machine
//   - coverage thresholds
//   - dual-review triggers
// The same (input, source files, REVIEW_VERSION, REPORT_VERSION) tuple
// must always produce the same case object.
// =====================================================================
export const REVIEW_VERSION = 1;

// =====================================================================
// REVIEW_STATES — the closed set of states a case may occupy.
// AI cannot read or write this; it is set by code (preCompute) or
// postProcess based on safety classification.
// =====================================================================
export const REVIEW_STATES = Object.freeze({
  PENDING_REVIEW:           'pending_review',
  OPERATOR_VERIFIED:        'operator_verified',
  REJECTED_BY_OPERATOR:     'rejected_by_operator',
  ESCALATED_TO_DUAL_REVIEW: 'escalated_to_dual_review',
  INSUFFICIENT_DATA:        'insufficient_data',
  UNSAFE_OUTPUT:            'unsafe_output',
});

// =====================================================================
// DECISION_OPTIONS_BY_CASE_KIND — closed enum per case-kind.
// Each option is frozen with:
//   - id:            stable canonical id
//   - elevation:     standard | dual_review | manager_only
//   - requires_operator_input: array of field names the operator must
//                              fill in to complete this option
// Adding an option requires a code change + REVIEW_VERSION bump.
// =====================================================================
export const DECISION_OPTIONS_BY_CASE_KIND = Object.freeze({
  delivery_run_review: Object.freeze([
    Object.freeze({
      id: 'reschedule_failed_stops',
      elevation: 'standard',
      requires_operator_input: Object.freeze(['target_date']),
      label_he: 'תיאום מחדש של עצירות שכשלו',
    }),
    Object.freeze({
      id: 'mark_as_unrecoverable',
      elevation: 'dual_review',
      requires_operator_input: Object.freeze(['reason']),
      label_he: 'סימון כבלתי-ניתן-לשחזור',
    }),
    Object.freeze({
      id: 'open_customer_outreach',
      elevation: 'standard',
      requires_operator_input: Object.freeze(['customer_owner']),
      label_he: 'פתיחת פנייה ללקוח',
    }),
    Object.freeze({
      id: 'refer_to_dispatcher',
      elevation: 'standard',
      requires_operator_input: Object.freeze(['handoff_note']),
      label_he: 'הפניה למוקד שיגור',
    }),
    Object.freeze({
      id: 'no_action_required',
      elevation: 'standard',
      requires_operator_input: Object.freeze(['justification']),
      label_he: 'לא נדרשת פעולה',
    }),
    Object.freeze({
      id: 'escalate_to_manager',
      elevation: 'manager_only',
      requires_operator_input: Object.freeze(['escalation_note']),
      label_he: 'הסלמה למנהל',
    }),
  ]),
  // v2 candidates (deferred): invoice_dispute_review, inventory_anomaly_review
});

// =====================================================================
// APPLICABILITY enum — values an LLM may set on a decision-option
// annotation. The integrity layer rejects anything else.
// =====================================================================
export const APPLICABILITY_VALUES = Object.freeze([
  'likely_relevant',
  'marginally_relevant',
  'not_applicable',
  'ai_uncertain',
]);

// =====================================================================
// ESCALATION TARGET ROLES — closed enum
// =====================================================================
export const ESCALATION_TARGET_ROLES = Object.freeze([
  'dispatcher',
  'manager',
  'compliance',
  'dual_review',
]);

// =====================================================================
// VIP_CUSTOMER_NAMES — deterministic frozen table.
// Adding/removing names requires a code change + REVIEW_VERSION bump.
// For sandbox v1 we treat one mock customer as VIP to exercise the
// dual-review trigger; the actual fixture (run 1001) involves a
// non-VIP customer, so this trigger does NOT fire on the default
// fixture. That's deliberate — exercises the negative path.
// =====================================================================
export const VIP_CUSTOMER_NAMES = Object.freeze([
  'Mock Customer Alpha Ltd',
]);

// =====================================================================
// REVIEW_COVERAGE_POLICY
// =====================================================================
export const REVIEW_COVERAGE_POLICY = Object.freeze({
  // Every decision option in the case-kind's enum MUST appear once in
  // decision_option_annotations[]. Even "not_applicable" must be explicit.
  require_full_decision_option_enumeration: true,

  // Every verified high-criticality risk surfaced by the engine MUST appear
  // in risk_flag_explanations[].
  require_full_high_risk_coverage: true,

  // Each annotation must cite a verified id.
  require_supporting_id_per_annotation: true,

  // Empty decision_option_annotations on non-empty enum → FAIL_CLOSED
  fail_on_empty_annotations_when_options_exist: true,

  // Empty risk_flag_explanations on a case with ≥1 high engine risk → FAIL_CLOSED
  fail_on_missing_high_risks: true,

  // Each annotation's `applicability` must be one of the enum values
  require_applicability_enum: true,

  // Echo of required_operator_inputs from policy must be present
  require_required_operator_inputs_echoed: true,
});

// =====================================================================
// REVIEW_COVERAGE_LABELS — same vocabulary as Exp 2/3 coverage labels
// =====================================================================
export const REVIEW_COVERAGE_LABELS = Object.freeze({
  FAIL_CLOSED:        'fail_closed_silent_omission',
  UNSAFE_INCOMPLETE:  'unsafe_incomplete_coverage',
  COMPLETE:           'complete',
});

// =====================================================================
// State-transition matrix.
// `from_state` → set of allowed `to_state`.
// AI is NEVER an actor for any transition. Allowed actors per transition
// are documented in the comments.
// =====================================================================
const ALLOWED_TRANSITIONS = Object.freeze({
  // initial → engine produced data, AI submitted clean packet
  'pending_review': new Set([
    'operator_verified',           // operator confirmed an option
    'rejected_by_operator',        // operator chose nothing / "no action"
    'escalated_to_dual_review',    // dual-review trigger fired or operator escalated
    'unsafe_output',               // rare: post-creation re-run triggered integrity flag
  ]),
  // initial → engine errored, AI never invoked
  'insufficient_data': new Set([]),  // terminal
  // AI submitted, integrity caught violation
  'unsafe_output': new Set([
    'pending_review',              // operator authorised retry after fixing inputs (out of v1 scope; documented for future)
  ]),
  // operator confirmed an option
  'operator_verified': new Set([]),  // terminal
  // operator rejected the AI suggestions
  'rejected_by_operator': new Set([]),  // terminal
  // dual-review path
  'escalated_to_dual_review': new Set([
    'operator_verified',           // second operator confirmed
    'rejected_by_operator',        // second operator rejected
  ]),
});

// =====================================================================
// enforceStateTransition(currentState, requestedState, actor)
// Returns { ok: bool, reason?: string }
//
// Hard rule: actor === 'ai' is ALWAYS rejected. AI cannot transition
// state under any circumstance.
//
// `actor` shape: 'engine' | 'postprocess' | 'operator:<role>' | 'system' | 'ai'
// =====================================================================
export function enforceStateTransition(currentState, requestedState, actor) {
  // Reject AI immediately
  if (typeof actor === 'string' && actor.toLowerCase() === 'ai') {
    return { ok: false, reason: 'ai_actor_disallowed' };
  }
  if (!REVIEW_STATES_VALUES.has(currentState)) {
    return { ok: false, reason: `unknown_current_state:${currentState}` };
  }
  if (!REVIEW_STATES_VALUES.has(requestedState)) {
    return { ok: false, reason: `unknown_requested_state:${requestedState}` };
  }
  // Self-transitions are allowed (idempotent re-set by code)
  if (currentState === requestedState) return { ok: true };

  const allowed = ALLOWED_TRANSITIONS[currentState] || new Set();
  if (!allowed.has(requestedState)) {
    return { ok: false, reason: `transition_disallowed:${currentState}->${requestedState}` };
  }
  return { ok: true };
}

const REVIEW_STATES_VALUES = new Set(Object.values(REVIEW_STATES));

// =====================================================================
// evaluateDualReviewTriggers(caseObj)
// Returns array of trigger ids that fire for the given case.
// Pure function over the verified case context.
// =====================================================================
export function evaluateDualReviewTriggers(caseObj) {
  const triggers = [];
  if (!caseObj || typeof caseObj !== 'object') return triggers;

  // Trigger 1: VIP customer affected (per VIP_CUSTOMER_NAMES table)
  if (Array.isArray(caseObj.verified_risk_flags)) {
    for (const flag of caseObj.verified_risk_flags) {
      // VIP-customer flags are emitted by the engine when a verified
      // record matches the VIP table.
      if (flag && flag.id === 'risk_vip_customer_affected') {
        triggers.push('vip_customer_affected');
        break;
      }
    }
  }

  // Trigger 2: case kind is in the always-dual list (placeholder for v2)
  // (none in v1)

  return triggers;
}

// =====================================================================
// requiredElevationForCase(caseObj)
// Returns 'standard' | 'dual_review' | 'manager_only'
// =====================================================================
export function requiredElevationForCase(caseObj) {
  const triggers = evaluateDualReviewTriggers(caseObj);
  if (triggers.length === 0) return 'standard';
  return 'dual_review';
}

// =====================================================================
// appendAudit(auditLog, entry)
// Returns a NEW array with the entry appended. Audit log is treated as
// append-only at the policy layer; callers must replace, not mutate.
// `entry` shape: { ts, actor, event, details }
// =====================================================================
export function appendAudit(auditLog, entry) {
  const safe = Array.isArray(auditLog) ? auditLog : [];
  const audited = {
    ts: entry?.ts || new Date().toISOString(),
    actor: entry?.actor || 'system',
    event: entry?.event || 'unknown',
    details: entry?.details || {},
  };
  return [...safe, audited];
}

// =====================================================================
// evaluateReviewCoverage(verifiedCase, narrative)
//
// Coverage failure codes (review-specific):
//   - empty_annotations_with_options
//   - option_missing:<option_id>
//   - unknown_option:<option_id>
//   - duplicate_option:<option_id>
//   - applicability_invalid:<value>
//   - missing_required_operator_input:<option_id>:<field>
//   - missing_high_risk:<risk_id>
//   - unknown_risk_id:<risk_id>
//   - option_supporting_id_unknown:<id>
//   - risk_supporting_id_unknown:<id>
//   - escalation_target_role_invalid:<value>
// =====================================================================
export function evaluateReviewCoverage(verifiedCase, narrative) {
  const failures = [];

  const caseKind = verifiedCase?.case_kind;
  const enumOpts = caseKind && DECISION_OPTIONS_BY_CASE_KIND[caseKind]
    ? DECISION_OPTIONS_BY_CASE_KIND[caseKind]
    : [];
  const enumOptIds = new Set(enumOpts.map((o) => o.id));

  const annotations = (narrative && Array.isArray(narrative.decision_option_annotations))
    ? narrative.decision_option_annotations : [];
  const riskExplanations = (narrative && Array.isArray(narrative.risk_flag_explanations))
    ? narrative.risk_flag_explanations : [];

  // Build verified-id set from the case (for supporting_id validation)
  const validIds = new Set();
  // From verifiedReport sections
  for (const sec of (verifiedCase?.verified_context?.sections || [])) {
    if (sec.id) validIds.add(sec.id);
    for (const k of (sec.kpis || [])) if (k.id) validIds.add(k.id);
    for (const r of (sec.records || [])) {
      if (r.record_id) validIds.add(r.record_id);
      if (r.customer_name) validIds.add(r.customer_name);
    }
  }
  // From engine risk flags
  const validRiskIds = new Set();
  for (const f of (verifiedCase?.verified_risk_flags || [])) {
    if (f.id) {
      validRiskIds.add(f.id);
      validIds.add(f.id);
    }
  }
  // Subject + case_id + decision option ids are also valid supporting refs
  if (verifiedCase?.case_id) validIds.add(verifiedCase.case_id);
  if (verifiedCase?.subject?.run_number) validIds.add(verifiedCase.subject.run_number);
  for (const id of enumOptIds) validIds.add(id);

  // ---- Empty-annotations check -----------------------------------
  if (enumOpts.length > 0 && annotations.length === 0
      && REVIEW_COVERAGE_POLICY.fail_on_empty_annotations_when_options_exist) {
    failures.push('empty_annotations_with_options');
  }

  // ---- Decision-option enumeration check -------------------------
  const annotatedOptIds = new Map();   // id → count
  for (const a of annotations) {
    const id = a?.option_id;
    if (!id) continue;
    annotatedOptIds.set(id, (annotatedOptIds.get(id) || 0) + 1);
    if (!enumOptIds.has(id)) failures.push(`unknown_option:${id}`);
  }
  for (const [id, count] of annotatedOptIds.entries()) {
    if (count > 1) failures.push(`duplicate_option:${id}`);
  }
  if (REVIEW_COVERAGE_POLICY.require_full_decision_option_enumeration) {
    for (const opt of enumOpts) {
      if (!annotatedOptIds.has(opt.id)) failures.push(`option_missing:${opt.id}`);
    }
  }

  // ---- Per-annotation applicability + supporting_id + required-input echo
  for (const a of annotations) {
    if (!a || typeof a !== 'object') continue;
    if (!enumOptIds.has(a.option_id)) continue;  // already flagged as unknown
    if (REVIEW_COVERAGE_POLICY.require_applicability_enum) {
      if (!APPLICABILITY_VALUES.includes(a.applicability)) {
        failures.push(`applicability_invalid:${a.applicability ?? '<missing>'}`);
      }
    }
    if (REVIEW_COVERAGE_POLICY.require_supporting_id_per_annotation) {
      if (!a.supporting_id) {
        failures.push(`option_supporting_id_unknown:<missing>`);
      } else if (!validIds.has(a.supporting_id)) {
        failures.push(`option_supporting_id_unknown:${a.supporting_id}`);
      }
    }
    if (REVIEW_COVERAGE_POLICY.require_required_operator_inputs_echoed) {
      const opt = enumOpts.find((o) => o.id === a.option_id);
      const expected = opt?.requires_operator_input || [];
      const got = Array.isArray(a.required_operator_inputs) ? a.required_operator_inputs : [];
      for (const f of expected) {
        if (!got.includes(f)) failures.push(`missing_required_operator_input:${a.option_id}:${f}`);
      }
    }
  }

  // ---- High-risk coverage ----------------------------------------
  const highRiskIds = (verifiedCase?.verified_risk_flags || [])
    .filter((f) => f.engine_criticality === 'high')
    .map((f) => f.id);
  const explainedRiskIds = new Set(
    riskExplanations.map((r) => r?.id).filter(Boolean)
  );
  for (const re of riskExplanations) {
    if (re?.id && !validRiskIds.has(re.id)) failures.push(`unknown_risk_id:${re.id}`);
    if (re?.supporting_id && !validIds.has(re.supporting_id)) {
      failures.push(`risk_supporting_id_unknown:${re.supporting_id}`);
    }
  }
  if (REVIEW_COVERAGE_POLICY.fail_on_missing_high_risks) {
    for (const rid of highRiskIds) {
      if (!explainedRiskIds.has(rid)) failures.push(`missing_high_risk:${rid}`);
    }
  }

  // ---- Escalation recommendation target_role validation ----------
  if (narrative?.escalation_recommendation
      && narrative.escalation_recommendation.target_role
      && !ESCALATION_TARGET_ROLES.includes(narrative.escalation_recommendation.target_role)) {
    failures.push(`escalation_target_role_invalid:${narrative.escalation_recommendation.target_role}`);
  }

  // ---- Determine label + enforcement -----------------------------
  let label = REVIEW_COVERAGE_LABELS.COMPLETE;
  let fail_closed = false;
  let cap_confidence_to = null;

  if (failures.includes('empty_annotations_with_options')
      || failures.some((f) => f.startsWith('missing_high_risk:'))) {
    label = REVIEW_COVERAGE_LABELS.FAIL_CLOSED;
    fail_closed = true;
    cap_confidence_to = 'low';
  } else if (failures.length > 0) {
    label = REVIEW_COVERAGE_LABELS.UNSAFE_INCOMPLETE;
    cap_confidence_to = 'medium';
  }

  return {
    coverage_failures: failures,
    coverage_safety_label: label,
    enforcement: { fail_closed, cap_confidence_to },
    case_kind: caseKind,
    enum_options_count: enumOpts.length,
    annotations_count: annotations.length,
    high_risks_count: highRiskIds.length,
    explained_risks_count: explainedRiskIds.size,
    applied_policy: REVIEW_COVERAGE_POLICY,
  };
}

// =====================================================================
// reviewPolicyForPrompt — used by buildUserMessage so the LLM cannot
// claim ignorance of the policy.
// =====================================================================
export function reviewPolicyForPrompt(caseKind) {
  const opts = DECISION_OPTIONS_BY_CASE_KIND[caseKind] || [];
  const optLines = opts.map((o) =>
    `      ${o.id.padEnd(28)} elevation=${o.elevation.padEnd(13)} required=${JSON.stringify(o.requires_operator_input)}`
  ).join('\n');
  return [
    `      review_states:`,
    `        pending_review (initial after engine + AI), operator_verified, rejected_by_operator,`,
    `        escalated_to_dual_review, insufficient_data, unsafe_output`,
    `      AI cannot transition state. Operator + policy engine own transitions.`,
    ``,
    `      decision options for case_kind=${caseKind}:`,
    optLines,
    ``,
    `      coverage policy:`,
    `        every decision option MUST be annotated (even "not_applicable")`,
    `        every high-criticality verified_risk_flag MUST appear in risk_flag_explanations`,
    `        applicability ∈ {likely_relevant, marginally_relevant, not_applicable, ai_uncertain}`,
    `        every annotation must cite a supporting_id from verified data`,
    `        every annotation must echo the required_operator_inputs from policy`,
    `        empty annotations on non-empty enum → FAIL_CLOSED`,
    `        missing high risk → FAIL_CLOSED`,
  ].join('\n');
}
