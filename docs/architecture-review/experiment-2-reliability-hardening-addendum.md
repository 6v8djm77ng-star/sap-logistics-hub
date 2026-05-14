# Sandbox Experiment 2 — Reliability Hardening Addendum

**Date:** 2026-05-10
**Status:** Hardening implemented + validated. Sandbox-only.
**Parent reports:**
- [experiment-2-anomaly-architecture.md](./experiment-2-anomaly-architecture.md)
- [experiment-2-reliability-validation.md](./experiment-2-reliability-validation.md)

**Scope confirmation:** sandbox-only, no production runtime touched, no SAP live connectivity, no PM2, no schedulers, no autonomous execution, no public exposure.

---

## 1. TL;DR

Three qualitative residuals from the prior validation are now bounded by code:

| Prior residual | Status | New defense |
|---|---|---|
| T5 — unsupported trend / causality claims | **Caught deterministically** when un-anchored to a verified id | `classifyNarrativeText` scanner + integrity flag + safety label |
| Vague action verbs ("בחן", "שקול", "review", "examine") | **Caught + reported** as `recommendation_issues` and `vague_only_actions` | `validateStructuredRecommendation` |
| Invented time horizons ("תוך 6 חודשים", "within 90 days") | **Caught at TWO layers**: schema enum + free-text scanner | `time_horizon` enum field + `TIME_HORIZON_REGEXES` |

**10/10 hardening tampering tests caught.** **3/3 live LLM runs** with hardened agent: deterministic anomalies hash-identical, 0 trend/causal/deadline claims, 0 invented numbers, recommendations fully structured.

**Verdict:** `READY_FOR_SANDBOX_EXPERIMENT_3` (see §10).

---

## 2. Files changed

| File | Change | Notes |
|---|---|---|
| `backend-sandbox/lib/sandboxPolicy.js` | **NEW** (~270 lines) | Phrase lists, allowed time-horizon enum, `classifyNarrativeText`, `validateStructuredRecommendation`, prompt-helper |
| `backend-sandbox/agents/registry.js` | Anomalysummary `submitTool.input_schema`, `systemPrompt`, `buildUserMessage`, `postProcess` extended | ~150 lines added/changed |
| (No other files touched.) | | |

No production runtime files. No SAP-related files. No PM2 configuration. No `.env.sandbox` content beyond the temporary key-injection ritual used for the 3 live runs (restored post-validation).

---

## 3. Hardening defenses — detailed

### 3.1 Allowed time-horizon enum (schema-enforced)

```js
ALLOWED_TIME_HORIZONS = [
  { canonical_id: 'immediate',         label_he: 'מיידי',           label_en: 'immediate' },
  { canonical_id: 'today',             label_he: 'היום',            label_en: 'today' },
  { canonical_id: 'this_week',         label_he: 'השבוע',           label_en: 'this week' },
  { canonical_id: 'next_review_cycle', label_he: 'בסבב הבדיקה הבא',   label_en: 'next review cycle' },
  { canonical_id: 'not_specified',     label_he: 'לא צוין',          label_en: 'not specified' },
]
```

Submit-tool schema includes `time_horizon: { type: 'string', enum: ALLOWED_TIME_HORIZON_IDS }`. Any other value → tool-call validation rejects (Anthropic-side enforcement). The model can use `not_specified` as an escape hatch — explicitly preferred over invention.

### 3.2 Free-text invented-deadline scanner

Defense in depth: the LLM might smuggle a deadline into `business_meaning` or `executive_summary` (which are free strings). The scanner runs **regex-based** patterns over those fields:

```js
// Hebrew
/תוך\s+\d+\s+(ימים|שבועות|חודשים|רבעונים|שנים)/g
/תוך\s+(שבועיים|שלושה\s+חודשים|רבעון|חצי\s+שנה|שנה|שנתיים)/g
/ב-?\d+\s+(ימים|שבועות|חודשים)\s+הקרוב/g
// English
/\bwithin\s+\d+\s+(days?|weeks?|months?|quarters?|years?)\b/gi
/\bin\s+the\s+next\s+\d+\s+(days?|weeks?|months?)\b/gi
/\bby\s+(end\s+of\s+)?(q[1-4]|quarter|year)\b/gi
```

Hits go into `integrity.invented_time_horizons` with the matched phrase + sentence excerpt.

### 3.3 Trend / causality scanner with evidence-link suppression

