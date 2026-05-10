# System Overview — SAP Logistics / BI Hub

**Scope:** Production-grade architecture review, generated 2026-05-09.
**Repository root:** `sap-logistics-hub/`
**Stack:** Node.js 20+ (ESM), Express 4, mssql, Socket.IO, PM2, React 18 + Vite + Tailwind, Anthropic SDK.
**Deployment:** Single Windows host, PM2 managed (`ecosystem.config.cjs`), Cloudflare Quick Tunnel for public ingress.

> **Naming note.** The codebase started as a "logistics planning" hub (delivery runs, returns, drivers) but has grown into a full BI / financial-analytics platform: DAVO product-mix tracking, customer profitability, anomaly detection, daily CEO brief, weekly executive reports, financial dashboards. This document treats it as one system because it ships as one process.

---

## 1. High-level architecture

```
                   ┌────────────────────────────────────────┐
                   │  Browser (React SPA, Vite-built)       │
                   │  - Planner / Wallboard                 │
                   │  - Executive / Sales / Finance dashb.  │
                   │  - Driver mobile (PWA) — same bundle   │
                   └──────┬───────────────────┬─────────────┘
                          │ REST              │ WebSocket
                          │ (Bearer JWT)      │ (Socket.IO, JWT in handshake)
                          ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Node.js process (PM2 single instance, fork mode, port 4000)      │
│                                                                   │
│  Express app (server.js)                                          │
│   ├─ helmet (CSP) + cors (env CORS_ORIGINS)                       │
│   ├─ /api/* route files (22 mounted, all *behind* requireAuth     │
│   │   except /api/auth/login and /api/public/track)               │
│   ├─ /uploads/* static (signatures/photos, public, immutable 7d)  │
│   ├─ Frontend served from frontend/dist when NODE_ENV=production  │
│   ├─ Socket.IO server (cors:'*' — production gap, see security)   │
│   └─ Same-process workers (5 schedulers — see §3.2)               │
│                                                                   │
│  Service layer                                                    │
│   ├─ services/sap/*       — SAP SQL reader, Service Layer client  │
│   ├─ services/analytics.js — Logistics-DB KPIs                    │
│   ├─ services/davoMix.js   — Product-mix / DAVO BI                │
│   ├─ services/reports/*    — PDF generation (driver, picking)     │
│   ├─ services/notifications, customerComms — SMTP / SMS stub      │
│   └─ services/auditLog, fileStorage, trackingTokens               │
│                                                                   │
│  Intelligence / AI                                                │
│   ├─ agents/runtime.js     — Anthropic tool-use loop              │
│   ├─ agents/ceoBrief.js    — Daily CEO Brief agent                │
│   ├─ agents/tools/*        — financial tools exposed to LLM       │
│   └─ lib/intelligence/*    — eventBus, eventStore (no-op),        │
│                              alertGuard (dedup), aiCostGuard      │
│                              (Phase-1 stub, no enforcement)       │
└────┬─────────────────────────────┬─────────────────────────┬─────┘
     │                             │                         │
     ▼                             ▼                         ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌────────────────────┐
│ Logistics DB        │   │ SAP Business One    │   │ Anthropic API      │
│ (MS SQL Server,     │   │ - SQL Server (read) │   │ (Sonnet 4.5)       │
│  ~30 tables)        │   │   ORDR, OINV, INV1, │   │                    │
│ - operational       │   │   OITM, OCRD, ODLN  │   │  agents/runtime.js │
│ - DeliveryRuns,     │   │ - Service Layer     │   │  no cost ceiling,  │
│   Stops, Returns    │   │   (HTTPS/JSON, write│   │  no rate limit     │
│ - Audit, GPS, Alerts│   │   delivery notes,   │   │                    │
│ - AgentRuns/Tools   │   │   return requests)  │   │                    │
└─────────────────────┘   └─────────────────────┘   └────────────────────┘
                          (companies A + B, isolated DBs per company)

External: SMTP (Nodemailer), SMS (provider stub: 'none'/twilio/inforu/019),
           Cloudflare quick-tunnel (cf-tunnel.log evidence — see security).
```

