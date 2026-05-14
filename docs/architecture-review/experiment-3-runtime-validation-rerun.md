# Sandbox Experiment 3 — Runtime Validation Rerun (post-F1/F2/F3)

**Date:** 2026-05-10
**Status:** Rerun complete inside sandbox. Production rollout NOT authorized.
**Scope confirmation:** sandbox only, mock data only, isolated runtime (`127.0.0.1:4101`), no production runtime touched, no SAP live connectivity, no PM2 integration, no schedulers, no autonomous execution, no public exposure.

**Parent reports:**
- [experiment-3-runtime-validation.md](./experiment-3-runtime-validation.md) (the validation that produced the F1/F2/F3 recommendations)
- [experiment-3-implementation-summary.md](./experiment-3-implementation-summary.md)
- [experiment-3-report-explainer-architecture.md](./experiment-3-report-explainer-architecture.md)

**Approved fixes applied this iteration:**
- **F1** — raise per-agent `MAX_TOKENS_OUT` for `reportExplainer` from 2,000 → 3,500
- **F2** — include `unverified_numbers_in_text` in the unsafe-cascade so a fabricated number against a high-criticality backdrop labels output `unsafe_unsupported_claims_with_high_severity`
- **F3** — add a "FINAL CHECK BEFORE SUBMITTING" recency-reinforcement footer to the `reportExplainer` system prompt

**Not applied:** F4 (aggressive natural-language imperative filtering) — deliberately deferred.

---

## 1. TL;DR

| Dimension | Prior validation | Rerun (this iteration) | Direction |
|---|---|---|---|
| Determinism (verified hash, 5 runs) | 5/5 identical (`dc8c37f0fd8f`) | 5/5 identical (`dc8c37f0fd8f`) | unchanged ✓ |
| `safety: safe` distribution | 0/5 | **0/5** | **no change** ⚠ |
| `confidence: high` distribution | 0/5 | 0/5 | no change |
| Output-token utilization | **100% (cap reached)** | **71–91% (avg 80%)** | **F1 effective** ✓ |
| Recommendations submitted per run | 1–2 | **3–4** | **F1+F3 effective** ✓ |
| Coverage failures (avg per run) | 2.6 | **1.6** | **38% reduction** ✓ |
| Runs with zero coverage failures | 0/5 | **1/5** | **partial improvement** |
| Cross-agent regression (anomalySummary) | safety=unsafe (1 causal) | **safety=safe, integrity=1.0** | **regression cleared** ✓ |
| Cross-agent regression (ceoBrief) | confidence=medium | confidence=medium (within prior envelope) | no regression |
| Cost per reportExplainer run | $0.0141 | $0.0185 | +32% (expected from token-cap raise) |
| Wall per run | ~21 s | 24–34 s | +20% (longer outputs) |

**Critical finding:** every rerun flagged a quoted threshold value (`"80%"` — the high-criticality boundary for `completion_rate_pct`) as an "unverified number". The threshold value IS deterministic engine-side data (in `kpi.thresholds.high_below = 80`) but `collectReportValueSet` does not currently harvest threshold numerics into the value set. **The LLM was correct; the integrity scanner was overstrict.** F2 then escalated all 5 runs to `unsafe_unsupported_claims_with_high_severity` based on a value-set indexing gap, not a real fabrication.

**This is a defect in the value-set indexing layer, not an LLM behavior issue.** Fixing it is a small targeted change (~5 lines in `lib/verifiedReport.js → collectReportValueSet`).

**Verdict:** `REPEAT_RUNTIME_VALIDATION_AFTER_FIX` — proposed F4 (threshold-indexing fix in value-set collector) and F5 (record-level recommendation acceptance for parent section coverage). See §10.

---

## 2. Files modified this iteration

| File | Change | Backwards compatibility |
|---|---|---|
| `backend-sandbox/agents/runtime.js` | Added optional `maxTokensOut` parameter to `runAgent`; honored by `runAgentDef` from `agent.maxTokensOut`; budget pre-flight uses effective value; hard ceiling at 8192 | YES — agents without `maxTokensOut` field continue to use `config.MAX_TOKENS_OUT` |
| `backend-sandbox/agents/registry.js` (`reportExplainer` only) | (a) added `maxTokensOut: 3500`; (b) F2 cascade extension: `has_unsafe_claims` includes `unverified_numbers_in_text.length > 0`; (c) updated `safety_explanation` to enumerate which unsupported-claim categories triggered; (d) F3 recency-reinforcement footer (~50 lines) appended to `systemPrompt` | OTHER agents (`anomalySummary`, `ceoBrief`, `salesInsights`) untouched |

