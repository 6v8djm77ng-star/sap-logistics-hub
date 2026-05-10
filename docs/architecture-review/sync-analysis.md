# SAP BI Sync — Architecture Review

Read-only analysis of the SAP integration in `sap-logistics-hub`. All paths absolute under
`backend/src/`. Line numbers refer to current code state.

---

## 0. TL;DR — production risks worth fixing this week

1. **No incremental watermark anywhere.** Every SAP read is a full scan against `OINV`/`ORDR`/`OITM`/`OITW` filtered by `DATEADD(DAY, -N, GETDATE())`. There is no `last_sync_at` column, no change-tracking, no CDC. (`services/sap/sqlReader.js`, `services/sap/financialReader.js`, `services/davoMix.js`)
2. **Worker has no checkpoint and no per-job locking.** A crash mid-tick can re-issue a SAP `POST /DeliveryNotes` for the same `RunOrder` and create duplicate Delivery Notes, since the only idempotency guard is reading `SapDeliveryDocEntry IS NULL` BEFORE the POST. (`workers/sapSyncWorker.js:33-69`, `services/deliveryNotes.js:24-101`)
3. **`startWorker()` uses a single-instance in-process `setInterval`.** If `pm2 cluster` or two replicas are ever turned on, two workers race the same `RunOrders` rows. There is no DB-level row lock (`SELECT ... WITH (UPDLOCK, READPAST)`) on the picker query. (`workers/sapSyncWorker.js:215-221`, `server.js:165-169`)
4. **Service Layer session expiry math is wrong.** `expiresAt = Date.now() + (SessionTimeout - 5) * 60_000` assumes `SessionTimeout` is in minutes, which is true for SL — but if SL ever returns 0 or undefined the expression becomes negative and every request re-logs in (login storm). (`services/sap/serviceLayer.js:86`)
5. **Return Request retry rebuilds the SAP payload from scratch with no reference to what was already attempted.** If the first POST timed out *after* SAP committed but before our HTTP response, retry creates a duplicate `ORRR`. (`workers/sapSyncWorker.js:74-129`)
6. **No reconciliation job exists.** Nothing ever scans SAP→Hub or Hub→SAP for drift. The system trusts the one-way write forever.
7. **One company down silently degrades multi-tenant reads.** `financialReader.queryAll` swallows failures with `console.warn` and returns `[]`, so KPIs and CEO brief silently report half the business. (`services/sap/financialReader.js:25-34`)

---

## 1. Inventory of all sync / scheduled jobs

| Job | File:Line | Schedule | Mechanism | Pulls / Pushes | Incremental? |
|---|---|---|---|---|---|
| **SAP Sync Worker** (delivery-note + return + retry queue) | `workers/sapSyncWorker.js:215-221` (`startWorker`) | every 30s (`RUN_INTERVAL_MS = 30_000`, line 19), fires after 5s boot delay | `setInterval` in main Node process | **Pushes** Delivery Notes (`POST /DeliveryNotes`), Return Requests (`POST /ReturnRequest`); **reads** `RDR1` order lines for retry payload | Pseudo-incremental: scoped by `Status='DELIVERED' AND SapDeliveryDocEntry IS NULL AND s.CompletedAt > DATEADD(HOUR, -24, ...)`. After 24h failures fall off the picker (line 41, 81). |
| **Cleanup Worker** | `workers/cleanupWorker.js:124-141` | 03:00 daily, computed via `setTimeout` | self-rescheduling timer | **DELETEs** in Logistics DB only: `TrackingTokens`, `NotificationLog`, `DriverLocationHistory`, `AuditLog`, `SapRetryQueue` (SUCCESS rows >7d). Does NOT touch SAP. | n/a (delete by age) |
| **Daily Digest Worker** | `workers/dailyDigestWorker.js:285-300` | 07:00 daily, `setTimeout` math (line 275-283) | self-rescheduling timer | **Reads** Logistics DB only (no SAP read). Sends email digest. | n/a |
| **CEO Brief Scheduler** | `workers/ceoBriefScheduler.js:20-50` | `env.CEO_BRIEF_CRON` (default `0 7 * * *`), `node-cron`, TZ `Asia/Jerusalem`. Off unless `CEO_BRIEF_SCHEDULE_ENABLED=true` and `ANTHROPIC_API_KEY` set. | `node-cron` | Triggers `agents/ceoBrief.js` which calls `financialReader` queries against SAP. | Queries always full window-by-day, no watermark. |
| **DAVO Mix Weekly Report** | `workers/davoMixReportScheduler.js:14-35` | `env.DAVO_MIX_REPORT_CRON` (default `0 8 * * 0`), TZ `Asia/Jerusalem`. Off unless `DAVO_MIX_REPORT_ENABLED=true`. | `node-cron` | **Reads** SAP `OINV+INV1+OITM` via `services/davoMix.js`. Sends email. | Full lookback every run (7d / 14d windows recomputed each Sunday). |

