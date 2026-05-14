# Verified Metrics Architecture — Design Proposal

**Status:** DESIGN. Implemented in sandbox only — `backend-sandbox/lib/verifiedMetrics.js` is the prototype. No production changes.

**Trigger:** `ceo-brief-reliability-validation.md` — 50% aggregation-fabrication rate. The model is not the right tool for arithmetic; making the prompt stricter doesn't address the root cause.

**Principle:**
> **Deterministic code computes. The LLM narrates.**
> The LLM never becomes the source of truth for any number a business decision will be made on.

---

## 1. The architectural shift

### 1.1 Before (Experiment 1)
```
operator HTTP POST
  ↓
runtime.js → Anthropic loop:
  • LLM calls get_daily_sales → receives raw JSON ([{date, revenue, orders}, ...])
  • LLM calls get_top_customers → receives raw JSON
  • LLM calls get_top_items → receives raw JSON
  • LLM calls get_dead_stock → receives raw JSON
  • LLM does mental arithmetic over the 4 datasets
  • LLM submits with claimed totals (which are sometimes wrong)
  ↓
return: output where headline KPIs are LLM-generated
```

The LLM is asked to do two jobs simultaneously: **compute aggregates** and **narrate insights**. It does the second well and the first unreliably.

### 1.2 After (this design)
```
operator HTTP POST
  ↓
agent.preCompute(input)
  ↓
verifiedMetrics.computeCeoBriefMetrics(input)  ← DETERMINISTIC CODE
  ↓
verified = {
  metrics: [{id, value, unit, source, formula, confidence}, ...],
  anomalies: [{id, description, severity, source, threshold}, ...],
  warnings: [],
  errors: [],
  meta: {computed_at, sources_consulted, sources_missing}
}
  ↓
IF verified.errors.length > 0 → fail closed; return validation_error to operator
  ↓
runtime.js → Anthropic loop:
  • LLM receives `verified` in user message
  • LLM has NO data tools; only submit_brief tool
  • LLM submits NARRATIVE referencing verified metrics by metric_id
  ↓
agent.postProcess(llm_output, verified)
  • Inject verified.metrics + verified.anomalies into output (LLM cannot touch them)
  • Validate every metric_id reference resolves to a verified metric
  • Detect free-floating numbers in narrative; flag any not present in verified
  ↓
return: output where verified_metrics is deterministic; narrative is LLM
```

The LLM does only what it does well: turn structured numbers into Hebrew prose. Arithmetic is removed from its job description.

---

## 2. Responsibility split

| Job | Owner | Why |
|---|---|---|
| Read mock JSON files | `verifiedMetrics.js` | Deterministic; no judgment needed |
| Sum daily revenue | `verifiedMetrics.js` | Pure arithmetic |
| Count orders | `verifiedMetrics.js` | Pure arithmetic |
| Compute customer concentration % | `verifiedMetrics.js` | Pure ratio |
| Detect day-over-day drops | `verifiedMetrics.js` | Rule-based threshold |
| Detect dead stock | `verifiedMetrics.js` | Rule-based threshold |
| Validate data shape (schema) | `verifiedMetrics.js` | Code validates code |
| Emit `validation_error` on bad input | `verifiedMetrics.js` | Fail closed |
| Hebrew narrative composition | LLM | Language fluency, tone |
| Identify which insights matter most | LLM | Judgment, prioritization |
| Frame an anomaly's business meaning | LLM | Interpretation |
| Suggest recommended actions | LLM | Domain reasoning over verified facts |
| Decide what to leave OUT of the brief | LLM | Editorial judgment |
| Compute or claim any new number | **forbidden** | Prevent fabrication |
| Modify verified_metrics in output | **forbidden (runtime overwrites)** | Hard guarantee |

---

## 3. Data model

### 3.1 `verified.metrics[]` (input to LLM, output to operator)

```typescript
type VerifiedMetric = {
  id: string                  // stable machine-id, e.g. "total_revenue_ils"
  label_he: string            // Hebrew display label, e.g. "סך הכנסות"
  value: number | null        // null if insufficient_data
  unit: string                // 'ILS' | 'count' | 'pct' | 'ratio' | 'days'
  source: string              // mock-data file name (or live-source identifier later)
  formula: string             // human-readable formula, e.g. "SUM(daily_sales[].revenue_ils)"
  confidence: 'high' | 'medium' | 'low' | 'insufficient_data'
  inputs_count: number        // how many records were used
  computed_at: string         // ISO 8601
}
```

