# Sandbox Experiment 2 — Coverage Hardening

**Date:** 2026-05-10
**Status:** Implemented + validated. Sandbox-only.
**Parent reports:**
- [experiment-2-anomaly-architecture.md](./experiment-2-anomaly-architecture.md)
- [experiment-2-reliability-validation.md](./experiment-2-reliability-validation.md)
- [experiment-2-reliability-hardening-addendum.md](./experiment-2-reliability-hardening-addendum.md) (the `§8.1` residual closed by this work)

**Scope confirmation:** sandbox-only, no production runtime, no SAP live connectivity, no PM2, no schedulers, no autonomous execution, no public exposure.

---

## 1. TL;DR

The §8.1 residual — "the LLM submitted `anomaly_interpretations: []` once in 3 runs, but `confidence: high` + `safety: safe` despite zero coverage" — is **closed**. Coverage is now a first-class deterministic dimension with explicit fail-closed semantics.

| Behavior | Before this hardening | After this hardening |
|---|---|---|
| `anomaly_interpretations: []` while verified anomalies exist | `confidence: high`, `safety: safe`, score 0.95 | **`fail_closed: true`**, `safety: fail_closed_silent_omission`, `confidence: low` |
| Uncovered HIGH severity anomaly | `confidence: high`, `safety: safe` | **`fail_closed: true`** |
| Uncovered MEDIUM severity anomaly | `safety: safe` | **`safety: unsafe_incomplete_coverage`**, `confidence ≤ medium` |
| Uncovered LOW > 50% threshold | not detected | **`safety: unsafe_incomplete_coverage`**, `confidence ≤ medium` |
| Recommendation missing on a covered anomaly | not detected | **`safety: unsafe_incomplete_coverage`**, `confidence ≤ medium` |
| Non-structured (legacy string) recommendation | quietly accepted | **`safety: unsafe_incomplete_coverage`**, `confidence ≤ medium` |
| Operator gate signal | inspection only | **top-level `fail_closed: true|false`** boolean |

**Validation results:**

- 9 / 9 omission unit tests pass (no LLM)
- 9 / 9 coverage-evaluator unit tests pass (no LLM)
- 2 / 2 live LLM runs: coverage_ratio = 1.0, fail_closed = false, safety = safe, confidence = high
- 0 production-runtime touches

**Verdict:** `READY_FOR_SANDBOX_EXPERIMENT_3_ARCHITECTURE` (see §10).

---

## 2. Files changed

| File | Change | Notes |
|---|---|---|
| `backend-sandbox/lib/coveragePolicy.js` | **NEW** (~200 lines) | Policy constants, `evaluateCoverage`, `applyConfidenceCap`, prompt-helper |
| `backend-sandbox/agents/registry.js` | `anomalySummary` postProcess restructured; systemPrompt + buildUserMessage extended | ~80 lines added/changed |
| (No other files touched.) | | |

No production runtime files. No SAP files. No PM2 configuration. No `.env.sandbox` content beyond the temporary key-injection ritual used for the 2 live runs (restored post-validation).

---

## 3. Coverage policy (deterministic, code-locked)

```js
// lib/coveragePolicy.js
export const COVERAGE_POLICY = Object.freeze({
  required_coverage_by_severity: {
    high:   1.0,   // 100% — any uncovered → FAIL_CLOSED
    medium: 1.0,   // 100% — any uncovered → unsafe_incomplete_coverage
    low:    0.5,   // 50%  — below threshold → unsafe_incomplete_coverage
  },
  require_structured_recommendation: true,
  fail_on_empty_interpretations_when_anomalies_exist: true,
  fail_on_uncovered_high_severity: true,
  fail_on_non_structured_recommendation: true,
});
```

**Why these specific thresholds:**

| Severity | Threshold | Rationale |
|---|---|---|
| high | 100% | High-severity anomalies are by definition operationally important. Omission = the operator is unaware of a serious thing. Equivalent to fabrication risk. |
| medium | 100% | A medium anomaly is meaningful but not blocking. We still require coverage to ensure the operator sees the full picture; the *consequence* of omission is "unsafe" not "fail_closed" because the operator can plausibly proceed with high coverage and a flagged gap. |
| low | 50% | Low-severity anomalies are common (e.g., individual item-level findings); 100% required would push the model to verbose noise. 50% threshold balances completeness with focus. |

