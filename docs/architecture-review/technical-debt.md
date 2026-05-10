# Technical Debt — SAP Logistics Hub

Read-only architecture review. File:line citations are absolute against `backend/`.

---

## 1. Fragile areas — code that works only by accident

### 1.1 `config/env.js` admits its own compromises

`backend/src/config/env.js:142-152` — startup explicitly logs:

> `LOGISTICS_SQL: encrypt=true but trustServerCertificate=true ... TEMPORARY compromise`
> `SAP_SQL: ... same compromise`
> `SAP_SL_SSL_REJECT_UNAUTHORIZED=false in production`

These warnings have been "temporary" long enough to be hard-coded into the startup banner. MITM-able encryption is the floor, not a step forward.

`config/env.js:153-156` — `JWT_STRICT_VERIFY: z.coerce.boolean().default(false)` with comment _"set after all active sessions have re-logged in"_. Translation: pre-aud/iss tokens are accepted indefinitely. There is no monitoring that would tell you if any are still in circulation, so this flag will never get flipped.

### 1.2 `eventStore.js` is wired but inert

`backend/src/lib/intelligence/eventStore.js:42-49` — `storeEvent` always returns `{ stored: false, reason: 'phase1_table_not_present' }`. Migration 009 (`database/migrations/PENDING.md:1-3`) is "prepared but not yet applied." The event-bus, event-schema, and HTTP receiver all run, validate, and quietly drop. Anyone reading the code thinks it works.

The dead-code commented-out implementation at `eventStore.js:50-84` is what's actually intended to run. That's a 35-line "should be deleted" block sitting in production code.

### 1.3 `agents/runtime.js` — model output validation happens twice

`agents/ceoBrief.js:253-258` validates with Zod _after_ the LLM has already passed the JSON Schema in the tool definition. The two schemas are kept in sync **manually** (compare `ceoBrief.js:40-158` JSON Schema to `:161-198` Zod schema). They drift; the comment at `:160` admits "second line of defense". When they disagree (e.g. the JSON schema allows `delta_pct` optional, Zod also makes it optional, but only the `value`/`metric`/`direction`/`note` are required in both — these are kept aligned by hand), the run will succeed against one and fail validation against the other, producing a mysterious "schema validation failed" error after the LLM already ran.

### 1.4 `serviceLayer.js` session re-login race

`backend/src/services/sap/serviceLayer.js:41-45` — request interceptor checks `isSessionValid()` and re-logins if not. Multiple concurrent requests from the worker (`workers/sapSyncWorker.js:204-207` `Promise.all` of 3 sub-tasks) can simultaneously enter the request interceptor, each see invalid session, and **each fire their own `login()`** (`:67-97`). SAP B1 SL serializes logins per-CompanyDB; usually they all succeed and the last one wins, but there's no `loginInProgress` mutex.

### 1.5 `deliveryRuns.js:185-193` — token creation outside transaction

`backend/src/services/deliveryRuns.js:132-194` — `addStopToRun` returns from the DB transaction at `:185`, then **separately** awaits `trackingTokens.createTokenForStop` outside the transaction (`:187-191`). If the token creation fails, the stop is committed but has no token. The comment at `:148-150` explicitly notes this trade-off, but the user-facing impact (no SMS link will work for that customer) isn't surfaced anywhere except a `apiLogger.warn`.

### 1.6 `gpsTracking.js:46-59` — throttle by SQL race

`backend/src/services/gpsTracking.js:46-59` — INSERT into `DriverLocationHistory` only `WHERE NOT EXISTS (... > DATEADD(SECOND, -60, ...))`. Two simultaneous position posts both pass the NOT EXISTS check, both insert. Throttle is best-effort.

### 1.7 `deliveryRuns.js:23-32` — RunNumber is non-atomic