### 3.2 `verified.anomalies[]` (input to LLM, output to operator)

```typescript
type VerifiedAnomaly = {
  id: string                  // stable id, e.g. "rev_drop_2026-05-10"
  type: string                // 'day_over_day_drop' | 'concentration' | 'dead_stock' | 'low_margin' | ...
  description: string         // factual description (English; LLM translates if needed)
  severity: 'high' | 'medium' | 'low'
  related_metric_ids: string[]  // links into metrics[]
  source: string
  threshold_used: object      // e.g. {drop_pct: 15, observed: 23.7}
}
```

### 3.3 `verified.warnings[]` and `verified.errors[]`

```typescript
type Warning = { code: string, message: string, source?: string }
type ValidationError = { code: string, message: string, source?: string }
```

`warnings` are non-fatal (e.g., one mock file missing — partial brief possible).
`errors` are fatal (e.g., schema-broken JSON — refuse to brief at all).

### 3.4 LLM output schema (`submit_brief`)

```typescript
type CeoBriefNarrative = {
  executive_summary: string                    // Hebrew, ≤150 words
  metric_interpretations: Array<{
    metric_id: string                          // MUST exist in verified.metrics
    narrative: string                          // Hebrew; what this metric means
  }>
  anomaly_interpretations: Array<{
    anomaly_id: string                         // MUST exist in verified.anomalies
    business_meaning: string                   // Hebrew; what this anomaly tells the CEO
  }>
  risks: Array<{
    description: string                        // Hebrew
    severity: 'high' | 'medium' | 'low'
    related_metric_ids: string[]               // MUST exist in verified.metrics
  }>
  recommended_actions: Array<{
    action: string                             // Hebrew, ≤30 words
    rationale: string                          // Hebrew
    related_metric_ids: string[]
  }>
  prioritization_note: string                  // Hebrew; what matters most this period and why
}
```

Note: **no `value` fields in the LLM schema.** The model literally cannot type a number into the output and have it appear as a verified metric.

### 3.5 Final composed output (sent to operator)

```typescript
type CeoBriefResponse = {
  // From runtime
  runId: string
  agentName: string
  model: string
  durationMs: number
  costUsd: number
  tokensIn: number
  tokensOut: number

  output: {
    // From verifiedMetrics (deterministic, LLM cannot touch)
    verified_metrics: VerifiedMetric[]
    verified_anomalies: VerifiedAnomaly[]
    verified_metrics_warnings: Warning[]
    computed_at: string

    // From LLM (narrative only)
    narrative: CeoBriefNarrative

    // From postProcess
    integrity: {
      unknown_metric_ids: string[]      // narrative refs that don't resolve
      unknown_anomaly_ids: string[]
      unverified_numbers_in_text: string[]  // numbers found in narrative not in verified.metrics
      validation_errors: string[]
    }
    confidence: {
      overall: 'high' | 'medium' | 'low'
      computed_from: 'sources_completeness + integrity_check'  // how it was set
    }
  }
}
```

---

## 4. Confidence model (deterministic, not LLM-claimed)

The previous prompt let the LLM declare its own confidence — and it always picked "high". The new model computes confidence from objective signals:

```
sources_completeness = (sources_returning_data / total_sources_consulted)

integrity_score = (
  + 1.0 if integrity.unknown_metric_ids.length == 0 else 0.5
  + 1.0 if integrity.unknown_anomaly_ids.length == 0 else 0.5
  + 1.0 if integrity.unverified_numbers_in_text.length == 0 else 0.0
  + 1.0 if integrity.validation_errors.length == 0 else 0.0
) / 4

overall_confidence:
  high   if sources_completeness >= 0.9 AND integrity_score >= 0.9
  medium if sources_completeness >= 0.7 AND integrity_score >= 0.7
  low    otherwise
```

Examples:
- All 4 mock sources return data + LLM cited correctly + no free numbers = **high** ✓
- 3 of 4 sources returned (one was `_mock_missing`) + LLM clean = **medium** (per rule, the missing-data run should now correctly flag medium)
- LLM mentioned "1.18M" in text, but verified total is 1.28M = **low** (forced down by integrity_check)

---

## 5. Citation model

### 5.1 What "citation" means now

A citation is no longer "model claims X comes from source Y". It's "the LLM's narrative references metric_id Z, AND metric Z exists in the runtime-injected verified.metrics."