**Why 100% required for medium but the consequence is `unsafe`, not `fail_closed`:**
The fail_closed signal is reserved for cases where downstream consumers must NOT use the output. A missing medium-severity interpretation is a reduced-utility output, not an operationally hazardous one. The `unsafe_incomplete_coverage` label + confidence cap is the proportionate response.

**All values are frozen in code.** Changing them requires a code change + re-validation (analogous to `DETECTOR_VERSION` discipline in `verifiedAnomalies.js`).

---

## 4. Failure rules (explicit)

The coverage evaluator returns specific failure codes. Each maps to one of three escalation levels:

| Failure code | Trigger | Escalation |
|---|---|---|
| `empty_interpretations_with_verified_anomalies` | LLM submitted `[]` while engine produced ≥1 anomaly | **FAIL_CLOSED** |
| `uncovered_high_severity:<id>` | High-severity anomaly has no matching `anomaly_id` in interpretations | **FAIL_CLOSED** |
| `uncovered_medium_severity:<id>` | Medium-severity anomaly uncovered | unsafe_incomplete_coverage, cap=medium |
| `low_severity_coverage_below_threshold:<observed>` | Low coverage below 50% | unsafe_incomplete_coverage, cap=medium |
| `missing_recommendation:<id>` | Interpretation present but no `recommended_action` (or has empty required field) | unsafe_incomplete_coverage, cap=medium |
| `non_structured_recommendation:<id>` | `recommended_action` is a string instead of structured object | unsafe_incomplete_coverage, cap=medium |

When **fail_closed = true**:
- `output.fail_closed = true` (top-level boolean — unambiguous downstream gate)
- `safety.label = 'fail_closed_silent_omission'`
- `confidence.overall = 'low'` (hard cap)
- `safety.explanation` names the specific reason and instructs operator NOT to use the output

When **unsafe_incomplete_coverage**:
- `output.fail_closed = false`
- `safety.label = 'unsafe_incomplete_coverage'`
- `confidence.overall ≤ 'medium'` (cap applied via `applyConfidenceCap`)
- `safety.explanation` enumerates the specific coverage failures

When **partial_low_severity_uncovered**:
- Coverage gap exists ONLY in low-severity anomalies AND coverage is within the 50% threshold
- `safety.label = 'partial_low_severity_uncovered'`
- `confidence ≤ medium` (cap applied — even partial low gaps prevent `high`)

When **complete**:
- All severities at 100% (or low at ≥ 50%) AND every interpretation has a structured recommendation
- No coverage cap on confidence

---

## 5. Output shape (extended)

```jsonc
{
  "fail_closed": false,                        // ← NEW top-level gate
  "verified_anomalies": [...],
  "verified_summary": {...},
  "narrative": {
    "executive_summary": "...",
    "anomaly_interpretations": [...],
    "cross_anomaly_themes": [...],
    "prioritization_note": "..."
  },
  "coverage": {                                // ← NEW block
    "ratio": 1.0,
    "total_anomalies": 3,
    "total_interpreted": 3,
    "uncovered_anomaly_ids": [],
    "uncovered_high_severity_ids": [],
    "uncovered_by_severity": { "high": [], "medium": [], "low": [] },
    "missing_recommendation_ids": [],
    "non_structured_recommendation_ids": [],
    "coverage_failures": [],
    "coverage_safety_label": "complete",
    "applied_policy": { ... }
  },
  "integrity": {
    ...,
    "integrity_components": {
      ...,
      "coverage_ratio": 1.0,                   // ← NEW continuous component
      "coverage_failures": 1                   // ← NEW binary component
    }
  },
  "confidence": {
    "overall": "high",
    "computed_from": "...",
    "coverage_cap_applied": null               // ← NEW (null | "medium" | "low")
  },
  "safety": {
    "label": "safe",                           // ← extended enum (see §6)
    "fail_closed": false,                      // ← NEW
    "unsafe_for_high_severity": false,
    "explanation": "..."
  }
}
```

---

## 6. Safety label priority order (worst → best)

1. `fail_closed_silent_omission` — coverage failure: empty interpretations OR uncovered high severity
2. `unsafe_unsupported_claims_with_high_severity` — qualitative + high severity (from prior hardening)
3. `unsafe_incomplete_coverage` — uncovered medium / missing rec / non-structured rec / low below threshold
4. `caution_qualitative_claims_unsupported` — qualitative claims without high-severity context (from prior hardening)
5. `partial_low_severity_uncovered` — only some low-severity uncovered, within policy threshold
6. `safe` — everything passes