No engine files modified. No coverage-policy files modified. No `sandboxPolicy.js` change.

---

## 3. Determinism (rerun)

5 identical inputs (`{ "run_id": 1001 }`) produced 5 identical verified-block hashes:

| Run | Hash | Match prior validation? |
|---|---|---|
| det-1 | `dc8c37f0fd8f` | YES |
| det-2 | `dc8c37f0fd8f` | YES |
| det-3 | `dc8c37f0fd8f` | YES |
| det-4 | `dc8c37f0fd8f` | YES |
| det-5 | `dc8c37f0fd8f` | YES |

**Hash matches the prior validation's `dc8c37f0fd8f` exactly.** F1/F2/F3 did not touch the deterministic engine; the verified data block is unchanged. ✓

---

## 4. Safety distribution (rerun)

| Label | count |
|---|---|
| `fail_closed_silent_omission` | 0/5 |
| `unsafe_unsupported_claims_with_high_severity` | **5/5** |
| `unsafe_incomplete_coverage` | 0/5 |
| `caution_qualitative_claims_unsupported` | 0/5 |
| `partial_low_severity_uncovered` | 0/5 |
| `safe` | **0/5** |

Compare to prior validation:

| Label | Prior 5/5 | Rerun 5/5 |
|---|---|---|
| `unsafe_unsupported_claims_with_high_severity` | 3/5 | **5/5** |
| `unsafe_incomplete_coverage` | 2/5 | 0/5 |
| `safe` | 0/5 | 0/5 |

**Confidence distribution:** rerun 5/5 medium; prior 5/5 medium. No change at the operational-trust level.

---

## 5. Per-run integrity detail

| Run | safety | conf | integrity_score | sec_cov | rec_cov | cov_failures | trend/causal/time | unverified_nums | recs[] | tokens_out / cap | cost |
|---|---|---|---|---|---|---|---|---|---|---|---|
| det-1 | unsafe_uns_high | medium | 0.94 | 1.00 | 1.00 | 2 | 0/0/0 | 4 (all "80%") | 4 | 3,178 / 3,500 (91%) | $0.0205 |
| det-2 | unsafe_uns_high | medium | 0.88 | 1.00 | 1.00 | 2 | 0/1/0 | 2 (both "80%") | 3 | 2,485 / 3,500 (71%) | $0.0170 |
| det-3 | unsafe_uns_high | medium | 0.88 | 1.00 | 1.00 | **0** | 0/1/0 | 4 (all "80%") | 4 | 2,720 / 3,500 (78%) | $0.0182 |
| det-4 | unsafe_uns_high | medium | 0.94 | 1.00 | 1.00 | 2 | 0/0/0 | 4 (all "80%") | 3 | 2,764 / 3,500 (79%) | $0.0184 |
| det-5 | unsafe_uns_high | medium | 0.88 | 1.00 | 1.00 | 2 | 0/1/0 | 1 ("80%") | 3 | 2,776 / 3,500 (79%) | $0.0185 |

**Run det-3 had ZERO coverage_failures.** The model met the recommendation-per-high-section bar in that run — but the F2 cascade still escalated the run because of the unverified-number ("80%") trigger.

---

## 6. F1 effectiveness — token utilization

Prior validation: every reportExplainer run hit `tokens_out = 2,000` (the cap).

Rerun:

| Run | tokens_out | % of 3,500 cap | cap reached? |
|---|---|---|---|
| det-1 | 3,178 | 91% | no (322 head-room) |
| det-2 | 2,485 | 71% | no |
| det-3 | 2,720 | 78% | no |
| det-4 | 2,764 | 79% | no |
| det-5 | 2,776 | 79% | no |

Average: 2,785 tokens (80% of cap). **No run hit the new ceiling.** The "missing recommendation" failure mode is no longer caused by token starvation. The remaining missing-rec issues (4/5 runs flagged 2 each) are caused by the LLM choosing to bind recommendations to **record_ids** rather than **section_ids** of the parent high-criticality section. See §7.