**Key topology facts**
- One Node process owns: REST API + WebSocket + 5 cron workers + LLM agent runtime + frontend serving. PM2 `instances: 1, exec_mode: 'fork'`. There is no horizontal scale path today.
- Two databases: own **Logistics DB** (writable) and **SAP Business One SQL** (read-only for analytics; SAP writes go through Service Layer HTTPS).
- SAP credentials are *optional at startup*. The Hub starts even without SAP and `sapConfigured` flag drives runtime fallbacks (`config/env.js:123-128`).

---

## 2. Data flow

### 2.1 Operational write path (driver completes a stop)

```
Driver PWA
  → POST /api/driver/stops/:id/deliver
     (driver JWT, 7d TTL)
  → routes/driver.js
  → services/deliveryNotes.createDeliveryNoteForOrder(runOrderId)
       1. Check RunOrders.SapDeliveryDocEntry IS NULL  ← idempotency guard
       2. Build SAP DLN payload (lines from RunOrders + RunOrderItems)
       3. POST /b1s/v2/DeliveryNotes  (Service Layer)
       4. UPDATE RunOrders SET SapDeliveryDocEntry = X  ← single row UPDATE
       5. Insert into AuditLog
  → Socket.IO emit to room 'planner'
  → If step 3 fails: enqueue SapRetryQueue, worker retries (5 attempts)
```

> **Risk surfaced in sync-analysis.md:** steps 3 + 4 are *not* in a transaction. Process death between them = duplicate SAP delivery note on next sync. No idempotency token sent to SAP.

### 2.2 BI / KPI read path (Wallboard refresh, 5s polling)

```
Browser (TanStack Query, 5s refetch)
  → GET /api/analytics/dashboard-summary
  → routes/analytics.js
  → services/analytics.js  — 6 COUNT(DISTINCT) queries, no cache
       - Logistics DB: open runs, stops by status, today's deliveries, exceptions
  → Returns JSON
```

KPI flow has *no caching layer*. Every refetch from every browser hits the DB. See `kpi-analysis.md` and `performance-analysis.md` for the 60+ raw queries per CEO brief.

### 2.3 BI sync flow

There is no incremental sync into a warehouse. All BI is **query-time on SAP SQL**:

```
Browser (DAVO Mix / Customer Profitability / Top items)
  → GET /api/davo-mix/buyers
  → routes/davoMix.js
  → services/davoMix.js
  → services/sap/sqlReader.js  — direct mssql query into SAP company A DB
       SELECT … FROM OINV o JOIN INV1 l JOIN OITM i WHERE DocDate >= …
       (7 OR'd LIKE patterns to classify mixers vs non-mixers — full scan)
  → JSON straight back to client
```

There is **no Logistics-side aggregate** of SAP data. No watermark, no change tracking, no nightly rollup. Every viewer recomputes from raw SAP rows.

---

## 3. SAP sync flow

### 3.1 Read paths

| Path | File | Mechanism | Use |
|------|------|-----------|-----|
| SAP SQL | `services/sap/sqlReader.js` | mssql connection pool, parameterized queries | Heavy analytics: DAVO mix, financial reader, customer profitability, dead stock, churn risk |
| SAP Service Layer (read) | `services/sap/serviceLayer.js` | HTTPS + cookie session | Lightweight reads (status checks, BP info, item lookup) |

Per-company SAP SQL pools are created lazily, one per company (A, B). Service Layer sessions are cached per company with timeout-based renewal.

### 3.2 Background workers (all in-process, all node-cron / setInterval)