`generateRunNumber` reads `COUNT(*)` and pads-by-one. Two concurrent `createRun` calls produce the same `RUN-YYYY-MM-DD-NN`. The UNIQUE constraint catches it (`001_initial_schema.sql:128`), so the second INSERT fails with a generic SQL error. There's no retry-on-conflict; the user sees a 500.

### 1.8 `cleanupWorker.js:114-122` `setTimeout(ms)` for next-day scheduling

`backend/src/workers/cleanupWorker.js:114-141` — schedules via `setTimeout(ms)` where `ms` is up to 24h. `setTimeout` accuracy in Node is fine, but if the system suspends or the laptop sleeps (this runs locally), the timer fires when the machine wakes. The `lastRunDate` guard at `:131-134` prevents double-runs same day, but a 25-hour suspend skips a day silently.

---

## 2. Architectural debt — the monolith owns everything

`backend/src/server.js:21-46` mounts **22 route modules** in a single Express app:
- SAP ETL (`sap.js` diagnostic, `sapSyncWorker.js`)
- OLTP CRUD (`orders, runs, returns, picking, drivers, zones, customers, addresses, users, settings`)
- KPI computation (`analytics.js`, `reports.js`)
- AI agents (`agents.js`, scheduled CEO brief)
- Driver mobile API (`driver.js`, `tracking.js`)
- Public customer tracking portal (`trackPublic.js`, no auth)
- Failure ops console (`failures.js`, `audit.js`)
- DAVO BI mix tracker (`davoMix.js`)

All on one process (`ecosystem.config.cjs:59` `instances: 1, exec_mode: 'fork'`). All of these compete for:
- 1 GB heap
- 10 connections to logistics DB
- 10 connections per company to SAP SQL
- 1 SAP Service Layer session per company
- 1 Socket.IO server

A slow `/api/analytics/summary` triggered from the wallboard can starve the driver mobile API. A misbehaving agent run can crash the SAP retry worker.

The frontend SPA is also served from this process (`server.js:136-150`). When backend is down, the UI is too.

The Cloudflare tunnel is a sibling PM2 process (`ecosystem.config.cjs:39-49`) — fine, but means there's only one production "node" of this whole stack.

---

## 3. Dangerous shortcuts

### 3.1 TODO/FIXME inventory

```
backend/src/services/deliveryRuns.js:350  // Nearest-neighbor from warehouse (TODO: store warehouse coords in config)
backend/src/services/notifications.js:39  // TODO: plug in Twilio / 019 / inforu
backend/src/services/returnRequests.js:168  warehouseCode: '01', // TODO: map from zone/product
backend/src/services/trackingTokens.js:138  * TODO: integrate with routing API for more accurate ETAs.
```

Only 4 — but each is a structural unknown:
- `deliveryRuns.js:353` — TLV warehouse coords **hard-coded** as `{ Latitude: 32.0853, Longitude: 34.7818 }`. Route optimization is anchored to a fictional location.
- `notifications.js:38-49` — SMS provider is a `console.log` stub. SMS notifications "succeed" but nothing is sent. The fact that `notifyEvent` returns `sent: 1` for a stub send is a silent failure waiting to happen.
- `returnRequests.js:168` — every return request hard-codes `warehouseCode: '01'`. If Company B's main warehouse is `02`, returns silently route to the wrong location.

### 3.2 Hardcoded company codes

`services/davoMix.js:9` — `const COMPANY = 'A'` — entire DAVO BI is OIG-only by hard-code. No abstraction over `companies` from `config/env.js:130-133`.

`services/sap/financialReader.js:14` — `const COMPANIES = ['A', 'B']` — list literal. Adding company C means a code change.

`services/orderUnification.js:28-35` — both companies hard-coded.

`workers/sapSyncWorker.js:95-110` — `warehouseCode: '01'` hard-coded for the retry path of return requests. Same magic value as `returnRequests.js:168`.

### 3.3 Magic numbers

