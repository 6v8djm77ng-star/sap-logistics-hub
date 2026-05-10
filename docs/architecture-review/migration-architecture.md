# Migration Architecture — `demoServer.js` → `server.js`

Companion to `cutover-plan.md`. Defines the target architecture, what stays, what moves, what dies, and how to eliminate `demoServer.js` safely.

References (this document depends on):
- `demo-server-root-cause.md` — why demoServer is currently running
- `route-matrix.md` — which endpoints exist where
- `store-json-analysis.md` — what data needs to migrate
- `security-analysis.md` — anonymous-route exposures that close on cutover
- `sync-analysis.md` — SAP-write idempotency model that needs to apply

---

## 1. Target architecture (post-migration)

```
                                  ┌────────────────────────────────────┐
                                  │  Browser SPA (frontend/dist)       │
                                  │  - Planner / Wallboard / Picker    │
                                  │  - Driver PWA / Documents / DAVO   │
                                  └──────┬───────────────────┬─────────┘
                                         │ REST (Bearer JWT) │ Socket.IO
                                         │                   │ (JWT in handshake,
                                         │                   │  CORS allow-list)
                                         ▼                   ▼
       ┌───────────────────────────────────────────────────────────────────┐
       │  PM2 app: sap-logistics                                           │
       │  Entry: backend/src/server.js   (single source of truth)          │
       │                                                                    │
       │  Express middleware chain                                          │
       │  - helmet (CSP)   - cors (env.CORS_ORIGINS)   - compression       │
       │  - express.json (2 MB)   - morgan + apiLogger                     │
       │                                                                    │
       │  /api/* routers (single-file each, all behind requireAuth         │
       │   except /api/auth/login + /api/auth/driver-login + /api/public)  │
       │  ┌──────────────────────────────────────────────────────────────┐ │
       │  │  routes/auth, users, settings, addresses                     │ │
       │  │  routes/zones, drivers, pickers ← NEW                        │ │
       │  │  routes/runs, stops ← NEW (split out)                        │ │
       │  │  routes/picking ← EXTENDED (scan/QC/shortage)                │ │
       │  │  routes/driver, tracking, reports, audit                     │ │
       │  │  routes/customers, customerPolicy ← NEW                      │ │
       │  │  routes/orders, returns, failures                            │ │
       │  │  routes/cod ← NEW                                            │ │
       │  │  routes/documents ← NEW (DN/Invoice list, generate, confirm) │ │
       │  │  routes/sap ← keeps diagnose; SAP-write moves to documents   │ │
       │  │  routes/analytics ← EXTENDED (anomalies, profitability,      │ │
       │  │                       stock-prediction, driver-perf)         │ │
       │  │  routes/davoMix, agents                                      │ │
       │  │  routes/trackPublic                                          │ │
       │  │  routes/notify ← NEW (ETA SMS)                               │ │
       │  └──────────────────────────────────────────────────────────────┘ │
       │                                                                    │
       │  Background workers (5)                                           │
       │  - sapSyncWorker  - dailyDigestWorker  - cleanupWorker            │
       │  - ceoBriefScheduler  - davoMixReportScheduler                    │
       │                                                                    │
       │  Service layer                                                     │
       │  - services/sap/{sqlReader, serviceLayer}  (production)            │
       │  - services/{analytics, davoMix, customerComms, gpsTracking,       │
       │    notifications, fileStorage, deliveryRuns, deliveryNotes,        │
       │    returnRequests, wavePicking, addressNormalizer, …}              │
       │  - services/reports/{driverManifest, pickingList, exceptions,      │
       │    + new: distributionSummary, loadingManifest, deliveryNotesXlsx, │
       │           invoicesXlsx, bulkManifest}                              │
       │  - services/cod ← NEW                                              │
       │  - services/documents ← NEW (replaces demo/sapWriter)              │
       │  - services/customerPolicy ← NEW                                   │
       │  - services/zoneAssignment ← NEW (city → zone)                     │
       │  - services/sapWriter ← unified, idempotent (replaces demo's)      │
       │                                                                    │
       │  Data layer                                                        │
       │  - db/logisticsDb.js  (mssql pool — single source for state)      │
       └──────┬───────────────────────────────┬────────────────────────────┘
              │                               │
              ▼                               ▼
   ┌──────────────────────┐    ┌────────────────────────────┐
   │  Logistics DB        │    │  SAP Business One           │
   │  (MS SQL Server)     │    │  - SQL Server (read-only)   │
   │  Tables:             │    │    OINV, INV1, OITM, OCRD,  │
   │  - existing 001-008  │    │    ORDR, ODLN, …            │
   │  - existing 009-012  │    │  - Service Layer (writes)   │
   │  - NEW (this plan):  │    │    DeliveryNotes, Returns,  │
   │    DeliveryNotes,    │    │    Invoices                 │
   │    Invoices,         │    │  - 2 companies (A, B)       │
   │    Pickers,          │    └────────────────────────────┘
   │    CodCollections,   │
   │    CityZoneOverrides,│
   │    CustomerPolicies, │
   │    CustomerHours,    │
   │    LineDeliveries,   │
   │    DriverStats       │
   └──────────────────────┘

   demo/* directory  → DELETED after cutover (kept on a tag for rollback)
   data/store.json   → archived; never read again by server.js
```