| Worker | File | Schedule | Purpose |
|---|---|---|---|
| SAP sync retry | `workers/sapSyncWorker.js:218` | `setInterval` 30s | Retry failed Delivery Notes, Return Requests, and `SapRetryQueue` jobs (5-attempt exp backoff: 1m → 5m → 15m → 1h → 4h → `FAILED_PERMANENT`). |
| Daily digest | `workers/dailyDigestWorker.js` | node-cron daily | Email summary of yesterday's runs / failures. |
| Cleanup | `workers/cleanupWorker.js` | node-cron daily | Hard-delete old GPS pings + uploads. **Does not touch** AgentRuns/Insights/Alerts/IntelligenceEvents — see prisma-analysis. |
| CEO Brief scheduler | `workers/ceoBriefScheduler.js` | env `CEO_BRIEF_CRON` (default `0 7 * * *`), gated on `CEO_BRIEF_SCHEDULE_ENABLED` | Triggers `agents/ceoBrief.js` daily; sends email. |
| DAVO Mix weekly report | `workers/davoMixReportScheduler.js` | env `DAVO_MIX_REPORT_CRON` (default Sunday 08:00), gated on `DAVO_MIX_REPORT_ENABLED` | Email weekly DAVO product-mix report. |

**Multi-instance safety: none.** All schedulers use plain `setInterval` / `node-cron`. PM2 cluster mode with N>1 instances would fire each job N times (see sync-analysis §6).

### 3.3 Write paths into SAP

- **Delivery Note:** `services/deliveryNotes.js` → `serviceLayer.createDeliveryNote()` (called by `routes/driver.js` on stop completion + by `sapSyncWorker.retryDeliveryNotes`).
- **Return Request:** `services/returnRequests.js:markReturnPickedUp()` → `serviceLayer.createReturnRequest()`.

Both are non-transactional with respect to the Logistics DB row that records the resulting `DocEntry`. See `sync-analysis.md` §3 for the duplicate-document scenario.

---

## 4. Queue architecture

There is **no real queue** (no Bull/BullMQ/Redis/SQS). The only queue is a SQL table:

- `SapRetryQueue` — written by `sapSyncWorker.enqueue()`, polled every 30s by `processRetryQueue()` (`sapSyncWorker.js:134`).
- States: `PENDING` → `SUCCESS` | `FAILED_PERMANENT`.
- No DLQ workflow, no admin UI, no metrics, no alerting on `FAILED_PERMANENT` row count.
- Polling uses `SELECT TOP 10 … WHERE Status='PENDING' AND NextAttemptAt <= now ORDER BY NextAttemptAt` — no row-level lock, no two-instance safety.

For LLM agent jobs there is no queue at all — `POST /api/agents/ceo-brief/run` blocks the HTTP request for the entire tool-use loop (potentially 30+ seconds, capped at `AGENT_MAX_TOOL_CALLS=8`).

For real-time push, Socket.IO is single-instance (no Redis adapter) — see performance-analysis §8.

---

## 5. Auth / RBAC flow

```
Login                                  Driver login (auto-link via short URL)
─────                                  ─────────────────────────────────────
POST /api/auth/login                   POST /api/auth/driver-login
  { username, password }                 { driverPhone, code }
  → bcrypt compare                       → lookup Driver
  → signToken({ sub, role, name })       → signDriverToken({ sub:'driver-N',
    8h TTL, aud + iss claims               role:'DRIVER', driverId }) 7d TTL
  → returns { token, user }              → returns { token, driver }
       │                                       │
       ▼                                       ▼
   Bearer header on every REST + Socket.IO handshake auth
       │
       ▼
   middleware/auth.js
     requireAuth   — verifies signature, optional aud/iss in lax mode
     requireRole(...roles) — coarse-grained role gate
```

**Roles seen in code**: `ADMIN`, `PLANNER`, `WAREHOUSE`, `DRIVER`, plus implicit `CEO`/viewer use through ADMIN.

**RBAC reality (see security-analysis.md):**
- 22 route files mounted. All except `/api/auth` and `/api/public/track` go through `requireAuth`.
- `requireRole` is applied inconsistently. Many routes accept *any* authenticated user — including a DRIVER token — and return finance, customer, audit, or other-driver data.
- No per-row ownership checks on driver routes (`routes/driver.js`) — a driver token can mark *any* stop delivered.
- JWT revocation: none. 7-day driver tokens cannot be invalidated.

