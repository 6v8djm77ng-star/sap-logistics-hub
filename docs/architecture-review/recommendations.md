# Recommendations — Prioritized Roadmap

**Generated:** 2026-05-09. Synthesizes findings from `system-overview.md`, `prisma-analysis.md`, `sync-analysis.md`, `kpi-analysis.md`, `security-analysis.md`, `performance-analysis.md`, `technical-debt.md`.

Each item includes: **rationale**, **target effort** (S=≤1d, M=≤1w, L=≤1mo, XL=multi-month), and the **source finding(s)** that justify it.

---

## Tier 0 — Immediate critical fixes (this week)

These are exploitable now, or actively shipping wrong numbers to leadership. Do not defer.

### 0.1 Lock down Socket.IO CORS — **S**
- **Action:** `sockets/index.js:16` — replace `cors: { origin: '*' }` with the same allow-list used by Express CORS (`env.CORS_ORIGINS`).
- **Why:** A stolen JWT works from any origin via WebSocket today. The comment "tighten for production" has been there since launch.
- **Source:** security-analysis P0 #1.

### 0.2 Add per-stop ownership check in driver routes — **S**
- **Action:** In `routes/driver.js:58, 116, 149` and any other handler that mutates a stop, require `req.user.driverId === stop.AssignedDriverId` (with ADMIN bypass).
- **Why:** Today a DRIVER token can mark *any* driver's stop delivered, push signatures, and create real SAP delivery notes for orders they were never assigned. This writes to SAP, so it's a financial-data-integrity issue, not just an info-leak.
- **Source:** security-analysis P0 #2.

### 0.3 Tighten `requireRole` on finance / cross-driver routes — **M**
- **Action:** Audit every route file; require `requireRole('ADMIN','PLANNER','CEO')` (as appropriate) on `routes/davoMix.js`, `routes/analytics.js`, `routes/audit.js`, `routes/customers.js`, `routes/drivers.js`, `routes/reports.js`, plus the live-tracking endpoints in `routes/tracking.js` that expose other drivers' GPS.
- **Why:** Right now any DRIVER token reads full DAVO revenue, top buyers, every CEO KPI, full SAP customer DB, every driver's PII, and live GPS for everyone.
- **Source:** security-analysis P0 #3 (RBAC matrix).

### 0.4 Delete `cf-tunnel.log` from repo + rotate any creds the URL touched — **S**
- **Action:** Delete `sap-logistics-hub/cf-tunnel.log`, add `*.log` to `.gitignore` if not already, confirm tunnel is down, rotate JWT_SECRET (forces re-login but invalidates any stolen tokens), confirm no passwords were ever served via that tunnel.
- **Why:** The file documents a public Cloudflare quick-tunnel URL that exposed the dev box without auth at the tunnel layer.
- **Source:** security-analysis P0 #4.

### 0.5 Stop fabricating KPIs in `routes/orders.js stats` — **S**
- **Action:** Either compute `totalStops`, `stopsSaved`, `mergeRatio`, `mergedStops` from real data, or remove them from the response. Today they are `Math.ceil(totalOpen*0.8)` etc. with `// estimate` comments, displayed as real BI.
- **Why:** Leadership decisions are being made against fake numbers.
- **Source:** kpi-analysis "fabricated KPIs".

### 0.6 Pick one definition of "revenue" — **S**
- **Action:** Decide: `OINV.DocTotal` (gross / VAT-inclusive) or `INV1.LineTotal` summed (net). Apply consistently across `services/davoMix.js`, `services/sap/financialReader.js`, `routes/davoMix.js`, CEO Brief tools, weekly report. Add a one-line comment at the top of each file explaining the convention.
- **Why:** Today CEO brief and DAVO weekly report disagree by ~17% VAT on the same period. Open-order pipeline is also conflated with booked revenue in customer-profitability.
- **Source:** kpi-analysis "revenue has 3 definitions".

### 0.7 Fix the broken `Insights.AgentRunId` join — **S**
- **Action:** Change `Insights.AgentRunId UNIQUEIDENTIFIER` → `INT` (matching `AgentRuns.RunId INT IDENTITY`), or migrate `AgentRuns.RunId` to UNIQUEIDENTIFIER. Add explicit FK.
- **Why:** Type mismatch makes "insights from this agent run" feature broken by design — no row will ever join.
- **Source:** prisma-analysis #2.

