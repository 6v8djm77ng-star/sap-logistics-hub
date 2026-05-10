# P0 Fixes — Applied 2026-05-09

Read-only-then-fix pass. Source of P0 list: `security-analysis.md` §8 (F1–F10) and
`recommendations.md` Tier 0 (0.1–0.8).

The user constraint was: **fix only confirmed P0 issues; document anything ambiguous instead of guessing.**

---

## ✅ Applied (10 changes, 9 files)

| # | Finding | File | Change |
|---|---|---|---|
| F1 | `cors:'*'` on Socket.IO | `backend/src/sockets/index.js` | Origin allow-list bound to `env.CORS_ORIGINS`; reject + log on bad origin; defense-in-depth Origin check inside `io.use`. |
| F2 | Driver IDOR on stops/orders | `backend/src/routes/driver.js` | Added `driverOwnsEntity(req, {stopId\|runOrderId})` helper that joins `RunOrders → DeliveryStops → DeliveryRuns.DriverId`. ADMIN bypass. Applied to the **three** write handlers F2 specifically called out (`PATCH /stops/:stopId/status`, `POST /stops/:stopId/complete`, `POST /orders/:runOrderId/deliver`). 403 on mismatch. |
| F3 | DRIVER reads any GPS / trail | `backend/src/routes/tracking.js` | `requireRole('ADMIN','PLANNER')` on `GET /drivers` and `GET /drivers/:id/trail`. `POST /position` unchanged (driver-self path). |
| F4 | DRIVER reads SAP customer DB | `backend/src/routes/customers.js` | Router-level `requireRole('ADMIN','PLANNER')`. |
| F5 | DRIVER reads DAVO revenue/buyers | `backend/src/routes/davoMix.js` | Router-level `requireRole('ADMIN','PLANNER')`. The previous `POST /weekly-report/run` ADMIN gate is now redundant but kept (defense in depth). |
| F6 | DRIVER reads all KPI dashboards | `backend/src/routes/analytics.js` | Router-level `requireRole('ADMIN','PLANNER')`. The per-endpoint gate on `/summary` is now redundant but harmless and kept. |
| F7 | DRIVER reads every driver's contact info | `backend/src/routes/drivers.js` | Per-endpoint `requireRole('ADMIN','PLANNER')` on `GET /` only — kept other endpoints' existing ADMIN gates. |
| F8 | Any authed user reads any audit trail | `backend/src/routes/audit.js` | Router-level `requireRole('ADMIN')`. |
| F9 | Any authed user pulls any manifest PDF / picking XLSX | `backend/src/routes/reports.js` | Router-level `requireRole('ADMIN','PLANNER','WAREHOUSE')`. **See deferred-2 below** — this temporarily breaks DRIVER manifest downloads if any UI uses this path; the safe scope is "admin/planner/warehouse only" until per-driver-own-manifest is wired. |
| F10 | Public Cloudflare tunnel URL committed | `cf-tunnel.log` (repo root) | File deleted. |

**Syntax check:** `node --check` passes for all 9 modified files.

**No restart performed** per the user's standing constraint. Changes are inert until backend is restarted.

---

## ⚠️ Deferred — require a decision I refused to guess

### D1 — Tier 0 item 0.4 (second half): rotate `JWT_SECRET`
**Why deferred:** rotating `JWT_SECRET` requires editing `backend/.env`, which is on the explicit do-not-touch list. It also forces every active session and driver token to re-login — that's an operational decision, not a code change.

**What's needed:** owner picks a maintenance window, generates a new 32-byte secret, updates `.env`, restarts PM2. The cf-tunnel log is already deleted (F10) so the leaked URL is gone from the repo, but anyone who captured live traffic during the tunnel's lifetime can still use any unexpired token they captured. Rotating the secret is the durable fix.

### D2 — Tier 0 item 0.5: stop fabricating KPIs in `routes/orders.js stats`
**Why deferred:** `kpi-analysis.md` flags that `mergeRatio`, `stopsSaved`, `mergedStops`, `totalStops` in this endpoint are computed as `Math.ceil(totalOpen*0.8)`-style placeholders. The fix is **either** "compute the real numbers from `DeliveryStops` joined with `RunOrders`" **or** "remove the fields from the response and update the frontend that consumes them." Both are reasonable — the choice is product-policy, not security-mechanical.

**What's needed:** decision on whether the dashboard tile that shows `mergeRatio` / `stopsSaved` should display real data or be removed. Then a code change that either computes the figure or trims the response shape (and updates `frontend/src/pages/DashboardPage.jsx`).

### D3 — Tier 0 item 0.6: pick one definition of "revenue"
**Why deferred:** `kpi-analysis.md` documents three live, conflicting definitions:
- `OINV.DocTotal` (gross / VAT-inclusive) used by `services/sap/financialReader.js`
- `INV1.LineTotal` summed (net of VAT) used by `services/davoMix.js` and `getTopItems`/`getMarginByItem`
- Open-order `DocTotal` (pipeline, not booked) used by customer-profitability

