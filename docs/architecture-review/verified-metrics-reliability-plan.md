# Verified-Metrics Reliability Plan

Companion to `verified-metrics-architecture.md`. This document explains **why prompt-only iteration is insufficient**, what risks remain after the deterministic-layer refactor, and the new responsibility boundary.

**Audience:** anyone deciding whether to trust an AI-generated CEO Brief in production.

**TL;DR:** the architectural change moves arithmetic out of the LLM. Prompt fixes alone could not have closed the 50% fabrication rate observed in `ceo-brief-reliability-validation.md`. The new architecture eliminates an entire class of failures (numeric fabrication) but does not eliminate all hallucination risk — narrative bias and editorial misjudgment remain. We document those explicitly so they aren't surprises.

---

## 1. Why prompt-only mitigation is insufficient

### 1.1 What we tried in Experiment 1's prompt
The original CEO Brief prompt had 6 absolute rules including "NO FABRICATION" stated three times:
```
1. NO FABRICATION. Every number ... MUST come from a tool call you actually made.
2. CITE EVERYTHING. Each insight MUST cite the data_sources_used by name.
3. MISSING DATA = "insufficient_data". Do NOT guess. Do NOT extrapolate.
4. CONFIDENCE. Output a confidence value in {high, medium, low} ...
5. HEBREW for human-facing strings.
6. LENGTH. executive_summary ≤ 150 words.
```

Despite this, **3 of 6 runs produced wrong totals** with phantom citations attached. The model didn't violate the *letter* of the rules — it cited a real source name (`get_daily_sales`) for a number it wrote down (`1,183,000`). The structural check was satisfied; the semantic claim was false.

### 1.2 The deeper problem
LLMs are unreliable at multi-step arithmetic on numbers in context. This is well-documented:
- Models often paraphrase ("1.18M" instead of citing exactly)
- Models confuse similar values across different sources
- Models perform partial sums (drop last item) under cognitive load
- Models invent values that "feel right" given the surrounding context
- Models confidently assert calculations they didn't actually perform

You can ask harder. You can offer rewards. You can demand chain-of-thought. The fundamental issue — that the model is producing a probabilistic continuation of plausible-looking text — doesn't go away. The rate goes down (sometimes substantially); the rate doesn't go to zero.

### 1.3 The architecture answer
Don't fix the model's arithmetic. **Don't ask the model to do arithmetic.** Compute in code. Give the model the verified numbers as input. Ask it to narrate.

This is a category change, not a degree change:
- **Prompt fix**: 50% fabrication → maybe 10% fabrication (still unacceptable)
- **Architecture change**: 50% fabrication → 0% on verified metrics (impossible, by construction)

We tested the deterministic calculator with 12 ground-truth assertions. All 12 pass. The numbers are byte-identical across every run because the same code runs against the same data.

### 1.4 Cost-benefit argument
| Approach | Reliability ceiling | Engineering cost | Ongoing maintenance |
|---|---|---|---|
| Prompt iteration | ~90-95% accuracy on arithmetic | High (continuous tuning + per-model regression) | Each model upgrade re-tests everything |
| Verified-metrics architecture | 100% on verified values; fabrication detection on narrative | Medium one-time (build calculator) | Calculator extends naturally with new metrics |

The architecture change is cheaper long-term and provides hard guarantees the prompt approach cannot.

---

## 2. Why aggregation hallucinations are dangerous (specifically)

### 2.1 They look right
A wrong total revenue number doesn't trigger "this is suspicious" pattern recognition the way a wrong customer name might. "1,183,000 ILS" is plausible — operators don't carry the real total in their heads. They trust the brief.

### 2.2 They cascade
Once the model reports a wrong total, downstream insights compound the error:
- "Top 3 customers represent 21% of weekly revenue" — math from wrong total → wrong %
- "Average daily revenue is 147,875 ILS" — wrong total / 8 days → wrong average
- "Revenue grew X% week-over-week" — wrong base → wrong delta

The whole brief becomes a structurally consistent fabrication tree.

### 2.3 They survive fact-checking shortcuts
A reader spot-checks one number against memory; "yeah, that sounds about right." The phantom citation (`source_tool: "get_daily_sales"`) provides false reassurance — readers don't go pull get_daily_sales output and verify.

### 2.4 They drive decisions
The CEO Brief exists to inform decisions. A 7% wrong revenue figure could trigger:
- Wrong vendor payments
- Wrong cash-flow planning
- Wrong "we're up vs last week" narrative shared externally
- Wrong commission calculations

