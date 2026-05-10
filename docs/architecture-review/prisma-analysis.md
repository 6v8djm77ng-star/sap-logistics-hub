# Database Schema Analysis — sap-logistics-hub

> Note on the filename: the parent task asked for `prisma-analysis.md` but this project does **not** use Prisma. The schema is **Microsoft SQL Server** managed via raw `.sql` files in `database/migrations/` and applied by a hand-rolled runner at `backend/src/db/migrate.js`. The filename is preserved for the review tooling; the contents below are an MS SQL Server schema review.

Scope of files read:
- `database/migrations/001_initial_schema.sql` … `012_ai_cost_budget.sql`
- Rollback pairs `009_rollback.sql`, `010_rollback.sql`, `011_rollback.sql`, `012_rollback.sql`
- `backend/src/db/logisticsDb.js` (connection pool / query helpers)
- `backend/src/db/migrate.js` (migration runner)
- All `backend/src/services/*.js` and `backend/src/routes/*.js` for query patterns
- `backend/src/workers/cleanupWorker.js`, `workers/sapSyncWorker.js`, `agents/store.js`

---

## Summary verdict

The schema is well-organized for an early-stage product but carries a **clear OLTP/OLAP-mixed footprint** and several **production-hot tables without retention or partitioning**. The biggest concrete risks:

1. `AuditLog`, `DriverLocationHistory`, `NotificationLog`, `IntelligenceEvents`, `AgentRuns`, `AgentToolCalls` all grow unbounded; only some have an explicit cleanup path in `cleanupWorker.js`, and **none are partitioned** despite migration 009 explicitly saying "partition-ready".
2. `analytics.js` runs heavy multi-join aggregates against the same OLTP tables (`DeliveryRuns` / `DeliveryStops` / `RunOrders`) that pickers and drivers are writing to during the workday — **no read replica, no aggregate tables, no NOLOCK / RCSI guidance** in the migration set.
3. Several rollback files are **destructive `DROP TABLE`** with no data preservation — they will lose every row in production if invoked. Migrations 001–008 have no rollback files at all.
4. The `_Migrations` table tracks applied filenames but each migration is **not wrapped in a transaction** and a mid-batch failure leaves the DB half-applied with no row in `_Migrations`. See `backend/src/db/migrate.js:49-63`.

---

## Per-table analysis

### Migration 001 — initial schema

#### `dbo.Companies` (`001_initial_schema.sql:21`)
- **Purpose:** Maps logical company codes (`A`, `B`) to SAP Business One company DBs (`SBO_COMPANY_A`, later overridden in migration 006).
- **Classification:** dimension.
- **Keys:** PK `CompanyId`, UNIQUE `Code`. FK targets from `RunOrders`, `ReturnRequests`, `CustomerAddressLinks`.
- **Indexes:** PK + unique on `Code` only.
- **Missing indexes:** none material — table is tiny (2 rows) and joined only by PK.
- **Large-table risk:** none.
- **OLTP/OLAP:** N/A.

#### `dbo.Zones` (`001_initial_schema.sql:36`)
- **Purpose:** 7-zone distribution lookup (`NORTH`, `CENTER`, …) — see `002_seed_data.sql:23`.
- **Classification:** dimension.
- **Keys:** PK `ZoneId`, UNIQUE `Code`.
- **Indexes:** PK + unique only.
- **Missing indexes:** none — fixed 7 rows.
- **Large-table risk:** none.
- **OLTP/OLAP:** N/A.

#### `dbo.Drivers` (`001_initial_schema.sql:52`)
- **Purpose:** Driver master — credentials for mobile app + vehicle metadata.
- **Classification:** dimension (with operational columns `LastLoginAt`, `PasswordHash`).
- **Keys:** PK `DriverId`, UNIQUE `Code`.
- **Missing indexes:**
  - `IX_Drivers_IsActive` — `routes/drivers.js:21` lists active drivers; today's seed has 2 rows, but as fleet grows the table-scan will not show in any plan tool until there's a problem.
  - No index on `LastLoginAt` even though there's a login flow that probably wants "drivers logged in today" reporting eventually.
- **Large-table risk:** none currently.
- **OLTP/OLAP:** OK.

#### `dbo.DriverZones` (`001_initial_schema.sql:72`)
- **Purpose:** Many-to-many between drivers and their default zones.
- **Classification:** dimension (junction).
- **Keys:** PK `DriverZoneId`, UNIQUE `(DriverId, ZoneId)`.
- **Missing indexes:** the unique key already covers `DriverId` lookups in `services/deliveryRuns.js:90` (`WHERE dz.ZoneId = …`) — but **the unique is on `(DriverId, ZoneId)`, so a query filtered only by `ZoneId` cannot seek**. Need `IX_DriverZones_Zone` on `(ZoneId)` for that path.
- **Large-table risk:** none.