Socket.IO auth re-uses the same JWT but with a **`cors: { origin: '*' }`** comment-flagged TODO (`sockets/index.js:16`).

---

## 6. KPI computation flow

```
                    ┌─────────────────────────────────────────────┐
                    │   Frontend pages / panels                   │
                    │   - DashboardPage / WallboardPage           │
                    │   - AnalyticsPage / WeeklyReportPage        │
                    │   - DavoMixPage / CustomerProfitabilityPage │
                    │   - StockPredictionPage / AnomaliesPage     │
                    │   - DriverLeaderboardPage / DailyClosure    │
                    │   - CashOnDeliveryPage                      │
                    └────────────────┬────────────────────────────┘
                                     │ HTTP fetch (TanStack Query, 5-30s)
                                     ▼
        ┌────────────┬─────────────────┬───────────────┬─────────────┐
        │            │                 │               │             │
        ▼            ▼                 ▼               ▼             ▼
  /api/analytics  /api/davo-mix  /api/reports   /api/agents     (legacy)
        │            │                 │               │      demo/demoServer
        ▼            ▼                 ▼               ▼          (NOT mounted,
   services/      services/      services/        agents/         but logic still
   analytics.js   davoMix.js     reports/*        ceoBrief.js     leaks via copy-
        │            │                 │               │          paste — see
        ▼            ▼                 ▼               ▼          kpi-analysis)
   Logistics DB    SAP SQL       Logistics DB    SAP SQL via
   (own tables)    (OINV/INV1/   + SAP SQL       agents/tools/
                    OITM/OCRD)                   financialTools.js
```

**No semantic layer.** No dbt model, no Cube.js, no SQL views. Each KPI is hand-coded in JS.

**Observed problems** (full breakdown in `kpi-analysis.md`):
- "Revenue" has 3 incompatible definitions across services (`OINV.DocTotal` gross, `INV1.LineTotal` net, open-order `DocTotal` pipeline). CEO brief and DAVO weekly report disagree by ~17% VAT on the same period.
- "Success rate" computed two ways (whether PARTIAL counts).
- Driver score formula duplicated between `frontend/.../DriverLeaderboardPage.jsx:170` and `backend/.../persistentStore.js:863`.
- Some KPIs in `routes/orders.js stats` are **fabricated** with `Math.ceil(totalOpen*0.8)` and shipped to the UI as real numbers.

---

## 7. Caching strategy

**There isn't one.** Confirmed during analysis:

| Layer | Cache present? |
|---|---|
| Browser (TanStack Query) | Default in-memory, with 5s refetch on Wallboard. No `staleTime` tuning seen. |
| HTTP / CDN | None. No `Cache-Control` on JSON responses (only on `/uploads/* maxAge:7d`). |
| App-level in-process | None — no LRU, no TTL cache. Service-Layer session is cached per company (only thing). |
| Redis / external | Not deployed. No Redis client in `package.json`. |
| Database materialized views | None. Migrations create only base tables. |
| Aggregate / rollup tables | None. Every BI metric is recomputed from raw on each request. |

The architecture diagram in `README.md` mentions "Real-Time Dashboard live updates" — implemented as polling + Socket.IO event broadcast, not push-driven materialized views.

---

## 8. Alerting flow

```
Operational events                Anomaly detection           AI cost
──────────────────                ──────────────────          ───────
RunOrder DELIVERED                analytics anomaly          aiCostGuard.js
RunOrder FAILED                   detection paths            (Phase-1 stub —
Return PICKED_UP                  in services/analytics       returns
SAP retry FAILED_PERMANENT        and AnomaliesPage           'phase1_no_enforcement')
       │                                  │                          │
       ▼                                  ▼                          ▼
   AuditLog table                Insights table              No actual budget
   (services/auditLog.js)        (migration 010)             enforcement; spend
       │                          Alerts table                 is recorded but
       ▼                          (migration 011)             not blocked
   Socket.IO broadcast           lib/intelligence/
   to 'planner' room              alertGuard.js (dedup
                                  by AlertKey hash)
                                          │
                                          ▼
                                  Email via notifications.js
                                  (SMTP) — depending on env
```