**F1 verdict: effective.** The token cap is no longer the bottleneck.

---

## 7. F3 effectiveness — recommendation count

Prior validation: 1–2 recommendations per run.
Rerun: 3–4 recommendations per run.

| Run | recommendations[] count | high sections this fixture | high sections covered (via supporting_id == section_id) |
|---|---|---|---|
| det-1 | 4 | 3 (run_summary, flagged_stops, customer_impact) | 1 (run_summary) — 2 missing flagged + 2 missing failure_breakdown ref |
| det-2 | 3 | 3 | 1 (run_summary) — 2 missing |
| det-3 | 4 | 3 | **3** (all covered with section-id supporting_id) |
| det-4 | 3 | 3 | 1 — 2 missing |
| det-5 | 3 | 3 | 1 — 2 missing |

The model produced more recommendations (F3 helped) but **frequently bound them to record_ids** like `stop_5003` or `customer_mock_customer_gamma_ltd` instead of the parent section_ids. The current coverage check requires `supporting_id == high_section_id` to count.

**Spot-check (det-1 best-quality run):**

```
• supporting_id=stop_5003                          time_horizon=immediate
  owner: נהג / מנהל צי
  target: stop_5003 (Mock Customer Gamma Ltd, Herzliya)
  action: צור קשר טלפוני מיידי עם Mock Customer Gamma Ltd...
• supporting_id=run_summary                        time_horizon=this_week
  owner: מנהל סבבים / תכנן מסלולים
  ...
• supporting_id=customer_mock_customer_gamma_ltd   time_horizon=today
  owner: טיפול בלקוחות / מכירות
  ...
• supporting_id=failure_breakdown                  time_horizon=this_week
  owner: מנהל סבבים
  ...
```

The recommendations themselves are operationally **better** than prior — concrete owners, concrete targets, canonical time horizons, structured content. The model is doing meaningful work. The coverage check is treating record-level recommendations as separate from their parent section, which is **debatable as a design choice**, not a model failure.

**F3 verdict: directionally effective.** The model produces better and more recommendations. Coverage check needs a small refinement (see §10 F5) before this counts as "safe".

---

## 8. F2 effectiveness — unverified-number escalation

F2 caused all 5 runs to be labeled `unsafe_unsupported_claims_with_high_severity`. The integrity layer correctly applied the cascade.

But the *trigger* was not what F2 was designed to catch:

- Prior validation expectation: F2 would catch fabricated numerical claims (e.g., "$9,876,543 estimated damage" from synthetic test T2.3).
- Actual rerun observation: F2 fired on every quoted instance of `"80%"`, which is the verified threshold value `THRESHOLDS.completion_rate_pct.high_below = 80`.

The threshold IS deterministic engine-side data and IS exposed in the user message (`kpi.thresholds`). The LLM is doing the right thing by quoting it as the bar against which actual completion (66.67%) is judged. The integrity scanner doesn't see "80" in `valueSet.numbers` because `collectReportValueSet` only harvests:
- `kpi.value` (numeric)
- `record` field numerics (`stop_id`, `stop_count`, `failed_count`)
- `summary` counts

**It does NOT harvest:** `kpi.thresholds.high_below`, `kpi.thresholds.medium_below`, `kpi.thresholds.low_below`.

**This is an indexing gap in `collectReportValueSet`, not an LLM hallucination.** F2 is firing correctly given the inputs it has, but the inputs are incomplete.

**F2 verdict: mechanically effective (the cascade fires when triggered) but currently dominated by a value-set bug.** Fixing the value-set will let F2 do what it was designed for: catch *real* fabricated numbers.

---

## 9. Cross-agent regression (rerun)

### 9.1 anomalySummary

| Metric | Prior validation | Rerun | Direction |
|---|---|---|---|
| safety | unsafe_unsupported_claims_with_high_severity (1 causal) | **safe** | improved ✓ |
| confidence | medium | **high** | improved ✓ |
| integrity_score | 0.92 | **1.0** | improved ✓ |
| coverage_ratio | 1.0 | 1.0 | unchanged |
| coverage_failures | 0 | 0 | unchanged |
| cost | $0.0123 | $0.0116 | comparable |