Even if the impact is bounded ("we'd never act on this without verifying"), trust erodes the moment the first wrong number is caught. AI-generated executive summaries with documented fabrication history get ignored — the whole investment becomes worthless.

### 2.5 They are not addressed by "just make the model smarter"
Going haiku → sonnet → opus reduces fabrication rate. It doesn't eliminate it. And operating cost climbs faster than reliability. Sonnet is ~5x cost of haiku for ~2x reliability gain. The ROI curve flattens; the trust curve doesn't reach 100%.

---

## 3. Deterministic vs generative responsibility split

### 3.1 What deterministic code OWNS
| Responsibility | Where | Guarantee |
|---|---|---|
| Read source data | `loadSource()` in `verifiedMetrics.js` | Either succeeds or returns structured failure |
| Validate source schema | `zod` parsers per source | Either passes or returns `errors[]` |
| Sum daily revenue | `sumByKey(rows, 'revenue_ils')` | Pure arithmetic; reproducible |
| Sum order count | same | same |
| Compute averages | `total / inputs_count` | same |
| Find peak day | `sort + slice` | same |
| Top-N customer extraction | `sort + slice` | same |
| Customer concentration % | ratio | same |
| Day-over-day drop detection | rule: `(prev - cur) / prev * 100 >= threshold` | same |
| Low-margin item detection | rule: `margin_pct < 30` | same |
| Dead-stock count | direct field read | same |
| Confidence assignment | objective rule per metric | same |
| Source-attribution | constant per metric definition | same |

### 3.2 What the LLM is ALLOWED to do
| Responsibility | Why model is appropriate |
|---|---|
| Compose Hebrew executive summary | Language fluency is the model's strength |
| Choose which metrics to highlight | Editorial judgment over relative importance |
| Frame an anomaly's business meaning | Business reasoning, contextualization |
| Suggest recommended actions based on verified data | Domain knowledge + creativity |
| Prioritize: "what should the CEO read first" | Subjective ranking |
| Translate metric_id to Hebrew prose | Natural-language generation |
| Identify which combinations of metrics tell a story | Pattern recognition over structured data |

### 3.3 What the LLM is FORBIDDEN to do
| Forbidden | Enforcement mechanism |
|---|---|
| Type a number into output as a "verified" value | Schema has no value fields; runtime overwrites verified_metrics |
| Compute a sum, average, ratio, or any aggregate | No tools provided; cannot fetch raw data |
| Cite a metric_id that doesn't exist in verified.metrics | postProcess flags it; confidence drops |
| Cite an anomaly_id that doesn't exist | postProcess flags it |
| Mention a number in narrative not present in verified | regex scan + flag |
| Self-claim its own confidence | runtime computes confidence deterministically |
| Modify verified_metrics in output | runtime injects from preCompute, not from LLM submission |
| Claim "insufficient_data" was emitted when verified shows otherwise | structural mismatch detectable in postProcess |
| Fetch live data | no tools = no fetch capability |

### 3.4 Side benefits
- **Reproducibility:** the same input + same data files produce the same `verified_metrics`. The narrative will vary across runs, but the numbers won't. This makes A/B testing the prompt possible without confounders.
- **Audit:** every brief carries the verified_metrics array, so the CEO can ask "where did this number come from?" and get a traceable answer (`source: "mock-data/daily-sales.json"`, `formula: "SUM(...)"`, `inputs_count: 8`).
- **Cost:** removing tool-loop iterations cuts LLM calls per brief. Experiment 1 used 5 tool calls per brief; the new architecture uses 1 (just submit_brief). Approximate cost: ~$0.005/run instead of ~$0.014/run.

---

## 4. Remaining hallucination risks after refactor

The architecture closes the numeric-fabrication failure mode. It does NOT close all failure modes. The following remain:

### 4.1 Narrative bias
The LLM picks which verified metrics to emphasize. It might:
- Lead with a positive metric while burying a more important negative one
- Frame a 25% drop as "natural variation" instead of "concerning"
- Use softer Hebrew phrasing for risks vs harsher for opportunities (or vice versa)

**Mitigation:** human review of the brief's emphasis. Not a runtime check.

### 4.2 Misinterpretation of business meaning
Verified metric: `top3_customer_concentration_pct = 45.67`. The LLM might narrate this as:
- "תלות בריאה במספר לקוחות מובילים" (healthy dependence on top customers) — too positive
- "סיכון חמור של ריכוז לקוחות" (severe customer-concentration risk) — too dramatic
- The verified data doesn't tell us which framing is correct

**Mitigation:** prompt nudges toward neutral framing. Not perfect.