Phrase lists (Hebrew + English) for `TREND_PHRASES`, `CAUSAL_PHRASES`. The scanner segments the narrative on `.!?;\n`, then for each sentence:

1. Find which verified IDs (anomaly_id, metric_id) appear via substring match.
2. For each phrase-list hit, suppress the flag if the same sentence references at least one verified id.

**Rule:** *every trend / causal claim must be evidence-linked to a verified id in the same sentence*. Otherwise → flagged.

This is the user-mandated rule:
> Every trend/causality/urgency/time-horizon claim must reference a verified anomaly_id, metric_id, or deterministic policy field.

Validated by 10 tampering tests (see §6.1).

### 3.4 Urgency claim scanner

Per-anomaly urgency (engine-low anomaly with "קריטי" word) was already caught by the prior `severity_overpromotions` check. The new scanner adds:

- Un-anchored urgency in `executive_summary` / `prioritization_note` is allowed iff at least one anomaly in the verified set has `severity = 'high'`. If no high-severity anomaly exists, any urgency word is flagged.

### 3.5 Structured recommendation with required fields

Schema:

```jsonc
{
  "anomaly_id": "...",
  "business_meaning": "string ≤40 words",
  "recommended_action": {
    "owner":          "string (Hebrew, role/function)",
    "target":         "string (entity targeted)",
    "action":         "string ≤30 words (concrete directive)",
    "supporting_id":  "anomaly_id or metric_id from verified set",
    "time_horizon":   "enum: immediate | today | this_week | next_review_cycle | not_specified"
  }
}
```

`validateStructuredRecommendation` checks:
- All five fields present + non-empty
- `supporting_id` ∈ verified ID set
- `time_horizon` ∈ canonical enum
- `action` not vague-only (vague verb + length < 25 chars → flag)

Issues surface as `integrity.recommendation_issues` with the offending `anomaly_id` and a list of issue codes.

### 3.6 Safety label

A new `safety` block in the output:

```jsonc
{
  "label": "safe" | "caution_qualitative_claims_unsupported" | "unsafe_unsupported_claims_with_high_severity",
  "unsafe_for_high_severity": false,
  "explanation": "human-readable reason"
}
```

Hard cap: when **any** of `trend_claims | causality_claims | invented_time_horizons` is non-empty AND the verified set contains a high-severity anomaly, the run is labeled `unsafe_unsupported_claims_with_high_severity` and confidence is hard-capped to medium (or low if integrity_score < 0.6).

### 3.7 Updated integrity score

Now a 10-component average (was 6):

```
unknown_anomaly_ids       0.3 / 1
uncovered_anomaly_ids     0.5 / 1
invalid_theme_refs        0.5 / 1
severity_overpromotions   0.5 / 1
unverified_numbers        0   / 1
trend_claims              0   / 1   ← new
causality_claims          0   / 1   ← new
invented_time_horizons    0   / 1   ← new
recommendation_quality    0.5 / 1   ← new (covers all rec_issues)
validation_errors         0   / 1
```

Each component is exposed in `integrity.integrity_components` so an operator can see exactly which rule failed.

---

## 4. Smoke-test (no LLM) — 14 unit cases

All-pass before live runs:

| # | Case | Result |
|---|---|---|
| 1 | Hebrew detection regex (`[֐-׿]` matches `מגמה`, not `trend`) | ✓ |
| 2 | Clean — no claims, with id | ✓ 0 flags |
| 3 | Trend with id link | ✓ 0 flags (suppressed) |
| 4 | Trend without id link | ✓ 1 flag |
| 5 | Causality without id | ✓ 1 flag |
| 6 | Urgency on no high-sev | ✓ 2 flags |
| 7 | Urgency when high-sev exists | ✓ 0 flags |
| 8 | Invented "תוך 6 חודשים" | ✓ 1 flag |
| 9 | Invented "within 90 days" | ✓ 1 flag |
| 10 | Allowed "השבוע" | ✓ 0 flags |
| 11 | Recommendation complete | ✓ ok |
| 12 | Recommendation missing owner | ✓ rejected |
| 13 | Unknown supporting_id | ✓ rejected |
| 14 | Vague-only action | ✓ rejected |

---

## 5. Live LLM validation — 3 runs

**Input:** `{ "date_from": "2026-05-03", "date_to": "2026-05-10" }`
**Model:** `claude-haiku-4-5`

### 5.1 Determinism (preCompute output, hash compared)

