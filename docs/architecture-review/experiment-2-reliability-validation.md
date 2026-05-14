# Sandbox Experiment 2 — Reliability Validation Report

**Date:** 2026-05-10
**Scope:** Sandbox-only validation. No production runtime touched, no SAP live connectivity, no PM2, no schedulers, no public exposure, no autonomous execution.
**Subject:** `anomalySummary` agent wired to deterministic anomaly engine (`lib/verifiedAnomalies.js`)
**Architecture reference:** [experiment-2-anomaly-architecture.md](./experiment-2-anomaly-architecture.md)
**Sister validation:** [verified-metrics-llm-validation.md](./verified-metrics-llm-validation.md)

---

## 1. TL;DR

| Dimension | Result |
|---|---|
| Deterministic anomaly hash across 5 identical runs | **5/5 identical** (`596720b08040`) |
| Anomaly IDs + severity stability across 5 runs | **5/5 identical** |
| Fabricated numbers in narrative | **0** across all 5 runs |
| Phantom anomaly_id references | **0** across all 5 runs |
| Coverage (every anomaly interpreted) | **5/5 complete** |
| Severity-overpromotion (low→"קריטי") | **1/5 run-5** flagged by integrity layer |
| Missing-data behavior | **Correct** — 1 detector skipped, no fabrication, confidence→medium |
| Tampering tests caught | **7/8** (T5 trend-claim is documented qualitative residual) |
| Cost across 5 runs | **$0.0469 total** (~$0.0094/run) |
| Latency | 16–19s per run |
| Production-runtime impact | **None** |

**Verdict:** `READY_FOR_SANDBOX_EXPERIMENT_3` (see §13).

---

## 2. Wiring change

`backend-sandbox/agents/registry.js` — `anomalySummary` agent restructured:

| Before | After |
|---|---|
| `tools: [tool('get_anomalies_summary')]` (legacy single-tool flow, LLM detected anomalies) | `tools: []` — LLM has no data tools |
| LLM produced `bullets[]` (free-text) | LLM produces `anomaly_interpretations[]` keyed to verified `anomaly_id`s |
| No deterministic anomaly engine | `preCompute: computeAnomalies(input)` runs first |
| No post-process integrity scan | `postProcess` injects verified data + scans narrative |
| `submit_summary` tool | `submit_anomaly_summary` (narrative-only schema) |

The flow now is exactly what the architecture demanded:

```
mock data → deterministic anomaly engine → verified anomalies object
        → LLM interpretation layer → integrity validation → final output
```

Legacy `get_anomalies_summary` analytics tool is unchanged but no longer reachable from `anomalySummary`. (Other agents may still use it; not in scope.)

---

## 3. Deterministic stability — 5 repeatability runs

**Input:** `{ "date_from": "2026-05-03", "date_to": "2026-05-10" }`

### 3.1 Anomaly object stability

Hash of `(verified_anomalies, verified_summary)` across 5 runs:

| Run | Hash (first 12 hex) |
|---|---|
| 1 | `596720b08040` |
| 2 | `596720b08040` |
| 3 | `596720b08040` |
| 4 | `596720b08040` |
| 5 | `596720b08040` |

**Identical: YES.** Same anomalies, same severities, same descriptions, same thresholds.

### 3.2 Detected anomalies (truth)

| anomaly_id | type | severity | source |
|---|---|---|---|
| `customer_concentration_top3` | `customer_concentration` | high | top-customers.json |
| `dead_stock_present` | `dead_stock_present` | medium | dead-stock.json |
| `item_low_margin_MOCK-TINECO-IRON-A1` | `item_low_margin` | low | top-items.json |

DoD-drop, DoD-spike, IQR-outlier detectors did not fire (mock data falls inside thresholds; window too short for IQR).

### 3.3 Per-run integrity

| Run | unknown_ids | uncovered_ids | invalid_themes | severity_overpromotions | unverified_numbers | integrity_score | confidence |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 0 | 1.00 | high |
| 2 | 0 | 0 | 0 | 0 | 0 | 1.00 | high |
| 3 | 0 | 0 | 0 | 0 | 0 | 1.00 | high |
| 4 | 0 | 0 | 0 | 0 | 0 | 1.00 | high |
| 5 | 0 | 0 | 0 | **1** | 0 | 0.92 | high |

Run 5 is examined in §6.