- `services/wavePicking.js:18-24` — `WAVE-${run.RunNumber}` format hard-coded.
- `services/davoMix.js:48, 86-103` — target ratios `0.4`, `0.6`, `0.22` and Phase 1 target `0.16` (`davoMixWeeklyReport.js:13`) are scattered constants.
- `agents/runtime.js:22-28` — model pricing baked into source. Updating prices = code change + redeploy.
- `workers/sapSyncWorker.js:18` — `BACKOFF_MINUTES = [1, 5, 15, 60, 240]` — not configurable.
- `services/analytics.js` — every `BETWEEN` uses 30-day default from `routes/analytics.js:11-13`.

### 3.4 Swallowed errors

- `agents/store.js:115-119` — `try { JSON.parse(...) } catch { /* keep as string */ }` — silently corrupts caller's expectation of structured Output. The `/* keep */` no-op catches mask data corruption.
- `services/sap/financialReader.js:24-31` — when one company's SAP query fails, returns `[]` and a `console.warn`. CEO brief receives partial data; there is no in-band signal "Company B failed" to the LLM, which then "concludes" without it.
- `services/sap/sqlReader.js:171-174` — `findCustomerByName(...).catch(() => [])` — same pattern.
- `services/serviceLayer.js:103` — `try { await this.axios.post('/Logout'); } catch {}` — fine for logout, but uses bare `catch` with no log.
- `services/deliveryRuns.js:188-192` — token failure logged as `warn`, then ignored.

### 3.5 Inline `import('./customerComms.js').then(...)` dynamic import

`services/deliveryRuns.js:236-242` — fire-and-forget customer notification triggered by status change. The dynamic import is to break a circular dependency. Comment is missing; future readers won't understand why it's not a top-level import. The import error would not even surface — `.then()` chains a `.catch()` that only logs.

### 3.6 `routes/tracking.js:33` — coordinate POST hits server-managed `io`

`io?.to('planner').emit('driver:position', ...)` — the optional chain means if io isn't set up the emit silently no-ops. If `app.set('io', io)` ever fails to wire (e.g. Socket.IO crashes), the tracking endpoint succeeds but no UI updates.

---

## 4. Monolith coupling issues

### 4.1 Workers in same process as web server

All 5 workers — `sapSyncWorker, dailyDigestWorker, cleanupWorker, ceoBriefScheduler, davoMixReportScheduler` — are started inside `server.listen` callback (`server.js:161-170`). Consequences:

- A long-running CEO brief (`agents/runtime.js`, can take 60–90s with LLM + ~16 SAP queries) blocks **nothing CPU-wise**, but **does** consume an event-loop tick on every tool roundtrip and competes for the 10-conn pool. Concurrent dashboard polls slow down.
- The PDF/Excel generators in `routes/reports.js` block the event loop while `xlsx.write(res)` runs CPU-bound serialization. A 5000-row picking-list export can pause Socket.IO heartbeats.
- A worker crash (`workers/sapSyncWorker.js:208-211` only `try/catch` at tick level — but bugs outside the tick, e.g. in `enqueue`, or unhandled-rejection in `customerComms`) brings down the whole API.
- PM2 `max_memory_restart: '1G'` (`ecosystem.config.cjs:64`) restarts everything together when any one service leaks. SAP retry queue may double-process around restarts.

### 4.2 Frontend served from same Express

`server.js:136-150` — `frontend/dist` is served by the same process, with a `/^(?!\/api|...)/` SPA fallback. Backend deployment = frontend deployment. No CDN. No independent scaling.

### 4.3 PM2 single instance

`ecosystem.config.cjs:59` — `instances: 1, exec_mode: 'fork'`. Mandatory because:
- `Socket.IO` has no Redis adapter (`sockets/index.js:14-18`).
- `setInterval`-based workers would all duplicate.
- `agents/runtime.js` writes to DB without optimistic concurrency; multiple instances would create multiple AgentRuns from a single cron tick.
- `cleanupWorker.js:114-141` `setTimeout`-based schedule would fire N times.

So scaling = rewrite, not config change.