The target is a **single-process, single-source-of-truth, zero-anonymous-route** architecture. Every route enforces auth+role. Every mutation persists to MS SQL. demoServer's in-memory state, inline routes, and synthetic GPS simulator all disappear.

---

## 2. What stays / moves / dies

### Stays unchanged
| Module | Why |
|---|---|
| `backend/src/server.js` | Already the production target |
| `backend/src/config/env.js` | Validates env; complete schema |
| `backend/src/middleware/auth.js` | Token + role gate; correctly designed |
| `backend/src/middleware/errorHandler.js` | OK |
| `backend/src/db/logisticsDb.js` | mssql pool wrapper; sound |
| `backend/src/sockets/index.js` | Already CORS-locked + JWT after F1 P0 fix |
| `backend/src/services/sap/{sqlReader,serviceLayer}.js` | Production SAP path |
| `backend/src/services/{analytics, davoMix, deliveryRuns, deliveryNotes, returnRequests, wavePicking, addressNormalizer, gpsTracking, customerComms, notifications, auditLog, fileStorage, trackingTokens, sapDiagnostic, sapSampleData, davoMixWeeklyReport, systemSettings, timeWindows, orderUnification, health, failures}.js` | Production services already implemented |
| `backend/src/workers/*.js` | All 5 schedulers are production-grade (with caveats from `sync-analysis.md`) |
| `backend/src/lib/intelligence/*.js` | Phase-1 stubs; not blocking |
| `backend/src/agents/*` | LLM agents already mounted in both servers |
| `backend/src/routes/{auth,users,settings,addresses,zones,drivers,driver,tracking,reports,audit,customers,orders,returns,failures,picking,sap,trackPublic,analytics,davoMix,agents,runs,intelligenceEvents}.js` | Existing route files; some need EXTENSION (see below) |