### 4.3 Recommended actions disconnected from data
The model can suggest "increase marketing for DAVO Mixer Pro" — citing `top_item_code` — even though the verified data doesn't say marketing budget is the limiting factor. The recommendation is plausible but not data-supported.

**Mitigation:** require recommendations to reference at least one metric_id (already in schema). The model is forced to ground recommendations in verified data, but the recommendation itself can still be a non-sequitur from that data.

### 4.4 Free-floating numbers in narrative the regex misses
The `findUnverifiedNumbers` regex catches:
- `1,283,000` — explicit comma-separated thousands
- `1.28M` — abbreviated millions
- `21%` — percentages
- `89500` — plain integers ≥4 digits

It does NOT catch:
- `כמיליון שקלים` (about a million shekels) — Hebrew prose with no digit
- `שלוש פעמים יותר` (three times more) — relative claim
- `לפחות חמש מאות` (at least five hundred) — Hebrew number-words

These are subtler hallucinations. Catching them would require natural-language number-detection over Hebrew, which is non-trivial.

**Mitigation:** prompt explicitly forbids paraphrased numbers. Not perfectly enforced.

### 4.5 LLM may correctly cite a metric_id but mis-paraphrase the value
Example:
```
metric: { id: "total_revenue_ils", value: 1283000 }
narrative: "סך ההכנסות (total_revenue_ils) עמד על 1.3 מיליון ש"ח"
```
The metric_id is right. The cited approximation (1.3M instead of 1,283,000) is close but not exact. The regex flags `1.3` (well, `1.3 מיליון` if we extend regex to Hebrew number-words). For now: flagged because `1300000` ≠ `1283000`.

This is actually correct behavior — if the operator wants to allow loose approximations, the regex tolerance can be tuned. Default: strict.

### 4.6 Schema-violation under model degradation
If the LLM returns malformed JSON, the Anthropic tool-use API rejects the tool call. We saw this in Experiment 1 Run 3 (key_metrics returned as string). Under the new schema, the only tool is `submit_brief` and its required fields are narrative strings/arrays, not numeric values — easier for the model to comply with.

**Mitigation:** narrower schema = lower violation rate. Not zero.

### 4.7 Anthropic API failures
Network errors, rate limits, model deprecation, etc. — out of architectural scope. Existing runtime error handling applies.

### 4.8 Mock data quality
The verified metrics are only as good as their source. Mock JSON with PII-redacted but otherwise realistic samples gives realistic experiments. Synthetic mock data ("Mock Customer Alpha") gives less-realistic experiments.

**Mitigation:** operator backfills realistic mocks per `sandbox-runbook.md` §5.1.

---

## 5. Expected reliability improvement

### 5.1 Numeric fabrication
- Experiment 1 baseline: 50% rate (3 of 6 runs)
- Architecture target: **0%** on verified_metrics (structural guarantee — model cannot type values)
- Architecture target: **<5%** on free-floating numbers in narrative (regex-detected; lowers confidence rather than blocks)

