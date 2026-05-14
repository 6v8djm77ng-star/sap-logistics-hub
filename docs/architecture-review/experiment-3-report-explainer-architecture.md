# Sandbox Experiment 3 — Report Explainer Architecture

**Date:** 2026-05-10
**Status:** **DESIGN ONLY.** Not implementation. Not runtime validation. Not production integration.
**Scope:** Sandbox only. No production runtime, no SAP live connectivity, no PM2, no schedulers, no autonomous execution, no public exposure.
**Authorization granted for:** architecture/design work on `reportExplainer` (NOT `salesInsights`)
**Sister documents:**
- [verified-metrics-architecture.md](./verified-metrics-architecture.md) (Experiment 1)
- [experiment-2-anomaly-architecture.md](./experiment-2-anomaly-architecture.md)
- [experiment-2-reliability-validation.md](./experiment-2-reliability-validation.md)
- [experiment-2-reliability-hardening-addendum.md](./experiment-2-reliability-hardening-addendum.md)
- [experiment-2-coverage-hardening.md](./experiment-2-coverage-hardening.md)

---

## 1. Premise — generalization claim

The verified-data architecture has been validated for two adjacent surfaces:

| Surface | Purpose | Status |
|---|---|---|
| Experiment 1 — `ceoBrief` | Aggregate metrics + interpretation | Reliability-validated |
| Experiment 2 — `anomalySummary` | Discrete anomalies + interpretation + structured action | Reliability-validated, hardened, coverage-enforced |

Experiment 3 asks: **does the same architecture safely extend to a structurally different output type?**

`reportExplainer` differs from anomalySummary in three meaningful ways:

| Dimension | anomalySummary | reportExplainer |
|---|---|---|
| Unit of interpretation | Discrete anomaly object | Structured *report sections* (heterogeneous: KPI block, failure breakdown, per-stop flags, customer impact) |
| Cardinality | 0–N anomalies (small) | Multi-section, each with multi-row content (medium) |
| Severity model | Engine-assigned per anomaly | Section-level criticality derived from KPI thresholds + presence of flagged sub-records |
| Causality temptation | Low (anomalies are point-facts) | **Higher** ("stop 3 failed because the customer wasn't home" is plausibly verified; "the cascade of failures was caused by route mis-planning" is fabricated) |
| Recommendation surface | Per anomaly | Per critical section AND per flagged sub-record |
| Operational risk if hallucinated | Misallocated attention | **Misdiagnosed operational root cause** |

The premise of this design is that the same five primitives — deterministic verified data, integrity enforcement, fail_closed semantics, coverage policy, structured outputs, confidence governance — generalize to this richer structure with disciplined extension.

This document defines that extension. **No code is written here.** Implementation requires separate authorization.

---

## 2. Deterministic-vs-generative split