### 0.8 Cap the AI runtime cost — **S**
- **Action:** In `agents/runtime.js`, before each tool-loop iteration, call `aiCostGuard.checkBackpressure()` and abort the run with a logged error if daily budget exceeded. The Phase-1 stub returns `phase1_no_enforcement` today — implement the actual check based on the `AiSpendBudget` table.
- **Why:** No ceiling exists on Anthropic cost. A runtime bug or rogue caller can burn arbitrary spend.
- **Source:** security-analysis + tech-debt aiCostGuard sections.

---

## Tier 1 — 30-day stabilization (sprint scope)

### 1.1 Make SAP writes idempotent — **M**
- **Action:** For Delivery Notes and Return Requests, send a unique `U_HubRunOrderId` or `U_HubReturnId` UDF in the SAP payload. Before POST, check if SAP already has a doc with that UDF. Wrap "POST + UPDATE local row" in retry logic that's safe to repeat.
- **Why:** Today, a process crash between SL POST success and local UPDATE causes the next 30s tick to re-POST → duplicate ODLN in SAP.
- **Source:** sync-analysis #2.

### 1.2 Unify the SAP retry path — **S**
- **Action:** `services/returnRequests.markReturnPickedUp:173-187` swallows SL errors. Wire it to `sapSyncWorker.enqueue()` the same way `services/deliveryNotes.js` does.
- **Why:** Failed return-pickups are silently stranded; only delivery notes get the queue.
- **Source:** sync-analysis #5.

### 1.3 Add reconciliation worker — **M**
- **Action:** Nightly worker that compares (SAP `ODLN` for last 7 days where `U_HubRunOrderId IS NOT NULL`) against (Logistics `RunOrders` with `SapDeliveryDocEntry NOT NULL`). Flag mismatches to a new `SapReconciliation` table + email.
- **Why:** No system today notices SAP-side cancellation, manual SAP edits, or duplicate documents created by the worker bug above.
- **Source:** sync-analysis #6.

### 1.4 Add JWT revocation — **M**
- **Action:** Introduce a `RevokedTokens` table (token jti + revoked_at). On `requireAuth`, reject if jti is revoked. Add `POST /api/auth/revoke` (admin) and `POST /api/auth/me/logout` (self).
- **Why:** Driver tokens have 7-day TTL. Lost phone = lost fleet for a week with current architecture.
- **Source:** security-analysis P1.

### 1.5 Rate-limit auth + password-change endpoints — **S**
- **Action:** Apply `express-rate-limit` to `POST /api/auth/login`, `POST /api/auth/me/change-password`, and any password reset endpoint. Suggested: 5 attempts / 15min / IP.
- **Why:** Password change isn't rate-limited, only login is. Stolen token can brute-force old password to escalate persistence.
- **Source:** security-analysis P1.

### 1.6 Lock down `/uploads/*` — **M**
- **Action:** Either move uploads behind `requireAuth` with a per-asset signed URL, or move them to private S3-equivalent. Today: 7-day immutable static, no auth — signature/photo URLs are durable bearer tokens.
- **Why:** URL leakage = permanent compromise of signed PoD evidence.
- **Source:** security-analysis P1.