### 4.4 In-process `app.set('io', io)` coupling

`server.js:158`. Anything that needs to emit must be a request handler that has `req.app`. Workers can't emit without explicitly importing `server.js`. A separate worker process (the eventual fix) cannot emit at all without going via Redis pub/sub.

---

## 5. Future scaling blockers

### 5.1 In-memory state hidden in caches

- `sap/sqlReader.js:29` `pools = new Map()`, `sap/serviceLayer.js:212` `sessions = new Map()`. These would each multiply across PM2 instances → N × Service Layer logins → SAP B1 license consumption.
- `agents/runtime.js:37` `_client = null` lazy Anthropic SDK. Per-instance client is fine; per-instance API budget tracking is not — there's no central enforcement of `INTEL_AI_DAILY_TOKEN_BUDGET` (`featureFlags.js:69`).

### 5.2 Single-tenant assumptions

The whole codebase assumes 2 SAP companies (A, B) — see §3.2. Adding a third company would require touching `financialReader.js`, `orderUnification.js`, `sqlReader.js`, `routes/sap.js`, `config/env.js`, `serviceLayer.js`, and the migrations seeding `dbo.Companies` (`002_seed_data.sql`).

### 5.3 MSSQL `NVARCHAR(MAX)` JSON columns vs proper modeling

- `dbo.AgentRuns.Output`, `.Messages` (`008_agent_runs.sql:19-22`)
- `dbo.AgentToolCalls.Input`, `.Output` (`008_agent_runs.sql:39-41`)
- `dbo.AuditLog.OldValue`, `.NewValue` (`001_initial_schema.sql:314-315`)
- `dbo.SapRetryQueue.Payload` (`003_gps_tracking.sql:47`)
- `dbo.IntelligenceEvents.Payload` (`009_intelligence_events.sql`, pending)

All of these are queried with `JSON.parse(row.Output)` in code. SQL Server has `OPENJSON` / `JSON_VALUE` but none of it is used. Searching/filtering across these columns requires full table scan. Migration to typed columns or a dedicated document store will be painful once the data shape is "the production app uses this exact JSON layout".

### 5.4 No event sourcing / CQRS path

`AuditLog` (`001_initial_schema.sql:307-321`) is the closest thing to an event log, but it's **per-entity-after-the-fact**. There is no append-only event stream. The pending `IntelligenceEvents` migration adds something close but only for the BI/social side, not for delivery/order events.

### 5.5 Manual cron + setTimeout = no horizontal scaling

`workers/sapSyncWorker.js:217-220` (`setInterval` 30s) and `workers/cleanupWorker.js:114-141` (recursive `setTimeout` for next 03:00) both assume exactly one process. To go multi-instance the worker needs distributed locking (e.g. SQL `sp_getapplock` or Redis Redlock) or a dedicated worker process with a leader election.

### 5.6 `serviceLayer.js` per-company singleton

`backend/src/services/sap/serviceLayer.js:212-222` — one `ServiceLayerSession` per company per process. Going multi-instance multiplies SAP login count and increases lock contention on B1 server. A shared session pool (Redis-backed cookie cache) is the eventual fix.

---

## 6. Repeated patterns that should be abstracted

### 6.1 `Math.min(Math.max(Number(x) || default, min), max)` clamping

Appears in:
- `services/davoMix.js:48, 112, 151, 211, 212, 254, 321, 322`
- `services/sap/financialReader.js:68, 95, 121, 170, 202, 226`
- `agents/store.js:86`

Same pattern: coerce-to-number, default, clamp to range. Should be a single `clampInt(value, min, max, default)` helper.

### 6.2 `queryAll` cross-company fan-out

`services/sap/financialReader.js:20-35` defines `queryAll`. `services/orderUnification.js:25-39` and `services/sap/sqlReader.js:167-177` re-implement the same `Promise.all([query('A', ...), query('B', ...)])` pattern with `CompanyCode` tagging — three times. Should live in `sqlReader.js` as a shared util.