This is implemented as an explicit cascade in `postProcess`: the worst-applicable label wins. An operator dashboard can read `safety.label` once and know the appropriate response.

---

## 7. Omission validation results (no LLM, 9 cases)

All cases below run the real `postProcess` against the deterministic engine output for `(2026-05-03, 2026-05-10)` (3 anomalies: 1 high, 1 medium, 1 low).

| # | Scenario | fail_closed | safety.label | confidence | cap |
|---|---|---|---|---|---|
| CV0 | Control: all covered + structured | false | safe | high | null |
| CV1 | Empty `anomaly_interpretations: []` | **true** | fail_closed_silent_omission | low | low |
| CV2 | Uncovered HIGH severity | **true** | fail_closed_silent_omission | low | low |
| CV3 | Uncovered MEDIUM severity | false | unsafe_incomplete_coverage | medium | medium |
| CV4 | Uncovered LOW (1 of 1, below 50%) | false | unsafe_incomplete_coverage | medium | medium |
| CV5 | Recommendation missing on covered anomaly | false | unsafe_incomplete_coverage | medium | medium |
| CV6 | Non-structured (string) recommendation | false | unsafe_incomplete_coverage | medium | medium |
| CV7 | Mixed: HIGH + MEDIUM uncovered | **true** | fail_closed_silent_omission | low | low |
| CV8 | Structured rec present but `owner` empty | false | unsafe_incomplete_coverage | medium | medium |

**9/9 caught with the expected escalation level.**

Coverage failures inspected per case were exactly the deterministic codes (e.g. `uncovered_high_severity:customer_concentration_top3`, `non_structured_recommendation:dead_stock_present`). No silent passes.

---

## 8. Live LLM validation — 2 runs

**Input:** `{ "date_from": "2026-05-03", "date_to": "2026-05-10" }`
**Model:** `claude-haiku-4-5`

| Run | coverage.ratio | uncovered_high | rec_issues | trend/causal/time | safety | confidence | fail_closed | cost | wall |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1.0 | 0 | 0 | 0/0/0 | safe | high | false | $0.0128 | 21.9 s |
| 2 | 1.0 | 0 | 0 | 0/0/0 | safe | high | false | $0.0119 | 19.0 s |

The tightened system prompt (which now explicitly explains fail_closed semantics and the coverage policy) causes the model to reliably submit one structured interpretation per verified anomaly. The §8.1 empty-array failure mode did not recur in 2/2 runs.

**Cost note:** Input tokens grew from ~3,558 (after qualitative hardening) → 3,882 due to the longer system prompt + coverage-policy block in user message. Cost grew ~3% per run. Within sandbox budget.

---

## 9. Remaining residual risks

### 9.1 Threshold-numbers are policy decisions, not deterministic facts

The 100% / 100% / 50% thresholds are operator-chosen. Different organizations will have different views. The thresholds are configurable in code; changing them requires a code change + re-validation. There is no "right" answer — only an audit trail.

### 9.2 Non-structured-rec detection is structural, not semantic

A model could submit a structured recommendation with all fields filled in but with vapid content (e.g. `action: "x"`, `owner: "x"`, `target: "x"`, `supporting_id: "real_id"`, `time_horizon: "this_week"`). The schema validator says "complete"; the operator says "useless". This is the same surface the qualitative-integrity scanner addresses (vague-only verbs, evidence linkage); coverage hardening doesn't replace it.

### 9.3 Severity is what the engine assigned, not what the LLM thinks

Coverage requires every high-severity anomaly to be interpreted, but it doesn't enforce *quality* of the interpretation for high-severity anomalies. A perfunctory interpretation of a high passes coverage even if it under-explains the situation. The hardening addendum's qualitative scanner catches some of this (urgency claims, vague verbs) but not all.

### 9.4 Coverage doesn't cross into the engine layer

The engine is the source of truth: if the engine missed an anomaly that exists in the data, coverage is silent about that. This is by design — the engine's job is detection; coverage's job is "did the LLM faithfully interpret what the engine produced". The two layers are independent.

### 9.5 Schema-level enforcement vs runtime enforcement

The submit-tool schema doesn't have `minItems` because the required count is dynamic (= number of verified anomalies). Coverage enforcement is a *post-process* check. If a future Anthropic API change makes runtime enforcement of `minItems` possible (or a verified-count enum), we should adopt it for defense-in-depth. Until then, post-process is the only guarantee.