### 5.2 Citation enforcement

In `agent.postProcess()`:
1. Build the set of valid IDs: `validIds = new Set(verified.metrics.map(m => m.id))`
2. For each `narrative.metric_interpretations[].metric_id` and each `narrative.risks[].related_metric_ids` → check membership
3. Unmatched IDs go into `output.integrity.unknown_metric_ids`
4. The LLM CANNOT insert a phantom citation — the validation is post-hoc and structural

### 5.3 Free-floating number detection (anti-fabrication net)

Regex over `executive_summary` + all narrative strings:
```js
const numberPattern = /(\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?(?:[KMB])?|\d+%)/g;
```

Each captured number must:
- Exist literally in `verified.metrics[].value` (after normalization), OR
- Exist in `verified.anomalies[].threshold_used` values, OR
- Be flagged in `output.integrity.unverified_numbers_in_text`

This catches the Run 2 case: the LLM wrote "1,183,000" — that number doesn't exist in `verified.metrics` (which has 1,283,000). Flag → confidence drops to low → operator sees the warning.

### 5.4 Hebrew/English citation chain

Verified metric IDs are English (`total_revenue_ils`). Hebrew narrative cites them like:
```
"סך ההכנסות (total_revenue_ils) עמד על 1,283,000 ש"ח..."
```

The metric_id stays in the text. Post-processor extracts and validates.

---

## 6. Anti-fabrication boundaries (hardened)

| Boundary | Enforcement | Failure mode |
|---|---|---|
| LLM cannot return numeric `value` fields in `submit_brief` | Schema doesn't allow it (no value-type properties) | If LLM tries, Anthropic rejects the tool call |
| `verified_metrics` in output is runtime-injected, not LLM-typed | `agent.postProcess` overwrites whatever was there | Hard guarantee |
| LLM references must resolve to verified IDs | `postProcess` validates; mismatches flagged | Soft (flag), but feeds into confidence reduction |
| Free-floating numbers in narrative must match verified values | regex + lookup; mismatches flagged | Soft, feeds confidence |
| Verified metrics computed from missing data → null + insufficient_data | `verifiedMetrics.js` enforces | Hard |
| Validation errors → fail closed (no LLM call) | `runtime.js` aborts on `verified.errors.length > 0` | Hard — operator gets `validation_error`, no LLM cost |

---

## 7. Failure modes (fail closed)

| Failure | Detection | Behavior |
|---|---|---|
| Mock JSON file missing | `verifiedMetrics.js` returns `confidence: insufficient_data` for affected metrics | Warning (non-fatal); LLM still narrates other metrics |
| Mock JSON malformed (parse error) | `verifiedMetrics.js` returns error | **Fail closed**; no LLM call; operator gets `validation_error` |
| Verified metrics empty (all sources failed) | `verifiedMetrics.js` returns errors | **Fail closed** |
| Anthropic API error | Existing runtime.js error handling | Existing behavior (return error, log) |
| LLM submits invalid JSON | Anthropic schema validation | Already enforced by tool-call schema |
| LLM cites unknown metric_id | `postProcess` flags + reduces confidence | Soft |
| LLM mentions number not in verified | `postProcess` regex check + flags | Soft |
| Per-run cost exceeds ceiling | `budget.js` (existing) | Hard |

"Fail closed" = no narrative produced; operator sees structured error explaining why; no money spent on LLM call.

---

## 8. Where verifiedMetrics lives in the codebase

```
backend-sandbox/
├── lib/
│   └── verifiedMetrics.js         ← NEW: deterministic calculator
├── agents/
│   ├── runtime.js                 ← MODIFY: add preCompute + postProcess hooks
│   ├── registry.js                ← MODIFY: ceoBrief uses new flow
│   └── tools/
│       └── ...                    ← UNCHANGED: still available for OTHER agents that
│                                     don't need verified metrics (e.g., reportExplainer)
└── server.js                      ← UNCHANGED: routes work the same way
```

**Other agents (anomalySummary, reportExplainer, salesInsights) keep using the tool-loop pattern** — they're narrative-only experiments where the model isn't claimed to compute anything authoritative. CEO Brief is the first agent where the output is consumed as fact.

This means the architecture is **opt-in per agent**. An agent declares whether it wants `preCompute` (verified metrics) or just `tools` (raw access). Future production agents that produce decisions should always opt-in to `preCompute`.

---

## 9. Observability + audit trail