### 6.3 SAP query `DAVO_FILTER_SQL` is a string-concat WHERE clause

`services/davoMix.js:14-18` is a ~200-char SQL fragment string-concatenated into 6 different queries (`:50, 114, 153, 215, 256, 324`). One of them additionally `LIKE N'%DAVO%'` — a typo or a new prefix means 6 edits. Should be a module-level constant injected via a helper, or moved to a SQL view in the SAP DB (`vw_DAVO_LineItems`).

### 6.4 Hebrew RTL HTML email templates duplicated

`services/davoMixWeeklyReport.js:112-257` and `workers/dailyDigestWorker.js:132-251` both have inlined Hebrew RTL HTML email templates with hand-rolled `escapeHtml`. They share styling concepts (color palette, header gradient pattern) but no shared template engine. A 3rd email (the eventual CEO brief delivery) will be a 3rd hand-rolled template.

### 6.5 `IF NOT EXISTS (...) INSERT` upsert pattern

Appears in `services/orderUnification.js:97-105`, `services/deliveryRuns.js:160-181` and likely others. This is fine SQL but should be `MERGE` for clarity (which `gpsTracking.js:28-43` already uses correctly).

### 6.6 Premature abstraction: `eventBus`

`backend/src/lib/intelligence/` has 4 implementations (`eventBusFactory.js`, `eventBusHttp.js`, `eventBusNoop.js`, plus the contract in `eventBus.js`) plus a feature-flag-driven driver selection (`featureFlags.js:61`). The actual usage today is `noop`, and the schema (`eventSchema.js`) is for a feature (`IntelligenceEvents`) whose migration is unapplied (`PENDING.md`). Five files for "we'll wire this up later". Keep the contract; delete the three implementations until you have a second consumer.

`agents/runtime.js` is the right amount of abstraction; `eventBus` is over-engineered for one no-op driver.

---

## 7. Test coverage gaps

Test files in `backend/src`:

```
backend/src/lib/intelligence/__tests__/eventSchema.test.js
backend/src/middleware/auth.test.js
backend/src/services/addressNormalizer.test.js
backend/src/services/fileStorage.test.js
backend/src/services/timeWindows.test.js
```

5 files. What's not tested:

| Area | File | Why it matters |
|---|---|---|
| Order unification | `services/orderUnification.js` | The unique value-prop of the system. Untested. |
| Wave picking aggregation | `services/wavePicking.js` | Money math. Untested. |
| Delivery Note creation | `services/deliveryNotes.js` | Writes to SAP. Untested. |
| SAP retry worker | `workers/sapSyncWorker.js` | Backoff logic, idempotency. Untested. |
| Analytics queries | `services/analytics.js` | KPIs the business decisions ride on. Untested. |
| DAVO Mix BI | `services/davoMix.js`, `davoMixWeeklyReport.js` | Email goes to CEO. Untested. |
| Agent runtime | `agents/runtime.js`, `agents/ceoBrief.js` | LLM tool-use loop, schema enforcement, cost tracking. Untested. |
| All routes | `routes/*.js` | Every HTTP contract. Untested except via auth middleware. |
| GPS tracking | `services/gpsTracking.js` | Includes the throttle-by-NOT-EXISTS race condition. Untested. |
| Service Layer client | `services/sap/serviceLayer.js` | Auto-relogin, cookie management. Untested. |
| Worker crons | `workers/ceoBriefScheduler.js`, `workers/davoMixReportScheduler.js`, `workers/dailyDigestWorker.js` | Untested. |

There is no integration-test harness against a real or in-memory SQL Server. The in-process `mssql` pool means unit tests that touch DB are infeasible without a live server. Mocking `db.query` would require a service-locator pattern that doesn't exist.

The `eventSchema.test.js` and `auth.test.js` exist for code paths that **will be exposed externally** — that's reasonable prioritization, but it leaves the entire core domain (delivery → SAP write) untested.