### 1.7 Restrict public tracking payload — **M**
- **Action:** `routes/trackPublic.js` currently returns full street, lat/lng, driver name + plate, and live GPS while in transit. Reduce to: city + neighborhood + status + ETA window. Add token revocation when a delivery completes (don't keep serving GPS history).
- **Why:** SMS link recipient = anyone who got the link forwarded. Today the link is also a doxx vector for the driver.
- **Source:** security-analysis P1.

### 1.8 Move TLS to validated certs — **M**
- **Action:** Install CA-signed certs on Logistics SQL, SAP SQL, and Service Layer hosts. Flip `LOGISTICS_SQL_TRUST_SERVER_CERT=false`, `SAP_SQL_TRUST_SERVER_CERT=false`, `SAP_SL_SSL_REJECT_UNAUTHORIZED=true`.
- **Why:** Today all three connections are encrypted-but-MITM-able. The compromise warnings in `config/env.js:142-156` admit this is "TEMPORARY" — make it not.
- **Source:** security-analysis P1, env.js itself.

### 1.9 Flip `JWT_STRICT_VERIFY=true` — **S**
- **Action:** Watch `getJwtRolloutStats().legacyAccepted` for 7 days; once it reaches 0, set `JWT_STRICT_VERIFY=true` in env.
- **Why:** Lax mode still accepts tokens missing aud/iss. The migration mode has been on long enough.
- **Source:** security-analysis P1.

### 1.10 Bound the unbounded tables — **M**
- **Action:** Extend `cleanupWorker.js` to cover `IntelligenceEvents` (use `RetainUntil`), `AgentRuns` (90d), `AgentToolCalls` (90d), `Insights` (180d unless `Pinned`), `Alerts` (180d), GPS pings (already covered, verify), AuditLog (1y). Batch in chunks of 1000 to avoid lock storms.
- **Why:** Tables grow forever. First cleanup run after months of growth would lock the DB.
- **Source:** prisma-analysis #3 + #10.

### 1.11 Add HTTP / in-process caching for hot dashboard endpoints — **M**
- **Action:** Wrap `/api/analytics/dashboard-summary`, `/api/davo-mix/buyers`, top-customers, top-items, weekly report generation in a 30-60s in-memory TTL cache (e.g., `lru-cache`). Add `Cache-Control: private, max-age=30` for dashboards.
- **Why:** Wallboard polls every 5s × N browsers → DB melts as user count grows. No cache exists today.
- **Source:** performance-analysis §1, §2.

### 1.12 Fix the migration runner — **S**
- **Action:** `backend/src/db/migrate.js`: wrap each migration apply in a transaction; insert the `_Migrations` row inside the same transaction; add a checksum column to detect drift; fail loudly on partial application.
- **Why:** Today, mid-batch failure leaves DB partially applied with no `_Migrations` row. Migrations 002 and 006 are not idempotent against partial state.
- **Source:** prisma-analysis #4.

### 1.13 Audit + apply pending migrations or remove the dependent code — **S**
- **Action:** Review `database/migrations/PENDING.md` (4 prepared migrations). Either apply them and unstub `eventStore.js:42-49`, or remove the code paths that gate on them so the system isn't half-built.
- **Why:** Intelligence pipeline is wired but inert. Hard to debug why "no events appear".
- **Source:** tech-debt §1.

---

## Tier 2 — 90-day platform evolution

### 2.1 Move BI to a real read replica or warehouse — **L**
- **Action:** Stand up a SQL Server read replica (transaction log shipping or AlwaysOn readable secondary) for SAP SQL. Point all `services/sap/sqlReader.js` reads at the replica. Optional next step: nightly export to Postgres or DuckDB for analyst-friendly querying.
- **Why:** Heavy DAVO mix queries (full-scan with 7 OR'd LIKE patterns) and CEO brief (60+ raw queries per run) directly hit production SAP today. SAP outage or contention = BI down + SAP slow.
- **Source:** performance-analysis §1, §6; sync-analysis §10.

### 2.2 Build a semantic / metrics layer — **L**
- **Action:** Replace ad-hoc SQL strings in `services/davoMix.js`, `services/analytics.js`, `services/sap/financialReader.js` with views or a metric layer (Cube.js, dbt + a thin proxy, or hand-rolled SQL views). One file per metric. Versioned definitions. Owners per metric.
- **Why:** 46 KPIs, ≥3 incompatible revenue definitions, no tests, copy-pasted classification rules. Numbers will keep diverging until there's one source of truth.
- **Source:** kpi-analysis "governance gap" + duplications.

### 2.3 Pre-compute aggregates — **M**
- **Action:** Nightly job materializes: daily revenue per company, per-customer rolling 30/90/365d totals, DAVO mix per buyer, dead-stock candidates, churn-risk customers. Store in new Logistics-DB tables `Agg_DailyRevenue`, `Agg_BuyerMonthly`, etc. KPI endpoints read from these instead of full-scanning SAP.
- **Why:** Most BI endpoints don't need real-time. 24h-old DAVO mix is fine. Eliminates the per-request full-scan.
- **Source:** performance-analysis §1; prisma-analysis missing-aggregate-table comments.

### 2.4 Real queue (BullMQ + Redis) for background jobs — **M**
- **Action:** Move sapSyncWorker retries, agent runs, weekly/daily reports off `setInterval`/`node-cron` into a Bull queue. Add a `bull-board` admin UI for retries / DLQ. Use Redis-distributed locks so multiple Hub instances are safe.
- **Why:** Today: no concurrency control, no backpressure, no DLQ visibility, no multi-instance safety. Long agent runs block the HTTP request.
- **Source:** sync-analysis §9; performance-analysis §4.

### 2.5 Split the monolith — at least workers vs API — **L**
- **Action:** PM2 second app: `sap-logistics-workers` running only the schedulers + Bull workers. `sap-logistics-api` runs only HTTP + WebSocket. Same codebase, different entrypoints.
- **Why:** Today a slow worker (CEO brief, weekly report) consumes the same Node event loop and the same 10-connection DB pool as the API. Memory pressure on workers (1GB cap) restarts the API too.
- **Source:** tech-debt §4; performance-analysis §5.

### 2.6 Socket.IO Redis adapter + horizontal scale — **M**
- **Action:** `@socket.io/redis-adapter`, point at the same Redis. Now `instances > 1` is safe.
- **Why:** Single instance today. Restart = every browser reconnects + lost in-flight events. Horizontal scaling impossible.
- **Source:** performance-analysis §8.

### 2.7 Implement actual `aiCostGuard` enforcement — **S**
- **Action:** Replace Phase-1 stub in `lib/intelligence/aiCostGuard.js`. Read budgets from `AiSpendBudget`, sum actual spend from `AgentRuns.CostUsd` for the period, return backpressure decision. Integrate into `agents/runtime.js` before each tool loop.
- **Why:** Item 0.8 was the immediate gate; this is the durable solution. Tier 0 fix can be a hardcoded daily cap until this lands.
- **Source:** security-analysis + tech-debt.

### 2.8 Replace the SMS stub — **S**
- **Action:** `services/notifications.js:38-49` is `console.log` returning success. Pick a provider (current options: twilio / inforu / 019), wire the real client, fail loudly if unconfigured.
- **Why:** Driver / customer SMS notifications silently never send. This is invisible until a customer complains.
- **Source:** tech-debt §3.

### 2.9 Fix `financialReader.queryAll` partial-data leak — **S**
- **Action:** `services/sap/financialReader.js:25-34` swallows per-company errors and returns `[]` with a `console.warn`. CEO brief and weekly report ship half-the-business numbers without flagging it. Add a `partial: true, missingCompanies: [...]` field to the response and surface it in the brief.
- **Why:** Today, SAP-B outage produces a CEO brief that looks like SAP-B has zero revenue.
- **Source:** sync-analysis #7.

### 2.10 Indexes for hot paths — **S**
- **Action:** Add covering indexes named in `prisma-analysis.md` §"Missing indexes": `ReturnRequestLines.ReturnId`, `StopFailures.StopId`, `StopFailures.ReasonCode`, `CustomerAddressLinks.AddressId`, `NormalizedAddresses.ZoneId`, `PickingAllocations.RunOrderId`, plus any seek-friendly index on `RunOrders(Status, SapDeliveryDocEntry, CompletedAt)` for the sync worker.
- **Why:** Sync worker, picking, and return flows full-scan FK columns today.
- **Source:** prisma-analysis missing-indexes.

### 2.11 Audit log — make safer to use — **S**
- **Action:** `services/auditLog.js:67-88` auto-logs full response body if used as middleware. Add an explicit allow-list (`auditableRoutes`) and a redaction list. Today nobody uses it on a secret-returning endpoint, but the API is too easy to misuse.
- **Source:** security-analysis.

### 2.12 Bound the SAP SQL connection pool / add `requestTimeout` — **S**
- **Action:** Set `requestTimeout: 30000` (or lower) on both Logistics + SAP SQL configs. Bump `pool.max` for SAP SQL pools to 20+ since CEO brief and weekly report fan out 7-9 concurrent queries × 2 companies. Or — better — serialize the fan-out behind a semaphore.
- **Why:** No timeout = runaway analytics holds connections forever. Pool of 10 is saturated by the CEO brief alone.
- **Source:** performance-analysis §6; sync-analysis #10.

---

## Tier 3 — Long-term architecture (multi-quarter)

### 3.1 Move BI off OLTP entirely — **XL**
- **Action:** Adopt a small data warehouse (Postgres + Citus, ClickHouse, BigQuery, Snowflake — pick by cost/team familiarity). Nightly + change-tracked sync from SAP SQL using a real CDC tool (Debezium / Fivetran / Airbyte). Build dashboards on top via Metabase / Superset / Tableau.
- **Why:** OLTP (logistics) and OLAP (BI) sharing one MS SQL instance is the single biggest scaling blocker. Solving it changes every other capacity question.
- **Source:** prisma-analysis OLTP/OLAP collision; performance-analysis §6.

### 3.2 Multi-tenant / multi-company-clean separation — **L**
- **Action:** Many things in code hard-code company list `['A','B']`. To onboard a 3rd company (or a DAVO-only customer), refactor `services/sap/serviceLayer.js` and `config/env.js companies` to read company config from a DB table.
- **Why:** Currently every SAP-touching file enumerates companies inline.
- **Source:** tech-debt §5; system-overview §3.1.

### 3.3 Migrate to Postgres or accept MS SQL — **XL** (decision, not action)
- **Action:** Decide whether the Logistics DB stays on MS SQL (ops familiarity, parity with SAP) or moves to Postgres (bigger ecosystem for BI, cheaper). Document the decision; stop accidentally drifting toward both (e.g., the "PostgreSQL scaling risks" header in the original brief implies Postgres is on the table).
- **Source:** performance-analysis §6 reframing.

### 3.4 Frontend split — driver app vs BI app — **L**
- **Action:** Today one Vite bundle is shipped to drivers (mobile PWA), planners, and CEOs. Long-term: separate driver app (smaller bundle, offline-first) from BI app (heavy charts, dashboards). Same backend.
- **Why:** Drivers don't need TanStack-Query polling 6 KPI endpoints. CEOs don't need Service Worker geolocation code.
- **Source:** system-overview §1; tech-debt §4.

### 3.5 Observability — **L**
- **Action:** Stand up Prometheus + Grafana (or vendor equivalent). Instrument: SAP query latency p50/p95/p99 per company per query, SapRetryQueue depth + age, agent run duration + cost, KPI endpoint latency, Socket.IO connected clients. Alerting on `SapRetryQueue.Status='FAILED_PERMANENT' > 0` (currently invisible to humans).
- **Source:** sync-analysis §9; alerting flow gap in system-overview §8.

### 3.6 Move secrets to a vault — **M**
- **Action:** Move `backend/.env` contents to a secrets manager (HashiCorp Vault, AWS SM, even Bitwarden Org). Stop committing `.env.bak.*` files. Rotate JWT_SECRET, SAP credentials, SMTP, Anthropic key on a schedule.
- **Source:** security-analysis P1 (env backup file).

---

## Decision points the team should make explicitly (not Claude's call)

1. **Stay monolith vs split workers** — both are viable; splitting is more work but unblocks horizontal scale and isolates the AI-cost blast radius.
2. **MS SQL vs Postgres for Logistics DB** — see 3.3.
3. **Real warehouse (3.1) vs accept "BI is query-time on SAP forever"** — the second is fine for current scale; the first is the only path to per-customer self-serve dashboards.
4. **Buy vs build BI tooling** — Metabase/Superset on top of a warehouse beats hand-coding 46 React pages with hand-coded SQL, but transitioning 46 pages is its own project.
5. **Cloudflare quick-tunnel vs proper public ingress** — the current `cloudflared --url http://localhost:4000` setup gives a randomized URL; for production this should be a named tunnel with access policies.

---

## Quick-reference: top 10 to fix this month

| # | Item | Tier | Effort | Impact |
|---|------|------|--------|--------|
| 1 | Socket.IO CORS allow-list | 0.1 | S | Closes auth bypass |
| 2 | Driver per-stop ownership check | 0.2 | S | Stops cross-driver SAP writes |
| 3 | Tighten `requireRole` on BI/finance routes | 0.3 | M | Stops driver-token data exfil |
| 4 | Delete `cf-tunnel.log`, rotate JWT_SECRET | 0.4 | S | Closes documented exposure |
| 5 | Pick one revenue definition | 0.6 | S | Stops shipping wrong KPIs |
| 6 | Make SAP writes idempotent (UDF token) | 1.1 | M | Prevents duplicate ODLN/ORDR |
| 7 | Cap AI spend in runtime | 0.8 | S | Bounds Anthropic cost |
| 8 | Dashboard endpoint TTL cache | 1.11 | M | Eases DB pressure now |
| 9 | Reconciliation worker SAP↔Hub | 1.3 | M | Catches drift |
| 10 | Bound unbounded tables (cleanup) | 1.10 | M | Prevents future lock storms |
