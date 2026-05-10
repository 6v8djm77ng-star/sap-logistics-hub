# Performance Analysis — SAP Logistics Hub

Read-only architecture review. File:line citations are absolute against `backend/`.

---

## 1. Slow-query risks

### 1.1 Heavy multi-join + COUNT(DISTINCT) on every dashboard load

`services/analytics.js:17-39` — `getOverallKpis` runs one query that joins `DeliveryRuns × DeliveryStops × RunOrders` and uses **9 `COUNT(DISTINCT)`** plus 2 `AVG(DATEDIFF(...))`. Default range is 30 days (`routes/analytics.js:11-13`). On a year-old DB with millions of `RunOrders`, this becomes a hash-aggregate-of-a-hash-join scan. No index on `RunOrders.StopId` exists in `001_initial_schema.sql:172-191` (only `IX_RunOrders_Stop` was named but is fine — the issue is column count, not access path). No covering index for `DeliveryStops.Status`, no index on `DeliveryStops.ArrivedAt`/`CompletedAt`.

`services/analytics.js:41-57` — `mergerStats` uses `CROSS APPLY` correlated against every stop in the range. For 10k stops × inner aggregate over `RunOrders` × `Companies`, this is O(N) subqueries. Will not scale past ~50k stops/range.

### 1.2 Dashboard summary issues 6 queries serially-parallel

`services/analytics.js:200-210` — `getDashboardSummary` `Promise.all`-s 6 heavy queries (overall + daily + drivers + zones + failures + sap-health). They all run on the same pool (`logisticsDb.js:20`, max 10 connections) — when called repeatedly from `WallboardPage` (`refetchInterval: 30_000`/`5_000`/`10_000`, `frontend/src/pages/WallboardPage.jsx:25,30,35`) and `DashboardPage` (`refetchInterval: 30_000`/`60_000`, `frontend/src/pages/DashboardPage.jsx:18,24,35`), ~10–15 concurrent dashboard sessions saturate the pool.

`routes/analytics.js:19-23` — `/api/analytics/summary` triggers all 6 queries on every hit. No caching layer.

### 1.3 SAP analytics scans OINV/INV1 with no date partitioning

`services/davoMix.js:50-64` (`getMixSummary`), `:114-126` (`getCategoryBreakdown`), `:153-162` (`getAttachRate`), `:215-223` (`getTopAttachItems`), `:256-266` (`getBuyerBreakdown`), `:324-337` (`getTopDavoBuyers`) — all hit `OINV INNER JOIN INV1` with `DocDate >= DATEADD(DAY, -@days, GETDATE())` and a fat `ItemCode LIKE 'DAV%' OR ... OR Dscription LIKE N'%DAVO%'` (`davoMix.js:14-18`). The leading `LIKE 'DAV%'` is sargable, but the `OR Dscription LIKE N'%DAVO%'` forces a scan on `INV1`. No covered index possible here since `Dscription` is part of the OR.

`davoMixWeeklyReport.js:46-55` — single weekly report invokes **7 of these queries** in parallel on Sunday 08:00 (`davoMixReportScheduler.js:5`). Each one re-scans the same `OINV/INV1` slice. No memoization across calls.

`services/sap/financialReader.js:120-152` — `getDeadStock` runs 3 correlated subqueries per row of `OITM × OITW`: `(SELECT MAX(DocDate) FROM OINV INNER JOIN INV1 ...)` is repeated 3 times in `SELECT`, `HAVING`, and `ORDER BY` paths. SQL Server may or may not cache the result. With ~10k items and full OINV scan, this is a multi-second query. No index on `INV1.ItemCode` is guaranteed in SAP B1 schema.

`financialReader.js:225-249` — `getChurnRiskCustomers` uses `NOT EXISTS` with another full-window scan. Will be slow on large customer bases.

### 1.4 OLTP+OLAP same DB

The Logistics DB (`SAP_Logistics_Hub`) is the only DB the app owns. Analytics queries on `DeliveryRuns × DeliveryStops × RunOrders` (multi-million rows over time) compete for the same locks/buffer pool as the planner UI's per-run reads (`services/deliveryRuns.js:250-306`) and the worker's polling reads (`workers/sapSyncWorker.js:34-42, 75-82, 135-140`).

### 1.5 Per-request fetches in driver/wallboard

`frontend/src/pages/WallboardPage.jsx:25` — `runs` query runs **every 5 seconds**. `runsApi.list` resolves to `services/deliveryRuns.js:308-333`, a 4-table join with two correlated count subqueries (`StopCount`, `OrderCount`). At 5s × N TVs, this is hot-path. No caching.

