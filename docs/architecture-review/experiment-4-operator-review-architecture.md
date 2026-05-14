# Sandbox Experiment 4 — Operator Review Assistant Architecture

**Date:** 2026-05-10
**Status:** **DESIGN ONLY.** Not implementation. Not runtime validation. Not production integration.
**Scope confirmation:** sandbox only, mock data only, isolated runtime, no production runtime touched, no SAP live connectivity, no PM2 integration, no schedulers, no autonomous execution, no public exposure.
**Authorization granted for:** architecture/design work on `operatorReviewAssistant` (review-oriented, NOT pricing optimization, NOT autonomous strategy).

**Parent documents:**
- [experiment-3-report-explainer-architecture.md](./experiment-3-report-explainer-architecture.md)
- [experiment-3-runtime-validation-rerun-2.md](./experiment-3-runtime-validation-rerun-2.md) (the milestone that authorized this design)
- [experiment-2-coverage-hardening.md](./experiment-2-coverage-hardening.md)
- [verified-metrics-architecture.md](./verified-metrics-architecture.md)

---

## 1. Premise — extending governance into human-in-the-loop

The verified-data architecture has been validated for three *one-shot interpretation* surfaces:

| Surface | Output | Operator action implied |
|---|---|---|
| ceoBrief (Exp 1) | Aggregate metrics + interpretation | Read; awareness only |
| anomalySummary (Exp 2) | Anomalies + interpretation + structured recommendations | Read; act on suggestions |
| reportExplainer (Exp 3) | Report sections + explanations + recommendations | Read; act on suggestions |

Experiment 4 is structurally different: **the AI's output is the input to a human review process, not an end product.** The operator must explicitly act on each case through a defined state machine. The AI's role is to *prepare the case for review*, not to resolve it.

This is the safest possible extension of the architecture:

- The AI never decides
- The AI never executes
- The AI never marks a case as resolved
- The AI surfaces context the operator might miss; the operator decides what to do
- Every operator action is auditable
- Certain decisions require two reviewers (dual-review)

The architecture remains a brake, not a propeller. Experiment 4 codifies that the brake is operator-side.

---

## 2. Generalization claim

The five governance primitives — deterministic verified data, integrity enforcement, fail_closed semantics, coverage policy, structured outputs, confidence governance — generalize to a *workflow* surface as follows:

| Primitive | Single-shot (Exp 1–3) | Workflow (Exp 4) |
|---|---|---|
| Deterministic verified data | preCompute returns verified payload | preCompute returns verified **case context** (subject + history + flags) |
| Integrity enforcement | Scan narrative against verified set | Scan narrative against verified set + scan **decision_options** for invalid types |
| fail_closed semantics | Refuse to ship if engine fails | Refuse to ship if engine fails + **review_state initialized to `pending_review`**, never to "resolved" by AI |
| Coverage policy | Every required section/anomaly explained | Every **case_decision_point** has at least one option enumerated + risk flag covered |
| Structured outputs | Hebrew narrative + recommendations | Decision-options enumeration (NOT decisions) + required_operator_inputs |
| Confidence governance | Deterministic from completeness × integrity | Same; capped further by review-state policy |

The structural newness is **state**: a review case persists across operator turns. The architecture must track state without ever letting the AI write to it.

---

## 3. Deterministic-vs-generative split

