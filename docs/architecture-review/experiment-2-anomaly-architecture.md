# Sandbox Experiment 2 — Anomaly Architecture

**Status:** Designed (sandbox-only). Reliability validation pending.
**Scope:** Sandbox only. No production runtime, no SAP live connectivity, no PM2, no schedulers, no autonomous execution, no public exposure.
**Sister document:** [verified-metrics-architecture.md](./verified-metrics-architecture.md), [verified-metrics-llm-validation.md](./verified-metrics-llm-validation.md)
**Code artifact:** `backend-sandbox/lib/verifiedAnomalies.js`

---

## 1. Premise

Experiment 1 (CEO Brief) proved the LLM cannot be trusted with arithmetic — it fabricated totals 50% of the time before we moved aggregation outside the model. The verified-metrics architecture restored reliability by making the LLM a *narrator* of pre-computed truth.

Experiment 2 applies the **same principle** to anomaly detection:

> Anomaly *existence*, *classification*, and *severity* are deterministic.
> The LLM only *interprets* what an already-detected anomaly means for the business.

This is a stricter test than Experiment 1, because anomaly narratives are richer and the temptation for the model to fabricate (an extra concern, a derived ratio, an unstated threshold) is higher.

---

## 2. Deterministic-vs-generative split

| Concern | Owner | Rationale |
|---|---|---|
| Detection (is this an anomaly?) | **Code** | Threshold breach is a yes/no fact; LLMs blur it. |
| Severity (how bad?) | **Code** | A severity score the LLM picks is a number it invented. |
| Threshold values (≥15%, <30%, …) | **Code** | Embedded in `THRESHOLDS` constant. Locked per `DETECTOR_VERSION`. |
| Anomaly ID | **Code** | Stable, reproducible, indexable. |
| Anomaly description (raw factual) | **Code** | "Revenue dropped 25.6% from X to Y" — pure restatement. |
| Business significance | **LLM** | Why does this matter to the CEO/operator? |
| Recommended action | **LLM** | What should the human do next? |
| Prioritization order | **Code** (severity → id) and **LLM** (within same severity) | Severity is law; tie-break can be soft. |
| Cross-anomaly themes | **LLM** | "Three of five anomalies trace back to one customer" is allowed. |
| Confidence | **Code** | From data completeness × integrity, never LLM-claimed. |

The LLM is **NEVER** allowed to:

- invent an anomaly that the engine did not surface;
- promote an anomaly's severity above what the engine assigned;
- introduce a threshold value that doesn't appear in `threshold_used`;
- compute aggregate counts (5 anomalies, 3 high-severity, etc.) — those come from `summary`;
- omit an anomaly because it disagrees with detection (it must interpret every one or explicitly say "no business significance").

---