The single causal claim observed in the prior validation did not recur. anomalySummary is stable and clean. **No regression introduced by F1/F2/F3.** ✓

### 9.2 ceoBrief

| Metric | Prior validation | Rerun |
|---|---|---|
| integrity_score | 0.75 | 0.75 |
| confidence | medium | medium |
| unverified_nums | 2 | 3 |
| sources_completeness | 1.0 | 1.0 |
| schema_coercions | empty | (assumed empty — no errors) |
| cost | $0.0128 | $0.0128 |

ceoBrief is within its prior validation envelope. No regression. ✓

---

## 10. Remaining residual risks + proposed fixes

### 10.1 Threshold values not in verified value-set (NEW finding — primary cause of "0/5 safe")

**Symptom:** every run flags `"80%"` as unverified. "80" is the deterministic threshold from `THRESHOLDS.completion_rate_pct.high_below`. The LLM correctly quoted it. The integrity scanner doesn't see it as verified.

**Proposed F4 (small fix, sandbox only):**

In `backend-sandbox/lib/verifiedReport.js → collectReportValueSet`, extend the KPI-walk to harvest threshold numerics:

```js
for (const k of (sec.kpis || [])) {
  if (k.id) strings.add(k.id);
  if (typeof k.value === 'number') numbers.add(k.value);
  // NEW — index threshold values:
  if (k.thresholds && typeof k.thresholds === 'object') {
    for (const v of Object.values(k.thresholds)) {
      if (typeof v === 'number') numbers.add(v);
    }
  }
}
```

~5 lines. No design change — it's a correctness fix to the value-set indexer.

### 10.2 Record-level recommendations not counted toward parent-section coverage

**Symptom:** runs det-1, det-2, det-4, det-5 each had 3–4 structured recommendations but `missing_recommendation_for_high_section:flagged_stops` and `missing_recommendation_for_high_section:customer_impact` still flagged because the recommendations bound to specific record_ids (stop_5003, customer_mock_customer_gamma_ltd) instead of section_ids.

The current rule is too strict: it doesn't credit a recommendation that targets a record inside a high-criticality section as covering that section.

**Proposed F5 (small fix, sandbox only):**

In `backend-sandbox/lib/reportCoveragePolicy.js → evaluateReportCoverage`, when computing `recsBySupportingId`, also include the parent section_id of any record_id supporting_id:

```js
const recsBySupportingId = new Set();
for (const r of recommendations) {
  if (!r || !r.supporting_id) continue;
  recsBySupportingId.add(r.supporting_id);
  // NEW — if supporting_id is a record_id, credit its parent section_id too
  for (const sec of sections) {
    if ((sec.records || []).some((rec) => rec.record_id === r.supporting_id)) {
      recsBySupportingId.add(sec.id);
    }
  }
}
```

~7 lines. This is a coverage-rule refinement, not a weakening — operator intent ("address the failed stop") is reasonably interpreted as addressing the section that surfaces it.

### 10.3 Causality drift (3/5 runs had 1 causal claim each)

**Symptom:** model uses causal phrases ("בגלל", "נובע") in narrative without anchoring to a verified id or verbatim `failure_reason_label_he`. Same as prior validation; F1/F2/F3 didn't address it.

**Defer to future hardening.** F4 (causality phrase-list expansion) was deliberately deferred per user directive. Operator review remains the gate.

### 10.4 Sanitizer is partial (residual from prior validation)

Unchanged from prior. Documented as a production blocker.

### 10.5 LLM behavior is variable

det-3 produced zero coverage failures while the other 4 produced 2 each. The schema and prompt are identical across runs; the variance is model-side. Increasing temperature settings or running multiple samples and selecting are options outside the architecture's scope.

---

## 11. Was token starvation the dominant root cause? (the user's core diagnostic question)

**Answer: partially, yes — and the rerun isolated the diagnosis.**

| Failure mode in prior validation | Root cause | F1+F3 fixed? |
|---|---|---|
| "missing recommendation for X high section" (5/5 runs) | Token starvation + prompt clarity | **Partially** — recs went from 1–2 → 3–4 per run. |
| "unverified numbers" (5/5 runs) | The LLM correctly quotes `THRESHOLDS.completion_rate_pct.high_below = 80` but the value-set indexer does not include it. **NOT a token issue.** | No (and not what F1/F2/F3 targeted) |
| "causality_claims" (3/5 runs) | LLM behavior — uses causal phrases without anchoring. **NOT a token issue.** | No (deferred) |