| Concern | Owner | Rationale |
|---|---|---|
| What sections exist | **Code** | Section taxonomy is fixed in the engine version. LLM cannot add a section. |
| Whether a section is present (e.g., `failure_breakdown` only when failures > 0) | **Code** | Determined deterministically from data. LLM cannot suppress or add a section. |
| Section criticality (high/medium/low/info) | **Code** | Threshold-driven, same discipline as `verifiedAnomalies.js`. |
| KPI values (completion_rate_pct, on_time_rate_pct, total_failures, etc.) | **Code** | Pure computation; no LLM. |
| Per-stop flags (e.g., this stop is "delayed" by >X minutes) | **Code** | Threshold-based detector. |
| Section narrative (Hebrew explanation of the section's meaning) | **LLM** | Bounded interpretation. |
| Per-flagged-record explanation | **LLM** | Bounded; references the specific record by id. |
| Cross-section themes (e.g., "all failures cluster in one geographic zone") | **LLM** | Bounded — the records the LLM points to must exist in verified data. |
| Recommendations | **LLM** | Structured (owner/target/action/supporting_id/time_horizon), same as anomalySummary. |
| Causality assertion ("X failed *because* Y") | **LLM, only when supported** | The LLM may state a causal relationship ONLY when the verified data carries the causal field (e.g., `FailureReason: "CUSTOMER_NOT_AVAILABLE"`). Inferred causality is forbidden. |
| Coverage decisions | **Code** | Same severity hierarchy as anomalySummary; sections take the role anomalies played there. |
| Confidence | **Code** | Deterministic, never LLM-claimed. |
| Severity-promotion language | **Detected by code** | Reuses the qualitative scanner from `sandboxPolicy.js`. |
| Time horizon enum | **Code** | Same five canonical values from `sandboxPolicy.js`. |

The LLM is **NEVER** allowed to:
- invent KPIs, sections, sub-records, customer names, stop ids, or numerical values;
- override engine-assigned criticality;
- introduce a recommendation referencing an entity not in the verified data;
- produce strategic claims (org structure, multi-period planning, market positioning);
- assert causality where the verified data does not provide a causal field.

---

## 3. Verified report inputs

A new module `backend-sandbox/lib/verifiedReport.js` (planned, not implemented) would produce:

```jsonc
{
  "report_id": "report_run_<RunId>_<RunDate>",
  "report_kind": "delivery_run_explanation",
  "report_version": 1,                          // analogous to DETECTOR_VERSION

  "subject": {
    "kind": "delivery_run",
    "run_id": 1001,
    "run_number": "RUN-MOCK-2026-05-10-01",
    "run_date": "2026-05-10",
    "driver_id": 1,
    "driver_name": "Mock Driver A",
    "status": "COMPLETED"
  },

  "sections": [
    {
      "id": "run_summary",
      "kind": "kpi_block",
      "criticality": "info",                    // info | low | medium | high
      "label_he": "סיכום סבב",
      "kpis": [
        { "id": "total_stops",          "label_he": "סך עצירות",      "value": 3,    "unit": "count" },
        { "id": "completed_stops",      "label_he": "עצירות הושלמו",   "value": 2,    "unit": "count" },
        { "id": "failed_stops",         "label_he": "עצירות כשלו",     "value": 1,    "unit": "count" },
        { "id": "completion_rate_pct",  "label_he": "אחוז השלמה",      "value": 66.67, "unit": "pct",
          "thresholds": { "high_below": 80, "medium_below": 90, "low_below": 100 },
          "criticality_contrib": "high" },
        { "id": "run_duration_minutes", "label_he": "משך סבב (דק)",     "value": 130,   "unit": "minutes" }
      ],
      "computed_at": "...",
      "source": "mock-data/runs.json"
    },
    {
      "id": "failure_breakdown",
      "kind": "categorical_breakdown",
      "criticality": "high",
      "present_when": "failed_stops > 0",
      "label_he": "פירוט כשלים לפי סיבה",
      "rows": [
        { "category": "CUSTOMER_NOT_AVAILABLE", "count": 1, "pct": 100.0,
          "stop_ids": [5003], "customer_codes": ["Mock Customer Gamma Ltd"] }
      ],
      "computed_at": "...",
      "source": "mock-data/runs.json"
    },
    {
      "id": "flagged_stops",
      "kind": "record_list",
      "criticality": "high",                    // promoted because contains a high-criticality flag
      "present_when": "any stop has Status != DELIVERED OR is delayed > threshold",
      "label_he": "עצירות מסומנות",
      "records": [
        {
          "record_id": "stop_5003",
          "stop_id": 5003,
          "customer_name": "Mock Customer Gamma Ltd",
          "city": "Herzliya",
          "status": "FAILED",
          "failure_reason_code": "CUSTOMER_NOT_AVAILABLE",
          "failure_reason_label_he": "הלקוח לא היה זמין",   // policy mapping
          "engine_criticality": "high",
          "notes_from_driver": "Closed for inventory; reschedule to next week"   // verbatim
        }
      ],
      "computed_at": "...",
      "source": "mock-data/runs.json"
    },
    {
      "id": "customer_impact",
      "kind": "entity_impact",
      "criticality": "medium",
      "present_when": "any failed stop OR any delayed stop > threshold",
      "label_he": "השפעה על לקוחות",
      "records": [
        { "customer_name": "Mock Customer Gamma Ltd", "stop_count": 1, "failed_count": 1,
          "engine_criticality": "high" }
      ],
      "computed_at": "...",
      "source": "mock-data/runs.json"
    }
  ],

  "summary": {
    "total_sections":         4,
    "by_criticality":         { "info": 1, "low": 0, "medium": 1, "high": 2 },
    "computed_overall_criticality": "high"
  },

  "warnings": [],                               // mock_missing, schema_violation, etc.
  "errors": [],
  "meta": {
    "computed_at":            "...",
    "report_version":         1,
    "sources_consulted":      ["mock-data/runs.json", "mock-data/failures.json"],
    "sources_returning_data": ["mock-data/runs.json"],
    "sources_missing":        [],
    "sources_completeness":   1.0
  }
}
```

**Key properties (mirroring `verifiedAnomalies.js`):**
- Pure computation; no LLM
- Same input + same source files → byte-identical (modulo `computed_at`)
- Schema validation fails closed (no LLM call downstream)
- Missing source → `confidence: 'insufficient_data'` on affected sections; never an estimate
- `report_version` increments with any threshold or section-taxonomy change

---

## 4. Section taxonomy (v1)

Locked in code. Section ids are stable across runs.

| Section id | Always present? | Criticality source | Notes |
|---|---|---|---|
| `run_summary` | always | derived from completion_rate KPI bands | The minimum operational record. |
| `kpi_indicators` | always | derived from worst KPI band | Subset of run_summary OR additional indicators. May be merged with `run_summary` in v1. |
| `failure_breakdown` | when failures > 0 | high if any reason ≥ X% OR total ≥ Y | Per-reason aggregation. |
| `flagged_stops` | when any stop has flag | takes the max criticality of its records | Includes failed stops + delayed stops > threshold. |
| `customer_impact` | when any customer touched by failure/delay | high if multiple customers affected, medium else | Aggregated by customer. |
| `geographic_pattern` | optional, when stops span ≥ N cities and pattern detected | low/medium | Deferred to v2; not in initial design. |
| `time_distribution` | optional, when run duration deviates from baseline | low/medium | Deferred to v2. |

**v1 implementation scope:** `run_summary`, `failure_breakdown`, `flagged_stops`, `customer_impact`. The two deferred sections are placeholders — adding them later requires a `report_version` bump.

**Severity (criticality) bands** are locked in code analogous to `verifiedAnomalies.THRESHOLDS`:

```js
THRESHOLDS_v1 = {
  completion_rate_pct: { high_below: 80, medium_below: 90, low_below: 100 },
  failure_count:       { low: 1, medium: 3, high: 5 },        // per run
  delayed_stop_minutes:{ low: 15, medium: 30, high: 60 },     // per stop
  customers_affected:  { low: 1, medium: 2, high: 3 },        // per run
}
```

---

## 5. Forbidden behaviors (explicit)

The LLM **MUST NOT**:

1. **Invent KPIs.** No number in narrative may exist outside `verified.sections[*].kpis[*].value` or `verified.sections[*].records[*]` field values.
2. **Invent sections.** Narrative may only have one `section_explanation` entry per `verified.sections[*].id`. New section topics ("supply chain analysis", "driver performance summary") are forbidden in v1.
3. **Invent sub-records.** Stop ids, customer names, doc numbers — only those present in verified data may appear.
4. **Infer missing business data.** "Stop 7 probably failed because the warehouse was closed" — forbidden unless `verified.records[].failure_reason_code === 'WAREHOUSE_CLOSED'` or similar deterministic field.
5. **Generate authoritative strategy.** "We should restructure last-mile delivery" — forbidden. Strategy is operator-owned.
6. **Fabricate causality.** Causal phrases ("נובע מ", "כתוצאה", "caused by") trigger the qualitative scanner; the same evidence-link rule applies — every causal claim must reference a deterministic causal field (e.g., `failure_reason_code`) OR a verified id in the same sentence.
7. **Fabricate timelines.** Free-text horizons ("תוך 6 חודשים", "next quarter") forbidden. Recommendations use the same canonical enum from `sandboxPolicy.ALLOWED_TIME_HORIZONS`.
8. **Override verified values.** "The actual completion rate is closer to 95%" — forbidden. Verified values are immutable.
9. **Promote criticality.** "This is critical" on a `medium` section — caught by qualitative scanner using existing severity-overpromotion heuristic.
10. **Span runs.** v1 explainer addresses ONE run. Cross-run claims ("today's failure rate is higher than yesterday's") are forbidden because no cross-run verified data is provided.
11. **Identify drivers as accountable for systemic issues.** Driver-level performance summaries are deferred to v2 with explicit policy + driver-side review.

---

## 6. Allowed behaviors (explicit)

The LLM **MAY**:

1. **Summarize verified KPIs in plain Hebrew.** "אחוז ההשלמה היה 66.67% — שתיים משלוש העצירות הושלמו."
2. **Explain relationships present in the data.** "הכשל של עצירה 5003 קושר ל-Mock Customer Gamma Ltd, שמופיע כלקוח היחיד הפעיל מתוך הקבוצה הזו." (when both are in verified data).
3. **Quote `failure_reason_label_he`** verbatim. The deterministic policy mapping (`'CUSTOMER_NOT_AVAILABLE' → 'הלקוח לא היה זמין'`) is the LLM's safe causality vehicle.
4. **Quote driver notes verbatim.** `notes_from_driver: "Closed for inventory; reschedule to next week"` may be quoted in narrative.
5. **Prioritize verified risks.** Identify which section deserves operator attention first, respecting engine-assigned criticality.
6. **Produce bounded recommendations.** Same structured schema as anomalySummary: `{owner, target, action, supporting_id, time_horizon}`. Per critical section, optionally per high-criticality record.
7. **Use the canonical time horizons** when recommendations require time framing.
8. **Indicate uncertainty.** "מקור לא זמין" / "Information not available" for missing data.

---

## 7. Structured explanation schema

```jsonc
// submitTool.input_schema (planned)
{
  "type": "object",
  "properties": {
    "executive_summary": {
      "type": "string",
      "description": "Hebrew, ≤120 words. References verified report id and overall criticality."
    },
    "section_explanations": {
      "type": "array",
      "description": "ONE entry per verified section_id. Cover every section.",
      "items": {
        "type": "object",
        "properties": {
          "section_id":         { "type": "string", "description": "MUST be one of verified.sections[*].id" },
          "narrative":          { "type": "string", "description": "Hebrew, ≤80 words. Explains this section's meaning. References at least one KPI id or record_id from this section." },
          "key_observations": {
            "type": "array",
            "description": "≤3 short bullets. Each must cite a KPI id or record_id from this section.",
            "items": { "type": "string" }
          }
        },
        "required": ["section_id", "narrative", "key_observations"]
      }
    },
    "flagged_record_explanations": {
      "type": "array",
      "description": "ONE entry per high-criticality record across all sections. May include medium-criticality records.",
      "items": {
        "type": "object",
        "properties": {
          "record_id":          { "type": "string", "description": "MUST be one of verified.sections[*].records[*].record_id" },
          "operational_meaning":{ "type": "string", "description": "Hebrew, ≤40 words. What does this record mean operationally?" },
          "failure_reason_label_he": { "type": "string", "description": "OPTIONAL. If included, MUST exactly match verified.records[*].failure_reason_label_he." }
        },
        "required": ["record_id", "operational_meaning"]
      }
    },
    "cross_section_themes": {
      "type": "array",
      "description": "OPTIONAL. Themes connecting 2+ sections. Each must list section_ids it spans.",
      "items": {
        "type": "object",
        "properties": {
          "title":          { "type": "string", "description": "Hebrew, ≤8 words." },
          "description":    { "type": "string", "description": "Hebrew, ≤40 words." },
          "section_ids":    { "type": "array", "items": { "type": "string" }, "minItems": 2 }
        },
        "required": ["title", "description", "section_ids"]
      }
    },
    "recommendations": {
      "type": "array",
      "description": "Structured actions. ONE per high-criticality section minimum; medium optional.",
      "items": {
        "type": "object",
        "properties": {
          "owner":          { "type": "string" },
          "target":         { "type": "string" },
          "action":         { "type": "string", "description": "Hebrew, ≤30 words. Concrete directive." },
          "supporting_id":  { "type": "string", "description": "section_id, KPI id, or record_id from verified data." },
          "time_horizon":   { "type": "string", "enum": "<canonical enum from sandboxPolicy>" }
        },
        "required": ["owner", "target", "action", "supporting_id", "time_horizon"]
      }
    },
    "prioritization_note": {
      "type": "string",
      "description": "Hebrew, 1-2 sentences. Which section should the operator address first, respecting engine criticality."
    }
  },
  "required": [
    "executive_summary",
    "section_explanations",
    "flagged_record_explanations",
    "recommendations",
    "prioritization_note"
  ]
}
```

Key differences from anomalySummary schema:
- Two coverage layers: **section coverage** (every section_id explained) AND **record coverage** (every high-criticality record explained).
- `key_observations` array forces citation density inside the narrative.
- `failure_reason_label_he` is the controlled causality vehicle (LLM may include only the verbatim mapped string).
- `recommendations` are top-level, not per-section, but each carries a `supporting_id` that links back.

---

## 8. Coverage policy for reports

A new policy module `backend-sandbox/lib/reportCoveragePolicy.js` (planned, not implemented) extends the patterns from `coveragePolicy.js`:

```js
REPORT_COVERAGE_POLICY = {
  // Section coverage
  required_section_coverage_by_criticality: {
    high:   1.0,    // 100% — uncovered → FAIL_CLOSED
    medium: 1.0,    // 100% — uncovered → unsafe_incomplete_coverage
    low:    1.0,    // 100% — uncovered → unsafe_incomplete_coverage (low gets stricter than anomalies)
    info:   0.5,    // 50%  — kpi indicators may sometimes be batched
  },

  // Record coverage (within sections that contain records)
  required_record_coverage_by_criticality: {
    high:   1.0,    // 100% — uncovered → FAIL_CLOSED
    medium: 1.0,    // 100% — uncovered → unsafe_incomplete_coverage
    low:    0.5,    // 50%  — same as anomaly low policy
  },

  // Recommendation coverage: every high-criticality section must have ≥1 rec
  require_recommendation_per_high_section: true,

  // Empty section_explanations on non-empty verified.sections → FAIL_CLOSED
  fail_on_empty_section_explanations_when_sections_exist: true,

  // Each section_explanation must have ≥1 key_observation citing something
  // from the section
  require_at_least_one_observation_per_section: true,

  // Each section_explanation.narrative must reference at least one KPI id
  // or record_id from the same section
  require_in_section_id_reference: true,

  // Structured recommendation requirement (same as anomalySummary)
  require_structured_recommendation: true,
}
```

**Why stricter than anomaly coverage:**
- Reports are presented as comprehensive operational documents. A missing section *looks* like the system thinks the topic doesn't matter, even when the engine flagged it. That's a worse signal than a missing anomaly interpretation.
- Low-severity sections are still required at 100% because they're rare in v1 (the section taxonomy is small). When v2 adds optional sections, the 100% rule may be relaxed.

**Failure code taxonomy** (deterministic):

| Code | Trigger | Escalation |
|---|---|---|
| `empty_section_explanations_with_verified_sections` | LLM submitted `[]` while engine produced ≥1 section | **FAIL_CLOSED** |
| `uncovered_section:high:<id>` | High-criticality section has no `section_explanation` | **FAIL_CLOSED** |
| `uncovered_record:high:<record_id>` | High-criticality record has no `flagged_record_explanation` | **FAIL_CLOSED** |
| `uncovered_section:medium:<id>` | Medium-criticality section uncovered | unsafe_incomplete_coverage |
| `uncovered_section:low:<id>` | Low-criticality section uncovered | unsafe_incomplete_coverage |
| `uncovered_record:medium:<id>` | Medium-criticality record uncovered | unsafe_incomplete_coverage |
| `record_coverage_below_low_threshold:<observed>` | Low-criticality record coverage < 50% | unsafe_incomplete_coverage |
| `missing_observations:<section_id>` | Section explained but no `key_observations` | unsafe_incomplete_coverage |
| `narrative_no_in_section_id_ref:<section_id>` | Section narrative doesn't cite any in-section id | unsafe_incomplete_coverage |
| `missing_recommendation_for_high_section:<section_id>` | High-criticality section has no recommendation | unsafe_incomplete_coverage |
| `non_structured_recommendation:<index>` | Recommendation is string instead of object | unsafe_incomplete_coverage |
| `recommendation_supporting_id_unknown:<id>` | Recommendation cites id not in verified set | unsafe_incomplete_coverage |
| `recommendation_time_horizon_invalid:<value>` | Recommendation time_horizon not in enum | unsafe_incomplete_coverage |

---

## 9. Confidence model

Same structure as anomalySummary, with adjustments:

```
confidence_components = {
  unknown_section_ids,                  // 0/1
  uncovered_section_ids,                // 0/0.5/1
  uncovered_record_ids,                 // 0/0.5/1
  invalid_theme_refs,                   // 0/0.5/1
  missing_observations,                 // 0/0.5/1
  narrative_no_in_section_id_ref,       // 0/0.5/1
  unverified_numbers,                   // 0/1
  trend_claims,                         // 0/1
  causality_claims_unsupported,         // 0/1   ← stricter for reports (see §10)
  invented_time_horizons,               // 0/1
  recommendation_quality,               // 0/0.5/1
  section_coverage_ratio,               // 0..1 continuous
  record_coverage_ratio,                // 0..1 continuous
  validation_errors,                    // 0/1
}
integrity_score = mean(components)

confidence_overall =
  if (fail_closed_for_high)             → 'low'
  elif (sources_completeness ≥ 0.9 AND integrity_score ≥ 0.9) → 'high'
  elif (sources_completeness ≥ 0.7 AND integrity_score ≥ 0.7) → 'medium'
  else                                  → 'low'

confidence_overall = applyConfidenceCap(confidence_overall, coverage.enforcement.cap)
```

**Critical addition over anomalySummary:** the *causality* component is binary 0/1 (vs anomalySummary's same scoring). For reports, causality fabrication is operationally more dangerous because reports are read as diagnostic documents — a fabricated cause becomes a misallocated remediation.

---

## 10. Integrity scanning — extended causality rule

Reuses `sandboxPolicy.classifyNarrativeText` for trend / urgency / time-horizon detection unchanged.

Causality detection is **extended** for reports:

| Sentence pattern | Verdict |
|---|---|
| Causal phrase + verified id mentioned in same sentence | OK (existing rule) |
| Causal phrase + `failure_reason_label_he` quoted verbatim | OK (new rule for reports) |
| Causal phrase + verified KPI id mentioned in same sentence | OK |
| Causal phrase + no id, no failure_reason | **FLAGGED** |

The `failure_reason_label_he` allowance is what makes report explanations operationally useful. Without it, the LLM cannot say "the stop failed *because* the customer wasn't home" — which is exactly the operationally-correct framing the engine has *already* labeled.

Implementation note: the scanner needs the verified report's `failure_reason_label_he` strings added to the suppression set when scanning narrative. This is a small extension to `sandboxPolicy.classifyNarrativeText` (or a wrapper).

---

## 11. Fail_closed rules (consolidated)

Same priority-cascade structure as anomalySummary:

| Trigger | Result |
|---|---|
| `empty_section_explanations_with_verified_sections` | `fail_closed = true`, `safety = fail_closed_silent_omission` |
| `uncovered_section:high:<id>` (any) | `fail_closed = true`, `safety = fail_closed_silent_omission` |
| `uncovered_record:high:<record_id>` (any) | `fail_closed = true`, `safety = fail_closed_silent_omission` |
| Trend/causal/time claim AND high-criticality section exists | `safety = unsafe_unsupported_claims_with_high_severity` |
| Any other coverage failure | `safety = unsafe_incomplete_coverage`, `confidence ≤ medium` |
| Any qualitative claim without high-criticality section | `safety = caution_qualitative_claims_unsupported` |
| Some low-severity records uncovered but within threshold | `safety = partial_low_severity_uncovered` |
| Otherwise | `safety = safe` |

The `fail_closed: true` boolean is the unambiguous downstream gate. Operator dashboards must NOT render a fail_closed report's narrative; they may render the verified data block (which is deterministic truth) with an explicit "explanation unavailable" message.

---

## 12. Downstream consumption model

The output document has four layers of trust:

| Layer | Trust level | Operator can use without human review? |
|---|---|---|
| `verified` (sections, KPIs, records) | Deterministic source of truth | YES, always |
| `coverage`, `integrity`, `confidence`, `safety` | Deterministic policy verdict | YES, always |
| `narrative` (section_explanations, themes, prioritization_note) | LLM-produced, scanned | Only if `safety = safe` AND `confidence ≥ medium` |
| `recommendations` (structured) | LLM-produced, scanned, validated | Only if `safety = safe` AND `fail_closed = false` AND operator confirms each |

Recommendation: production consumers of `reportExplainer` outputs should:
1. **Always** render the `verified` block (truth).
2. **Conditionally** render the narrative based on `safety.label`.
3. **Never auto-act** on recommendations — they require operator confirmation.
4. **Surface the `safety.explanation` text** prominently when label ≠ `safe`.

Compare to anomalySummary: same trust hierarchy, same gating discipline. Generalization holds.

---

## 13. Hallucination risk surfaces (residual after design)

Even with this design, these surfaces remain:

| Risk | Status | Mitigation |
|---|---|---|
| LLM invents a KPI value (e.g., quotes a wrong completion rate) | Caught by `findUnverifiedNumbers` | Existing scanner |
| LLM invents a section topic | Caught by `unknown_section_ids` check | New post-process check |
| LLM invents a stop id or customer name | Caught by `findUnverifiedNumbers` (numbers) + a new `unknown_record_ids` check (strings) | New post-process check |
| LLM infers a cause not in `failure_reason_code` | **Partially caught** — "נובע מ" without verified id is flagged; but a fluent paraphrase that avoids the listed phrase may slip through | Phrase list extension + operator review |
| LLM produces a recommendation referencing the wrong owner role | Not caught (free-text owner) | Operator review |
| LLM omits a low-severity section that's structurally important (e.g., `kpi_indicators`) | Caught: low coverage = 100% required | New post-process check |
| LLM rephrases a `failure_reason_label_he` non-verbatim | Caught: `failure_reason_label_he` field in submitted explanation is required to match verbatim | New post-process equality check |
| LLM produces recommendations for non-critical sections that are operationally noisy | Soft: count flag, not blocking | Operator review |
| LLM presents a flagged_stop's `notes_from_driver` as fact when the note is the driver's hypothesis | **NOT caught** — driver notes are verbatim "verified" but their semantic correctness is unverified | Operator review; could add a "driver-quoted" tag in narrative |
| Prompt injection via `notes_from_driver` (driver writes "ignore previous instructions") | **NOT caught** — driver notes are quoted verbatim | Strip control sequences in `verifiedReport.js`; documented sanitization rule |
| Reading-order assumptions (LLM assumes stops are in chronological order without explicit timestamp) | Not directly caught | Engine ensures stops carry timestamps; LLM relies on those |

**Most dangerous residuals:** prompt injection via driver notes (item 10) and unverified semantic correctness of verbatim notes (item 9). Both require *engine-side* sanitization, not LLM-side.

---

## 14. Explainability limits

The design has explicit boundaries on what the explainer can produce:

- **Single-run scope.** No cross-run trends. No comparison to "yesterday's run". v2 may add a multi-run report kind with its own architecture pass.
- **Section taxonomy is closed.** Adding sections requires a `report_version` bump.
- **Causality only via deterministic fields.** No inference of unknown causes.
- **No driver evaluation.** Driver-level performance summaries are out of scope. v2 with HR review.
- **No customer scoring.** Customer-level reliability scores are out of scope. v2 with separate verification.
- **No operational strategy.** Strategic claims are operator-owned. The LLM's recommendations are tactical, time-bounded, and structured.
- **No timeline forecasting.** The verified data is a snapshot; predictions of future failure rate are forbidden.

---

## 15. Operator review requirements

Even with `safety = safe` and `confidence = high`, the operator must:

1. Read the `verified` block first. The narrative is supplementary.
2. Confirm each `recommendation` before action — never auto-act.
3. Cross-check `failure_reason_label_he` quotations against the engine's policy mapping (the engine *might* mis-label; the LLM cannot fix that).
4. When `safety.label = 'caution_qualitative_claims_unsupported'`, treat the narrative as advisory only.
5. When `safety.label` starts with `unsafe_*` or `fail_closed_*`, do NOT act on narrative or recommendations.
6. When the report involves a high-failure-rate run, escalate per existing logistics SOPs — the explainer is supplementary, not a replacement for SOP.
7. Inspect `coverage.uncovered_*` lists periodically to check for systematic LLM omission patterns.
8. Inspect `integrity.unverified_numbers_in_text`, `trend_claims`, `causality_claims` for systematic prompt-engineering gaps.

---

## 16. Production-rollout blockers (cannot be lifted in design phase)

Production deployment of `reportExplainer` would require ALL of:

| Blocker | Status |
|---|---|
| Live SAP source integration with same fail-closed behavior | Not in design |
| Cross-source consistency (run data + failure data + customer data must reflect the same period) | Not in design |
| Driver-note sanitization against prompt injection | **Not in design** — must add to `verifiedReport.js` |
| Audit log: every report ever produced, with `report_version` + verified data snapshot | Not in design |
| Operator override path (acknowledge / suppress) | Not in design |
| Recommendation execution gate (UI-side block; never auto-act) | Operator-side, not in scope |
| Multi-period verified report kind (for trend support) | Deferred to v2 |
| Prompt-injection red-team review | Required |
| Customer-name PII handling | Required if non-mock data used |
| Reliability validation (5+ runs, tampering, missing-data, coverage) | Deferred to next experiment phase |
| Cost projection for production-cadence usage | Required |
| Rollback path | Required |
| Content-policy review for recommendation language | Required |

The list is intentionally long. None of these is in scope for this design or for any subsequent sandbox validation phase. Production is a separate world.

---

## 17. Changes required to existing sandbox modules (for future implementation)

When implementation is authorized, these modules would change:

| Module | Change |
|---|---|
| `lib/verifiedReport.js` | **NEW** — engine producing the verified report object per §3 |
| `lib/reportCoveragePolicy.js` | **NEW** — coverage policy + evaluator per §8 |
| `lib/sandboxPolicy.js` | **EXTEND** — `classifyNarrativeText` accepts an optional `causal_safe_phrases` set so `failure_reason_label_he` strings can be added per call |
| `agents/registry.js` | **EXTEND** — replace legacy `reportExplainer` agent with verified-data flow (preCompute / buildUserMessage / postProcess / submitTool) |
| `agents/runtime.js` | **NO CHANGE** — `runAgentDef` already supports preCompute/postProcess pattern |
| `mock-data/runs.json` | **EXTEND (test fixtures only)** — additional runs with multiple failures for higher-criticality test |
| `lib/verifiedMetrics.js` `findUnverifiedNumbers` | **NO CHANGE** — sandbox-shared; reused as-is |
| `lib/coveragePolicy.js` | **NO CHANGE** — anomalySummary still uses it |

Implementation is NOT authorized at this point.

---

## 18. Validation plan (when implementation is later authorized)

Mirroring Experiment 2's discipline:

1. **Determinism:** 5 identical runs, hash-compare `verified_report` (must be byte-identical modulo `computed_at`).
2. **Tampering (no LLM):** synthetic narratives with each forbidden behavior from §5; ensure each is caught with the right escalation.
3. **Missing-source:** rename one of `runs.json` / `failures.json`; confirm `confidence: insufficient_data` on affected sections, no fabrication.
4. **Coverage:** synthetic narratives that omit a high-criticality section, a high-criticality record, a recommendation; confirm `fail_closed`.
5. **Driver-note injection:** craft a `notes_from_driver` containing prompt-injection text; confirm engine-side sanitization or, at minimum, that the LLM doesn't follow the injected instruction.
6. **3+ live LLM runs:** clean baseline confirmation; cost & latency.
7. **Qualitative review:** trend / causality / urgency / vague-verb counts across runs.

This plan is documented for traceability. **It is not authorized to execute.**

---

## 19. Architectural risk review

| Risk class | Severity | Why |
|---|---|---|
| Generalization gap | Medium | Two prior experiments don't guarantee a third works. The structural difference (sections vs flat anomalies) could expose unforeseen failure modes. Mitigation: this design's coverage layer is *stricter* than anomalySummary's, anticipating the higher operational risk. |
| Causality permission scope creep | High | Allowing causality via `failure_reason_label_he` is a real expansion of LLM authority. Misuse would be operationally serious. Mitigation: the allowance is structural (verbatim-quote rule, deterministic mapping in engine), not interpretive. |
| Driver-note prompt injection | High | Verbatim-quote design hands the model attacker-controlled text. Mitigation: engine-side sanitization is mandatory before any non-mock data flows. |
| Cost growth | Low | Each hardening pass adds ~50% to prompt size. Reports add another large block (verified sections + records). Could push per-run cost from $0.012 → $0.02+. Tracked, not blocking. |
| Section taxonomy ossification | Medium | Once locked at v1, adding sections requires a version bump. May discourage useful additions. Mitigation: documented version-bump discipline. |
| Coverage at low criticality (100% required for low) | Low | May force noisy interpretations of trivial sections. Mitigation: v1 has a small section taxonomy; if v2 expands, the 100%-low rule may be relaxed via explicit threshold change. |
| Trust hierarchy mis-rendering | Medium | Downstream UI must clearly separate verified vs narrative. A UI that conflates them defeats the architecture. Mitigation: documented in §12; UI implementation is operator scope. |

---

## 20. Verdict for this design phase

This document is the architecture deliverable. The next steps are **operator-decided**, not Claude-initiated:

| Option | What it authorizes |
|---|---|
| Proceed to Experiment 3 implementation | Build `verifiedReport.js`, `reportCoveragePolicy.js`, wire agent. Reliability validation as a separate authorization. |
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
- Driver-note exposure to non-mock data without sanitization

---

## 21. Sandbox-only declaration

This architecture document was produced under the sandbox runtime constraint. It represents a design proposal, not a deliverable system. The reportExplainer agent does not yet exist in the verified-data architecture; the legacy agent in `registry.js` is unchanged. Until implementation is authorized AND reliability validation passes AND the production-rollout blockers in §16 are met, the verified-data architecture for reports remains a research design.

---

## 22. Operational principle (extended)

Restated and extended:

> **In executive systems, omission risk is operationally equivalent to fabrication risk.**
> **In diagnostic systems, fabricated causality is operationally equivalent to a wrong remediation.**
> A report that says "the stop failed because of route mis-planning" when the engine knows it failed because the customer wasn't home doesn't just hallucinate — it sends the operator to fix the wrong thing.

This document codifies that principle by:
- Restricting causality to verified-field reuse (§10)
- Forbidding inferred causation (§5.4, §5.6)
- Coverage-enforcing every flagged record (§8)
- Mandating verbatim quotation of `failure_reason_label_he` strings (§7, §10)

The objective is **trustworthy executive interpretation under deterministic operational boundaries** — not "smarter AI". The design is intentionally narrow.

---

## 23. Cross-references

- **Architecture parents:** `verified-metrics-architecture.md`, `experiment-2-anomaly-architecture.md`
- **Coverage hardening parent:** `experiment-2-coverage-hardening.md`
- **Qualitative-integrity policy:** `backend-sandbox/lib/sandboxPolicy.js`
- **Coverage policy:** `backend-sandbox/lib/coveragePolicy.js`
- **Mock data referenced:** `mock-data/runs.json`, `mock-data/failures.json`
- **Legacy agent (to be replaced when authorized):** `backend-sandbox/agents/registry.js` → `reportExplainer`

---

## 24. End of design phase

The architecture is documented. No code was written. No mock data was modified. No sandbox process was started. No live LLM was called. No production runtime was touched.

The sandbox returns to idle. Awaiting operator decision on whether to authorize implementation as a separate phase.