#### `dbo.NormalizedAddresses` (`001_initial_schema.sql:87`)
- **Purpose:** Canonical address keyed by a normalized string so the same physical store under two SAP `CardCode`s collapses to one delivery point.
- **Classification:** dimension (extended with operational columns in 007: `DeliveryWindowStart/End`, `ContactPhone`, `SmsOptIn`, `ContactEmail`).
- **Keys:** PK `AddressId`. FK to `Zones`.
- **Indexes:** `IX_NormalizedAddresses_Key` on `NormalizedKey`.
- **Missing indexes:**
  - **No index on `ZoneId`** even though `services/deliveryRuns.js:342` joins by zone and `routes/zones.js:69` updates zone assignment. Add `IX_NormalizedAddresses_ZoneId`.
  - `IX_NormalizedAddresses_Key` is **non-unique** but the column is used as a dedup key (`services/orderUnification.js:55`). Should be a `UNIQUE` index — the absence allows duplicate canonical keys to slip in.
  - **No covering index on `(Latitude, Longitude)`** — geo-radius queries (none yet) would table-scan. Acceptable for now, but flag for future map UI.
- **Large-table risk:** Medium. Grows with customer expansion, but bounded by store count.
- **OLTP/OLAP:** OK.

#### `dbo.CustomerAddressLinks` (`001_initial_schema.sql:111`)
- **Purpose:** Bridges a SAP `CardCode` (per company) to a `NormalizedAddresses` row.
- **Classification:** dimension (junction).
- **Keys:** PK `LinkId`, UNIQUE `(CompanyId, SapCardCode, SapAddressName)`.
- **Missing indexes:**
  - The unique covers `(CompanyId, SapCardCode, SapAddressName)`. Queries in `routes/customers.js:53` filter by `AddressId` (reverse direction). Need `IX_CustomerAddressLinks_AddressId` for that hot path — currently it's a scan once data grows.
  - No FK constraint enforcement-issue, but **no index on `SapCardCode` alone** for unification lookups (`services/orderUnification.js:99` filters by `CompanyId` + `SapCardCode`, which the unique can seek — OK).
- **Large-table risk:** Medium-low.

#### `dbo.DeliveryRuns` (`001_initial_schema.sql:126`) — **HOT TABLE**
- **Purpose:** Central transactional entity — one delivery run per (date, zone) with status lifecycle.
- **Classification:** fact (status transitions are time-stamped).
- **Keys:** PK `RunId`, UNIQUE `RunNumber`. FKs to `Zones`, `Drivers`.
- **Indexes:** `IX_DeliveryRuns_Date_Zone` `(RunDate, ZoneId)`, `IX_DeliveryRuns_Status`.
- **Missing indexes:**
  - `IX_DeliveryRuns_Driver_Date` on `(DriverId, RunDate)` — `services/analytics.js:122` joins by `DriverId` and the dashboard "today's runs by driver" path is unindexed.
  - `IX_DeliveryRuns_Zone_Date` on `(ZoneId, RunDate DESC)` — `analytics.js:144` orders runs per zone, current `(RunDate, ZoneId)` has wrong key order for that pattern.
  - No covering include of `Status` on the date/zone index, so the workday "open runs in north" query has to do key lookups per row.
- **Large-table risk:** Bounded (≈ zones × days). 7 zones × 365 days × few drivers ≈ ~10K rows/year — OK.
- **OLTP/OLAP:** **HIGH CONCERN.** `services/analytics.js:34-103` runs multi-join GROUP BY against this table while `services/deliveryRuns.js` is mid-day inserting/updating it. With no RCSI / snapshot isolation hint anywhere, dashboard queries can block dispatcher writes.

#### `dbo.DeliveryStops` (`001_initial_schema.sql:151`) — **HOT TABLE**
- **Purpose:** Each physical destination in a run; aggregates orders from both companies.
- **Classification:** fact.
- **Keys:** PK `StopId`, FKs to `DeliveryRuns` (cascade), `NormalizedAddresses`.
- **Indexes:** `IX_DeliveryStops_Run` on `(RunId, StopOrder)`.
- **Missing indexes:**
  - `IX_DeliveryStops_Status` — many code paths filter on `Status` (`services/failures.js:83`, `services/deliveryNotes.js:110` filters via `RunOrders` but reads stop status downstream).
  - `IX_DeliveryStops_AddressId` — `services/deliveryRuns.js:135`, `services/returnRequests.js:101`, `services/failures.js:254` all do `WHERE RunId = … AND AddressId = …` and `WHERE AddressId = …`. The `(RunId, StopOrder)` index can satisfy the RunId predicate but a key-lookup happens for AddressId. Add `IX_DeliveryStops_Run_Address` `(RunId, AddressId) INCLUDE (StopOrder, Status)`.
  - `IX_DeliveryStops_CompletedAt` — `reports/exceptions.js:43` orders by `s.CompletedAt DESC`; will scan today.
- **Large-table risk:** Medium-high. Stops × runs grow linearly with business; no retention.
- **OLTP/OLAP:** **HIGH CONCERN.** Same dual-use as `DeliveryRuns`.