So token starvation was a *contributor* to the recommendation-completeness failure, but **the persistent "0/5 safe" outcome is now driven by a different pair of issues**: an indexing gap (§10.1) and a coverage-rule strictness (§10.2). Both are small, mechanical fixes — not LLM-behavior speculation.

**This is the architecture working as designed.** The rerun isolated the next bottleneck once the previous bottleneck (token cap) was removed. The integrity layer kept catching everything; the operator now has a clean view of what to fix next.

---

## 12. Validation objectives — met / unmet

| Objective | Status | Note |
|---|---|---|
| At least some runs reach `safety: safe` | **NOT MET** | 0/5; root cause is value-set indexing + coverage strictness (§10.1 + §10.2) |
| No regression in integrity enforcement | MET | every violation correctly caught |
| No regression in fail_closed behavior | MET | fail_closed not triggered (synthetic suite still confirms it works) |
| No regression in causality enforcement | MET | causal_safe_phrases extension working; 3/5 runs caught for un-anchored causal phrases |
| No regression in cross-agent stability | **MET** | anomalySummary improved to safe+high; ceoBrief unchanged |

The primary success criterion (**at least some runs reach `safety: safe`**) is **NOT met**, but the failure mode is now mechanically diagnosable.

---

## 13. Cost and latency

| Run | Cost | Wall |
|---|---|---|
| det-1 | $0.0205 | 33.1 s |
| det-2 | $0.0170 | 24.5 s |
| det-3 | $0.0182 | 28.4 s |
| det-4 | $0.0184 | 28.4 s |
| det-5 | $0.0185 | 28.2 s |
| **avg** | $0.0185 | 28.5 s |

Compared to prior validation ($0.0141 / 21 s), cost is up 32% and wall is up 36%. Both are direct consequences of F1 (larger output budget = larger output = more in/out tokens). Within sandbox per-run budget ($0.50). Daily-budget consumed: ~1.9% of $5.

Cross-agent regression total: $0.0244 (anomaly $0.0116 + ceo $0.0128). 8 LLM calls total: **$0.115**, comparable to prior validation's $0.110.

---

## 14. Production isolation verification

After all rerun activity:

| Check | Status |
|---|---|
| Sandbox bound to 127.0.0.1:4101 only | YES |
| Sandbox process killed | YES (port 4101 free) |
| `.env.sandbox` `ANTHROPIC_API_KEY=` empty | YES |
| Mock data unchanged | YES (no fixture modifications during rerun) |
| `.bak*` files removed | YES |
| Production runtime modified | NO |
| PM2 disturbed | NO |
| SAP connectivity | NO (no tools) |
| Public exposure | NO |
| Schedulers / cron | NO |
| Operator notifications sent | NO |

---

## 15. Final recommendation

> **REPEAT_RUNTIME_VALIDATION_AFTER_FIX**

### Why not READY_FOR_SANDBOX_EXPERIMENT_4

0/5 runs reached `safety: safe`. While the architecture caught every violation correctly, the operating point still doesn't produce clean outputs. Generalizing to Experiment 4 would build on a baseline that systematically labels every report `unsafe_*` — a poor foundation for a generalization claim.

### Why not SANDBOX_RUNTIME_FIX_REQUIRED or STOP_AI_WORK

The architecture is sound. F1+F3 produced their intended improvements (token cap raised, recommendations grew from 1–2 → 3–4 per run). F2 mechanically works. The remaining gap is two **specific, small, low-risk implementation fixes** (§10.1, §10.2) that complete the value-set indexing and coverage-rule semantics promised in the design.

### Proposed next iteration (sandbox-only, awaiting authorization)

| # | Fix | Scope | Estimated lines |
|---|---|---|---|
| F4 | Index `kpi.thresholds.*` numeric values into `valueSet.numbers` in `collectReportValueSet` | `lib/verifiedReport.js` | ~5 |
| F5 | Coverage check: a recommendation whose `supporting_id` is a record_id of a high-criticality section's records counts toward that section's coverage | `lib/reportCoveragePolicy.js` | ~7 |