### 9.6 Operator-action ambiguity on `unsafe_incomplete_coverage`

When the system says "unsafe", the operator may still be tempted to use the output (especially if the executive_summary reads well). The cap on confidence to `medium` is a deterrent but not a block. Production deployment would need a UI that physically prevents action when `fail_closed: true` and warns visibly when `safety.label` starts with `unsafe_*`.

### 9.7 Cost growth from prompt size

Each hardening pass has added ~50% to the input prompt. The model is now reading ~3,882 tokens per request. If a future hardening adds 50% again, we're at ~5,800 input tokens per request, and a high-cadence production deployment becomes costlier. Tracked as a budget consideration; not a defect.

---

## 10. Verdict

> **READY_FOR_SANDBOX_EXPERIMENT_3_ARCHITECTURE**

### Justification

1. **Coverage is now a first-class integrity dimension.** It has its own deterministic policy, evaluator, output block, integrity components, confidence cap, and safety label.
2. **The §8.1 silent-omission residual is closed.** Empty `anomaly_interpretations` while verified anomalies exist now triggers `fail_closed: true`, `safety: fail_closed_silent_omission`, `confidence: low`. Operationally the same severity we'd give a fabrication.
3. **Uncovered high severity is fail_closed.** Equivalent to fabrication risk for executive-facing systems, per the user's directive.
4. **Uncovered medium / non-structured rec / missing rec are uniformly handled** as `unsafe_incomplete_coverage` with `confidence ≤ medium`.
5. **9/9 omission unit tests pass.** Each escalation level was tested with a synthetic narrative; the evaluator made the right call deterministically every time.
6. **2/2 live LLM runs are clean.** The tightened prompt (which now states the fail_closed semantics in plain language) causes the model to submit complete coverage. The empty-array case did not recur.
7. **Top-level `fail_closed: true|false` boolean** gives downstream consumers an unambiguous gate that doesn't require parsing the safety label string.
8. **Production isolation verified:** no PM2, no SAP, no scheduler, no public reach; env restored, processes stopped.

### Conditions

- Verdict authorizes **sandbox-only** advancement to **Experiment 3 architecture design** (the design step only — not yet design + implementation + validation; that would be a separate authorization).
- Does **not** authorize: production rollout of any agent, autonomous execution, PM2 integration, public exposure, scheduled runs, threshold tuning without re-validation, or live SAP integration.
- The residual risks in §9 are documented and accepted for sandbox use. Production gates listed in `experiment-2-anomaly-architecture.md` §10 still apply.

The next authorized step (when the operator decides) is **design-only** of Experiment 3 — extending the deterministic-data + LLM-interpretation pattern to one of `reportExplainer` or `salesInsights`. Until that authorization, the sandbox returns to idle.

---

## 11. Artifact pointers

| Artifact | Path |
|---|---|
| Coverage policy module (new) | `backend-sandbox/lib/coveragePolicy.js` |
| Updated agent | `backend-sandbox/agents/registry.js` (`anomalySummary`) |
| Sister policy module | `backend-sandbox/lib/sandboxPolicy.js` |
| Anomaly engine | `backend-sandbox/lib/verifiedAnomalies.js` |
| Architecture doc | `docs/architecture-review/experiment-2-anomaly-architecture.md` |
| Prior validations | `experiment-2-reliability-validation.md`, `experiment-2-reliability-hardening-addendum.md` |

Hashes and integrity values are reproducible by re-running 2 calls against the same `(date_from, date_to)` input on the same source files with the same `DETECTOR_VERSION = 1`, `sandboxPolicy.js`, and `coveragePolicy.js` (`COVERAGE_POLICY` frozen).

---

## 12. Sandbox-only declaration

This coverage hardening was conducted entirely under the sandbox runtime. It does not authorize, recommend, or imply any production deployment. The hardened anomaly summarizer remains a research artifact under controlled testing. It will remain so until the operator explicitly approves a production-readiness review against the criteria in `experiment-2-anomaly-architecture.md` §10.

---

## 13. Operational principle

Restated for the record:

> **In executive systems, omission risk is operationally equivalent to fabrication risk.**
> A summary that silently drops a high-severity anomaly is not "safer than" a summary that invents a number — the operator just doesn't know what they don't know.

This document codifies that principle into deterministic policy + enforcement.