### Moves into routes/services (was inline in `demoServer.js`)
| Moves into | What | Source in demoServer |
|---|---|---|
| **NEW** `routes/pickers.js` + `services/pickers.js` | Picker CRUD + picker-login | `demoServer.js:91-154` (auth/login + CRUD) |
| **NEW** `routes/cod.js` + `services/cod.js` | Cash-on-delivery list, create, deposit, driver summary | `demoServer.js:991-1015` |
| **NEW** `routes/documents.js` + `services/documents.js` | Delivery notes / invoices listing, generate-invoice-from-DN, confirm-sap, mark-exported | `demoServer.js:2286-2337` |
| **EXTEND** `routes/picking.js` | Scan, QC approve/reject, line shortage/reset, allocation pick/reset, picking-waves list | `demoServer.js:2407-2536` |
| **EXTEND** `routes/runs.js` | Force-include, duplicate, split, optimize, loading-plan, approve-departure, cancel-departure, generate-invoices, run-stops POST, PATCH /:id (assign driver), DELETE | `demoServer.js:868-1308, 519, 460, 936, 952, 2296, 1212, 1281, 1242, 1220, 1235` |
| **NEW** `routes/stops.js` | Move up/down/to-run, edit, delete, line-deliveries, document-preview, generate-delivery-notes | `demoServer.js:1249-1295, 968-988, 2225, 2276` |
| **EXTEND** `routes/customers.js` | Customer policy CRUD/bulk, customer hours | `demoServer.js:327-405, 1041-1066` |
| **EXTEND** `routes/zones.js` | PATCH/:id, DELETE/:id, /cities, /cities/:city PATCH, /suggest | `demoServer.js:312-1097` |
| **EXTEND** `routes/drivers.js` | PATCH/:id, DELETE/:id | `demoServer.js:1110-1131` |
| **EXTEND** `routes/analytics.js` | /anomalies, /customer-profitability, /driver-performance, /stock-prediction, /suggest-drivers/:zoneCode | `demoServer.js:571-794, 1017-1031, 667` |
| **NEW** `routes/notify.js` | ETA SMS trigger | `demoServer.js:1651` |
| **EXTEND** `services/reports/` (5 new generators) | Bulk manifest PDF, distribution summary PDF, loading manifest PDF, picking PDF, delivery-notes XLSX, invoices XLSX | `demoServer.js:2345-3239` |
| **REPLACES `demo/sapWriter.js`** with `services/sapWriter.js` | Idempotent SAP write path with `U_HubRunOrderId` UDF (per sync-analysis recommendation 1.1) | new |

### Dies (deleted after cutover, kept on a git tag for emergency rollback)
| Dies | Why |
|---|---|
| `backend/src/demo/demoServer.js` | All routes ported; entry no longer used |
| `backend/src/demo/persistentStore.js` | All state in MS SQL |
| `backend/src/demo/liveSimulation.js` | Synthetic GPS no longer needed; real drivers post position |
| `backend/src/demo/sapBridge.js` | Replaced by `services/sap/sqlReader.js` |
| `backend/src/demo/sapWriter.js` | Replaced by `services/sapWriter.js` |
| `backend/src/demo/loadingPlanner.js` | Logic ported into a service module under `services/loadingPlanner.js` |
| `backend/src/demo/routeOptimizer.js` | Logic ported into `services/routeOptimizer.js` |
| `backend/src/demo/demoData.js` | Seed data only; replaced by SQL seed scripts (`database/migrations/002_seed_data.sql`) |
| `backend/data/store.json` | Archived to `backend/data/archive/store.json.YYYYMMDD-cutover` |
| `/api/demo/reset` route | Dev tool; never re-mounted |
| `/m/admin/:shortId` HTML credential vending page | Replaced by proper admin login flow (security gain) |
| `/api/auth/mobile-link` (POST) + `/api/auth/mobile-link/:shortId` (GET) | Replaced by signed time-limited URL or dropped if not used |

### Knock-on changes outside backend
| File | Change |
|---|---|
| `frontend/src/services/api.js` | Tighten URLs to match new patterns; ensure all PDF/XLSX URLs send `Authorization` header (not raw `<a href>`) — current latent bug per `route-matrix.md` |
| `frontend/src/pages/PickerAutoLoginPage.jsx` | If picker-login keeps the `/api/auth/picker-login` URL, no change. Otherwise update endpoint. |
| `frontend/src/components/PodCapture.jsx` | `/api/stops/:id/line-deliveries` URL preserved; only auth header behavior changes (already sends Bearer if present) |
| `ecosystem.config.cjs` | Already points at `server.js` — no change needed |
| `backend/.env` | No new keys required for the migration itself. The `SAP_WRITE_ENABLED` flag remains absent for safety until idempotent writes are proven |

---

## 3. How to unify state

State lives in two stores today: `backend/data/store.json` (demoServer) and the MS SQL Logistics DB (server.js). Server.js is the target.

### Single-pass migration (recommended)
A one-shot script reads `store.json` and INSERTs into MS SQL with deterministic IDs:

```
backend/scripts/migrate-store-to-sql.js
  → reads backend/data/store.json
  → opens db pool (env: LOGISTICS_SQL_*)
  → for each entity (in FK-safe order):
       drivers → users → zones → cityZoneOverrides → pickers
       → customerDocPolicies → customerHours
       → normalizedAddresses (synthesized from stops)
       → runs → stops → runOrders → runOrderItems
       → waves → waveLines → waveAllocations
       → deliveryNotes → invoices
       → lineDeliveries → codCollections
  → INSERT … OUTPUT INSERTED.* with WHERE NOT EXISTS clause keyed
    on natural keys (Code/Username/Phone/SapDocEntry+Company/etc.) for idempotency
  → if a foreign key target is missing, log + skip the row (don't fabricate)
  → write a JSON report: counts inserted, skipped, errors
```

Idempotency strategy per entity is the migration difficulty driver — see `store-json-analysis.md` §B.

### Data-window choice
Per `store-json-analysis.md`, write rate is ~4.5 runs/day, ~70 stops/day. To bound cutover-gap data loss to ≤1 hour:
- Run the migration script BEFORE cutover at T-60min
- Take a fresh `store.json` snapshot at T-15min and replay only the new rows

### Schema extensions required
Per `store-json-analysis.md`, 9 new tables and column extensions:

| Table | Already in SQL? | Action |
|---|---|---|
| Drivers | yes (`001`) | none — direct INSERT |
| Users | yes (`001`) | none |
| Zones | yes (`001`) | none |
| Pickers | NO | new migration `013_pickers.sql` |
| CityZoneOverrides | NO | new migration `013_city_zone_overrides.sql` |
| CustomerDocPolicies | NO | new migration `014_customer_doc_policies.sql` |
| CustomerHours | NO | new migration `014_customer_hours.sql` (combine with policies) |
| DeliveryRuns + departure approval columns | yes; needs columns `DepartureApprovedBy`, `DepartureApprovedAt`, `DepartureCanceledBy`, `DepartureCanceledAt` | new migration `015_run_departure.sql` |
| DeliveryStops | yes (`001`) | none — but needs FK from `AddressId` resolved (see `store-json-analysis.md` blocker) |
| RunOrders | yes (`001`) | none |
| RunOrderItems | yes (`001`) | none |
| PickingWaves + QC columns | yes; needs `QcApprovedBy`, `QcApprovedAt`, `QcRejectedReason` | new migration `015_qc.sql` (combine with departure) |
| PickingWaveLines | yes (`001`) | none |
| PickingAllocations | yes (`001`) | needs join during INSERT (no `RunOrderId` in store.json — keyed on `(Company, SapDocEntry, LineNum)`) |
| LineDeliveries | NO | new migration `016_line_deliveries.sql` |
| CodCollections | NO | new migration `017_cod.sql` |
| DriverStats | NO | new migration `018_driver_stats.sql` (or compute view from existing tables) |
| DeliveryNotes (Hub side) | NO | new migration `019_documents.sql` (Hub-side mirror; SAP-side stays in `ODLN`) |
| Invoices (Hub side) | NO | same migration `019_documents.sql` |

All new migrations follow the conventions in `database/migrations/001-012`. The migration runner (`backend/src/db/migrate.js`) is per `prisma-analysis.md` non-transactional and not idempotent — recommendation 1.12 — but for additive `CREATE TABLE` migrations the risk is low.

---

## 4. How to unify auth

### The two-token problem
demoServer issues legacy JWTs (no `aud`/`iss` claims). server.js's `requireAuth` accepts them in lax mode (`JWT_STRICT_VERIFY=false` default).

### Plan
1. **Pre-cutover:** keep server.js in lax mode. Tokens issued by demoServer continue to work after cutover.
2. **Cutover day:** all new logins go through `routes/auth.js` which signs with `aud`/`iss`. Active demoServer-issued tokens stay valid until expiry (8h users / 7d drivers).
3. **T+8 days:** flip `JWT_STRICT_VERIFY=true` in `.env`. Any remaining legacy tokens 401 — driver phones re-login.
4. **Per security-analysis F16 (deferred):** add `Users.TokenVersion` / `Drivers.TokenVersion` int + bump-on-password-reset in a follow-up. Out of migration scope.