| Concern | Owner | Rationale |
|---|---|---|
| What review cases exist (case enumeration) | **Code** (engine-driven) | A case is a deterministic record of "an operational item that requires review". The AI cannot create or hide cases. |
| Case state (`pending_review`, `operator_verified`, etc.) | **Code** (state machine) | State transitions are policy-driven. AI never mutates state. |
| Verified case context (subject data, history, flags) | **Code** | Same discipline as Exp 1–3. |
| Decision-option enumeration (what choices exist) | **Code** (closed enum per case_kind) | The set of allowed decisions is fixed in policy. The AI may not invent a decision. |
| Decision-option recommendation (which option to recommend) | **Mixed (LLM proposes, operator decides)** | The LLM may rank options or annotate them with significance. The operator chooses. |
| Required operator inputs | **Code** (per case_kind) | What the operator must supply (e.g., refund_amount, override_reason) is fixed schema. |
| Escalation triggers | **Code** | "When this kind of case meets these criteria, dual-review is required." Frozen rules. |
| Escalation recommendation (should this escalate?) | **LLM may suggest, operator decides** | The AI may flag a case for escalation; only the operator (or the policy engine) actually escalates. |
| Risk flag presentation | **Mixed** | Engine produces flags; LLM explains them in operator-readable terms. |
| Operator action audit | **Code** | Every operator action is logged with timestamp, user, action, prior state, new state. AI never writes here. |
| Confidence | **Code** | Deterministic, never LLM-claimed. |
| Final case resolution | **Operator (always)** | Even if AI confidence is high and all flags are clean, the operator's action is what closes the case. |

The LLM's role is now narrower than in Exp 3: **prepare a review packet**. It does not produce an end-user narrative; it produces a structured review document for an operator's eyes.

---

## 4. Subject domain (sandbox v1)

For v1, the operator-review surface is **delivery-run review** — extending Exp 3's `reportExplainer`. A `review_case` is a "this delivery run requires operator action" record.

| Case-kind | Trigger | Verified inputs reused |
|---|---|---|
| `delivery_run_review` | Run has any high-criticality section (`flagged_stops` with FAILED stop, or completion_rate < 80%) | `verifiedReport.computeReport(run_id)` |

v2 candidates (deferred):
- `invoice_dispute_review` — customer disputes an invoice
- `inventory_anomaly_review` — high-value item with discrepancy
- `vendor_chargeback_review` — chargeback or return

Adding case-kinds requires a `REVIEW_VERSION` bump and re-validation.

---

## 5. Review-state lifecycle

The state machine is **owned by code**, never by the AI:

```
                      ┌──────────────────┐
                      │  insufficient_   │
                      │  data            │   (engine error path; LLM never called)
                      └──────────────────┘
                              │
        engine produces       │ engine fails
        verified_case         │
                              ▼
                      ┌──────────────────┐
        AI prepares  ─►  pending_review   ◄────────────┐
        review packet │                  │             │
                      └──────────────────┘             │
                          │   │   │   │                │
                          │   │   │   └──→ unsafe_output (integrity flagged the AI's packet)
                          │   │   │
                          │   │   └──→ escalated_to_dual_review
                          │   │              │
                          │   │              ▼
                          │   │        (two operators must act; flow re-enters at one of below)
                          │   │
                          │   └──→ operator_verified  (operator chose & confirmed an option)
                          │              │
                          │              ▼
                          │        (case closed in audit log; AI never mutates)
                          │
                          └──→ rejected_by_operator  (operator overrode AI; chose nothing or "no action")
```

**Six terminal-or-progress states:**

| State | Meaning | Who sets it | What the AI sees |
|---|---|---|---|
| `pending_review` | Engine produced verified context; AI prepared a packet; operator has not yet acted | Code (initial state after AI submission) | Default upon AI completion |
| `operator_verified` | An operator chose one of the decision options and confirmed | Code (operator action) | Read-only (next AI call sees prior decision) |
| `rejected_by_operator` | Operator declined all AI-suggested options or chose "no action / not applicable" | Code (operator action) | Read-only |
| `escalated_to_dual_review` | Dual-review trigger fired OR operator explicitly escalated | Code (policy engine OR operator) | Read-only |
| `insufficient_data` | Engine errored in preCompute; AI never invoked | Code (engine error) | AI never sees the case |
| `unsafe_output` | Integrity layer flagged the AI's packet as fail_closed | Code (postProcess) | AI sees the packet was rejected; no retry without operator authorization |