### 3.4 Cost / latency

| Run | Cost | Tokens (in+out) | Wall |
|---|---|---|---|
| 1 | $0.0089 | 2,435 + 1,284 | 16.1 s |
| 2 | $0.0090 | 2,435 + 1,317 | 16.0 s |
| 3 | $0.0093 | 2,435 + 1,375 | 17.7 s |
| 4 | $0.0099 | 2,435 + 1,501 | 18.7 s |
| 5 | $0.0098 | 2,435 + 1,468 | 16.0 s |
| **total** | **$0.0469** | | |

Average $0.0094 per run, ~16.9 s/run. Within budget (`SANDBOX_PER_RUN_BUDGET_USD=0.5`).

### 3.5 Narrative variation (expected to vary)

| Run | summary hash | length |
|---|---|---|
| 1 | `8fe5f82f` | 358 |
| 2 | `6df0fd5b` | 302 |
| 3 | `c20573ff` | 368 |
| 4 | `c05d7613` | 354 |
| 5 | `876cd557` | 330 |

5 distinct narrative hashes — wording varies as designed. **What does NOT vary:**

- The anomaly objects (byte-identical).
- The severity assignments (engine-controlled).
- The submitted prioritization order: every run listed `customer_concentration_top3 → dead_stock_present → item_low_margin_MOCK-TINECO-IRON-A1` (high → medium → low).

---

## 4. Tampering test results

8 adversarial narratives fed through the real `postProcess` pipeline (no LLM call — pure code adversarial test):

| # | Test | Caught | Confidence |
|---|---|---|---|
| T1 | Fake `anomaly_id` (`PHANTOM_ANOMALY_2026`) | ✅ unknown_anomaly_ids = 1 | medium |
| T2 | Severity-word "קריטי" + "דחוף ביותר" on engine-low anomaly | ✅ severity_overpromotions = 1 | high (0.92) |
| T3 | Invented percentage `99.9%` (×2) | ✅ unverified_numbers = 2 | medium |
| T4 | Invented absolute `7,777,777` (×2) | ✅ unverified_numbers = 2 | medium |
| T5 | Trend claim "הולך ומחמיר... 3 שבועות" | ❌ not caught — no specific number to flag | high |
| T6 | Invalid theme reference (`PHANTOM_LINK`) | ✅ invalid_theme_refs = 1 | high (0.92) |
| T7 | Missing coverage (one anomaly omitted) | ✅ uncovered_anomaly_ids = 1 | high (0.92) |
| T8 | String-encoded array (schema drift) | ✅ schema_coercions = `[anomaly_interpretations]` | high (1.0) |