**Started from** `backend/src/server.js:165-169` — all workers are in-process, single-replica, no separate daemon, no PID file, no leader election.

---

## 2. SAP read paths

### 2a. SQL Server direct (mssql via connection pool) — **the main read path**
- Pool factory: `services/sap/sqlReader.js:15-42`. Per-company pool, `max: 10, min: 0, idleTimeoutMillis: 30000`. Pools cached in module-level `Map`.
- Pool error handler at line 36 logs but **does not invalidate the pool entry**. After a fatal pool error subsequent calls reuse a dead handle until the process restarts.
- Tables read directly: `ORDR`, `RDR1`, `OCRD`, `CRD1`, `OITM`, `OITW`, `OINV`, `INV1`, `CUFD` (docs only).
- Functions: `getOpenOrders` (line 71), `getOrderLines` (117), `findCustomerByName` (144), `searchCustomersAllCompanies` (167), `getCustomerRecentItems` (183), `getCustomer` (203), `getCustomerAddresses` (219), `getItemsStock` (241).
- Aggregates / BI: `services/sap/financialReader.js` — `getDailySales`, `getTopItems`, `getLowStockItems`, `getDeadStock`, `getMarginByItem`, `getTopCustomers`, `getChurnRiskCustomers`. All run `queryAll` which fans out to companies A+B in parallel.
- DAVO mix: `services/davoMix.js` — invoice/line aggregates against `OINV/INV1` for company A only.

### 2b. Service Layer (HTTP REST) — write-only in practice
- `services/sap/serviceLayer.js`. The class also exposes `getOrder` (line 200) and `getBusinessPartner` (204) but **no caller** uses them — confirmed by absence in greps over `services/`, `workers/`, `routes/`. So Service Layer is effectively write-only.

### 2c. Data flowing back into Logistics DB vs computed on-the-fly

**Persisted into Logistics DB:**
- `RunOrders` table holds SAP order context: `SapDocEntry`, `SapDocNum`, `SapCardCode`, `SapCardName`, `OrderTotal`, `LinesCount`. Written by `services/deliveryRuns.js:159-181` during `addStopToRun`.
- `NormalizedAddresses` is derived from SAP `OCRD` fields during unification (`services/orderUnification.js:46-84`).
- `CustomerAddressLinks` maps SAP CardCode → normalized address (`orderUnification.js:90-113`).
- After write: `SapDeliveryDocEntry` on `RunOrders`, `SapReturnRequestDocEntry` on `ReturnRequests`.

**Computed on-the-fly (not persisted) — every dashboard hit re-reads SAP:**
- All of `financialReader.js` (sales, margin, top items, churn, dead stock).
- All of `davoMix.js` (mixer/non-mixer split, attach rate, top buyers, category breakdown).
- `sap/sqlReader.getOpenOrders` — every planning click hits SAP live.