`frontend/src/pages/PickingPage.jsx:131` — `refetchInterval: 10_000`.
`frontend/src/pages/LiveMapPage.jsx:38` — `refetchInterval: 15_000` hits `gpsTracking.getAllDriverLocations` (`services/gpsTracking.js:65-79`) which scans `DriverLocations × Drivers × DeliveryRuns × Zones` joined.
`frontend/src/pages/WarehousePage.jsx:22,28` — 20s/15s.

---

## 2. Missing caching

There is **no cache layer at all** in the backend. No Redis, no in-memory LRU, no HTTP `Cache-Control` headers on JSON endpoints. Every dashboard tile recomputes from raw rows on every poll.

Specific endpoints that should be cached but aren't:

- `routes/analytics.js:19-51` — `/api/analytics/{summary,overall,daily,drivers,zones,failures,sap-health}`. All deterministic for `(fromDate, toDate)` and change at most once per minute as runs progress. A 30s in-memory TTL cache keyed on `(userRole, fromDate, toDate)` would eliminate ~95% of DB load from dashboard polling.
- `routes/davoMix.js` (called from `frontend/src/pages/DavoMixPage.jsx`) — DAVO mix queries are over 7–365 day windows; they change once a day at most when a new SAP invoice is posted. Should be cached for 5–15 min.
- `routes/sap.js:48-56` — `/api/sap/sample/:company` — read-only sample query, never cached.
- `services/gpsTracking.js:65-79` — driver positions are fresh-by-nature, but the joins are not. Could split: cache `Drivers/Runs/Zones` for 60s, only re-read `DriverLocations`.

`services/analytics.js:181-194` — `getSapSyncHealth` hits 5 separate `SELECT COUNT(*)` queries every time. Trivially cacheable for 30–60s.

`server.js:97-100` — `/uploads` static is the only thing that has `maxAge: '7d'`. JSON responses set no cache headers.

The frontend uses `@tanstack/react-query` defaults (no `staleTime`) — every component remount re-fetches. With 30+ pages each holding their own queries, a single SPA navigation often re-fires the same query unnecessarily.

---

## 3. N+1 risks

### 3.1 `orderUnification.js` — per-order DB roundtrip on the hot path

`services/orderUnification.js:121-189` — `unifyOrdersByAddress`:
- Loop at `:127-164` over **every order from both companies** (can be 100s–1000s/day on auto-plan). For each order:
  - `findOrCreateAddress` (`:46-84`) — 1 SELECT, possibly 1 INSERT.
  - `linkCustomerToAddress` (`:90-113`) — 1 SELECT for company + 1 INSERT...IF NOT EXISTS.
- Then `:167-185` — for each unique address group, **another** SELECT to enrich.

So for 500 orders that resolve to 200 distinct addresses: ~1500 round-trips. The `cache` Map in `:124` only deduplicates within a single call's `findOrCreateAddress`, not across `linkCustomerToAddress`.

This runs on every `/api/runs/auto-plan` (`routes/runs.js`) and every `getUnificationStats` (`services/orderUnification.js:195-208`).

### 3.2 `wavePicking.js` — per-order SAP roundtrip

`services/wavePicking.js:50-64` — `for (const ro of runOrders) { ... await sapSql.getOrderLines(ro.CompanyCode, ro.SapDocEntry); }`. SAP SQL roundtrip per RunOrder. A 30-stop run with 60 RunOrders = 60 sequential SQL calls to the SAP SQL Server. This is exactly the N+1 the comment in `sqlReader.js:8` warns against.

Should be a single `WHERE DocEntry IN (@list)` query per company.

### 3.3 `ceoBrief.js` agent loop — model-driven, but unbounded by the schema

`agents/runtime.js:98-192` — the LLM tool-use loop. `env.AGENT_MAX_TOOL_CALLS` defaults to 8 (`config/env.js:97`), but each tool wraps a financial query (`tools/financialTools.js`), each of which calls `queryAll` (`services/sap/financialReader.js:20-35`) — fan-out to **both companies in parallel**. So `AGENT_MAX_TOOL_CALLS = 8` × 2 SAP queries = up to 16 `OINV` scans per brief. Per scheduled run (`workers/ceoBriefScheduler.js:35-47`), this fires every morning. Each brief takes 30–90s.

There is no SAP query result memoization within a brief, and the LLM may re-request the same date range from a different angle.

### 3.4 `dailyDigestWorker.js` — better, but still 5 parallel queries hitting the same tables