#### `dbo.RunOrders` (`001_initial_schema.sql:173`) — **HOT TABLE**
- **Purpose:** Many-to-one between `DeliveryStops` and SAP sales orders. Stores SAP DocEntry pointers and the resulting Delivery DocEntry after sync.
- **Classification:** fact.
- **Keys:** PK `RunOrderId`, UNIQUE `(CompanyId, SapDocEntry)`, FKs to `DeliveryStops` (cascade), `Companies`.
- **Indexes:** `IX_RunOrders_Stop`.
- **Missing indexes:**
  - **`IX_RunOrders_Status_DeliveryDoc` filtered** — `analytics.js:184-187` runs `COUNT(*) WHERE Status='DELIVERED' AND SapDeliveryDocEntry IS NULL` and the symmetric one. These are hot dashboard widgets. A filtered index `WHERE Status='DELIVERED'` covering `SapDeliveryDocEntry` would turn each into a seek.
  - `IX_RunOrders_StopId_Status` — many lookups pair them (`services/deliveryNotes.js:110`).
  - `IX_RunOrders_SapDocEntry` — already covered by the unique on `(CompanyId, SapDocEntry)` for both-column lookups, but reverse-lookup by DocEntry alone (e.g. SAP webhook callbacks if added) would not seek.
- **Large-table risk:** High. 1 row per SAP order per day. Multi-year retention is needed for tax/SAP reconciliation, no archive plan exists.
- **OLTP/OLAP:** **HIGH CONCERN.** Same as siblings.

#### `dbo.ReturnRequests` (`001_initial_schema.sql:198`)
- **Purpose:** Customer-initiated reverse-logistics requests; assigned to a stop on pickup day.
- **Classification:** fact.
- **Keys:** PK `ReturnId`, UNIQUE `ReturnNumber`. FKs to `Companies`, `NormalizedAddresses`, `DeliveryStops`.
- **Indexes:** `IX_ReturnRequests_Status`, `IX_ReturnRequests_Stop`.
- **Missing indexes:**
  - `IX_ReturnRequests_RequestedDate` — `services/returnRequests.js:222` orders by it.
  - `IX_ReturnRequests_AddressId` — `routes/returns.js` and `reports/exceptions.js:51` join via address.
  - `IX_ReturnRequests_CompanyCard` `(CompanyId, SapCardCode)` — for "all open returns for customer X" lookups.
- **Large-table risk:** Bounded by return rate. Low.

#### `dbo.ReturnRequestLines` (`001_initial_schema.sql:225`)
- **Purpose:** Line items inside a return request.
- **Classification:** fact.
- **Keys:** PK `ReturnLineId`, FK to `ReturnRequests` (cascade).
- **Missing indexes:** **No index on `ReturnId`** even though every read filters by it (`services/returnRequests.js:147,240`). The cascade FK provides one in some RDBMS, but **SQL Server does NOT auto-create an index on FK columns**. Add `IX_ReturnRequestLines_ReturnId`.
- **Large-table risk:** Low.

#### `dbo.PickingWaves` (`001_initial_schema.sql:242`)
- **Purpose:** Aggregated picking job for one delivery run.
- **Classification:** operational (workflow state).
- **Keys:** PK `WaveId`, UNIQUE `WaveNumber`, FK to `DeliveryRuns`.
- **Missing indexes:** `IX_PickingWaves_RunId_Status` — `routes/runs.js:108` does `WHERE RunId = @runId AND Status <> 'CANCELLED'` (no index, will scan).
- **Large-table risk:** Low (1 per run).

#### `dbo.PickingWaveLines` (`001_initial_schema.sql:258`)
- **Purpose:** Aggregated SKU quantities to pick across all stops in the wave.
- **Classification:** operational.
- **Keys:** PK `WaveLineId`, FK to `PickingWaves` (cascade).
- **Indexes:** `IX_PickingWaveLines_Wave`.
- **Missing indexes:** `IX_PickingWaveLines_SapItemCode` — for "where is item X being picked today" cross-wave queries.
- **Large-table risk:** Low.

#### `dbo.PickingAllocations` (`001_initial_schema.sql:278`)
- **Purpose:** Bridges a picked wave-line back to specific run-order line numbers (the accounting separation).
- **Classification:** operational.
- **Keys:** PK `AllocationId`, FKs to `PickingWaveLines` (cascade), `RunOrders`.
- **Missing indexes:** **None on `RunOrderId`** despite the FK and certain reverse lookups. Add `IX_PickingAllocations_RunOrderId`.
- **Large-table risk:** Medium — proportional to picked line count.

#### `dbo.Users` (`001_initial_schema.sql:291`)
- **Purpose:** Logistics-hub UI users (planner, warehouse, admin).
- **Classification:** dimension/operational.
- **Keys:** PK `UserId`, UNIQUE `Username`.
- **Missing indexes:** None material (small table). Note the seed at `002_seed_data.sql:79` inserts a placeholder bcrypt hash that is then overwritten by `migrate.js:100-105`. If the post-migration step fails, the placeholder hash remains in production — there is no `IsTemporaryPassword` flag to force a reset.
- **Large-table risk:** None.