**The AI cannot transition to ANY of these states.** Every transition is the result of either:
- the engine producing or failing to produce data,
- the postProcess applying its deterministic policy, or
- an operator action through the workflow API.

---

## 6. Decision-options model

The most architecturally novel piece. For each case-kind, a closed enum of `decision_option_kinds` is defined in code:

```js
// Sketch — not implemented yet
DECISION_OPTIONS_BY_CASE_KIND = {
  delivery_run_review: [
    { id: 'reschedule_failed_stops',     requires_operator_input: ['target_date'], elevation: 'standard' },
    { id: 'mark_as_unrecoverable',       requires_operator_input: ['reason'], elevation: 'dual_review' },
    { id: 'open_customer_outreach',      requires_operator_input: ['customer_owner'], elevation: 'standard' },
    { id: 'refer_to_dispatcher',         requires_operator_input: ['handoff_note'], elevation: 'standard' },
    { id: 'no_action_required',          requires_operator_input: ['justification'], elevation: 'standard' },
    { id: 'escalate_to_manager',         requires_operator_input: ['escalation_note'], elevation: 'manager_only' },
  ],
}
```

Each option has:
- `id` — canonical, stable across `REVIEW_VERSION`
- `requires_operator_input` — fields the operator must fill in to complete this option
- `elevation` — `standard` | `dual_review` | `manager_only`

**The LLM's job:** for each verified case context, surface which subset of decision options is relevant, with a brief justification per option grounded in verified data. **The LLM does NOT pick.**

Forbidden:
- Inventing a decision option not in the enum
- Recommending one option as "the right answer"
- Skipping required_operator_input fields in the surfaced packet
- Marking an option as "approved" or "executed"

Allowed:
- Marking an option as "AI recommended" (advisory only)
- Marking an option as "not applicable" with reason
- Annotating each option with a verified-data link explaining why it's relevant

---

## 7. Escalation semantics

Escalation is **deterministic** based on case attributes + decision-option attributes:

| Trigger | Action | Owner |
|---|---|---|
| Case kind = `delivery_run_review` AND any flagged stop with criticality=high AND any failed_stop affects a VIP customer | escalated_to_dual_review | Code (policy) |
| Operator selects an option with `elevation: dual_review` | escalated_to_dual_review | Code (UI block) |
| Operator selects an option with `elevation: manager_only` | escalated_to_manager_only | Code (UI block) |
| AI flags 1+ unsupported claim in its packet (fail_closed by qualitative scanner) | unsafe_output | Code (postProcess) |
| AI flags a "high_uncertainty" reason on its packet (e.g., sparse verified data) | escalation_recommended (advisory; doesn't auto-trigger) | LLM (operator may follow) |
| Engine source missing | insufficient_data | Code (engine error) |
| Operator explicitly clicks "escalate" in UI | escalated_to_dual_review | Code (operator action) |

**Escalation recommendation is always advisory.** The LLM may write `escalation_recommendation: { reason: "...", target_role: "manager" }` in its packet, but the deterministic escalation rules above are what actually transition state.

A VIP-customer table for the escalation rule above is itself deterministic data:
```js
VIP_CUSTOMER_CARD_CODES = ['C-MOCK-001', 'C-MOCK-VIP-002', ...];  // frozen list
```
Adding to that list is a code change + `REVIEW_VERSION` bump.

---

## 8. Forbidden behaviors (explicit)

The LLM in `operatorReviewAssistant` MUST NOT:

1. **Make a decision.** No "I recommend approving the refund". Only "decision_option `approve_refund` is relevant because...".
2. **Mark a case as resolved.** The LLM has no `resolution` field to write.
3. **Execute any action.** The LLM has no tools that mutate state. Read-only tooling is also disallowed in v1 (all data comes via the user message).
4. **Override operator authority.** No "the operator should choose X" framing — even though the LLM's annotation may rank options.
5. **Bypass escalation.** No "this doesn't need dual review" override. Escalation rules are policy.
6. **Invent customer/vendor/role data.** Same constraint as Exp 3 — every entity referenced must be in verified data.
7. **Generate authoritative strategy.** No "we should review pricing strategy" — that's outside the case scope.
8. **Fabricate causality.** Same constraint as Exp 3, with the same `causal_safe_phrases` allowance.
9. **Promote criticality.** Engine criticality is law.
10. **Surface options not in the enum.** The decision_options enum is closed per case-kind.
11. **Skip required_operator_input fields.** If `mark_as_unrecoverable` requires a `reason`, the AI's surface of that option must list the field as required.
12. **Cross cases.** v1 packet covers ONE case_id. Cross-case reasoning ("this is similar to last week's refund") is forbidden.
13. **Anticipate operator action.** The packet is a snapshot; it doesn't track operator behavior.

---

## 9. Allowed behaviors (explicit)

The LLM **MAY**:

1. **Summarize the verified case context** in operator-readable Hebrew.
2. **Annotate each decision option** with a brief justification grounded in verified data.
3. **Flag verified risks** the operator might miss (e.g., "this customer was flagged in anomalySummary on 2026-05-08").
4. **Recommend escalation** when verified data triggers an advisory threshold (the actual escalation is policy-driven).
5. **Highlight required operator inputs** for each option.
6. **Cite verified ids** (case_id, run_id, customer card_code, anomaly_id) as evidence.
7. **Quote** `failure_reason_label_he` strings verbatim (causal-safe vehicle from Exp 3).
8. **Indicate uncertainty** with the canonical phrases ("נתונים אינם זמינים", "מקור לא זמין").
9. **Reference prior operator actions** (read-only — visible in case history if any).

---

## 10. Structured submission schema

```jsonc
// submitTool.input_schema (planned, not implemented)
{
  "type": "object",
  "properties": {
    "case_summary": {
      "type": "string",
      "description": "Hebrew, ≤120 words. Operator-facing summary of the case context."
    },
    "verified_risk_flags": {
      "type": "array",
      "description": "Verified risks worth elevating to operator attention. Each must reference a verified id.",
      "items": {
        "type": "object",
        "properties": {
          "id":             { "type": "string", "description": "Stable id; e.g., risk_high_failure_rate, risk_vip_customer_affected" },
          "title":          { "type": "string", "description": "Hebrew, ≤8 words" },
          "explanation":    { "type": "string", "description": "Hebrew, ≤40 words. Cite verified ids." },
          "supporting_id":  { "type": "string", "description": "section_id, anomaly_id, record_id, or KPI id from verified data" }
        },
        "required": ["id", "title", "explanation", "supporting_id"]
      }
    },
    "decision_option_annotations": {
      "type": "array",
      "description": "ONE entry per decision option in the case-kind's enum. Operator picks; AI annotates.",
      "items": {
        "type": "object",
        "properties": {
          "option_id":              { "type": "string", "description": "MUST be one of the decision-option ids enumerated for this case-kind." },
          "applicability":          { "type": "string", "enum": ["likely_relevant", "marginally_relevant", "not_applicable", "ai_uncertain"] },
          "justification":          { "type": "string", "description": "Hebrew, ≤30 words. Cite verified id supporting why this option is relevant or not." },
          "supporting_id":          { "type": "string", "description": "Verified id supporting the applicability assessment." },
          "required_operator_inputs": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Names of operator-input fields required to complete this option (echoed from policy)."
          }
        },
        "required": ["option_id", "applicability", "justification", "supporting_id"]
      }
    },
    "escalation_recommendation": {
      "type": "object",
      "description": "OPTIONAL. AI advisory; deterministic policy is final.",
      "properties": {
        "should_consider_escalation": { "type": "boolean" },
        "reason":                     { "type": "string", "description": "Hebrew, ≤30 words. Cite verified id." },
        "target_role":                { "type": "string", "enum": ["dispatcher", "manager", "compliance", "dual_review"] }
      }
    },
    "operator_attention_note": {
      "type": "string",
      "description": "Hebrew, 1-2 sentences. What does the operator most need to notice about this case before deciding?"
    }
  },
  "required": [
    "case_summary",
    "verified_risk_flags",
    "decision_option_annotations",
    "operator_attention_note"
  ]
}
```

The schema is intentionally narrower than Exp 3's `reportExplainer`:
- No "executive_summary" — there's no executive consumer
- No "recommendations" — replaced by `decision_option_annotations`
- No "cross_section_themes" — single-case scope
- No "prioritization_note" — operator does the prioritizing

---

## 11. Coverage policy (review-specific)

A new policy module `lib/reviewWorkflowPolicy.js` (planned, not implemented):

```js
REVIEW_COVERAGE_POLICY = {
  // Every decision option in the case-kind's enum MUST appear once in
  // decision_option_annotations[]. Even "not_applicable" must be explicit.
  require_full_decision_option_enumeration: true,

  // Every verified high-criticality risk surfaced by the engine MUST appear
  // in verified_risk_flags[]. Omitting a high risk is a silent omission.
  require_full_high_risk_coverage: true,

  // Each annotation must cite a verified id in its justification AND
  // supporting_id field.
  require_supporting_id_per_annotation: true,

  // Empty decision_option_annotations on non-empty enum → FAIL_CLOSED
  fail_on_empty_annotations_when_options_exist: true,

  // Empty verified_risk_flags on a case with ≥1 high engine risk → FAIL_CLOSED
  fail_on_missing_high_risks: true,

  // Each annotation's `applicability` must be one of the enum values
  require_applicability_enum: true,
};
```

**Failure code taxonomy:**

| Code | Trigger | Escalation |
|---|---|---|
| `empty_annotations_with_options` | LLM submitted `[]` while ≥1 option exists | FAIL_CLOSED |
| `option_missing:<option_id>` | An enum option not annotated | UNSAFE_INCOMPLETE |
| `unknown_option:<id>` | LLM annotated a non-enum option | UNSAFE_INCOMPLETE |
| `option_supporting_id_unknown:<id>` | Annotation cites a non-verified id | UNSAFE_INCOMPLETE |
| `risk_supporting_id_unknown:<id>` | Risk flag cites a non-verified id | UNSAFE_INCOMPLETE |
| `missing_high_risk:<id>` | Engine emitted a high risk; LLM did not surface it | FAIL_CLOSED |
| `missing_required_operator_input:<option_id>:<field>` | Annotation lists option but doesn't echo required field | UNSAFE_INCOMPLETE |
| `applicability_invalid:<value>` | Applicability not in enum | UNSAFE_INCOMPLETE |

---

## 12. Confidence model

Inherits Exp 3's chained-cap structure:

```
confidence_overall =
  if (fail_closed_in_coverage)                                      → 'low'
  elif (sources_completeness ≥ 0.9 AND integrity_score ≥ 0.9 AND
        review_state == 'pending_review')                            → 'high'
  elif (sources_completeness ≥ 0.7 AND integrity_score ≥ 0.7)        → 'medium'
  else                                                              → 'low'

confidence_overall = applyConfidenceCap(confidence_overall, coverage.cap)
```

**Additional cap rule for Experiment 4:** even at `confidence: high`, if the case has ANY `verified_risk_flag` with `engine_criticality: high`, the operator-facing display MUST surface a "high-risk verified flag present" banner. Confidence is about packet integrity; risk presence is about case content. They're orthogonal.

---

## 13. Integrity scanning (review-specific extensions)

Reuses `sandboxPolicy.classifyNarrativeText` for trend/causal/urgency/time-horizon. Reuses `findUnverifiedNumbers`. Adds:

| Scanner | What it checks |
|---|---|
| Decision-option presence | every enum option annotated |
| Decision-option uniqueness | no duplicate `option_id` annotations |
| Decision-option enum membership | every annotated `option_id` is in the closed enum for this case-kind |
| Required-operator-input echo | each annotated option lists the required fields per policy |
| High-risk coverage | every engine-emitted high-criticality risk appears in `verified_risk_flags` |
| Supporting_id validity | every `supporting_id` (in annotations and risk flags) is in the verified id set |
| Applicability enum | every `applicability` value is one of the four allowed values |

Reused from Exp 3 with minor adaptation:
- `causal_safe_phrases` set is built from the verified case's `failure_reason_label_he` strings (if any) plus an empty default
- `localIdsForSection` becomes `localIdsForCase` (slightly different surface)

---

## 14. Fail_closed rules (consolidated)

Priority cascade (worst → best), preserved from Exp 3 with review-specific additions:

| Trigger | Result |
|---|---|
| `empty_annotations_with_options` | `fail_closed = true`, `safety = fail_closed_silent_omission`, `review_state = unsafe_output` |
| `missing_high_risk:*` | `fail_closed = true`, `safety = fail_closed_silent_omission`, `review_state = unsafe_output` |
| Trend/causal/invented-deadline claim AND any high risk exists | `safety = unsafe_unsupported_claims_with_high_severity` |
| Other coverage failure | `safety = unsafe_incomplete_coverage`, `confidence ≤ medium` |
| Any qualitative claim without high risk | `safety = caution_qualitative_claims_unsupported` |
| Otherwise | `safety = safe`, `review_state = pending_review` |

**Critical:** the `review_state` field is set by code based on the safety label. The LLM cannot influence `review_state`.

---

## 15. Dual-review triggers

Three deterministic dual-review triggers:

```js
DUAL_REVIEW_TRIGGERS = [
  // Trigger 1: VIP customer affected
  (case_) => caseHasVipCustomer(case_, VIP_CUSTOMER_CARD_CODES),

  // Trigger 2: option with elevation: 'dual_review' was selected
  (case_, action) => {
    const option = DECISION_OPTIONS[case_.case_kind].find(o => o.id === action.option_id);
    return option?.elevation === 'dual_review';
  },

  // Trigger 3: case kind always-dual (e.g., write-off above threshold)
  (case_) => CASE_KINDS_ALWAYS_DUAL.includes(case_.case_kind),
];
```

**The AI can recommend escalation. Only the policy engine triggers it.** The UI must enforce dual-review at the action layer (block single-operator confirmation when trigger fires).

For sandbox v1, only Trigger 1 (VIP customer) is implementable on the existing fixture. Triggers 2 and 3 are placeholders for v2.

---

## 16. Hallucination risk surfaces (residual after design)

| Risk | Mitigation | Residual |
|---|---|---|
| LLM picks a decision instead of annotating options | Schema has no "selected_option" field; annotation is the only output | None — schema-enforced |
| LLM invents a decision option | Closed enum check in postProcess | None — caught |
| LLM omits an enum option | Coverage check | None — caught |
| LLM ranks options as "must do X" | Free-text in `justification`/`operator_attention_note` could imply preference | **Yes — qualitative** |
| LLM imports cross-case context ("similar to last week") | Trend-claim scanner | None for cross-time references; cross-case content has no scanner — **operator review** |
| LLM under-reports a high-criticality risk | High-risk coverage check | None — fail_closed |
| LLM paraphrases a `failure_reason_label_he` | Existing non-verbatim check | None — caught |
| LLM produces a "should escalate to manager" recommendation that misframes severity | Free-text scanner doesn't classify severity-of-recommendation | **Yes — operator review** |
| LLM annotation creates implicit pressure on the operator | Cannot be caught by code | **Yes — UI design must visibly separate AI annotation from policy** |
| Operator UI conflates AI annotation with verified fact | Out of architecture scope | **Yes — UI requirement** |

**Most dangerous residual:** *operator-pressure framing.* An AI annotation that says "this is the obviously correct option" — even when policy and verified data don't support that conclusion — could nudge the operator toward a decision they wouldn't otherwise make. This is fundamentally a UI + training problem, not solvable in the AI layer alone.

---

## 17. Operator-review boundaries

This document codifies the boundaries between AI and operator authority:

| Operation | AI authority | Operator authority |
|---|---|---|
| See verified case context | YES (read) | YES |
| Generate review packet | YES | NO (operator consumes, doesn't generate) |
| Choose a decision option | NO | YES (sole authority) |
| Mark case `operator_verified` | NO | YES |
| Mark case `rejected_by_operator` | NO | YES |
| Trigger escalation | RECOMMEND ONLY (advisory) | YES (manual) — and code triggers automatically per policy |
| Override AI's flagging | NO (AI flagging is engine-derived) | YES (operator may dismiss with `dismissal_reason`) |
| Override engine criticality | NO | NO (criticality is policy; both AI and operator must respect it) |
| Mutate verified data | NO | NO (verified data is immutable; operator can request a re-run) |
| Audit trail | READ ONLY | WRITE (their actions are recorded by code; they can read the trail) |

The **principle**: operators have judgment authority within policy bounds. AI has narration authority within deterministic bounds. Neither has authority over the engine's verified data — it is the floor of truth.

---

## 18. Production rollout blockers (cannot be lifted in design phase)

All Exp 3 blockers (driver-note sanitization, audit log, etc.) carry forward. Plus:

| Blocker | Why |
|---|---|
| Operator UI with explicit state-machine display | The state machine is the architecture; UI must surface state visibly. Generic "review" UI undermines it. |
| Authentication / authorization (who can review what) | A reviewer's identity gates the audit log. Required for any non-mock deployment. |
| Dual-review enforcement at action layer | UI must block single-operator confirmation when dual-review is triggered. AI cannot enforce this. |
| Audit log persistence + retention policy | Every operator action + every state transition + every verified data snapshot per case |
| Cross-team handoff workflow | Escalations must route to the right inbox |
| SLA tracking | Cases that sit in `pending_review` past SLA must surface; AI cannot track this |
| Operator onboarding | Operators must be trained that AI annotation is advisory, not authoritative |
| PII handling on real customer data | Real card_codes, customer names — compliance review |
| Tamper-resistance of operator actions | Audit log must be append-only; immutable post-action |
| Recovery from `unsafe_output` state | What's the operator workflow when AI fails? Code path must exist |
| Dispute / appeal workflow | What if the operator disagrees with the engine's criticality? Out of v1 scope, but production needs an answer |
| Cost projection at production cadence | Per-case cost × case volume |
| Rollback path | If the AI annotation system breaks, operators must still be able to review cases without it |

---

## 19. Architectural risk review

| Risk | Severity | Notes |
|---|---|---|
| Operator-trust calibration | **High** | Operators may over-trust AI annotations or under-trust them. Both fail. UI design + training mitigates; not solvable in the AI layer. |
| Decision-option enum staleness | Medium | As real cases reveal needed options, enum changes require `REVIEW_VERSION` bumps. |
| AI-pressure bias | High | The `applicability: 'likely_relevant'` for one option implicitly prioritizes it. UI must counter-balance with explicit "AI does not decide" framing. |
| Coverage strictness | Low | Same as Exp 3 — corrected via F4/F5 patterns; expect same lessons here. |
| Cost growth | Low | Each case packet is small (closed-enum schema); cheaper than Exp 3 reports. |
| Workflow latency | Medium | Live data may take time; `pending_review` cases pile up. SLA tracking is operator-side. |
| Cross-agent dependencies | Medium | Future Exp 4 needs Exp 3's verifiedReport, anomalySummary's verifiedAnomalies, ceoBrief's verifiedMetrics. Tight coupling — version-bump discipline is critical. |

---

## 20. Validation plan (when implementation is later authorized)

Mirroring Exp 2/3 discipline:

1. **Determinism:** 5 identical case inputs, hash-compare verified case context (must be byte-identical).
2. **Decision-option enumeration:** synthetic narratives that omit / invent / duplicate options; confirm fail_closed or unsafe escalation.
3. **High-risk coverage:** synthetic narrative that omits an engine-flagged high risk; confirm fail_closed.
4. **Escalation:** case with VIP customer; confirm dual-review trigger fires deterministically.
5. **Cross-agent regression:** verifiedReport + anomalySummary + ceoBrief continue to function unchanged.
6. **Live LLM:** 3–5 calls; cost & latency; spot-check annotation quality.
7. **Operator-pressure check (qualitative):** review LLM annotations for implicit ranking that exceeds advisory framing.

This plan is documented for traceability. **It is not authorized to execute.**

---

## 21. Verdict for this design phase

This document is the architecture deliverable for Experiment 4. The next steps are operator-decided:

| Option | What it authorizes |
|---|---|
| Proceed to Experiment 4 implementation | Build `lib/verifiedReviewCase.js`, `lib/reviewWorkflowPolicy.js`, wire `operatorReviewAssistant` agent. Reliability validation as a separate authorization. |
| Revise architecture | Operator may flag specific design decisions for change before implementation. |
| Pause and re-evaluate sandbox direction | Sandbox returns to idle; the design is preserved as a record. |

This design does NOT authorize:
- Implementation
- Reliability validation
- Production rollout
- Live SAP integration
- Autonomous execution
- PM2 integration
- Public exposure
- Scheduled runs
- Real customer / vendor data exposure

---

## 22. Cross-references

- **Architecture parents:** `experiment-3-report-explainer-architecture.md`, `experiment-2-anomaly-architecture.md`, `verified-metrics-architecture.md`
- **Validation milestone:** `experiment-3-runtime-validation-rerun-2.md`
- **Coverage discipline:** `experiment-2-coverage-hardening.md`
- **Qualitative discipline:** `experiment-2-reliability-hardening-addendum.md`
- **Reuse targets (when implemented):**
  - `backend-sandbox/lib/verifiedReport.js` for delivery_run_review case context
  - `backend-sandbox/lib/verifiedAnomalies.js` for cross-reference risk flags
  - `backend-sandbox/lib/sandboxPolicy.js` for qualitative scanning
  - `backend-sandbox/lib/coveragePolicy.js` (NOT directly — review uses its own policy)

---

## 23. Sandbox-only declaration

This architecture document was produced under the sandbox runtime constraint. It represents a design proposal, not a deliverable system. The `operatorReviewAssistant` agent does not yet exist; no code has been written; no sandbox process was started; no live LLM was called; no production runtime was touched.

The work was: read existing architecture, design a workflow surface that extends governance into human-in-the-loop, write this document.

---

## 24. Operational principle (extended)

> **In executive systems, omission risk is operationally equivalent to fabrication risk.**
> **In diagnostic systems, fabricated causality is operationally equivalent to a wrong remediation.**
> **In structured-output systems, a paraphrased deterministic field is a fabricated deterministic field.**
> **In production-gate systems, "no run reached safe" is a stronger signal than the integrity score for any individual run.**
> **In operator-review systems, an AI that decides is an AI that has overrun its authority — even when its decision matches what the operator would have chosen.**

The fifth clause is new to Experiment 4. It motivates the central design choice: the AI annotates options, the operator decides; the AI never selects. Even when the AI's annotation is correct, allowing it to act would establish a precedent that erodes the operator-authority boundary. The architecture is configured so the boundary is structural, not behavioral.

The system should assist operator judgment, not replace it. This document codifies that principle into a workflow, a state machine, an escalation policy, and a closed-enum schema.

---

## 25. End of design phase

The architecture is documented. No code was written. No sandbox process was started. No mock data was modified. No live LLM was called. No production runtime was touched.

The sandbox returns to idle. Awaiting operator decision on whether to authorize implementation of Experiment 4 as a separate phase.