The choice between gross and net depends on what the CEO and DAVO weekly report should show. That's a finance/leadership decision (Israeli tax-inclusive numbers vs. revenue-recognition numbers). Picking the wrong one and pushing it as "the standard" will cause a worse problem — a change in reported numbers without explanation — than the current inconsistency.

**What's needed:** finance owner names the canonical definition. Then a documented constant (e.g., a comment block at the top of each KPI service file) and a coordinated change across `davoMix.js`, `financialReader.js`, `analytics.js`, weekly-report templates, and CEO-Brief tools.

### D4 — Tier 0 item 0.7: fix `Insights.AgentRunId` type mismatch
**Why deferred:** `prisma-analysis.md` confirms `Insights.AgentRunId UNIQUEIDENTIFIER` cannot ever join `AgentRuns.RunId INT IDENTITY`. The fix is a schema migration — but **which side migrates?**
- Option A: change `Insights.AgentRunId` to `INT` (one column, no rows referenced today since the join is broken — likely empty in practice).
- Option B: change `AgentRuns.RunId` to `UNIQUEIDENTIFIER` (touches `AgentToolCalls.RunId` FK, `routes/agents.js`, `agents/runtime.js`, `agents/store.js`, frontend identifiers).

Option A is far cheaper and more reversible. Either way, applying the migration requires running `node src/db/migrate.js` against the live Logistics DB. The constraint says no env / restart changes; this also touches DB schema, which is a production-impact action that should not be done implicitly.

**What's needed:** confirmation that Option A is acceptable, plus an opportunity to apply the migration. I can prepare `database/migrations/013_fix_insights_agent_run_id.sql` if you confirm.

### D5 — Tier 0 item 0.8: cap AI runtime cost
**Why deferred:** `lib/intelligence/aiCostGuard.js` is a Phase-1 stub (`checkBackpressure` returns `{ ok: true, reason: 'phase1_no_enforcement' }`). The real implementation requires:
1. Reading `AiSpendBudget` rows (created by migration 012).
2. Aggregating `AgentRuns.CostUsd` for the relevant window.
3. Deciding the daily / hourly cap **value** — that's a business cost-tolerance decision (today's CEO Brief uses ~X tokens; what daily ceiling is acceptable?).
4. Wiring `runtime.runAgent` to call `checkBackpressure` before each tool-loop iteration and abort gracefully.

The mechanical wiring is straightforward but the budget number is a policy input I will not invent. The current state is that `routes/agents.js` already gates LLM endpoints behind `requireRole('ADMIN')`, so the immediate exposure is a runaway loop within an admin-initiated run, bounded by `AGENT_MAX_TOOL_CALLS=8` and `AGENT_MAX_TOKENS_OUT=4096`. That's not zero risk but it is bounded.

**What's needed:** budget figure (USD / day). Then I can implement `aiCostGuard.checkBackpressure` and integrate it into `agents/runtime.js` in one pass.

### D6 — Out-of-scope but related: `routes/runs.js`, `routes/returns.js`, `routes/failures.js`, `routes/picking.js`, `routes/orders.js`
**Why deferred:** `security-analysis.md` §1 (RBAC matrix) and §3 (IDOR) flag that any authed user — including DRIVER — can read any run, return, failure, or picking detail by guessing an `:id`. These are listed as P1 in the file, not P0, so they fall outside this fix pass. Worth a follow-up.

### D7 — Driver's own manifest download (knock-on from F9)
**Why flagged:** F9 closed `routes/reports.js` to `ADMIN/PLANNER/WAREHOUSE`. If any driver UI hits `GET /api/reports/runs/:id/manifest.pdf` to download their own run manifest, that path now 403s. The driver mobile manifest is served via `GET /api/driver/runs/:id/manifest` (in `routes/driver.js`) which is a different route and still works. If a separate PDF download is needed for the driver, the right shape is a new endpoint under `/api/driver/runs/:id/manifest.pdf` that calls the same generator and runs `driverOwnsEntity`.

**Action:** verify with frontend that no driver page calls `/api/reports/...`. If one does, add the driver-scoped equivalent.

---

## What I disagreed with — none

Every P0 finding I read in `security-analysis.md` is supported by the file:line evidence in the document. I had no reason to push back on any of F1–F10. The deferrals above are about **decisions** (policy/budget/schema-direction), not about **disagreement**.

---

## Verification suggestion when you next restart the backend

```
# After PM2 restart, sanity-check 401/403s on the gated routes with a DRIVER token:
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/customers/search?q=test     # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/davo-mix/summary             # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/analytics/overall            # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/audit/User/1                 # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/reports/runs/1/manifest.pdf  # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/tracking/drivers             # expect 403
curl -H "Authorization: Bearer <DRIVER_TOKEN>" https://<host>/api/drivers                      # expect 403

# F2 ownership: with a DRIVER_TOKEN whose driverId != stop's run.DriverId
curl -X PATCH -H "Authorization: Bearer <OTHER_DRIVER_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"status":"DELIVERED"}' \
  https://<host>/api/driver/stops/<some-other-driver-stop-id>/status                            # expect 403

# F1 Socket.IO: connect from disallowed origin → handshake should fail
# (test in browser devtools from an off-list origin — connection event fires error)
```

End of P0 fix pass.