`workers/dailyDigestWorker.js:33-115` — `Promise.all` of 5 queries that all fan out into `DeliveryRuns × DeliveryStops × RunOrders`. Acceptable, but worth noting that if it were running at a busy hour it would saturate 5 of the pool's 10 connections.

### 3.5 `deliveryRuns.js:308-333` — listRuns has 2 correlated subqueries per row

`(SELECT COUNT(*) FROM DeliveryStops WHERE RunId = r.RunId)` and `(SELECT COUNT(*) FROM RunOrders ro INNER JOIN DeliveryStops s ON s.StopId = ro.StopId WHERE s.RunId = r.RunId)`. For a year of runs (~5000 rows), that's 10000 subquery executions. Polled every 5s on Wallboard.

---

## 4. Queue bottlenecks

### 4.1 `sapSyncWorker.js` — `setInterval` racing itself

`workers/sapSyncWorker.js:18-21,199-213` — interval is 30s, with a `running` boolean guard. If `tick()` takes >30s (e.g. SAP Service Layer login is slow), subsequent ticks **skip silently**. There is no queue of skipped work; the next tick just looks at the DB state. That's mostly OK because the DB state is the queue (`SapRetryQueue` table), but:

- If `retryDeliveryNotes()` (`:33-69`) processes a fixed `TOP 20` (`:35`), and there are >20 pending DNs every tick, queue grows unboundedly while the worker plods along at 20/30s = 40/min throughput.
- `Promise.all` at `:203-207` runs the 3 sub-tasks in parallel. If any throws, it propagates up into the `running` guard's `finally` (line `:210-211`), but **the outer `tick()` `try/catch`** (`:201-211`) just logs and resets — no metrics, no alert.

### 4.2 No backpressure or concurrency control

`node-cron` (`workers/ceoBriefScheduler.js:13`, `workers/davoMixReportScheduler.js:7`) fires regardless of whether the previous run is still going. If a CEO brief stalls past midnight, the next 07:00 fires while the prior is still pending. There is no `running` guard on cron-scheduled tasks, only the manual `setInterval` ones.

`sendDailyDigest` (`workers/dailyDigestWorker.js:253`) likewise has a `lastRunDate` flag (`:18, :291-295`) but no overlap guard — if the previous run is still in `await notifyEvent`, a `setTimeout`-driven re-fire would not collide here only because the interval is 24h, but the pattern is brittle.

### 4.3 `cleanupWorker.js` runs every cleanup serially

`workers/cleanupWorker.js:86-104` — `for (const fn of [...]) await fn()`. If `cleanupAuditLog` is slow on 365-day-deep AuditLog (no partitioning, see §7), the whole cleanup blocks. Acceptable at 03:00 but the workers run inside the web server process — see §6 / Tech Debt §4.

### 4.4 `customerComms.js` loop sends SMS one-at-a-time

`services/customerComms.js:45-` — `for (const stop of stops) { await sendSms(...); }`. Sequential. For a 30-stop run going `IN_TRANSIT`, that's 30 serial provider calls. The trigger is at `services/deliveryRuns.js:235-242` — fire-and-forget (good) but inside the same Node process.

---

## 5. Memory risks

### 5.1 PM2 1 GB cap with single instance

`ecosystem.config.cjs:64` — `max_memory_restart: '1G'`, `instances: 1, exec_mode: 'fork'`. Restart on 1 GB means the full app (Express + Socket.IO + 5 cron workers + SAP retry worker + agents runtime) shares one 1 GB heap. No clustering.

### 5.2 In-memory state that grows without bound

- `services/sap/sqlReader.js:29` — `pools = new Map()` — bounded by company count (2). Fine.
- `services/sap/serviceLayer.js:212` — `sessions = new Map()` — bounded by company count. Fine.
- `agents/store.js:33-56` — `Messages` and `Output` stored as `NVARCHAR(MAX)` JSON. The runtime (`agents/runtime.js:90, 117, 136-141`) **accumulates the full `messages[]` array in memory** for the entire agent run (system prompt + user message + every tool_use + every tool_result with full SQL recordsets stringified at `:177` `JSON.stringify(result)`). A `get_top_items` call returns up to 100 rows × 2 companies = 200 objects. After 8 tool calls, the `messages[]` array can be 1–5 MB. Persisted as one row to `dbo.AgentRuns.Messages` (`store.js:44, :54`). Heap stays inflated until run completes.
- `lib/intelligence/eventStore.js:42-49` — currently a no-op (Phase 1, returning `stored: false`). Once enabled, no in-memory buffering exists yet.
- No in-process LRU/cache, so no leak risk there.