After F4+F5, repeat the validation suite. Expected outcome (based on the failure-mode breakdown):
- Run det-3 baseline: 0 coverage_failures + 0 unverified (after F4) + 1 causal claim → still `unsafe_unsupported_claims_with_high_severity` (causal residual). 4/5 runs would still trip on that residual.
- Runs det-1, det-4 baseline: 0 unverified (after F4) + 0 trend/causal/time + 0 coverage_failures (after F5) → **`safety: safe`**, **`confidence: high`**.
- Predicted distribution: 2–3 runs `safe`, 2–3 runs `unsafe_unsupported_claims_with_high_severity` (causal). At minimum, ≥1 reaches `safe`.

If the prediction holds, the architecture is ready for Experiment 4 design generalization.

If after F4+F5 the distribution still shows 0/5 `safe`, deeper revisits would be needed (causality phrase set, prompt re-engineering, possibly a different model). At that point the verdict would shift to `SANDBOX_RUNTIME_FIX_REQUIRED`.

---

## 16. Architectural disciplines preserved

The user directive emphasized: *"In executive systems, refusing unsafe output is preferable to producing persuasive incomplete output."*

| Discipline | Preserved this iteration |
|---|---|
| Determinism | YES — engine output byte-identical to prior validation |
| fail_closed semantics | YES — synthetic suite still confirms; live runs didn't trigger it |
| Coverage policy | YES — refinement proposed in §10.2, not weakened |
| Confidence governance | YES — chained caps still apply; no run claimed unwarranted high confidence |
| Structured outputs | YES — schema enforced; recommendations structured in all 5 runs |
| Qualitative integrity scans | YES — causal claims caught, unverified numbers caught (even if some catches were false positives due to §10.1) |
| Top-level operational gate | YES — `fail_closed: bool` semantics intact |
| Cross-agent stability | YES — anomalySummary improved (safe + high); ceoBrief unchanged |

The architecture continues to behave as a *brake*, not a propeller. Every "unsafe" label this iteration was the system telling the operator something the operator should know — even when one of those things was a value-set indexing gap.

---

## 17. Sandbox-only declaration

This rerun was conducted entirely under the sandbox runtime constraint:
- Sandbox bound to `127.0.0.1:4101` only — never publicly exposed
- No production runtime modified
- No PM2 process disturbed
- No SAP connectivity
- No scheduler / cron created
- Anthropic API key injected from `backend/.env` for the rerun, restored to empty post-rerun
- No mock data modified during rerun (driver-note injection test was prior validation only)
- Sandbox process killed; port 4101 confirmed free

After this report, the sandbox returns to idle.

---

## 18. Cross-references

- **Prior validation:** `experiment-3-runtime-validation.md`
- **Implementation summary:** `experiment-3-implementation-summary.md`
- **Architecture:** `experiment-3-report-explainer-architecture.md`
- **Modified files this iteration:**
  - `backend-sandbox/agents/runtime.js` (per-agent maxTokensOut plumbing)
  - `backend-sandbox/agents/registry.js` (reportExplainer F1+F2+F3)
- **Untouched files:**
  - `backend-sandbox/lib/verifiedReport.js`
  - `backend-sandbox/lib/reportCoveragePolicy.js`
  - `backend-sandbox/lib/sandboxPolicy.js`
  - `backend-sandbox/lib/coveragePolicy.js`
  - `backend-sandbox/lib/verifiedAnomalies.js`
  - `backend-sandbox/lib/verifiedMetrics.js`

---

## 19. Operational principle

Restated:

> **In executive systems, refusing unsafe output is preferable to producing persuasive incomplete output.**

The rerun honors this. 0/5 outputs were claimed `safe` because the integrity layer correctly identified concerns. Two of those concerns turned out to be implementation gaps (§10.1, §10.2) rather than LLM hallucinations — and that's exactly the kind of thing the architecture is supposed to surface. The architecture is functioning. The operating point is two small fixes away from stable.

---

## 20. End of rerun phase

Validation rerun complete. The sandbox returns to idle.

No further action without explicit operator authorization for F4+F5 + a third re-validation pass, OR a different direction.