---

## 8. Documentation debt

Top-level repo MD files (`sap-logistics-hub/`):

| File | Date | Status |
|---|---|---|
| `README.md` | unknown | Likely stale relative to actual feature surface (33 frontend pages, 22 routes). |
| `README_USAGE.md` | unknown | Duplicate-ish of README. Splits docs across 2 files. |
| `QUICK_START.md` | unknown | A 3rd entry point. |
| `MORNING_NOTES.md` | 2026-04-24 (head) | A nightly dev log left committed in the root. Historic, not maintenance docs. |
| `NIGHT_WORK_PLAN.md` | targets 2026-04-24 03:07 | Same — a one-off planning doc that should have been deleted or moved. |

`docs/`:

- `AUDIT_REPORT.md` — dated **30 April 2026**. Reports `1,265 הזמנות ב-46 מסלולים`, `5,236 lines backend`, `42 stale dist builds`. Numbers are static; will be stale next week. The "8 critical fixes" listed at the top have an unknown completion status — there's no follow-up file or check-in marking which were applied.
- `PRODUCTION.md`, `SAP_INTEGRATION.md` — not reviewed in detail; assumed at risk of staleness given the pace implied by `MORNING_NOTES.md`.
- `architecture-review/folder-tree.txt` — single static dump.
- `database/migrations/PENDING.md` — clear, well-maintained. Tracks 4 unapplied migrations with rollback pairs and pre-flight checklist. The **one piece of documentation that is current and load-bearing**.

### Symptoms of doc rot

- README, QUICK_START, README_USAGE all coexist with no canonical entry point.
- Nightly working logs (`MORNING_NOTES.md`, `NIGHT_WORK_PLAN.md`) are committed to root, not to a `journal/` folder.
- `AUDIT_REPORT.md` recommendations have no traceability to implementation.
- Code has good per-file JSDoc headers (e.g. `services/analytics.js:1-11`, `services/orderUnification.js:1-15`) — better than the top-level docs. The real architecture is in the code comments, not in `docs/`.
- The `docs/architecture-review/` folder, when this review lands, will be the most thorough document about what the system actually does. That's a sign the prior docs aren't doing their job.

### Recommended cleanup

1. Move `MORNING_NOTES.md`/`NIGHT_WORK_PLAN.md` to `journal/2026-04/` or delete.
2. Pick one of `README.md` / `QUICK_START.md` / `README_USAGE.md` as canonical; redirect from the other two.
3. Date-stamp `AUDIT_REPORT.md` items as "open / done / superseded by performance-analysis.md".
4. Add a `docs/RUNBOOK.md` for what to do when the SAP retry queue grows / when AgentRuns blow up cost.
5. `PENDING.md` is the model — replicate its style for any other deferred work.

---

## Worst-offender shortlist

Ordered by "biggest production risk if left alone":

1. **`config/env.js:142-156`** — TLS-skip + JWT-strict-off "temporary" flags. Security ceiling.
2. **`services/sap/financialReader.js:24-31`** + **`sqlReader.js:171-174`** — silent partial-data fallback to LLM. The CEO brief can confidently report half a dataset with no flag.
3. **`services/notifications.js:38-49`** — SMS stub returns success. Customer-facing notifications are a ghost.
4. **`workers/sapSyncWorker.js:33-69`** — `TOP 20` per 30s = 40/min throughput cap, with no growth alert.
5. **`agents/runtime.js:90, 117, 136-141`** + **`store.js:33-56`** — full message history including SAP tool results in heap and DB. No retention. Per-run blob size grows with model verbosity.
6. **`server.js:161-170`** — workers and web server in same process; one OOM kills both.
7. **`services/deliveryRuns.js:23-32`** — non-atomic RunNumber generation; user-visible 500s under concurrency.
8. **`PENDING.md`** — 4 migrations prepared but not applied. The longer they sit, the more they drift from the schema they expect.