#### `dbo.AuditLog` (`001_initial_schema.sql:308`) — **UNBOUNDED**
- **Purpose:** Generic JSON audit trail for any entity / action / user.
- **Classification:** raw / event log.
- **Keys:** PK `AuditId BIGINT`.
- **Indexes:** `IX_AuditLog_Entity`, `IX_AuditLog_CreatedAt`.
- **Missing indexes:** `IX_AuditLog_UserId_Created` — for "what did user X do today" admin views (none yet, but commonly added late and very expensive without an index when added).
- **Large-table risk:** **HIGH.** Every write path calls `auditLog.record()` (`services/auditLog.js:30`). At 50 writes/min sustained that's ~26M rows/year, all in one heap-ordered table. `cleanupWorker.js:60` does delete rows past retention but with **no batching, no `TOP (N)` loop**, and no archive — a first-time run after months of data will lock the table.
- **OLTP/OLAP:** **HIGH** — `services/auditLog.js:55` reads with `ORDER BY a.CreatedAt DESC` in the admin UI. As the table grows, this read collides with insert hot-spots (the BIGINT identity tail).

---

### Migration 003 — GPS tracking

#### `dbo.DriverLocations` (`003_gps_tracking.sql:9`)
- **Purpose:** Last-known GPS fix per driver — one row per driver, updated in place.
- **Classification:** operational (live state).
- **Keys:** PK `DriverId` (and FK).
- **Missing indexes:** None needed — single-row-per-driver pattern.
- **Large-table risk:** None.
- **OLTP/OLAP:** OK.

#### `dbo.DriverLocationHistory` (`003_gps_tracking.sql:24`) — **UNBOUNDED, FAST GROWING**
- **Purpose:** Breadcrumb trail of every GPS ping.
- **Classification:** raw event stream.
- **Keys:** PK `HistoryId BIGINT`.
- **Indexes:** `IX_DriverLocationHistory_Driver_Time` `(DriverId, RecordedAt DESC)`.
- **Missing indexes:** `IX_DriverLocationHistory_RunId_Time` — `services/gpsTracking.js:95` queries by `RunId` for route playback. Today this scans.
- **Large-table risk:** **CRITICAL.** At a 30-second ping cadence × 8h workday × 10 drivers that's ~10K rows/day, ~3.5M/year. No partitioning, no archival rollup. `cleanupWorker.js:47` deletes by date but again with no batching loop.
- **OLTP/OLAP:** Live driver dashboard reads `IX_DriverLocations` (current row) — OK. Route playback hits history table directly; once it's >10M rows the playback API will time out.
- **Note:** No FK on `RunId` (column 27 is plain INT). Orphan ping history is silently allowed.

#### `dbo.SapRetryQueue` (`003_gps_tracking.sql:41`) — **OPERATIONAL QUEUE**
- **Purpose:** Background retry queue for failed SAP B1 calls (delivery/return creation).
- **Classification:** operational queue.
- **Keys:** PK `QueueId BIGINT`.
- **Indexes:** `IX_SapRetryQueue_Status_NextAttempt`.
- **Missing indexes:** `IX_SapRetryQueue_Entity` — `workers/sapSyncWorker.js:188` queries `WHERE EntityType = … AND EntityId = …` (dedup before insert) — currently table-scan.
- **Large-table risk:** Low if cleanup runs (`cleanupWorker.js:72` purges); but `Status='FAILED_PERMANENT'` rows accumulate forever per `analytics.js:192` — they never get pruned.
- **OLTP/OLAP:** OK — internal worker only.

---

### Migration 004 — failures, portal, alerts

#### `dbo.FailureReasons` (`004_failures_and_portal.sql:11`)
- **Purpose:** Catalog of canonical failure reason codes (14 seeded).
- **Classification:** dimension (seeded reference).
- **Keys:** PK `ReasonCode`.
- **Missing indexes:** none.
- **Risk:** none.

#### `dbo.StopFailures` (`004_failures_and_portal.sql:54`)
- **Purpose:** A failed-delivery record, linked to the stop and reason; tracks resolution + reschedule.
- **Classification:** fact.
- **Keys:** PK `FailureId`, FKs to `DeliveryStops`, `FailureReasons`, `Drivers`, `DeliveryRuns` (RescheduledTo).
- **Indexes:** `IX_StopFailures_Status` `(ResolutionStatus, CreatedAt DESC)`.
- **Missing indexes:**
  - `IX_StopFailures_StopId` — `services/failures.js:281` filters by `StopId`. Will scan.
  - `IX_StopFailures_ReasonCode` — `analytics.js:169` GROUPs by `ReasonCode`. Today scans the full failures table per dashboard load.
  - `IX_StopFailures_ReportedByDriverId` — analytics by-driver report scans.
- **Large-table risk:** Medium (proportional to delivery volume × failure rate).
- **OLTP/OLAP:** OK so long as failures stay rare.

#### `dbo.TrackingTokens` (`004_failures_and_portal.sql:78`)
- **Purpose:** Public, time-bounded token for the customer-facing tracking link.
- **Classification:** operational.
- **Keys:** PK `Token`, FK to `DeliveryStops`.
- **Indexes:** `IX_TrackingTokens_Stop`, `IX_TrackingTokens_Expires`.
- **Missing indexes:** None material.
- **Large-table risk:** Bounded by stops × token-lifetime. `services/trackingTokens.js:169` purges expired+7d via `cleanupWorker.js:24`. OK.
- **Security note:** `Token VARCHAR(40)` — should be a 256-bit token; UUID is 36 chars but the comment says "UUID-ish". No rate-limit metadata in the table; abuse detection lives outside the schema.