> Risk: the BI layer has **no caching, no materialized snapshot, no daily roll-up table**. Every CEO brief, every dashboard refresh, every weekly report recomputes the same `SUM(LineTotal) WHERE DocDate BETWEEN ...` against SAP production SQL. With `pool.max=10` and any traffic spike on the dashboard, you can starve SAP B1's DB connection pool — and that affects the SAP client UI, not just our app.

---

## 3. SAP write paths

All writes go through `services/sap/serviceLayer.js`:

| Write | Caller | Idempotency | Retry |
|---|---|---|---|
| `POST /DeliveryNotes` | `services/deliveryNotes.js:71-77`, `workers/sapSyncWorker.js:51` | Pre-check `SapDeliveryDocEntry IS NULL` (line 35-44 of `deliveryNotes.js`). **No idempotency-key header sent to SAP.** No `BaseEntry` uniqueness check beyond that. | Caught and re-queued by worker, exponential backoff `[1, 5, 15, 60, 240]` minutes (sapSyncWorker.js:18). |
| `POST /ReturnRequest` | `services/returnRequests.js:175`, `workers/sapSyncWorker.js:103-112` | Pre-check `SapReturnRequestDocEntry IS NULL` only on the worker side. The **first-attempt path** in `returnRequests.markReturnPickedUp` (line 136-198) catches errors and continues — it sets `Status='PICKED_UP'` with `SapReturnRequestDocEntry=NULL` and walks away. | Retried by `sapSyncWorker.retryReturnRequests` for 24h then **silently dropped** (no enqueue to `SapRetryQueue`, unlike delivery notes — see line 122-126 vs delivery-note path 59-66). |
| `POST /Returns` | `serviceLayer.createReturn` exists (line 182-198) but **no caller** wires it up. The "second step" of the two-step return flow described in `services/returnRequests.js:8-10` is not implemented. | n/a |

**Idempotency keys: none.** SAP B1 has no native idempotency-key mechanism on Service Layer, so the system relies entirely on the local `SapXxxDocEntry IS NULL` flag. The duplicate-document risk is real (see §7).

**Retry / backoff:** only the `SapRetryQueue` table has structured backoff. The "fast path" workers `retryDeliveryNotes` / `retryReturnRequests` have no backoff inside the 30s tick — they keep hammering at every interval until the 24h `s.CompletedAt > DATEADD(HOUR, -24, ...)` window passes, at which point they fall off forever unless explicitly enqueued. Delivery notes do get enqueued on failure (line 59-66); return requests do **not**.

---

## 4. Incremental sync logic

**There is none.** No watermark column, no `last_synced_at`, no `MAX(DocDate)` cursor, no SAP CDC, no `RowVersion` / `LogInst` / `UpdateDate` checks anywhere.

Every read uses one of:
- `DATEADD(DAY, -@days, GETDATE())` for sales/margin/churn analytics (`financialReader.js`, `davoMix.js`)
- `H.DocStatus = 'O'` for open orders (`sqlReader.js:72`)
- `s.CompletedAt > DATEADD(HOUR, -24, SYSUTCDATETIME())` on Logistics DB to find recent unsynced deliveries (`sapSyncWorker.js:41`)

The 24h window is the closest thing to a watermark and it's **the wrong direction** — it limits how far back the worker looks, not how far forward it has progressed. Anything that fails for >24h gets stranded in `RunOrders.SapDeliveryDocEntry=NULL` with no retry unless `SapRetryQueue` was populated.

For BI: every dashboard query is a **full re-aggregation** of the lookback window. With even modest sales volume, recomputing 90-day attach rate (`davoMix.getAttachRate`) on every dashboard render is expensive and produces flickering numbers if a long-running query hits a different SAP transaction snapshot than its sibling.

---

## 5. Retry / backoff