### 5.3 Reports buffer in memory

`routes/reports.js:31-37` — `generatePickingListExcel` builds an `xlsx` workbook and `await wb.xlsx.write(res)`. ExcelJS streaming exists but for a long picking list this is a fat in-memory Buffer.

`routes/reports.js:17-22` — `generateDriverManifestPdf` returns a stream and `pdf.pipe(res)` — that one's fine.

### 5.4 Worker logs

`pino`/`morgan` log every API hit (`server.js:94`). `workers/sapSyncWorker.js:46, 86` log per-batch. No log rotation config in `ecosystem.config.cjs`. `error_file`/`out_file` grow forever.

---

## 6. SQL Server scaling risks

This is **MS SQL Server**, not PostgreSQL.

### 6.1 Connection pool max=10

`db/logisticsDb.js:20` — `pool: { max: 10, min: 1 }`. With:

- Express request handlers (each `db.query` borrows 1 connection)
- `sapSyncWorker.tick()` running 3 concurrent queries every 30s
- Daily digest worker firing 5 parallel
- Dashboard polling at 5–60s intervals × N clients
- Agent runtime persisting tool calls

Easy to saturate. Symptoms: requests waiting for `pool.acquire`, perceived "slow API" but DB is idle.

`services/sap/sqlReader.js:26` — SAP read pool also `max: 10`, **per company**. Two companies = 20 connections to the SAP server. If SAP SQL Server has connection limits, this matters.

### 6.2 Single instance, no read replica

There is no read-replica configuration anywhere. The same server is used for:
- OLTP CRUD: orders/runs/picking writes
- Heavy analytics (`analytics.js`)
- Cleanup DELETEs (`cleanupWorker.js`)
- Background SAP retry writes
- Audit log appends

No `WITH (NOLOCK)` or `READ UNCOMMITTED` in any analytics query. Long analytics scans can block writers.

### 6.3 OLTP + OLAP overlap

Queries on `DeliveryRuns/Stops/Orders` are both transactional (`addStopToRun` writes) and analytical (`getOverallKpis` 30-day aggregate scans). No CDC/streaming to a separate OLAP store. As `RunOrders` grows past ~10M rows, the analytics queries will start affecting tail latency on planner writes.

### 6.4 No statement timeout

`logisticsDb.js:9-21` — no `requestTimeout`, no `connectTimeout`. A runaway analytics query holds a connection forever. Same for `sap/sqlReader.js:15-27`.

### 6.5 SAP Service Layer is HTTP, single session per company

`services/sap/serviceLayer.js:212-222` — `sessions = new Map()` keyed by company. Only 1 ServiceLayerSession per company. All concurrent writes serialize on a single HTTP cookie/`B1SESSION`. The `axios` instance has no maxSockets cap; if the worker fires 20 parallel `createDeliveryNote` calls (`workers/sapSyncWorker.js:33-69`), they all share one session ID. SAP B1 SL sometimes serializes at the cookie level.

---

## 7. Partitioning recommendations

Tables that grow unbounded and need date-partitioning + retention:

| Table | Source | Growth driver | Current retention | Recommendation |
|---|---|---|---|---|
| `dbo.DriverLocationHistory` | `001_initial_schema.sql`+`003_gps_tracking.sql:23-37` | every 30–60s × N drivers | 30 days (`workers/cleanupWorker.js:46-49`) | Partition by `RecordedAt` month; switch out months >30d. Currently DELETEs scan + lock. |
| `dbo.AuditLog` | `001_initial_schema.sql:307-321` | every CRUD action | 365 days (`cleanupWorker.js:55-65`) | Partition by `CreatedAt` month. The deletion pass on 365-day-deep tables is brutal without partitioning. |
| `dbo.NotificationLog` | not seen in initial schema (likely later mig.) | every email/SMS | 90 days (`cleanupWorker.js:33-39`) | Same. |
| `dbo.AgentRuns` | `008_agent_runs.sql:6-23` | 1+ per day (CEO brief + manual) but each row has `Messages NVARCHAR(MAX)` 1–5 MB | **none** — never deleted | Add retention (90d?) and consider archiving full `Messages` blob to cold storage / S3 after 30d. |
| `dbo.AgentToolCalls` | `008_agent_runs.sql:33-46` | 5–8 per AgentRun, with `Input/Output NVARCHAR(MAX)` | **none** | Cascades when run is deleted (FK ON DELETE CASCADE) but no retention exists for AgentRuns. |
| `dbo.SapRetryQueue` | `003_gps_tracking.sql:40-58` | 1 per failed SAP op | SUCCESS rows pruned >7d (`cleanupWorker.js:69-77`); FAILED_PERMANENT rows kept forever | Either prune or archive. |
| `dbo.IntelligenceEvents` (pending mig 009) | `database/migrations/009_intelligence_events.sql:32-` | High-volume — designed for cross-source events | designed with `RetainUntil` (default 90d in `featureFlags.js:85`) | **Already designed for partition-switch** per `PENDING.md:42-48` — good. Just needs a cleanup worker once enabled. |
| `dbo.RunOrders` | `001_initial_schema.sql:172-191` | 1 per delivered SAP order | none | Partition by `AddedAt` year once volume > a few million rows. |
| `dbo.DeliveryStops` | `001_initial_schema.sql:150-166` | 1 per delivery stop | none | Same. |
| `dbo.AlertSubscriptions/Alerts` (pending mig 011) | designed for retention | n/a | n/a |