#### `dbo.AlertSubscriptions` (`004_failures_and_portal.sql:95`)
- **Purpose:** Per-user alert subscription (event type × channel).
- **Classification:** dimension.
- **Keys:** PK `SubscriptionId`, UNIQUE `(UserId, EventType, Channel)`.
- **Missing indexes:** `IX_AlertSubscriptions_EventType_Active` `(EventType, IsActive) INCLUDE (UserId, Channel)` — `services/notifications.js:138` fans out by event type to find who to email; the unique cannot serve `WHERE EventType = …` first-column-filtered.
- **Large-table risk:** None.

#### `dbo.NotificationLog` (`004_failures_and_portal.sql:111`) — **UNBOUNDED**
- **Purpose:** Every notification (email/SMS/in-app) attempt is appended.
- **Classification:** raw event log.
- **Keys:** PK `LogId BIGINT`.
- **Indexes:** `IX_NotificationLog_Entity`, `IX_NotificationLog_CreatedAt DESC`.
- **Missing indexes:** `IX_NotificationLog_Status_CreatedAt` — for "what failed in the last hour" dashboards.
- **Large-table risk:** Medium-high. `cleanupWorker.js:35` purges, but with no batching.

---

### Migration 005 — `dbo.SystemSettings`
- **Purpose:** Runtime-mutable key-value config (warehouse codes, portal URL, etc.).
- **Classification:** dimension/config.
- **Keys:** PK `SettingKey`.
- **Missing indexes:** none — small.
- **Risk:** **`IsSecret BIT` is set on the table but the seeded data marks every row `IsSecret=0`.** The schema implies secrets can live here; that contradicts the user's standing rule (rule_credentials_in_env.md) that mandates `.env`. Recommend removing `IsSecret` or adding a CHECK constraint that forces it to 0.

---

### Migration 006 — data-only update to `Companies`
No schema changes. Updates `SapCompanyDb` and `Name` in place. No backup/audit row is written before mutation. If executed twice on a partially-renamed DB the WHERE clause is idempotent — OK.

---

### Migration 007 — time windows / contact info
Adds columns to `dbo.NormalizedAddresses`:
- `DeliveryWindowStart TIME`, `DeliveryWindowEnd TIME`
- `DeliveryDays VARCHAR(20)` — **CSV string** (`'MON,TUE,WED'`). This is a code smell; querying "all addresses that accept Wednesday deliveries" requires a `LIKE '%WED%'` scan. A bitmap INT or a side table `AddressDeliveryDays(AddressId, DayOfWeek)` would be queryable.
- `ContactPhone`, `ContactName`, `DeliveryNotes`, `SmsOptIn BIT`, `ContactEmail`, `EmailOptIn BIT`.
- **No indexes added.** Time-window-aware planner queries (`services/timeWindows.js`) cannot seek.

---

### Migration 008 — agent runs

#### `dbo.AgentRuns` (`008_agent_runs.sql:6`) — **UNBOUNDED**
- **Purpose:** One row per LLM agent execution (CEO brief, etc.); stores message history + cost.
- **Classification:** raw event log + cost telemetry.
- **Keys:** PK `RunId INT IDENTITY`. **`INT`, not `BIGINT`** — at high cadence this overflows in 6.8 years. Should be BIGINT.
- **Indexes:** `IX_AgentRuns_Agent_Started`.
- **Missing indexes:** `IX_AgentRuns_Status_Started` — for "still-running" detection (`agents/store.js:94`). `IX_AgentRuns_StartedAt` standalone for time-range cost reports.
- **Large-table risk:** **HIGH.** `Messages NVARCHAR(MAX)` and `Output NVARCHAR(MAX)` — full message histories are written here. At even modest agent activity the LOB pages explode. No archival worker exists for this table (`cleanupWorker.js` does not touch it).
- **OLTP/OLAP:** Read by debug UIs; written by every agent invocation. Mixed access on the same table.

#### `dbo.AgentToolCalls` (`008_agent_runs.sql:34`)
- Same concern. `RunId INT` referencing `AgentRuns(RunId)` — fine, but again **INT identity** for the toolcall PK; tool calls vastly outnumber runs. **Set `ToolCallId BIGINT`**.
- Index `IX_AgentToolCalls_Run` covers the only documented access pattern.

---

### Migration 009 — `dbo.IntelligenceEvents` — **UNBOUNDED, NEEDS PARTITIONING**

`009_intelligence_events.sql:34`. The migration's own header comment (`009_intelligence_events.sql:23-26`) declares the table is partition-ready — but **no PARTITION SCHEME or PARTITION FUNCTION is created**. The clustered PK `(Timestamp DESC, EventId)` is a *prerequisite* for partition switching, but partitioning still has to be defined.