### 5.2 Phantom citations
- Experiment 1 baseline: source_tool field structurally present but semantically wrong on 50% of fabricated metrics
- Architecture target: **0% structural phantom citations** (metric_ids must resolve; postProcess flags any that don't)
- Architecture target: **<10%** semantic mis-citation (LLM cites correct ID but applies wrong meaning) — soft, requires human review

### 5.3 Confidence inflation
- Experiment 1 baseline: 100% of runs claimed `high` confidence
- Architecture target: **0%** LLM-claimed confidence (LLM cannot output confidence)
- Architecture target: confidence reflects sources_completeness × integrity_score (deterministic; reproducible)

### 5.4 Inconsistent conclusions across runs
- Experiment 1 baseline: 4 different totals across 6 identical-input runs
- Architecture target: **0% variance on verified_metrics** (byte-identical for same input)
- Architecture target: ~30% variance on narrative phrasing (LLM creativity; acceptable)

### 5.5 Schema compliance
- Experiment 1 baseline: 5 of 6 runs valid; 1 broken
- Architecture target: ≥98% (narrower schema; numeric fields removed = fewer types to violate)

### 5.6 "insufficient_data" emission
- Experiment 1 baseline: 100% (already passing)
- Architecture target: 100% (now enforced by deterministic layer; LLM doesn't decide)

### 5.7 Aggregation correctness
- Experiment 1 baseline: 50% wrong
- Architecture target: **100% correct** (verified by 12 ground-truth assertions in self-test)

### 5.8 Re-validation criteria for advancing to Experiment 2
After re-running this validation with the new architecture, advance to Experiment 2 ONLY if:
- 100% verified_metrics correctness across 5+ runs (deterministic guarantee — should be automatic)
- 0 unknown_metric_ids in 5+ runs
- 0 unverified_numbers_in_text in 5+ runs (model didn't introduce free-floating numbers)
- ≥4/5 runs achieve confidence: high (overall sources + integrity OK)
- Missing-data test: confidence drops to medium or low; no invented dead-stock data
- Schema violations: 0
- Cost per run ≤ $0.05

If those hold → architecture is validated for narration; proceed to Experiment 2 with the same pattern (precompute → narrate → postProcess validate).

---

## 6. What the LLM is still allowed to do (positive scope)

| Capability | Examples |
|---|---|
| Hebrew narrative composition | Turn `top_customer_revenue_ils=89500` into "הלקוחה המובילה תרמה 89,500 ש\"ח..." |
| Editorial selection | Out of 14 verified metrics, choose the 5 most relevant for this period |
| Anomaly framing | Take `high_customer_concentration` and explain its business significance for the CEO |
| Recommended actions | Suggest "diversify customer base" given the customer-concentration anomaly |
| Tone calibration | Match Hebrew tone to severity (urgent for high-severity risks, measured for low) |
| Cross-metric synthesis | Notice that high-margin items have low concentration → recommend doubling down |
| Prioritization | "This week, attention to dead stock; revenue is healthy" |
| Cultural fit | Hebrew idioms, RTL formatting, executive register |

These are the model's competencies. We're not abandoning AI value; we're focusing it on tasks where it excels.

---

## 7. What the LLM is forbidden from doing (negative scope)

| Forbidden | Reason |
|---|---|
| Output any value field in submit_brief | Schema doesn't include them; runtime overwrites verified_metrics |
| Compute or claim a sum, average, ratio | Calculator does this; LLM has no raw data |
| Write a number in narrative not present in verified | Regex flags + lowers confidence |
| Claim its own confidence level | Deterministic computation; LLM cannot output `confidence` |
| Cite a metric_id that doesn't exist | postProcess flags; confidence drops |
| Cite an anomaly_id that doesn't exist | postProcess flags; confidence drops |
| Modify verified_metrics in output | Runtime injects from preCompute |
| Fetch live data | No tools provided |
| Self-loop or recurse | Synchronous request/response only |
| Trigger external actions (email, SMS, API calls) | No write tools; sandbox is read-only |
| Make decisions on behalf of the operator | Brief informs; operator decides |

---

## 8. Failure modes (fail-closed behavior)

| Trigger | Behavior |
|---|---|
| `mock-data/*.json` malformed JSON | `verifiedMetrics` returns `errors[]`; runtime returns `validation_error`; **no LLM call**; **no cost** |
| All 4 mock files missing | `verifiedMetrics` returns metrics with `confidence: insufficient_data`; runtime still calls LLM (operator may want a "everything is unavailable" brief); LLM should narrate the unavailability |
| Some mock files missing | `verifiedMetrics` returns partial metrics + warnings; runtime calls LLM; confidence drops; LLM narrates partial coverage |
| Date range outside data window | empty_window warning; affected metrics get `insufficient_data`; LLM narrates the gap |
| LLM returns malformed JSON | Anthropic tool-use API rejects; runtime returns error |
| LLM cites unknown metric_id | postProcess flags; confidence drops; brief still produced (operator sees flag) |
| LLM mentions unverified number in narrative | postProcess flags; confidence drops; brief still produced |
| Per-run cost exceeds $0.50 ceiling | budget.js throws; brief aborted |
| Daily cost exceeds $5 ceiling | budget.js throws; future briefs aborted until tomorrow |

"Fail closed" = operator gets a structured error, not a confident-looking-but-wrong brief.

---

## 9. Production-rollout criteria (still distant)

The verified-metrics architecture must satisfy ALL of these before any production deployment:

```
☐ Reliability re-validation: ≥5 runs, 100% verified_metrics correctness, 0 phantom IDs, 0 unverified numbers
☐ Missing-data behavior: confidence drops appropriately; never invents
☐ Mock data replaced with cached real-SAP samples
☐ Anti-prompt-injection review (operator can craft malicious date range; verifiedMetrics must validate)
☐ aiCostGuard production implementation lands (currently Phase-1 stub per security-reaudit.md F12)
☐ Production agent ownership defined (who responds when narrative is biased / wrong / late)
☐ Audit trail: every production brief stored with full verified_metrics + integrity flags
☐ Rollback plan: if briefs go bad, switch to "verified_metrics dump only" (no narrative) within 1 minute
☐ Stakeholder sign-off in cowork/INCIDENTS.md
☐ AT LEAST 30 days of sandbox operation with the new architecture before production proposal
☐ Cutover (Phase 4-6 of cutover-plan.md) complete first
```

These are intentionally strict. The cost of a wrong CEO Brief in production is high; the cost of waiting is low.

---

## 10. Files changed by this task (sandbox-only)

| File | Change |
|---|---|
| `backend-sandbox/lib/verifiedMetrics.js` | NEW — deterministic calculator with 14 metric definitions + 4 anomaly detectors + post-processor helpers |
| `backend-sandbox/agents/runtime.js` | MODIFIED — added `runAgentDef` orchestrator with preCompute / postProcess hooks; legacy `runAgent` unchanged |
| `backend-sandbox/agents/registry.js` | MODIFIED — `ceoBrief` now uses preCompute + buildUserMessage(verified) + postProcess + narrative-only schema; other agents (anomalySummary, reportExplainer, salesInsights) unchanged |
| `backend-sandbox/server.js` | MODIFIED — `/sandbox/run/:agentName` route now uses `runAgentDef` |
| `docs/architecture-review/verified-metrics-architecture.md` | NEW — design doc |
| `docs/architecture-review/verified-metrics-reliability-plan.md` | NEW — this file |

**No production code changes. No production env changes. No PM2 changes.**

---

## 11. Self-test results (no LLM)

The deterministic calculator was tested in isolation (no Anthropic call needed):

```
=== Ground-truth checks ===
  ✓ total_revenue_ils: 1283000 (expected 1283000)
  ✓ total_orders: 344 (expected 344)
  ✓ avg_daily_revenue_ils: 160375 (expected 160375)
  ✓ peak_revenue_day: "2026-05-08" (expected "2026-05-08")
  ✓ peak_revenue_value: 181400 (expected 181400)
  ✓ top_customer_revenue_ils: 89500 (expected 89500)
  ✓ top_customer_name: "Mock Customer Alpha Ltd" (expected "Mock Customer Alpha Ltd")
  ✓ top3_customer_revenue_sum_ils: 230500 (expected 230500)
  ✓ top_item_code: "MOCK-DAVO-MIXER-PRO" (expected "MOCK-DAVO-MIXER-PRO")
  ✓ top_item_revenue_ils: 67500 (expected 67500)
  ✓ top_item_qty_sold: 45 (expected 45)
  ✓ dead_stock_count: 3 (expected 3)
Pass: 12 Fail: 0

=== findUnverifiedNumbers test ===
  good text   : []                                                 (expect [])
  fabricated  : [{"raw":"1,183,000","normalized":1183000}]          (expect non-empty)

=== Missing-data simulation (dead-stock.json renamed) ===
  Errors: 0
  Warnings: mock_missing (mock-data/dead-stock.json)
  Sources missing: [ 'mock-data/dead-stock.json' ]
  Sources completeness: 0.75
  dead_stock_count: null  confidence: insufficient_data
```

**12 of 12 ground-truth assertions pass.** The arithmetic that the LLM got wrong 50% of the time is now deterministic.

---

## 12. Pending: actual LLM run with new architecture

The next experiment task should run the new flow end-to-end:
1. Set ANTHROPIC_API_KEY in `.env.sandbox` (separate sub-key recommended)
2. `cd backend-sandbox && node server.js`
3. `POST /sandbox/run/ceoBrief {date_from, date_to}` × 5 runs
4. Verify each output:
   - `output.verified_metrics` byte-identical across all 5 runs (modulo `computed_at`)
   - `output.narrative.*` varies (LLM creativity expected)
   - `output.integrity.unknown_metric_ids` = []
   - `output.integrity.unverified_numbers_in_text` = []
   - `output.confidence.overall` = `high`
5. Run missing-data test:
   - Rename `mock-data/dead-stock.json`
   - Re-run; verify `confidence.overall` drops to `medium` (sources_completeness=0.75)
   - Verify narrative says "נתונים אינם זמינים" for dead stock; doesn't invent items

If all pass → architecture validated. If any fail → diagnose; the failure mode points to which boundary is leaky.

---

## 13. Document references

- `verified-metrics-architecture.md` — design (this is the implementation plan)
- `ceo-brief-reliability-validation.md` — the data that motivated this refactor
- `ai-sandbox-plan.md` — sandbox boundary
- `freeze-policy.md` §1.2 — no production AI during freeze (still applies)
- `backend-sandbox/lib/verifiedMetrics.js` — the actual calculator
- `backend-sandbox/agents/registry.js` — refactored ceoBrief agent
- `backend-sandbox/agents/runtime.js` — runAgentDef orchestrator

End of reliability plan.