| Mechanism | Location | Behavior |
|---|---|---|
| Backoff array `[1, 5, 15, 60, 240]` minutes | `workers/sapSyncWorker.js:18` | Used **only** by `processRetryQueue` (line 134-180), not by the fast-path worker functions. |
| `SapRetryQueue` permanent failure | `sapSyncWorker.js:166-174` | After 5 attempts row goes to `Status='FAILED_PERMANENT'`. **Nothing pages an operator** — the daily digest at 07:00 mentions failed delivery notes but does not surface `FAILED_PERMANENT` separately (`dailyDigestWorker.js:69-81` queries `RunOrders` not `SapRetryQueue`). The only place `PermanentFailures` is exposed is `analytics.getSapSyncHealth` (`services/analytics.js:181-194`) which feeds an admin dashboard. |
| 401 auto-relogin | `services/sap/serviceLayer.js:47-60` | Single retry on 401 with `_retry` flag — good, but not generalized to 5xx, not generalized to socket timeouts. |
| Service Layer timeouts | `serviceLayer.js:36` (30s) and login (15s) | Bare timeout, no exponential backoff inside the SL client. |
| SQL connection pool retry | `services/sap/sqlReader.js:31-42` | None. First failure to `pool.connect()` rejects the call; pool entry is still cached as a dead pool object. |
| Dead-letter queue | none, beyond `FAILED_PERMANENT` rows that nobody auto-processes. |

**Single-shot fail surfaces:**
- `services/returnRequests.markReturnPickedUp` line 173-187: catches the SL error, logs, leaves `SapReturnRequestDocEntry=NULL`. The driver's UI shows success. The 30s worker tries for 24h and gives up. No alert.
- `services/davoMixWeeklyReport.runWeeklyReport` line 283-296: `Promise.allSettled` so partial failures are logged but not re-tried. A bounced email never resends.
- `services/sap/financialReader.queryAll` line 25-34: catches per-company failure, returns `[]`, `console.warn`. No alerting, no marking of partial result. Caller has no way to know it got half the picture.

---

## 6. Reconciliation protections

**None.** Search for `reconcil`, `drift`, `audit`, `compare`, `verify` against SAP returns nothing operational. There is no:
- Job that compares `SUM(RunOrders WHERE Status='DELIVERED')` to `COUNT(ODLN WHERE created today)` to detect drift.
- Job that verifies an `SapDeliveryDocEntry` we have actually exists in SAP `ODLN` (a stale or rolled-back DocEntry would never be detected).
- Job that re-pulls `OINV` to verify the cached `RunOrders.OrderTotal` still matches.
- Backwards check that flags `RunOrders.Status='DELIVERED'` rows whose SAP order was canceled after the fact (`H.CANCELED='Y'`).

The architecture trusts one-way SAP-Hub-SAP forever. If a SAP user manually closes/cancels/reopens an order, our state diverges silently.

`services/auditLog.js` (used by `deliveryRuns.createRun` line 49-55, `updateRunStatus` line 226-232) tracks Hub-side mutations only — not SAP-side.

---

## 7. Data-loss edge cases — be brutal

### 7.1 Worker crash mid-tick → duplicate Delivery Notes
- `workers/sapSyncWorker.js:33-69` selects `TOP 20 RunOrders WHERE SapDeliveryDocEntry IS NULL`.
- For each, it calls `deliveryNotes.createDeliveryNoteForOrder` which (a) re-checks `SapDeliveryDocEntry IS NULL`, (b) issues `POST /DeliveryNotes`, (c) on 200 updates the row.
- **Race:** if step (b) succeeds in SAP but the Node process is killed before step (c), the next tick re-selects the same row, re-issues `POST`, and SAP creates a **second `ODLN`** for the same Sales Order base entry. SAP B1 will accept this — the only constraint is line-level open-quantity, and a second DN with the same `BaseEntry` consuming the remaining open qty is legal.
- **No transactional bracket** wraps the SAP POST and the local UPDATE. There can't be — SAP and SQL are separate transaction realms. The conventional fix (write a "pending POST with idempotency token T" row before calling SL, then dedupe by token) is not implemented.