- **Classification:** raw event stream (cross-product event bus persistent store).
- **Keys:** Clustered PK `(Timestamp DESC, EventId)`. UUID `EventId` so writes are scattered if you cluster on it alone — clustering on `Timestamp DESC` is the right call but causes hot-page contention at the head.
- **Indexes:** Solid set of 8 nonclustered: `EventId`, `EventType_Time`, `Source_Time`, `Brand_Time` (filtered), `Severity_Time`, `Unprocessed` (filtered), `RetainUntil` (filtered), `NextRetry` (filtered).
- **Missing indexes:** `IX_IntelEvents_EntityType_Entity` `(EntityType, EntityId)` — entity-centric queries ("what events relate to customer X") have no index.
- **Large-table risk:** **CRITICAL.** This is the durable store for events from `facebook-service-agent`, `sap-logistics-hub`, and `davo-price-monitor` (header comment lines 13-15). At the social-listening cadence already operating in those apps this table will grow fast.
  - `RetainUntil` and `ArchivedAt` columns exist but **no archival worker is wired up** — `cleanupWorker.js` does not touch this table.
- **OLTP/OLAP:** Designed for both writes (event ingestion, line 19) and reads (agent polling for unprocessed, severity dashboards). The filtered `IX_IntelEvents_Unprocessed` is exactly the queue index — good — but the table is also being read for dashboards. As volume grows, partition or archive.

---

### Migration 010 — `dbo.Insights`

`010_insights.sql:25`.

- **Classification:** aggregate / synthesized output of intelligence agents (`competitor_threat`, `buying_lead`, etc.).
- **Keys:** Clustered PK `InsightId UUID`. **Random GUID clustered key** — guaranteed page splits / fragmentation. Should be `NEWSEQUENTIALID()` or a separate IDENTITY clustered column with `InsightId` as a unique nonclustered key.
- **Indexes:** Six well-targeted indexes (`Status_Severity`, `Open` filtered, `Brand`, `Competitor`, `AgentName`, `AgentRunId`, `AssignedTo`).
- **Missing indexes:** `IX_Insights_DueAt` — workflow due-date sweeping has no index. `IX_Insights_HandledAt` for SLA dashboards.
- **Large-table risk:** Medium. Volume is "synthesized" so much smaller than `IntelligenceEvents`, but again no archival worker.
- **Cross-table issue:** `AgentRunId UNIQUEIDENTIFIER NULL` is described as "soft link to AgentRuns". But `AgentRuns.RunId` (migration 008) is **INT IDENTITY**, not a UUID. **The link is type-mismatched and cannot be FK'd or joined directly.** This is a real bug — any "show insights from this agent run" query is broken by design. See `010_insights.sql:31` vs `008_agent_runs.sql:7`.

---

### Migration 011 — `dbo.Alerts`

`011_alerts.sql:25`.

- **Classification:** operational (alert dedup/throttle state).
- **Keys:** Clustered PK on UUID — same fragmentation concern as Insights.
- **Indexes:** `AlertKey_LastSeen`, `Status_Created`, `Severity_Created`, filtered `SuppressedUntil`.
- **Missing indexes:** none material.
- **Large-table risk:** Low (dedup + cooldown means low row count); no retention plan but volume is bounded.
- **Note:** `EventIds NVARCHAR(MAX)` JSON array — not queryable without JSON_VALUE / OPENJSON, no index. For traceability OK, but querying "alerts that referenced event X" requires a scan.

---

### Migration 012 — `dbo.AiSpendBudget`

`012_ai_cost_budget.sql:30`.

- **Classification:** aggregate (rollups by period bucket).
- **Keys:** Clustered PK `BudgetId UUID` (same fragmentation issue), UNIQUE `(PeriodType, PeriodKey, AgentName, Model)`.
- **Indexes:** `PeriodKey + PeriodType`, filtered `Backpressure` index.
- **Missing indexes:** `IX_AiSpend_AgentName_PeriodKey` — per-agent budget reporting filters AgentName first.
- **Large-table risk:** Low — bounded by `daily × hourly × agents × models`.
- **Note:** `UQ_AiSpend_Bucket` on nullable columns — SQL Server treats a single NULL as unique only once, so two rows where `(AgentName=NULL, Model=NULL)` cannot both exist. The header comment (line 60) acknowledges this. Inserts that race the "aggregate row" path will violate the unique. Need MERGE or a hash-of-keys column to enforce uniqueness across NULLs reliably.

---

## Cross-cutting issues

### 1. Missing FK constraints
- `dbo.DriverLocationHistory.RunId` — declared `INT NULL`, **no FK** (`003_gps_tracking.sql:27`). Orphan history possible.
- `dbo.AuditLog.EntityId` — by design generic, no FK. Acceptable, but no integrity guarantee anywhere.
- `dbo.AuditLog.UserId`, `dbo.DeliveryRuns.CreatedBy`, `dbo.PickingWaves.PickedBy`, `dbo.StopFailures.ResolvedByUserId` — all declared `INT NULL` with **no FK to `dbo.Users`**. Deleting a user leaves dangling references.
- `dbo.NotificationLog.RelatedEntityId` — generic, no FK. Acceptable.
- `dbo.AlertSubscriptions.UserId` — has FK ✓ but cascade behavior is unspecified (default NO ACTION). Deleting a user with subscriptions will throw a runtime error rather than tidy up.
- `dbo.Insights.AgentRunId` — soft UUID pointer to an INT identity; cannot be FK'd, **and the data types are incompatible** (real bug, see migration 010 entry above).