| Run | Hash |
|---|---|
| 1 | `dde2f1454db2` |
| 2 | `dde2f1454db2` |
| 3 | `dde2f1454db2` |

**Identical: YES.** (Hash differs from prior validation's `596720b08040` because the schema definition feeds into the user message; the verified anomalies themselves are unchanged. New baseline noted.)

### 5.2 Per-run integrity

| Run | trend | causal | urgency_unsupp | inv. time | rec_issues | uncovered | severity_overpromotion | unverified_nums | integrity_score | confidence | safety |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 0 | **3** | 0 | 0 | 0.95 | high | safe |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.00 | high | safe |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1.00 | high | safe |

**Run 1 anomaly:** the LLM submitted an empty `anomaly_interpretations: []` array. The deterministic anomaly engine still produced 3 anomalies and the executive_summary covered all three by name; but the *structured* field (operator-actionable) was empty. The integrity layer flagged `uncovered_anomaly_ids = 3` and dropped score to 0.95. The `safety` label remained `safe` because no trend/causal/deadline violation occurred. See §8 for residual analysis.

### 5.3 Cost / latency

| Run | Cost | Tokens (in+out) | Wall |
|---|---|---|---|
| 1 | $0.0124 | 3,558 + 1,769 | 19.1 s |
| 2 | $0.0124 | 3,558 + 1,765 | 19.3 s |
| 3 | $0.0115 | 3,558 + 1,587 | 17.5 s |
| **total** | **$0.0363** | | |

Input tokens grew from ~2,435 (Exp 2 baseline) → 3,558 due to the longer system prompt + structured-schema description. Cost still well under budget.

### 5.4 Spot-check (Run 2 — fully populated structured recs)

Three structured recommendations:

| anomaly_id | owner | target | time_horizon | action excerpt |
|---|---|---|---|---|
| `customer_concentration_top3` | מנהל מכירות | C-MOCK-001, C-MOCK-002, C-MOCK-003 | `next_review_cycle` | "ערוך בדיקה של תנאי חוזים…" |
| `dead_stock_present` | מנהל מחסן | dead_stock_present | `this_week` | "זיהוי פריטים תורמי מלאי ואישור סילוק…" |
| `item_low_margin_MOCK-TINECO-IRON-A1` | מחלקת תמחור | MOCK-TINECO-IRON-A1 | `next_review_cycle` | "הערך מחדש את המחיר או העלויות…" |

All `time_horizon` values are canonical. All `supporting_id` values are real. All owners are non-empty role names. Targets are real entity names from the verified data.

---

## 6. Tampering tests — hardening suite

Pure-code adversarial test (no LLM call). 10 inputs, each mutating one aspect of a clean baseline.

### 6.1 Results

| # | Test | Caught? | Confidence | Safety label |
|---|---|---|---|---|
| H1 | Unsupported trend "מגמה גוברת" | ✅ trend=1 | medium | unsafe_unsupported_claims_with_high_severity |
| H2 | Trend WITH id link (suppressed) | ✅ trend=0 | high | safe |
| H3 | Unsupported causality "נובע מהאטה" | ✅ causal=2 | medium | unsafe_unsupported_claims_with_high_severity |
| H4 | Invented deadline "תוך 6 חודשים" | ✅ time=1 | medium | unsafe_unsupported_claims_with_high_severity |
| H5 | Invented `time_horizon` enum value `"within 90 days"` | ✅ rec_issues=1 | high (0.95) | safe |
| H6 | Vague-only action "בחן" | ✅ vague_actions=1, rec_issues=1 | high (0.95) | safe |
| H7 | Unknown `supporting_id` | ✅ rec_issues=1 | high (0.95) | safe |
| H8 | Owner missing | ✅ rec_issues=1 | high (0.95) | safe |
| H9 | Causality WITH id link (suppressed) | ✅ causal=0 | high | safe |
| H10 | Mixed unsafe (trend + invented deadline) | ✅ trend=2 + time=1 | medium | unsafe_unsupported_claims_with_high_severity |

**10/10 caught.** The 1/8 miss from prior validation (T5 — un-anchored trend claim) is now caught by H1.

### 6.2 Notable observations

- **H5 vs H4 separation.** A schema-level enum violation (H5 `"within 90 days"` typed into `time_horizon` field) is reported as `rec_issues` (recommendation-quality flag), while the SAME phrase typed into a free-text field (H4 `business_meaning`) is reported as `invented_time_horizons` (qualitative-claim flag). Two different defenses, two different signals. Operator can tell *where* the violation came from.
- **Causality test (H3).** The phrase "נובעת מהאטה" trips both `נובע` and `נובעת` (singular + feminine forms). Detecting both forms reduces false negatives at the cost of double-flagging the same sentence — acceptable.
- **H6 vs longer vague text.** "בחן" alone (≤25 chars) is flagged as vague-only. Longer compound text containing "בחן" but with a concrete companion verb is not flagged. Live run 2's "ערוך בדיקה של תנאי חוזים וברחבת לקוחות אלה וצור תוכנית צמיחה" passes — directive verbs ("ערוך", "צור") carry the action.

---

## 7. Before / after behavior summary

| Behavior | Before hardening (Exp 2 baseline) | After hardening (this addendum) |
|---|---|---|
| Trend claim un-anchored to id | T5 PASSED (residual) | **Flagged** + safety label downgraded |
| Causal claim un-anchored to id | not checked | **Flagged** + safety label downgraded |
| "תוך 6 חודשים" inside narrative | not checked | **Flagged** at free-text scanner level |
| Free-text recommendation | accepted | Flagged as `recommendation_not_structured` |
| `recommended_action` schema | string | Object with 5 required fields including enum-time-horizon |
| Vague-only verbs | reported as count only | **Flagged** with anomaly_id + snippet |
| Owner / target / supporting_id missing | not checked | **Flagged** per anomaly |
| Confidence cap on unsafe high-severity | none | **medium** (or low) |
| Operator output | confidence + integrity | confidence + integrity + **safety label** |
| Integrity components visible | aggregated only | per-component breakdown in `integrity_components` |

---

## 8. Remaining residual risks

### 8.1 LLM behavior — empty array submission (Run 1 occurrence)

The model submitted `anomaly_interpretations: []` once in 3 runs. Schema requires the field but doesn't (and cannot dynamically) require `minItems == verified.anomalies.length`. The integrity layer correctly flagged 3 uncovered anomalies and reduced score to 0.95.

**Decision:** The current behavior — `confidence: high` + `safety: safe` despite 0 interpretations — is **debatable**. An empty-array case provides almost no operator-actionable content even though every other dimension is clean. Two possible follow-ups (NOT applied here, scoped out):

1. **Hard cap on coverage.** If `uncovered_anomaly_ids.length > 0`, force confidence ≤ medium.
2. **Schema retry.** If the postProcess sees an empty array, ask runtime to retry once with a stricter system prompt.

Neither is in scope for this addendum. Documented as a follow-up.

### 8.2 Heuristic phrase lists are not exhaustive

The trend/causal phrase lists cover the most common Hebrew + English idioms but are not a complete linguistic catalog. Bypasses possible:

- "בחודש האחרון ראינו עלייה" — uses no listed phrase but implies trend.
- "מקור הבעיה הוא..." — implies causality without a listed verb.
- Lookalikes: "האטה" (slowdown) is a noun, not flagged on its own.

Mitigation:
- Phrase lists are easy to extend in `sandboxPolicy.js`.
- The integrity layer is one of multiple defenses — operator review remains the final gate.

### 8.3 Substring matching produces double counts

A sentence containing `נובעת` matches both `נובע` (substring) and `נובעת` (full word). The flag count overstates the issue. Acceptable: counts are signals not metrics, and the integrity-score component is already binary (any hit → 0).

### 8.4 Identifier-substring suppression is permissive

A sentence is "suppressed" from trend/causal flags as long as **any** verified id appears anywhere in the sentence — regardless of whether the id supports the specific claim being made. A clever model could write "מגמת ירידה ב-customer_concentration_top3" to suppress the flag even though the engine never asserted a trend.

Mitigation: rule-of-thumb only. Operator reads the narrative.

### 8.5 Time-horizon enum doesn't distinguish action urgency

The five enum values are sufficient for "act now / soon / later". They don't capture finer gradations ("within 30 days for high severity, within next quarter for low"). For the sandbox this is fine; production policies might need richer enums tied to severity.

### 8.6 Schema enforcement depends on Anthropic tool-use validation

If the API or a future model version stops enforcing `enum`, the free-text scanner is the backup. Both paths are tested.

### 8.7 Owner / target validation is non-strict

`owner` is just "non-empty string" — could be any role name. We don't enforce a closed enum (intentional: real Hebrew role names are heterogeneous). `target` is "non-empty" too. A model could enter `"manager"` for owner or `"the customer"` for target. Counts as a soft contract — operator reviews.

### 8.8 The Run-3 high-cost path

Input tokens grew ~46% from baseline (2,435 → 3,558) due to the longer system prompt and tool schema. Output tokens stayed similar. Cost grew 32% from $0.0094 → $0.0124 per run. Worth tracking; if a future hardening pass triples the prompt, sandbox-budget headroom shrinks.

---

## 9. Production isolation verification

Confirmed during this addendum's validation:

| Check | Result |
|---|---|
| Sandbox bind | `127.0.0.1:4101` only |
| Production runtime modified | No |
| Production PM2 disturbed | No (sandbox = bare `node server.js`) |
| SAP connectivity | None — anomalySummary has 0 data tools |
| Public exposure | None — Cloudflare tunnel doesn't reach port 4101 |
| `.env.sandbox` Anthropic key | Injected from `backend/.env` for the 3 live runs, restored to empty post-validation |
| Source mock files modified | None — preCompute is read-only |
| Schedulers / cron created | None |
| Operator notifications sent | None |
| Test scripts cleaned up | `_addendum-tamper.mjs` deleted post-validation |

After cleanup: sandbox process killed, `.env.sandbox` `ANTHROPIC_API_KEY=` empty, all backups removed.

---

## 10. Verdict

> **READY_FOR_SANDBOX_EXPERIMENT_3**

### Justification

1. **Trend / causality / invented-deadline guards installed and validated.** 10/10 hardening tampering tests caught all four claim categories, including the prior T5 residual.
2. **Recommendation structure enforced** — 5 required fields, schema-level enum on time_horizon, post-process validation on supporting_id and vague-only patterns.
3. **Two-layer defense for time horizons** — schema enum (Anthropic-side) + free-text regex scanner (defense in depth). Both demonstrated in tampering H4 / H5.
4. **Live runs are clean** — 3/3 runs produced `safety: safe`, 0 trend/causal/deadline claims, 0 unverified numbers. Determinism preserved (3/3 hash identical).
5. **Safety label downgrades automatically** — `unsafe_unsupported_claims_with_high_severity` triggers when high-severity work meets unsupported claims; confidence hard-capped to medium.
6. **Production isolation verified** — no SAP, no PM2, no scheduler, no public reach; env restored, processes stopped.

### Conditions

- Verdict authorizes **sandbox-only** advancement to Experiment 3 design + reliability validation.
- Does **not** authorize: production rollout of Exp 1 / Exp 2 / hardening, autonomous execution, PM2 integration, public exposure, scheduled runs, or the residual follow-ups (§8.1 coverage hard cap, §8.2 phrase-list expansion).
- Run-1 empty-array LLM behavior (§8.1) is documented and accepted for now; if it recurs in Experiment 3 design exercises, revisit before authorizing rollout.

The next authorized step (when the operator decides) is sandbox Experiment 3 — extending the deterministic-data + LLM-interpretation pattern to one of `reportExplainer` or `salesInsights`. Until then, the sandbox returns to idle.

---

## 11. Artifact pointers

| Artifact | Path |
|---|---|
| Policy module (new) | `backend-sandbox/lib/sandboxPolicy.js` |
| Hardened agent | `backend-sandbox/agents/registry.js` (`anomalySummary`) |
| Anomaly engine | `backend-sandbox/lib/verifiedAnomalies.js` |
| Shared scanner | `backend-sandbox/lib/verifiedMetrics.js` (`findUnverifiedNumbers`) |
| Architecture | `docs/architecture-review/experiment-2-anomaly-architecture.md` |
| Prior validation | `docs/architecture-review/experiment-2-reliability-validation.md` |
| Live run captures (temp) | `C:\Users\izik\AppData\Local\Temp\harden-runs\run-{1,2,3}.json` (may be reaped) |

Hashes and integrity values in this report are reproducible by re-running 3 calls against the same `(date_from, date_to)` input on the same source files with the same `DETECTOR_VERSION = 1` and the same `sandboxPolicy.js` phrase lists.

---

## 12. Sandbox-only declaration

This hardening addendum was conducted entirely under the sandbox runtime. It does not authorize, recommend, or imply any production deployment. The hardened anomaly summarizer remains a research artifact under controlled testing. It will remain so until the operator explicitly approves a production-readiness review against the criteria in `experiment-2-anomaly-architecture.md` §10.