### 7.2 Same row picked up by `retryDeliveryNotes` and `processRetryQueue` simultaneously
- `tick()` at line 199-213 runs all three retry functions inside `Promise.all` (no exclusivity).
- A `RunOrder` failure that's both <24h old (caught by `retryDeliveryNotes`) AND has a `SapRetryQueue` row will be retried twice in the same tick. Both call `createDeliveryNoteForOrder`, both pre-check `SapDeliveryDocEntry IS NULL`, both POST. **Same dup risk as 7.1.**
- The `running` flag (line 21, 200-202) only guards against **overlapping ticks**, not against parallel executions inside one tick.

### 7.3 Multi-replica / pm2 cluster
- No DB-level lock (`sp_getapplock`, `WITH (UPDLOCK, READPAST)`, leader-elect row) means turning on a second instance creates double-fire across the board: cron jobs, daily digest emails, and Service Layer POSTs all duplicate.

### 7.4 Service Layer session race in `createDeliveryNote` flood
- `serviceLayerSession.login()` is not mutex-guarded. If 10 requests arrive while `cookies=null` (boot, or after expiry), all 10 see `isSessionValid()=false` (line 42) and call `login()` in parallel. SAP B1 SL allows it but every login burns a license slot and you'll see "session timeout" warnings as old sessions get replaced.

### 7.5 Service Layer relogin re-issues request without recomputing body
- `serviceLayer.js:51-57`: on 401 we re-attach the cookie and replay `original`. The original `data` is the JSON body — fine for `POST /DeliveryNotes`. But if SAP returned 401 *after* it had partially processed the document, we replay and get a duplicate. SAP usually rejects with `-2028 "Document already exists"` but the error path then re-enqueues for retry, a tight loop of guaranteed-failing attempts until `FAILED_PERMANENT`. The system never inspects the SAP error code.

### 7.6 SAP returning partial pages
- Not applicable to writes. For reads, `getOpenOrders` (sqlReader.js:71-112) issues a single non-paged SELECT. If the result set is > a few thousand rows the entire BI dashboard call holds memory; there's no `LIMIT/OFFSET` and no streaming.

### 7.7 Transaction not wrapping multi-row inserts
- `services/orderUnification.unifyOrdersByAddress` (orderUnification.js:121-189) inserts addresses + customer links **outside any transaction**, in a loop with `await` per row. A crash mid-loop leaves a partial unification — half the orders see their address, half don't. The next run will re-find the existing addresses (`findOrCreateAddress` is upsert-by-key) so it self-heals, but `linkCustomerToAddress` uses `IF NOT EXISTS` which is a TOCTOU race against itself if two operators auto-plan the same day in parallel.
- `services/returnRequests.createReturnRequest` line 39-86 **is** wrapped in `db.transaction` — good, but `markReturnPickedUp` (line 136-198) is not, and it does multi-row updates of `ReturnRequestLines` line 152-159 followed by a SAP POST followed by a local UPDATE. Crash anywhere here leaves orphan state.

### 7.8 Race between sync and live writes
- A driver hits "delivered" → `services/deliveryNotes.deliverStop` POSTs to SAP and updates `RunOrders.SapDeliveryDocEntry`. Concurrently, `sapSyncWorker.retryDeliveryNotes` may have already SELECTed the row 50ms earlier (NULL DocEntry) and is mid-POST. **Result:** two Delivery Notes. No row-level lock, no `WHERE SapDeliveryDocEntry IS NULL` in the final UPDATE either (`deliveryNotes.js:87-93`).