### 2. Soft-delete vs hard-delete inconsistencies
- `Drivers`, `Users`, `Zones`, `FailureReasons`, `Companies` use **`IsActive BIT`** soft-delete pattern.
- `DeliveryRuns`, `RunOrders`, `ReturnRequests` rely on **`Status='CANCELLED'`** as a soft-delete signal.
- `DeliveryStops` uses a `Status='SKIPPED'` enum — different verb again.
- `TrackingTokens`, `NotificationLog`, `DriverLocationHistory`, `AuditLog`, `SapRetryQueue` are **hard-deleted** by `cleanupWorker.js` after a retention window.
- `IntelligenceEvents`, `Insights`, `Alerts`, `AiSpendBudget` declare `RetainUntil` / `ArchivedAt` columns but **no worker actually archives or deletes them**.

There is no documented policy. A planner cannot tell whether they're allowed to physically delete a row or whether soft-delete is required. Recommend: explicit `DeletedAt DATETIME2 NULL` column or formal status enum, with a single project-wide convention.

### 3. Timestamp / timezone hygiene
- All `DATETIME2` columns default to `SYSUTCDATETIME()` (good). Migration 009/010/011/012 use `DATETIME2(3)` (3-decimal precision). Migrations 001–008 use `DATETIME2` (default 7-decimal). Mixed precision across the schema means comparisons across tables can have rounding artifacts.
- `dbo.NormalizedAddresses.DeliveryWindowStart/End` are **`TIME` with no timezone**. When daylight-saving shifts in Israel (Asia/Jerusalem), a 9:00 window stored naively can be off by an hour against UTC ping data. There's no `IANA_TimeZone` column anywhere.
- `dbo.AgentRuns.StartedAt` and `FinishedAt` are server-time UTC ✓; `DurationMs` is computed and stored — risk of drift if the row is updated post-hoc.
- `dbo.Insights.UpdatedAt` and `dbo.Alerts.UpdatedAt` are set on insert but **no trigger or app-level enforcement** updates them. They will lie.

### 4. Migration system robustness — `backend/src/db/migrate.js`

**What it does correctly:**
- `_Migrations` table tracks `Filename` + `AppliedAt` (lines 33-42).
- Files are sorted alphabetically and run in order (line 84).
- Already-applied files are skipped (line 88).
- `GO` separators are correctly split client-side (lines 51-54).

**Where it breaks:**
- **No transaction per migration.** Each batch in a file runs in its own auto-commit (`migrate.js:57`). If migration 003 has 5 batches and batch 3 fails, batches 1–2 are already committed and `_Migrations` does NOT get the row. Re-running will re-execute the partial migration — **the `IF NOT EXISTS / IF NOT EXISTS (sys.columns)` guards in 001–008 mostly save us, but 002 (seed data) and 006 (UPDATE Companies) are NOT idempotent against partial state.**
- **No checksum.** A migration file edited after-the-fact is not detected; the runner trusts the filename. Recommend adding a hash column to `_Migrations`.
- **No down-migration support.** Rollback files exist (009–012) but the runner has no command to apply them. They have to be invoked manually with `sqlcmd` — easy to forget which one matches the head of `_Migrations`.
- **Hardcoded post-migration password reset** (lines 100-105) lives outside the migration system. If the seed step in migration 002 is ever changed, this update may silently match nothing.
- **Master-DB CREATE DATABASE is not transactional with the migration table.** A crash between line 73 (close master) and line 78 (`ensureMigrationTable`) leaves an empty DB and no migration history.
- Logger output uses emojis `▶`, `✓`, `⏭` (lines 89-95). On Windows console code page 437/1252 these can throw. Cosmetic.

### 5. Rollback files vs. forward migrations

- **001–008 have NO rollback files.** Production has no documented down-path for the entire core schema. Restore-from-backup is the only option.
- **009_rollback.sql** (line 8): `DROP TABLE dbo.IntelligenceEvents;` — destroys all event data. The forward migration creates the table and 8 indexes. The rollback drops the table, which implicitly drops the indexes. Functionally reverses, but **data loss is silent**. The header line 4-5 says "PRIMARY rollback path: restore from BACKUP DATABASE" — at least it admits this, but operators reading the file name "rollback" may run it without realizing.
- **010_rollback.sql / 011_rollback.sql / 012_rollback.sql** — same pattern: a single `DROP TABLE`. Functionally reverses the forward migration's `CREATE TABLE` since no other object referenced these tables, but again destroys data.
- **None of the rollbacks remove the row from `dbo._Migrations`.** Operators who run `011_rollback.sql` will find re-running migrate.js does NOT re-apply `011_alerts.sql` because the runner still believes it's applied. Manual intervention required. This should be automated.

### 6. OLTP/OLAP boundary — global concern

The same SQL Server instance/DB hosts:
- High-frequency OLTP writes: `DeliveryStops`, `RunOrders`, `DriverLocationHistory`, `IntelligenceEvents`, `AgentRuns`/`AgentToolCalls`.
- Aggregate reads: `services/analytics.js`, `services/reports/exceptions.js`, `services/davoMix.js`, dashboard widgets in `analytics.js:184-193`.

