# CEO Daily Brief v2 — Verified-Metrics Architecture in Production

**Date:** 2026-07-25
**Status:** merged to branch, NOT yet enabled in production (all env gates default off).
**Replaces:** the v1 tool-calling brief agent (`agents/ceoBrief.js` before this change).

---

## Why

Sandbox validation of the v1 architecture measured a **50% numeric-fabrication
rate** — the LLM pulled raw rows via tools and did its own arithmetic
(`docs/architecture-review/ceo-brief-reliability-validation.md`).

The sandbox's verified-metrics redesign eliminated it: deterministic
calculator + narrative-only LLM + post-hoc integrity scan → **0% fabrication
across 5 identical runs** (`verified-metrics-llm-validation.md`).

This change ports that validated architecture from `backend-sandbox/` (mock
data) to `backend/src/` (live SAP), keeping the sandbox untouched.

## What changed

| File | Change |
|---|---|
| `backend/src/lib/verifiedNumbers.js` | NEW — numeric-integrity scanners, ported verbatim from the sandbox (shared literal regex, verified value-set harvester, unverified-number scanner). |
| `backend/src/lib/verifiedCeoBrief.js` | NEW — deterministic metrics + anomalies from live SAP via `financialReader` (daily sales, top customers/items, margin, dead/low stock, churn). Failed source → `insufficient_data` placeholder, never an estimate. |
| `backend/src/agents/ceoBrief.js` | REWRITTEN — the LLM is now a narrator: no data tools, verified payload embedded in the user message, forced `submit_brief` with narrative-only schema, `postProcess()` re-injects verified data and computes deterministic confidence. |
| `backend/src/agents/runtime.js` | Narrator-style agents (no data tools) get `tool_choice` forced to the submit tool from step 0. |
| `backend/src/services/ceoBriefEmail.js` | NEW — Hebrew RTL HTML rendering + delivery via the shared notifications SMTP transport. |
| `backend/src/workers/ceoBriefScheduler.js` | Sends the email after each scheduled run when enabled. |
| `frontend/src/pages/CeoBriefPage.jsx` | NEW — `/ceo-brief` (ADMIN): latest brief, KPI cards from verified metrics, run-now button, run history. |

Output schema: run `Output` now carries `schema_version: 2` with
`verified_metrics` / `verified_anomalies` (runtime-injected), `narrative`
(LLM), `integrity`, and `confidence`. v1 runs remain readable in the runs
API; the frontend flags them as legacy.

## Integrity model (same as sandbox)

1. Every number is computed in code with an explicit formula string.
2. The LLM may quote verified values, never transform them.
3. `postProcess` scans all narrative strings for numeric literals not in the
   verified set, and all `metric_id` / `anomaly_id` references against the
   verified IDs.
4. Confidence = f(sources_completeness, integrity_score) — computed, never
   LLM-claimed.

## Env gates (all default OFF)

```
CEO_BRIEF_SCHEDULE_ENABLED=false   # daily cron (07:00 Asia/Jerusalem)
CEO_BRIEF_CRON=0 7 * * *
CEO_BRIEF_EMAIL_ENABLED=false      # email delivery after scheduled runs
CEO_BRIEF_EMAIL_TO=                # comma-separated recipients (requires SMTP_*)
```

Manual runs stay available regardless of the schedule gate:
`POST /api/agents/ceo-brief/run` (ADMIN) or the `/ceo-brief` page.

## Rollout order

1. Merge; deploy with all gates off. Nothing changes at runtime.
2. From the `/ceo-brief` page, run manually against production SAP data a few
   times; check the integrity footer reports 0 unverified numbers.
3. Set `CEO_BRIEF_EMAIL_ENABLED=true` + `CEO_BRIEF_EMAIL_TO`, run manually —
   note: email is sent by the *scheduler* path only, so verify via a
   scheduled run or temporarily enable the schedule.
4. Set `CEO_BRIEF_SCHEDULE_ENABLED=true` for the daily 07:00 brief.

**Freeze note:** `freeze-policy.md` §1.2 forbids AI work until the migration
cutover completes. This branch respects that by default — nothing activates
without the env gates — but do not flip the gates in production until the
freeze is lifted.

## Tests

`npm test` in `backend/`:
- `lib/verifiedNumbers.test.js` — scanner + normalization + Hebrew-boundary regression
- `lib/verifiedCeoBrief.test.js` — window math, deterministic sums, anomaly thresholds, degraded-source behavior
- `agents/ceoBrief.test.js` — postProcess integrity (fabricated numbers, unknown IDs, coercions, tamper-resistance)
- `services/ceoBriefEmail.test.js` — RTL rendering, formatting, HTML escaping

(Pre-existing failures in `middleware/auth.test.js` and
`services/fileStorage.test.js` are unrelated — they fail on the base branch
too.)