## 3. Anomaly lifecycle

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. preCompute()                                                      │
│    computeAnomalies({ date_from, date_to })                          │
│    → { anomalies[], summary{}, warnings[], errors[], meta{} }        │
│                                                                      │
│    Detectors (v1):                                                   │
│      revenue_dod_drop, revenue_dod_spike, revenue_iqr_outlier,       │
│      customer_concentration, item_low_margin, dead_stock_present     │
│                                                                      │
│    Errors → fail closed; LLM never called.                           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. buildUserMessage(input, verified)                                 │
│    Embeds verified.anomalies + summary + meta into the prompt.       │
│    LLM has NO data tools — every datum is in the user message.       │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. LLM submits via submit_anomaly_summary tool                       │
│    Output schema: NARRATIVE-ONLY fields, no severity, no thresholds, │
│    no counts. Each insight references anomaly_id.                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. postProcess(llmOutput, verified)                                  │
│    - Inject verified.anomalies + summary + meta (LLM cannot touch)   │
│    - Validate every anomaly_id reference                             │
│    - Scan narrative for unverified numbers                           │
│    - Compute deterministic confidence                                │
│    - Coerce string-encoded array fields (defensive)                  │
│    - Surface integrity violations explicitly                         │
└─────────────────────────────────────────────────────────────────────┘
```

Each step is **idempotent**: same `(input, source files, DETECTOR_VERSION)` → byte-identical `verified` output.

---

## 4. Detector inventory (v1)

| # | Detector | Source | Severity bands | Notes |
|---|---|---|---|---|
| 1 | `revenue_dod_drop` | daily-sales | low ≥15%, medium ≥20%, high ≥25% | Day-over-day percentage drop |
| 2 | `revenue_dod_spike` | daily-sales | low ≥20%, medium ≥30%, high ≥40% | Spike — asymmetric vs drop because spikes are usually less actionable |
| 3 | `revenue_iqr_outlier` | daily-sales | medium = outside [Q1−1.5·IQR, Q3+1.5·IQR]; high if >3·IQR | Tukey-fence |
| 4 | `customer_concentration` | top-customers | low ≥20%, medium ≥25%, high ≥30% | Top-3 share of total revenue |
| 5 | `item_low_margin` | top-items | low <30%, medium <25%, high <20% | Margin% threshold |
| 6 | `dead_stock_present` | dead-stock | low ≥1, medium ≥2, high ≥5 | Count of items with no sales |

All thresholds are **frozen constants** in `THRESHOLDS`. Changing one requires:

1. Bumping `DETECTOR_VERSION`,
2. Re-running the regression suite,
3. Documenting the change here under §10 (Change log).

This is the deterministic-reproducibility guarantee. The same release of the engine cannot give two answers to the same question.

---

## 5. Anomaly object schema

```json
{
  "id": "revenue_dod_drop_2026-05-09",
  "type": "revenue_dod_drop",
  "detector": "day_over_day_change",
  "detector_version": 1,
  "severity": "medium",
  "severity_reason": "observed 22.4 ≥ medium threshold 20",
  "description": "הכנסות יומיות ירדו ב-22.40% מ-2026-05-08 (181400 ILS) ל-2026-05-09 (140700 ILS)",
  "threshold_used": {
    "metric": "daily_revenue_ils",
    "direction": "down",
    "thresholds_pct": { "low": 15, "medium": 20, "high": 25 },
    "observed_pct": 22.4
  },
  "observed": { "from_date": "2026-05-08", "to_date": "2026-05-09", "from_revenue": 181400, "to_revenue": 140700 },
  "related_metric_ids": ["total_revenue_ils"],
  "related_records": [],
  "source": "mock-data/daily-sales.json",
  "confidence": "high"
}
```

The LLM's submitted narrative attaches one (and exactly one) `business_meaning` and one `recommended_action` per anomaly_id. It cannot change any field above.

---

## 6. Integrity protections

The post-processor enforces five guarantees, in this order:

| # | Guarantee | Enforced by |
|---|---|---|
| 1 | Verified anomalies/summary cannot be touched by the LLM | `postProcess` overwrites those fields from `verified` after the LLM returns |
| 2 | Every `anomaly_id` referenced in the narrative is a real anomaly | `validAnomalyIds = new Set(verified.anomalies.map(a=>a.id))` membership check |
| 3 | Every numeric literal in the narrative is in the verified value-set | `findUnverifiedNumbers(text, valueSet.numbers, valueSet.strings)` (shared with Experiment 1) |
| 4 | Schema-violating string-encoded array fields are silently coerced (and surfaced) | `__schema_coercions` array in integrity output |
| 5 | Confidence is always derived from data completeness × integrity, never LLM-claimed | `postProcess` computes `confidence.overall` |

The same `findUnverifiedNumbers` scanner that protects Experiment 1 is reused here. The post-processor pulls a value-set from `verifiedAnomalies.collectAnomalyValueSet(verified)` — which harvests numbers from `description`, `threshold_used`, `observed`, and the `summary` counts; and identifier strings from `id`, `type`, and `related_records`.

---

## 7. Fail-closed behavior

**Hard fails (no LLM call):**

- `bad_input` — date range invalid or reversed
- `schema_violation` — any source file fails its zod schema
- `mock_parse_error` — JSON parse error in any source

**Soft fails (LLM still called, with explicit warnings in user message):**

- `mock_missing` — source file absent → relevant detectors skipped, surfaced in `meta.sources_missing`
- `empty_window` — date range matches no rows → no anomalies for that source
- `empty_source` — source file is empty array → no anomalies for that source

When soft fails reduce `sources_completeness` below 0.7, the post-processor downgrades `confidence.overall` to `low` regardless of how clean the narrative is.

This is intentional: the model can produce a flawless narrative on top of nearly-empty data, and we want that to LOOK low-confidence, not high.

---

## 8. Expected hallucination risks (residual)

Even with this architecture, these risks remain:

| Risk | Caught by | Residual |
|---|---|---|
| LLM invents a totally new anomaly | unknown_anomaly_id check | None — caught deterministically |
| LLM changes a severity ("this is HIGH-priority" when engine said low) | Free-text scan misses semantic severity claims | **Yes — needs prompt discipline** |
| LLM mentions a threshold value that doesn't exist | Number scanner | None — caught |
| LLM derives a ratio (e.g., "concentration is 2.5× the safe level") | Number scanner — derived ratio is unverified | None — caught |
| LLM omits an anomaly entirely | Coverage check ("every anomaly_id must appear in narrative") | **Implementable as a prompt rule + post-check** |
| LLM hallucinates cross-anomaly themes ("3 of 5 are tied to Customer X") | Number scan catches "3" and "5"; theme-claim about Customer X requires Customer X to be in `strings` set | **Partial — qualitative claims still possible** |
| LLM claims a trend ("worsening week-over-week") not supported by 1-period data | None | **Yes — would need a multi-period detector** |

**Most dangerous residual:** *qualitative* fabrication ("this is the worst week we've had", "customer X is increasingly unreliable") that involves no specific number. The post-processor cannot catch these. The mitigation is **prompt discipline** + **operator review**, not code.

The reliability validation phase will probe specifically for these.

---

## 9. Operator review points

When Experiment 2 runs are reviewed, an operator must check:

1. **Severity faithfulness** — does the narrative respect engine severity, or does it editorialize? ("חשוב מאוד" attached to a `low`-severity anomaly is a smell.)
2. **Coverage** — every anomaly in `verified.anomalies` should have a corresponding interpretation; missing one is a failure.
3. **Action quality** — recommended actions should be concrete (specific customer, specific item) rather than generic ("review concentration risk" is too vague).
4. **No multi-period claims** — narratives must not assert week-over-week or month-over-month trends unless `meta.detectors_run` includes a multi-period detector (none in v1).
5. **`integrity.unverified_numbers_in_text` length** — must be 0 for a clean run.
6. **`integrity.schema_coercions` length** — coercions are allowed but should be tracked; persistent coercion of the same field is a prompt-engineering bug.
7. **`confidence.overall`** — should align with `meta.sources_completeness × integrity_score`.

---

## 10. Future production constraints

Even after Experiment 2 passes reliability validation, this engine **cannot** be production-deployed without:

| Gate | Why |
|---|---|
| Live-source integration with the same fail-closed behavior | Mock data hides edge cases (NULLs, multi-currency, partial-day data). |
| Cross-source consistency check (e.g., does `top-customers.json` reflect the same window as `daily-sales.json`?) | Inconsistent windows cause spurious concentration anomalies. |
| Audit log: every anomaly that ever fired, with detector_version + thresholds frozen at decision time | Enables post-hoc threshold tuning without breaking historical claims. |
| Operator override path | Sometimes the engine is right and the business is wrong (legit one-off spike); operators need a documented "ack and suppress" path. |
| Multi-period detectors (week-over-week, month-over-month) | The hardest hallucination residual is trend fabrication; the only way to mitigate is to provide trend data deterministically. |
| Scheduled-run guarantees + idempotency | If a daily anomaly run fires twice, downstream consumers must not see double-counting. |

These gates are far from sandbox scope. They're recorded here so that when the operator considers production, the work isn't underestimated.

---

## 11. Reliability validation plan (next step, not yet authorized)

Once Task 1 fixes are validated and Experiment 2 architecture is reviewed, a future reliability-validation step would:

1. Run **5 identical anomaly-summary requests** against the same window
2. Compute SHA256 of `verified_anomalies` and `summary` across runs (must be identical, modulo `detected_at`)
3. Run **1 missing-source test** (e.g. rename `top-items.json` → `.bak`) and confirm:
   - Engine emits `sources_missing` warning
   - Affected detector skipped (no fabrication)
   - Confidence drops to `low`
4. Run **1 tampered-output defense test**: feed a fabricated narrative through `postProcess` and confirm:
   - Phantom `anomaly_id` references are caught
   - Fabricated numbers are caught
   - Severity-overpromotion language gets a manual review flag (qualitative, operator-judged)
5. Pass criteria match Experiment 1 standards (≥4/5 runs with `confidence: high`, 0 fabricated numbers caught by scanner, 0 phantom IDs).

This validation is **not authorized yet** — the user instruction was to design Experiment 2 only. Validation requires explicit approval as a separate step.

---

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 1 | 2026-05-10 | Initial detector set: 6 detectors, severity bands locked. |

Any change to thresholds or severity bands requires a version bump.

---

## 13. Cross-references

- **Architecture parent:** [verified-metrics-architecture.md](./verified-metrics-architecture.md)
- **Experiment 1 reliability:** [verified-metrics-llm-validation.md](./verified-metrics-llm-validation.md)
- **Experiment 1 reliability rationale:** [verified-metrics-reliability-plan.md](./verified-metrics-reliability-plan.md)
- **Sandbox runbook:** [sandbox-runbook.md](./sandbox-runbook.md)
- **Engine source:** `backend-sandbox/lib/verifiedAnomalies.js`
- **Shared scanner:** `backend-sandbox/lib/verifiedMetrics.js` → `findUnverifiedNumbers`, `normalizeNumberLiteral`

---

## 14. Sandbox-only declaration

This engine, like its sister, is built for sandbox reliability validation. It does **not**:

- run autonomously,
- write to any database,
- call SAP,
- expose an external endpoint,
- modify production runtime behavior,
- ship as part of any production deploy gate.

Until reliability validation passes AND the production-rollout criteria in §10 are met, the LLM-driven anomaly summarizer is a **lab experiment**, not operational truth.