There is **no read replica, no readable secondary, no Snapshot Isolation / RCSI flag** documented in the migration set, and **no aggregate / mart tables** for the dashboard. Every dashboard refresh walks the live transactional tables.

Recommended near-term: enable `READ_COMMITTED_SNAPSHOT ON` on `SAP_Logistics_Hub` (single ALTER DATABASE) so dashboard reads stop blocking dispatcher writes. Medium-term: precomputed daily aggregates in a `dbo.DailyRunSummary` aggregate table refreshed by a scheduled job.

### 7. Identity column sizing
- `AuditLog.AuditId BIGINT` ✓
- `DriverLocationHistory.HistoryId BIGINT` ✓
- `NotificationLog.LogId BIGINT` ✓
- `SapRetryQueue.QueueId BIGINT` ✓
- `AgentRuns.RunId INT` ✗ — should be BIGINT given LLM cost-tracker volume
- `AgentToolCalls.ToolCallId INT` ✗ — same

### 8. Storage of large JSON blobs
- `AuditLog.OldValue / NewValue NVARCHAR(MAX)`, `AgentRuns.Messages / Output NVARCHAR(MAX)`, `IntelligenceEvents.Payload NVARCHAR(MAX)`, `Insights.Body / SourceEvents NVARCHAR(MAX)`, `Alerts.EventIds NVARCHAR(MAX)`.

These are **stored in-row up to ~8KB then off-row to LOB pages**. None of these tables are using `TEXTIMAGE_ON [filegroup]` to keep LOB on a separate filegroup. Once the LOB pages dominate, full-table reads (e.g. analytics) get slow even when they don't read the LOB columns. Move LOBs to a dedicated filegroup, or normalize into a side table referenced by FK.

### 9. Security/PII surface
- `Drivers.PasswordHash`, `Users.PasswordHash` — bcrypt, OK.
- `NormalizedAddresses.ContactPhone / ContactEmail` — PII, no encryption-at-rest column, no key references. SQL Server's TDE is configured at DB level — not visible from migrations.
- `IntelligenceEvents.Payload` may carry PII from Facebook mentions per migration 009 header. No retention default (`RetainUntil` is `NULL` for new rows — meaning "retain forever"). GDPR risk.

---

## Recommended near-term fixes (ranked)

1. **Enable RCSI** on `SAP_Logistics_Hub`: `ALTER DATABASE SAP_Logistics_Hub SET READ_COMMITTED_SNAPSHOT ON`. Single biggest win for the OLTP/OLAP collision.
2. **Wrap each migration in a transaction in `migrate.js`** and add a SHA-256 checksum column to `_Migrations`.
3. **Add the missing FK-column indexes** on hot tables: `ReturnRequestLines.ReturnId`, `StopFailures.StopId`, `StopFailures.ReasonCode`, `CustomerAddressLinks.AddressId`, `NormalizedAddresses.ZoneId`, `PickingAllocations.RunOrderId`.
4. **Fix `Insights.AgentRunId` type mismatch** — either change `AgentRuns.RunId` to UUID (breaking) or change `Insights.AgentRunId` to INT (recommended).
5. **Promote `AgentRuns.RunId` and `AgentToolCalls.ToolCallId` to BIGINT** before production volume hits.
6. **Wire archival workers for `IntelligenceEvents`, `Insights`, `AgentRuns`** — the columns exist, the workers don't. Today these are unbounded.
7. **Batch the cleanup deletes in `cleanupWorker.js`** with `WHILE … DELETE TOP (5000)` loops to avoid lock escalation.
8. **Replace random-GUID clustered keys** on `Insights`, `Alerts`, `AiSpendBudget` with an INT/BIGINT identity clustered key + nonclustered unique on the GUID.
9. **Document and enforce a soft-delete convention** project-wide.
10. **Define partition function + scheme for `IntelligenceEvents`** (the schema is already partition-ready) before the table crosses ~10M rows.

---

## File reference quick-index
- Core schema: `database/migrations/001_initial_schema.sql`
- Seeds: `database/migrations/002_seed_data.sql`
- GPS + retry queue: `database/migrations/003_gps_tracking.sql`
- Failures + portal + alerts subs: `database/migrations/004_failures_and_portal.sql`
- Settings KV: `database/migrations/005_system_settings.sql`
- Company DB rename: `database/migrations/006_oig_company_mapping.sql`
- Time windows / contact PII: `database/migrations/007_time_windows.sql`
- Agent observability: `database/migrations/008_agent_runs.sql`
- Cross-app event bus: `database/migrations/009_intelligence_events.sql`
- Synthesized insights: `database/migrations/010_insights.sql`
- Alert dedup: `database/migrations/011_alerts.sql`
- LLM cost budget: `database/migrations/012_ai_cost_budget.sql`
- Migration runner: `backend/src/db/migrate.js`
- Pool / query helpers: `backend/src/db/logisticsDb.js`
- Cleanup worker (retention): `backend/src/workers/cleanupWorker.js`
- Hot-path consumers: `backend/src/services/analytics.js`, `services/deliveryRuns.js`, `services/failures.js`, `services/gpsTracking.js`, `services/auditLog.js`