### Index gaps observed in 001
- No index on `DeliveryRuns.RunDate` alone (analytics filters on this; the composite `IX_DeliveryRuns_Date_Zone` works but only if zone is also filtered).
- No index on `DeliveryStops.Status` — filtered in `getOverallKpis`, `getDailyTrend`.
- No index on `RunOrders.Status` — filtered in `getDriverPerformance` and the SAP retry worker.
- No covering index on `DriverLocations.UpdatedAt` — `gpsTracking.getAllDriverLocations` filters `WHERE dl.UpdatedAt > DATEADD(HOUR, -4, ...)`, will scan if not covered.

---

## 8. Socket.IO concerns

`sockets/index.js:14-52`:

- **Single instance, no Redis adapter.** Line `:14` — `new Server(httpServer)`. `instances: 1` in PM2 (`ecosystem.config.cjs:59`). If you ever scale to 2+ Node processes, sockets won't broadcast across them.
- **`cors: { origin: '*' }`** — line `:16`. Comment admits "tighten for production". Anyone can connect with a valid JWT; the rest of the app uses an explicit allow-list (`server.js:79-90`).
- **Broadcast scope is role-coarse.** Lines `:36-44` — every `PLANNER` joins the global `'planner'` room. Every position update from every driver hits every planner socket. At scale (5+ planners + 20+ drivers each polling 30s), each planner receives 20 events/30s = 0.67/s — fine for now, but a single-room broadcast with no per-zone or per-run filter means UI does the filtering. Server fan-out scales O(planners × drivers).
- `routes/tracking.js:32-33` — every position post emits to `'planner'` globally. No throttling — a chatty driver app sending 1Hz can flood.
- **No Socket.IO authentication audit trail.** JWT verification (`sockets/index.js:24-29`) is the only check. No reconnect token rotation. If `JWT_STRICT_VERIFY=false` (default per `config/env.js:35`), tokens missing `aud`/`iss` still pass — see `config/env.js:153-156`.
- **`transports: ['websocket', 'polling']`** — both supported. Long-poll fallback over Cloudflare tunnel (`ecosystem.config.cjs:39-49`) can multiply connection count.
- The `io` is stashed on `app.set('io', io)` (`server.js:158`) and routes look it up (`routes/tracking.js:32`). Workers running in the same process have no clean way to emit (`workers/sapSyncWorker.js` does no emits — it would need an exported io reference). When workers are extracted to a separate process, this coupling will break loudly.

---

## Summary of highest-impact fixes (ordered by effort:value)

1. **Add a 30s in-memory TTL cache** in front of `/api/analytics/*` and `getDashboardSummary`. Removes ~80% of analytics DB load instantly.
2. **Fix the `wavePicking.js:50-64` N+1** to one `WHERE DocEntry IN (...)` per company.
3. **Bump `pool.max` to 25–50** in `logisticsDb.js:20` — disk-bound waits are likely connection-bound now.
4. **Add `requestTimeout: 30000`** to both connection configs.
5. **Cache `davoMix.js` queries** with a 10-min TTL keyed on `days` — the weekly report makes 7 redundant scans of the same window.
6. **Plan retention + partitioning for `AgentRuns/AgentToolCalls`** before they hit GBs of `Messages` blob.
7. **Add a `running`/overlap guard to `node-cron`-scheduled tasks** (`ceoBriefScheduler.js`, `davoMixReportScheduler.js`).
8. **Add Socket.IO Redis adapter** when going multi-instance; until then, pin `instances: 1` deliberately.