**Reality check:**
- `lib/intelligence/eventStore.js:42-49` is a no-op returning `{ stored: false }` — the entire `IntelligenceEvents` pipeline is wired but inert pending migration that's been applied but downstream consumers not connected.
- `alertGuard` exists with proper dedup logic but is referenced from few places.
- SMS provider in `notifications.js:38-49` is `console.log` stub, returns success.
- SAP retry permanent failures are *not* alerted to a human channel — they sit in `SapRetryQueue.Status='FAILED_PERMANENT'` with no UI surface.

---

## 9. AI / LLM integration flow

```
Trigger                                Runtime                                  Output
───────                                ───────                                  ──────
POST /api/agents/ceo-brief/run         agents/runtime.js runAgent({...})        AgentRuns row
   (ADMIN token)                          │                                     (Messages JSONB-ish blob,
       OR                                  ├─ Anthropic tool-use loop:           tokens in/out, cost USD)
   ceoBriefScheduler cron tick             │   - System prompt (Hebrew)         AgentToolCalls rows
       │                                  │   - User msg with date scope        Optional: email send
       ▼                                  │   - Tools from financialTools.js
   agents/ceoBrief.js                     │     (get_daily_sales, get_top_items,
       │                                  │      get_margin_by_item, get_top_
       │                                  │      customers, get_dead_stock, …)
       │                                  │   - Each tool runs a SAP SQL query
       │                                  │     and returns JSON to model
       │                                  │   - Loop up to AGENT_MAX_TOOL_CALLS=8
       │                                  │   - submitTool forces final
       │                                  │     structured JSON output
       │                                  └─ Cost computed from token usage,
       │                                     hardcoded Sonnet 4.5 pricing
       │                                     (runtime.js:22-28). NO budget gate.
       ▼
   Generated brief in Hebrew → sent over SMTP
```

**Risks (full detail in security-analysis.md and tech-debt):**
- No cost ceiling at runtime. `aiCostGuard.checkBackpressure` exists but returns Phase-1 stub.
- Agent runtime executes SAP SQL on behalf of the LLM. Tool inputs are validated by JSON Schema, but the model controls *which* tool runs *with what date range*; a runaway loop could full-scan years of SAP data. Mitigated only by `AGENT_MAX_TOOL_CALLS=8`.
- `AgentRuns.Messages` blob grows unbounded; no retention worker covers it.
- `AgentRunId` in `Insights` table is `UNIQUEIDENTIFIER` but `AgentRuns.RunId` is `INT IDENTITY` — joins are physically impossible (see prisma-analysis #2).

---

## 10. Cross-cutting summary

| Concern | Status today | Source of detail |
|---|---|---|
| Schema | ~30 tables, no semantic layer, OLTP+OLAP collision in same DB | `prisma-analysis.md` |
| Sync | No incremental, no reconciliation, duplicate-document risk on writes | `sync-analysis.md` |
| KPIs | 46 metrics, no governance, multiple revenue definitions, fabricated numbers | `kpi-analysis.md` |
| Security | Permission to-DRIVER role over-grants reads; Socket.IO `cors:'*'`; TLS cert validation off; cf-tunnel quick-URL committed in repo | `security-analysis.md` |
| Performance | No caching, single 10-conn pool for everything, query-time KPIs, full table scans | `performance-analysis.md` |
| Tech debt | Monolith owns SAP ETL + API + workers + AI + frontend serving; SMS stub; eventStore no-op; pending migrations live in code | `technical-debt.md` |

**One-line takeaway:** the system works, but every load-bearing assumption — single instance, query-time analytics, optional SAP, in-process workers, no caching, no real queue — is currently absorbing growth that this stack will stop tolerating soon.