### 7.9 Deleting before confirming next sync
- `cleanupRetryQueue` (cleanupWorker.js:70-77) deletes `Status='SUCCESS'` rows older than 7 days. Fine in isolation, but `Status='FAILED_PERMANENT'` rows are kept forever — there's no operator workflow, no UI to reset them. They accumulate.
- `cleanupAuditLog` deletes >365d rows. If a SAP-side audit asks about a delivery from 13+ months ago, our trail is gone.

### 7.10 Orphan ship-to address normalization
- `addressNormalizer` is called inside `unifyOrdersByAddress`. If it returns `normalizedKey=null` (line 47-49 of orderUnification), the order is **silently dropped from the unification result** with no log, no DB row, no warning. Pure data loss for the planner UI — the order still exists in SAP but is invisible to the Hub.

### 7.11 Single-DB pool exhaustion cascading to SAP outage
- `pool.max=10` per company (sqlReader.js:26). The CEO Brief agent (`agents/ceoBrief.js`, called from `ceoBriefScheduler`) issues 7-9 concurrent `queryAll` calls each fanning out to 2 companies = up to 18 simultaneous queries. Plus dashboard. Plus DAVO weekly. The pool will block under load, requests will time out at the SL/HTTP layer with no useful error message.

---

## 8. SAP dependency risks — outage modes