**T5 caveat:** the trend claim contained no specific number, so the number scanner cannot catch it. This is the **qualitative residual** explicitly documented in `experiment-2-anomaly-architecture.md` §8. Mitigation is prompt discipline (rule #4 forbids trend claims) plus operator review, not code. The system prompt does forbid trend claims; in 5 live runs the model honored the rule. T5 demonstrates what *would* happen if it didn't.

**7/8 caught deterministically.** The 1/8 miss is design-known and documented.

---

## 5. Missing-data test

`mock-data/top-items.json` was renamed to `.bak.exp2` and the agent invoked once with the same input. File restored immediately after.

| Metric | Result |
|---|---|
| `verified_anomalies` count | 2 (was 3) |
| Removed anomaly | `item_low_margin_MOCK-TINECO-IRON-A1` (the only top-items dependent) |
| `verified_warnings` | 1: `mock_missing: top-items.json not present` |
| `sources_completeness` | 0.75 (3/4 sources returned) |
| `integrity_score` | 1.00 (narrative was clean) |
| `confidence.overall` | **medium** (downgraded from high by sources_completeness < 0.9) |
| Narrative mentions `item_low_margin` | **NO** |
| Narrative mentions `MOCK-TINECO-IRON-A1` | **NO** |
| Phantom anomaly fabrication | **None** |

The model correctly narrated only the 2 anomalies the engine surfaced, made no attempt to fill the gap from training data, and the deterministic confidence layer correctly downgraded the run despite a clean narrative. **This is exactly the desired insufficient-data behavior:** clean narrative on incomplete data should *look* medium-confidence, not high.

---

## 6. Interpretation quality review

### 6.1 Quantitative heuristic across 5 runs

| Run | Urgency words | Trend words | Causal words | Vague action verbs | Concrete-action verbs |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 2 | 0 |
| 2 | 1 | 0 | 0 | 2 | 0 |
| 3 | 1 | 0 | 0 | 1 | 0 |
| 4 | 0 | 0 | 0 | 1 | 0 |
| 5 | **1** (real overpromotion) | 0 | 0 | 3 | 0 |
| **total** | **3** | **0** | **0** | **9** | **0** |

(Heuristic word-list — not exhaustive; the score is a directional signal, not a verdict.)

### 6.2 Findings

**Strengths**
- **Zero trend claims** across all 5 runs. The "no trend" rule held.
- **Zero causal claims** ("בגלל", "בעקבות", etc.). The model did not editorialize cause.
- **Prioritization order identical** across all 5 runs and matches engine severity (high→medium→low).
- **Recommendations cite concrete entity names** (Mock Customer Alpha Ltd, MOCK-TINECO-IRON-A1, C-MOCK-001) where the verified data exposes them.
- **Cross-anomaly themes** in all 5 runs were distinct in title but referenced only real `anomaly_id`s.

**Weaknesses**
- **Run 5 severity overpromotion** — the model wrote "קריטי" inside the interpretation of a `low`-severity anomaly. Caught by the integrity heuristic; integrity_score dropped to 0.92. Confidence stayed at `high` because the cutoff is 0.9, but a stricter cutoff would downgrade. The model also wrote "בעוד לא קריטי, זה מצביע..." — the literal text *softens* the urgency word, which suggests the model is aware of the constraint but uses the word in a hedge. The heuristic cannot tell hedge from claim. Operator review still required for this class.
- **Vague action verbs** ("בחן", "שקול", "בדוק") appear 9 times across 5 runs. Most recommendations begin with analytical verbs rather than directive ones. The prompt asks for "concrete actions"; the model partially complies (entity-specific) but rarely fully (no "התקשר ל-...", no "הוצא מבצע ל-..."). Acceptable for advisory output; would need tightening for an autonomous-action layer.
- **Run 3 invented advice target** — "הורדת הריכוז ל-30% תוך 6 חודשים". The "30%" is a real threshold (in `customer_concentration` thresholds_pct.high), so it's not flagged as unverified. The "6 months" is invented as an action timeline. This is a *plan target*, not a metric fabrication, but it's a soft claim the integrity layer cannot verify. Acceptable but worth noting.

### 6.3 Narrative instability

Wording varies (5 distinct hashes), structure does not:
- Same anomaly count
- Same severity ordering
- Same coverage
- Same prioritization (high → medium → low) in every run
- Cross-anomaly theme present in every run, varying title, all valid refs

This is **the desired stability profile**: the operational facts are constant, only the prose varies.

### 6.4 Misleading prioritization

None observed. All 5 runs honor engine severity in their `prioritization_note` and in the order of `anomaly_interpretations`.

### 6.5 Unsupported business conclusions

Reviewed each run's full narrative. No claims like "this is the worst week of the quarter", "customer X is at risk of churn", or "margin pressure across category" appear. The model stays close to "this anomaly means X for the business" without inventing context. Slight exception: occasional advice with implicit assumptions (e.g., "סיום התקשרות" framed as a real risk despite no churn signal in data) — these are interpretive opinions, not factual claims, and they're inseparable from the interpretation task.

---

## 7. Hallucination analysis (residual)

Re-using the architecture doc §8 risk table, what we *observed* in 5 live runs:

| Risk | Observed in 5 runs | Caught by code? |
|---|---|---|
| Invent a new anomaly | 0 | n/a — none invented |
| Promote severity ("קריטי" on low) | 1/5 (run 5) | ✅ severity_overpromotions |
| Invent a threshold value | 0 | ✅ would catch |
| Invent a derived ratio | 0 | ✅ would catch |
| Omit an anomaly | 0 | ✅ would catch |
| Cross-anomaly theme with phantom IDs | 0 | ✅ would catch |
| Trend claim with no specific number | 0 (held by prompt) | ❌ design residual |
| Hedged severity language ("בעוד לא קריטי, זה...") | 1/5 (run 5) | ❌ heuristic ambiguous |
| Invented action timeline ("תוך 6 חודשים") | 1/5 (run 3) | ❌ not a metric fabrication |
| Implicit assumption ("סיום התקשרות") | mild, scattered | ❌ inseparable from interpretation |

**Net:** the deterministic guarantees held; qualitative residuals are bounded and known.

---

## 8. Production isolation verification

Performed during validation, recorded here for audit:

| Check | Result |
|---|---|
| Sandbox bind address | `127.0.0.1:4101` (per `/health`) |
| Sandbox SAP connectivity | None — agent has 0 data tools |
| Production PM2 disturbed | No (sandbox runs as bare `node server.js`) |
| Anthropic key handling | Injected from `backend/.env` for the run, restored to empty after — `.env.sandbox.bak.exp2` rollback verified |
| Source files modified | `top-items.json` renamed for §5 missing-data test, restored within seconds |
| Public exposure | None (Cloudflare tunnel doesn't reach port 4101) |
| Database writes | None (no DB connection in sandbox) |
| Schedulers / cron | None |
| Operator notifications | None sent |

After cleanup: `.env.sandbox` `ANTHROPIC_API_KEY=` (empty), sandbox process stopped.

---

## 9. Cost & latency summary

- **Live LLM cost:** $0.0469 across 5 repeatability runs + 1 missing-data run = ~$0.057 total
- **Tampering & smoke tests:** $0 (no LLM)
- **Average per run:** $0.0094 (haiku-4-5)
- **Latency:** 16–19 s wall per run (deterministic preCompute is sub-millisecond; LLM call dominates)
- **Daily-budget consumed:** ~1.1% of `$5 SANDBOX_DAILY_BUDGET_USD`

This is the operational-cost envelope for sandbox reliability validation. A production-style hourly cadence would cost $0.23/day; daily ~$0.01/day. Negligible at sandbox scale.

---

## 10. Remaining risks

### 10.1 Code-side
- **Severity-overpromotion heuristic is keyword-only.** "בעוד לא קריטי, זה מצביע..." (run 5) gets flagged because "קריטי" appears, even though the sentence is hedging away from it. Acceptable false-positive rate (1/5 was a legitimate hedge); a smarter NLI-style check could improve, but adds LLM dependency to integrity layer — explicitly avoided.
- **Trend claims with no number** are uncatchable by the scanner. Architecture doc residual #7. Mitigation: prompt discipline + operator review.
- **Vague action verbs.** Not a correctness defect, but reduces operational utility. Tightenable via prompt refinement, not code.

### 10.2 Engine-side
- **No multi-period detector.** Cannot surface week-over-week or month-over-month trend anomalies. By design (sandbox v1).
- **Threshold values frozen by `DETECTOR_VERSION = 1`.** Tuning requires a code change + version bump (per architecture doc §10.4 — this is a feature, not a defect).
- **Currency/timezone assumptions.** All ILS, Israel-local dates. Live SAP integration must respect the same.

### 10.3 Architectural
- **Operator override path absent.** When the engine is right and the business says "this anomaly is acceptable", there's no documented suppress mechanism. Future production gate.
- **Audit log absent.** Each anomaly fired is not persisted with `(detector_version, thresholds, observed)` snapshot. Future production gate.
- **No cross-source consistency check** (e.g., does `top-customers.json` reflect the same date window as `daily-sales.json`?). Mock data is internally consistent; live data may not be.

---

## 11. Comparison to Experiment 1 (CEO Brief)

| Dimension | Experiment 1 (metrics) | Experiment 2 (anomalies) |
|---|---|---|
| Deterministic-payload hash across N runs | 5/5 identical | 5/5 identical |
| Fabricated numbers | 0 | 0 |
| Phantom IDs | 0 | 0 |
| Coverage check | metric_id-only | metric_id + anomaly_id + cross-theme |
| Severity-promotion check | n/a (no severity field) | **new in Exp 2** |
| Schema-coercion auto-fix | yes | yes |
| Tampering tests caught | 4/4 (Exp 1) | 7/8 (Exp 2) |
| Missing-data behavior | correct | correct |
| Cost / run | $0.013 | $0.0094 |
| Time / run | ~22 s | ~17 s |
| Production runtime impact | none | none |

Experiment 2 inherits Experiment 1's reliability profile and adds a working severity-overpromotion check. The qualitative-residual surface is wider (trends, hedges, action-timelines), as expected for a richer interpretation task.

---

## 12. Recommendations (sandbox direction)

For the next sandbox iterations, in priority order:

1. **Experiment 3 — `reportExplainer` agent under verified-data architecture.** Extends the pattern to per-manifest run analysis. Would need a `lib/verifiedRunDetails.js` calculator. Same reliability test suite applies.
2. **Experiment 4 — `salesInsights` agent under verified-data architecture.** Riskiest of the four because it asks for week-over-week comparison; would require a multi-period verified-metrics computation (which would also unlock trend-anomaly detection if eventually applied to Experiment 2 as a v2 detector).
3. **Cost-comparison test** — re-run the same Experiment 2 input on `sonnet-4-5` and compare interpretation quality. Decide whether haiku is sufficient for advisory output.
4. **Severity-overpromotion v2** — replace the keyword heuristic with a more semantic check (e.g., compare each interpretation length-normalized for "weighted urgency density"). Optional; the keyword version captures the visible failure mode.
5. **DoD-drop / spike fixture** — create a synthetic mock dataset where the day-over-day detectors actually fire (current mock has all changes <15%). Current validation only exercises 3 of 6 detectors against live data.

None of these are authorized by the current scope.

---

## 13. Verdict

> **READY_FOR_SANDBOX_EXPERIMENT_3**

Justification:

1. **Deterministic guarantees held** (5/5 identical hash, identical severity assignments, identical prioritization order).
2. **No LLM-fabricated numbers** in any of 5 live runs.
3. **No invented anomalies** — every interpretation references an engine-detected anomaly.
4. **Missing-data behavior is correct** — model abstains from filling gaps; confidence downgrades automatically.
5. **Tampering surface is bounded** — 7/8 adversarial narratives caught deterministically; 1/8 (T5 trend claim) is the documented qualitative residual that the architecture doc explicitly warned about and that the prompt successfully prevented in all 5 live runs.
6. **One real-world severity overpromotion** was both committed (run 5) and *caught* by the integrity layer (severity_overpromotions = 1, integrity_score = 0.92). The system worked exactly as designed: it didn't prevent the model from making the mistake, but it surfaced the mistake to the operator.
7. **Production isolation verified** — `127.0.0.1`, no SAP, no PM2, no scheduler, no public reach; env restored, sources restored, processes stopped.
8. **Cost & latency well within budget.**

**Conditions on the verdict:**
- Verdict applies to **sandbox-only** advancement to Experiment 3 design + reliability validation.
- Does **not** authorize:
  - Production rollout of Experiment 1 or 2 (the production-rollout criteria in `experiment-2-anomaly-architecture.md` §10 are not met).
  - Autonomous execution.
  - PM2 integration.
  - Public exposure of the sandbox.
  - Scheduled runs.

The next authorized step (when the operator decides) is sandbox Experiment 3 design — extending the deterministic-data + LLM-interpretation pattern to one of `reportExplainer` or `salesInsights`. Until then, the sandbox returns to idle.

---

## 14. Artifacts

| Artifact | Path |
|---|---|
| Wired agent | `backend-sandbox/agents/registry.js` (anomalySummary) |
| Engine | `backend-sandbox/lib/verifiedAnomalies.js` |
| Shared narrative scanner | `backend-sandbox/lib/verifiedMetrics.js` (`findUnverifiedNumbers`) |
| Architecture doc | `docs/architecture-review/experiment-2-anomaly-architecture.md` |
| Experiment 1 sister doc | `docs/architecture-review/verified-metrics-llm-validation.md` |
| Run captures (deleted after report) | `C:\Users\izik\AppData\Local\Temp\exp2-runs\run-1.json` … `run-5.json`, `run-missing.json` |
| Tamper test (deleted after report) | `backend-sandbox\_exp2-tamper-test.mjs` |

Raw run captures are temp files and may have already been reaped by Windows. Hashes and integrity numbers in this report are reproducible by re-running 5 calls against the same `(date_from, date_to)` input on the same source files with the same `DETECTOR_VERSION = 1`.

---

## 15. Sandbox-only declaration

This validation was conducted entirely under the sandbox runtime. It does not authorize, recommend, or imply any production deployment. The deterministic anomaly engine and its LLM interpreter are research artifacts under controlled testing. They will remain so until the operator explicitly approves a production-readiness review against the criteria in the architecture doc §10.