### Eliminating anonymous access permanently
Every demoServer route that's currently anonymous gains `requireAuth` automatically when ported to `routes/*.js`. Specifically:
- All `/api/users` mutations → `requireRole('ADMIN')` (already in `routes/users.js`)
- All `/api/runs/*`, `/api/stops/*`, `/api/run-orders/:id` mutations → `requireRole('ADMIN','PLANNER')`
- All `/api/picking/*` flow → `requireRole('ADMIN','WAREHOUSE')` for mutations; `requireAuth` for reads
- All `/api/pickers/*` mutations → `requireRole('ADMIN')`
- `/api/cod/*` → `requireRole('ADMIN','PLANNER','DRIVER')` with ownership check on driver-deposit
- `/api/documents/*`, `/api/delivery-notes/*`, `/api/invoices/*` → `requireRole('ADMIN','PLANNER')`
- `/api/customers/policies/*`, `/api/customers/hours/*` → `requireRole('ADMIN','PLANNER')`
- `/api/zones/cities/*`, `/api/zones/:id` PATCH/DELETE → `requireRole('ADMIN')`
- `/api/drivers/:id` PATCH/DELETE → `requireRole('ADMIN')`
- `/api/analytics/*` → role:ADMIN/PLANNER (already enforced after P0 fix F6)
- `/api/notify/eta/:stopId` → `requireRole('ADMIN','PLANNER','DRIVER')` with stop-ownership check for DRIVER

### F2 ownership extends
The existing `driverOwnsEntity` helper (in `routes/driver.js` after the P0 fix) extends to:
- `/api/cod/:codId/deposit` — driver can only deposit their own collections
- `/api/notify/eta/:stopId` — driver can only ETA their own stops
- `/api/stops/:stopId/line-deliveries` (POST) — driver-only POD capture
- `/api/picking/allocations/:allocId/pick` — picker-token equivalent (introduce `pickerOwnsAllocation` helper)

---

## 5. How to eliminate `demoServer.js` safely

The deletion sequence is the LAST step. Before then, `demoServer.js` is kept as a parallel-running fallback. After cutover proves stable:

1. Move `backend/src/demo/` → `archive/demo-2026-05-09/` (out of `src/`).
2. Remove `backend/data/store.json` from runtime path; copy to `backend/data/archive/`.
3. Remove `demo/*` references from any tooling (search `package.json`, `Dockerfile`, scripts).
4. Tag the commit immediately before deletion as `pre-demo-removal-<date>` for emergency rollback.
5. `git rm -r backend/src/demo/`, commit.
6. Smoke-test full system one more time.
7. Update `cowork/INCIDENTS.md` and `cowork/TASKS.md` to mark the migration closed.

This step happens at minimum **30 days** after cutover-success — long enough that the operational worker queries (sapSync retry, dailyDigest, cleanup) have all proven correct against real DB state.

---

## 6. Out-of-scope decisions deferred

| Item | Owner | Why deferred |
|---|---|---|
| Whether to apply the 4 PENDING migrations (009-012) | Operator | Required for IntelligenceEvents/Insights/Alerts/AiSpendBudget — features not yet mounted in server.js. Independent of cutover. |
| Whether to enable `SAP_WRITE_ENABLED` post-cutover | Operations + Finance | Demo's anonymous-route exposure is gone after cutover; the gate is only "should the system actually post to SAP yet?" Tied to `sync-analysis.md` recommendation 1.1 (idempotency UDF). |
| Rotate `JWT_SECRET` (P0 D1 deferred item) | Operator | Forces re-login of every active session. Operational decision. |
| Pick one revenue definition (P0 D3) | Finance | Independent of which server runs. |
| Fix `Insights.AgentRunId` type mismatch (P0 D4) | Operator | Independent. |
| AI cost cap (P0 D5) | Cost-owner | Independent. |
| Migrate to a real read replica or warehouse | CTO | `recommendations.md` Tier 2 / 3. Not part of this migration. |

End of architecture document.