### SAP SQL Server down
- `services/sap/sqlReader.getPool` throws on `pool.connect()` failure. The pool entry **is still set in the Map** (line 38) before connect — actually wait, `await pool.connect()` runs before `pools.set` (line 38-40). OK so failed connects are not cached. Good.
- However: every dashboard endpoint, every BI route, every `unifyOrdersByAddress`, every CEO brief tool throws. Frontend gets 500s. **Visible failure** — loud, not silent.
- DAILY DIGEST email at 07:00 still goes out (it doesn't read SAP) but cannot show "yesterday's stats" except whatever is cached in `RunOrders` already.
- `sapSyncWorker` retry tick keeps failing every 30s, logs `[worker] Delivery Note still failing` for each pending row, fills up logs. No circuit breaker.

### SAP Service Layer down (HTTP 5xx, certs, network)
- Driver's `POST /api/driver/orders/:id/deliver` → `deliverStop` → `createDeliveryNoteForOrder` throws → **per-order catch** in `deliverStop` line 119-124 → result row marked `success:false`. The stop itself is marked `'PARTIAL'` or `'FAILED'`. Driver sees **a success-ish UI** because the stop completed locally even though zero deliveries reached SAP.
- Worker keeps retrying, exponential backoff via `SapRetryQueue` for delivery notes, no enqueue at all for return requests.
- After 24h the fast-path worker stops looking. If the SL was still down at hour 24, the row is **stranded forever** unless an admin manually re-enqueues. There's no admin UI for this — only `analytics.getSapSyncHealth` shows the count.

### Service Layer session expires
- 401 → auto-relogin at `serviceLayer.js:51-58`. Works.
- If the SL host returns a non-401 error wrapping a session issue (B1 sometimes returns 500 with `error.code: -100`), we do **not** re-login. We just propagate the error.
- License slot exhaustion: B1 SL has a per-license session cap (typically 30). The current code creates 1 session per (process, company) and never explicitly logs out except in `logoutAll` on shutdown. If the Node process dies hard (kill -9), the SL session lingers until `SessionTimeout` minutes pass. With the `setInterval` worker calling SL every 30s the session is kept alive forever, which is fine — until you restart 5 times in a row during dev and exhaust the 30 license slots.

### Coupling — does SAP outage = Hub outage?
- **Reads:** yes. Any dashboard, planning, or BI endpoint that calls `sqlReader` will fail end-to-end. There's no read-through cache.
- **Writes (driver flow):** mostly no. `deliverStop` decouples local stop completion from SAP write — the driver is unblocked. But the Hub will silently accumulate unsynced deliveries. The system continues operating with growing drift.
- **CEO brief / weekly report:** silently degrade. `financialReader.queryAll` returns `[]` per failed company. The CEO gets an email saying "revenue 0" rather than "SAP company B is down".

---

## 9. Queue architecture

### What's there
- `SapRetryQueue` table (DDL implied by usage in `sapSyncWorker.js:136-180`). It's a **DB-backed work queue with explicit `NextAttemptAt` polling** — ~1980s style, no LISTEN/NOTIFY, no message broker.
- The "polling" loop is the in-process `setInterval(tick, 30_000)` at line 218.
- `Promise.all([retryDeliveryNotes(), retryReturnRequests(), processRetryQueue()])` in `tick` (line 199-213) — three concurrent passes, no isolation.

### What's missing
- **No Bull / BullMQ / Redis / RabbitMQ / SQS / pg-boss / similar.**
- **No backpressure.** If 500 Delivery Notes pile up, the worker still does `TOP 20` per tick = 40 per minute = ~2400/hour. Service Layer can't sustain that — `pool.max=10` SAP SQL pool will trip first.
- **No concurrency control across operations.** A single SL session per company is the natural bottleneck — `axios.post('/DeliveryNotes')` calls are serialized only by the JS event loop, not by SL. Concurrent POSTs against the same SL session can interleave; B1 has historically had bugs around this.
- **No leader election.** `setInterval` runs on every replica. The codebase implicitly assumes single-replica deployment (confirmed by `ecosystem.config.cjs` not shown but referenced — would need separate review).
- **No DLQ workflow.** `FAILED_PERMANENT` rows just sit there. There is no "drain DLQ", no requeue API, no alerting integration.
- **No metrics.** No Prometheus, no StatsD, no log-derived counters. You can grep logs for `[worker]` lines but you can't graph "delivery notes pending over time".

---

## Appendix A — file map

| Concern | File | Key lines |
|---|---|---|
| Worker entry / 30s loop | `backend/src/workers/sapSyncWorker.js` | 18, 199-221 |
| Cron schedulers | `backend/src/workers/ceoBriefScheduler.js` `davoMixReportScheduler.js` | 35, 25 |
| Self-rescheduled timers | `backend/src/workers/cleanupWorker.js` `dailyDigestWorker.js` | 114-141, 275-300 |
| SL client + session | `backend/src/services/sap/serviceLayer.js` | 22-97, 213-227 |
| SQL read + pool | `backend/src/services/sap/sqlReader.js` | 15-55 |
| SQL BI aggregates | `backend/src/services/sap/financialReader.js` | 20-35 (queryAll), 47-251 |
| DAVO Mix BI | `backend/src/services/davoMix.js` | 47-338 |
| Weekly report | `backend/src/services/davoMixWeeklyReport.js` | 45-300 |
| Delivery Note write | `backend/src/services/deliveryNotes.js` | 24-101, 107-159 |
| Return Request write | `backend/src/services/returnRequests.js` | 136-198 |
| Order unification | `backend/src/services/orderUnification.js` | 46-189 |
| Diagnostic | `backend/src/services/sapDiagnostic.js` | 58-167, 172-263 |
| Sample preview | `backend/src/services/sapSampleData.js` | 27-67 |
| Routes | `backend/src/routes/sap.js` | 13-58 |
| Worker bootstrap | `backend/src/server.js` | 165-169 |
| Sync health KPI | `backend/src/services/analytics.js` | 181-194 |

## Appendix B — what's NOT a problem (so the team doesn't waste time)

- 401 relogin works.
- Per-company isolation in pools and sessions is clean.
- Parameterization: SQL queries are all parameterized via `request.input(...)` — no injection surface.
- `IF NOT EXISTS` patterns inside `addStopToRun` and `linkCustomerToAddress` correctly prevent obvious local duplicates on replay.
- Pre-check `SapDeliveryDocEntry IS NULL` at `deliveryNotes.js:35-44` catches the simple "I already created this" case (just not the race).
- Service Layer client is small and readable — easy to wrap with a circuit breaker / mutex later.