Every CEO Brief run record now carries:
- The exact `verified.metrics` array (so the operator can verify post-hoc)
- The exact `verified.anomalies` array
- The exact computed_at timestamp + sources_consulted
- The integrity check results (unknown IDs, unverified numbers)
- The confidence score AND its derivation

This means **a brief is reproducible**: given the same mock data + the same `computed_at`, the verified portion is byte-identical across runs. The narrative will vary; the numbers will not.

This is the property we lacked in Experiment 1.

---

## 10. What this design does NOT solve

| Limitation | Why we're OK with it for now |
|---|---|
| LLM can still write biased/leading narrative around correct numbers | Narrative is for interpretation — bias is a different problem (operator review) |
| LLM can still over/under-emphasize a metric | Editorial judgment is what the LLM brings; trade-off accepted |
| LLM may misinterpret a metric's business meaning | Same — but at least the metric value is right |
| Verified metrics still depend on mock data quality | Operator's job to populate realistic mocks; out of architecture scope |
| Live SAP path still needs deterministic compute | Same architecture applies — `verifiedMetrics.js` becomes the entry point regardless of source |
| Multi-step reasoning (e.g., "what would happen if...") | LLM still does this; if it produces numbers, those go through narrative-only checks |

---

## 11. Migration path (sandbox-only for now)

| Phase | What | Where |
|---|---|---|
| 1 (now, this task) | Implement `verifiedMetrics.js` for CEO Brief metrics | `backend-sandbox/lib/` |
| 2 (now, this task) | Refactor `ceoBrief` agent + `runtime.js` to use preCompute/postProcess | `backend-sandbox/agents/` |
| 3 (next experiment) | Re-run reliability test with new architecture | sandbox |
| 4 (if reliability ≥99%) | Apply same pattern to anomalySummary, salesInsights agents | `backend-sandbox/agents/` |
| 5 (post-cutover, distant) | Production AI features (CEO Brief, etc.) ALWAYS use this pattern | `backend/src/` (post Phase 6) |

**Do NOT promote to production** until:
- Reliability re-test shows ≤1% number-fabrication rate
- Operator sign-off
- All `cutover-plan.md` Phase 6 conditions met
- Proper `aiCostGuard` lands in production (currently Phase-1 stub)
- Architectural review by stakeholder

---

## 12. Refactored Experiment 1 flow (concrete)

### 12.1 Old (Experiment 1)
```
POST /sandbox/run/ceoBrief {date_from, date_to}
  → registry.ceoBrief.tools = [get_daily_sales, get_top_customers, get_top_items, get_dead_stock]
  → registry.ceoBrief.submitTool = submit_brief({headline_kpis, top_customers, top_items, dead_stock, recommendation})
  → runtime drives Anthropic tool-loop
  → output: LLM-claimed values
```

### 12.2 New (this design)
```
POST /sandbox/run/ceoBrief {date_from, date_to}
  → runtime.runAgent({agent: registry.ceoBrief, input})
  → agent.preCompute(input) [NEW]
      → verifiedMetrics.computeCeoBriefMetrics({date_from, date_to, mock_dir})
      → returns {metrics, anomalies, warnings, errors, meta}
  → IF errors.length > 0: return {status: 'validation_error', errors}; END
  → agent.buildUserMessage(input, verified)  [MODIFIED]
      → returns string with verified.metrics + verified.anomalies embedded
  → runtime calls Anthropic
      → tools: []  (no data tools — verified data is in user message)
      → submit_brief tool: NARRATIVE ONLY schema (no value fields)
      → LLM submits CeoBriefNarrative
  → agent.postProcess(narrative, verified)  [NEW]
      → output.verified_metrics = verified.metrics  (runtime-injected)
      → output.verified_anomalies = verified.anomalies
      → validate metric_id references → output.integrity.unknown_metric_ids
      → regex-scan narrative for free numbers → output.integrity.unverified_numbers_in_text
      → compute output.confidence based on sources + integrity
  → return final composed output
```

This is what the rest of the documents in this task implement.

---

## 13. Document references

- `ceo-brief-reliability-validation.md` — the data that motivated this design
- `ai-sandbox-plan.md` — sandbox boundary (still applies)
- `freeze-policy.md` — production AI still forbidden during freeze; this is sandbox-only
- `verified-metrics-reliability-plan.md` — companion: why prompt-only fix is insufficient + what risks remain after this refactor

End of architecture proposal.
