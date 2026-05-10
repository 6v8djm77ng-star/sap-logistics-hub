# Why is `demoServer.js` running in production? — root-cause investigation

**Generated:** 2026-05-09. Read-only investigation, no code or environment changes.

**Source data:** `backend/src/server.js`, `backend/src/demo/demoServer.js` (3,427 lines), `backend/src/demo/{persistentStore,sapBridge,sapWriter,liveSimulation}.js`, `ecosystem.config.cjs`, `Dockerfile`, `docker-compose.yml`, `backend/package.json`, all `*.md` in repo root + `cowork/`, `C:\Users\izik\.pm2\dump.pm2`, `C:\Users\izik\.pm2\pm2.log`, `backend/logs/{combined,error,pm2-out,pm2-error}.log`, `backend/.env` (key-name presence only — values not read), `backend/data/store.json` (size + mtime), git log (full repo history).

---

## Executive answer

**This is an accidental regression, not a deliberate fallback.**

The "switch to `server.js`" was applied successfully on **2026-05-05 ~10:49** and ran in production for ~25 hours (10 confirmed `🚚 SAP Logistics Hub API listening` banners in `backend/logs/combined.log`, last one at 2026-05-06 00:51:10). It was then **silently reverted at 2026-05-06 22:16:31** when the PM2 daemon itself restarted (likely OS reboot or `pm2 kill`). On daemon resurrection, PM2 ran `pm2 resurrect` against `C:\Users\izik\.pm2\dump.pm2` — a snapshot whose `pm_exec_path` still pointed at `…\backend\src\demo\demoServer.js` because **`pm2 save` was never run after the 2026-05-05 switch**. Nobody re-ran `pm2 start ecosystem.config.cjs` after the daemon came back, so the demoServer.js process has been live ever since.

Both servers can boot — `server.js` is fully functional given the current `.env` and `node_modules`. There is no infrastructure block keeping demoServer in place.

But **switching today is NOT safe.** `demoServer.js` exposes ~40 endpoints that don't exist in `server.js`, and ~1.6 MB of business state lives in `backend/data/store.json` (last write 2026-05-05 09:59) — none of which has been ported to the Logistics SQL DB that `server.js` reads from. A direct switch would 404 large parts of the planner, picker, driver, and documents UIs and present an empty Logistics DB.

The good news, security-wise: the most-feared exploit (anonymous SAP writes via `POST /api/sap/write/delivery-note/:id`) is **gated by env** — `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are both absent from `.env`, so those endpoints fail closed to dry-run. Real SAP writes are not happening from demoServer today.

---

## 1. Why is `demoServer.js` running in production?

### Timeline (UTC+3)

| When | Event | Source |
|---|---|---|
| 2026-04-26 → 2026-05-04 | demoServer.js running continuously under PM2 | `pm2-out.log` lines 9–11018 ("🎬 SAP Logistics Hub - DEMO SERVER" banners) |
| 2026-05-04 23:27 | Last DEMO banner under PM2 id 6 | `pm2-out.log:11056` |
| **2026-05-05 ~10:49** | **First successful boot of `server.js`** under PM2 id 8: `🚚 SAP Logistics Hub API listening on http://localhost:4000` from `server.js:162`. Plus the env.js startup warnings — proof it's the production path | `pm2-out.log:11463`, `combined.log:76`, `pm2.log:198378–198385` |
| 2026-05-05 → 2026-05-06 06:58 | server.js up; recurring `[worker] tick failed Connection is closed` errors from `dailyDigestWorker.js` and the SAP sync worker (server.js-only code) | `error.log` |
| 2026-05-06 00:51:10 | Last `🚚` banner under id 8 | `combined.log:1846` |
| 2026-05-06 06:58:20 | Last entry in `error.log` for that worker pattern | `error.log` tail |
| 2026-05-06 ~07:00 → 22:15 | **15-hour gap** with zero `sap-logistics` events in `pm2.log` while other apps kept logging — daemon degraded or worker quiet | `pm2.log` |
| **2026-05-06 22:16:31** | **`--- New PM2 Daemon started ---`** banner. `pm2 resurrect` reads from stale `dump.pm2` (still pointing at demoServer.js). Process re-registered as id 6 (note: id changed from 8 back to 6 — fresh dump replay, not a normal restart). **No prior `Stopping app:sap-logistics` event** for this transition. | `pm2.log:226446–226449` and the daemon banner immediately preceding |
| 2026-05-06 22:16:44 | First `🎬 DEMO SERVER` banner after the gap — confirms the resurrected process is demoServer.js | `pm2-out.log:14345` |
| 2026-05-07, 2026-05-09 | Subsequent restarts all stay on demoServer.js | `pm2-out.log:14584, 15550` |
| 2026-05-09 07:34:34 | Most recent `sap-logistics` start; `restart_time: 1` (only restart in this process's history) | `pm2 jlist` from earlier in this session |
| 2026-05-09 07:41:55 | `dump.pm2` last written (`pm2 save` snapshot) — `pm_exec_path` still demoServer.js | `stat C:\Users\izik\.pm2\dump.pm2` |

### Direct evidence quotes

**`ecosystem.config.cjs:51-56`** — committed to repo, **points at server.js**:
```
name: 'sap-logistics',
// Phase 2 hardened production server — replaces ./src/demo/demoServer.js,
// which defined its own /api/users etc. routes inline without requireAuth.
// src/server.js wires every route file through the auth middleware and
// applies Helmet CSP + scoped CORS. Switched 2026-05-05.
script: './src/server.js',
```

**`C:\Users\izik\.pm2\dump.pm2`** — what PM2 actually has registered:
```
"pm_exec_path": "C:\\Users\\izik\\OneDrive - OIG\\שולחן העבודה\\cowork\\sap-logistics-hub\\backend\\src\\demo\\demoServer.js",
"name": "sap-logistics",
```

**Every other launcher in the repo points at `server.js`:**
- `Dockerfile:50`
- `backend/Dockerfile:7`
- `docker-compose.yml:23`
- `backend/package.json:5,8,9` (`"main": "src/server.js"`, `dev`, `start`)

Only the live PM2 daemon's saved state is stale.

### Was the switch deliberately reverted?

**No.** Searched for evidence and found none:
- `git log` has only 2 commits in repo history (`3f866e2` baseline + `8086cb6` test cleanup); neither touches the `script:` line as a revert.
- No "rollback", "fallback", "outage" notes in `MORNING_NOTES.md`, `NIGHT_WORK_PLAN.md`, `QUICK_START.md`, `README.md`, `cowork/INCIDENTS.md`, or `cowork/TASKS.md` referencing a server.js→demoServer rollback.
- No `pm2 stop sap-logistics` event in `pm2.log` preceding the 22:16:31 daemon restart — the new daemon just `resurrect`-ed silently.

### Was demoServer kept as a deliberate safety fallback?

**No evidence.** Zero matches for `fallback`, `safety`, `disabled`, `do not use`, `temporary`, `WIP`, `HACK` in `backend/src/demo/`, deploy scripts, or top-level `.md` files referring to keeping demoServer alive. The only related mention is `NIGHT_WORK_PLAN.md:38` — a 2026-04-23 manual-recovery hint ("if the server doesn't respond, run `node src/demo/demoServer.js`"). That's a runbook tip, not a PM2 fallback configuration. The ecosystem comment at line 52 explicitly calls demoServer the thing being **replaced**, not preserved.

### Conclusion on the "why"

**Single root cause:** the operator who applied the 2026-05-05 switch did `pm2 reload` / `pm2 restart` against the new ecosystem file but **did not run `pm2 save`** afterwards. When the PM2 daemon restarted on 2026-05-06 22:16, it resurrected from the pre-switch dump. Nobody noticed because the system kept "working" (demoServer renders the same UI, just from in-memory data).

### Items I cannot confirm

- **NOT PROVEN:** whether the 2026-05-06 22:16 daemon restart was an OS reboot vs `pm2 kill && pm2 resurrect` vs PM2 daemon crash. To confirm, would need Windows Event Viewer system-startup logs around 2026-05-06 22:15.
- **NOT PROVEN:** who triggered the 2026-05-05 10:49 switch. No interactive shell history is preserved in the project tree.
- **NOT PROVEN:** whether `pm2 save` was deliberately skipped or simply forgotten. No notes either way.

---

## 2. Differences between `server.js` and `demoServer.js`

### Imports / dependencies
- **`server.js` (184 lines):** imports 21 route files (`routes/*.js`), `middleware/auth.js`, `sockets/index.js`, 5 worker schedulers, `config/env.js` (zod-validated). Reads from `db/logisticsDb.js` (real MS SQL pool) and `services/sap/{sqlReader,serviceLayer}.js` indirectly through routes.
- **`demoServer.js` (3,427 lines):** imports `demo/{demoData,liveSimulation,sapBridge,persistentStore}.js`. The ONLY shared `routes/*` import is `routes/agents.js` mounted at `/api/agents` (`demoServer.js:3391`). Defines all other endpoints inline.
- demoServer **does not import** `db/logisticsDb.js` at all. State lives in `backend/data/store.json` (1.6 MB, last write 2026-05-05 09:59) via `demo/persistentStore.js`.
- demoServer reads SAP via `demo/sapBridge.js` (mssql, read-only) and writes via `demo/sapWriter.js` (Service Layer fetch — gated by env).

### Auth model
- **`server.js`:** every route file applies `requireAuth` (verified across all 20 mounted routers); only `/api/public/track` is anonymous (`server.js:131`). 21 routers behind `middleware/auth.js`'s `requireAuth` + `requireRole`.
- **`demoServer.js`:** uses the **same `JWT_SECRET`** (`demoServer.js:46-53`) — tokens are interchangeable. But applies **zero `requireAuth` middleware** (`grep` for `requireAuth(` in demoServer.js → zero hits). Only 3 endpoints actually require a token (return 401 if absent):
  - `POST /api/auth/mobile-link` (`demoServer.js:170,172`)
  - `GET /api/auth/me` (`demoServer.js:260`)
  - `POST /api/users/me/change-password` (`demoServer.js:265,267`)

  Every other endpoint (~140 of them) is **fully anonymous**.

### Socket.IO
- **`server.js` → `sockets/index.js`:** CORS allow-list bound to `env.CORS_ORIGINS` (after my F1 P0 fix), JWT verification on handshake, role-based room joining (planner/warehouse/driver:N).
- **`demoServer.js`:** `cors:{origin:'*'}` (`demoServer.js:57`), `io.use((s,n)=>{n();})` (`demoServer.js:3400-3403` — explicit no-op auth comment). Anyone can subscribe and receive every `io.emit(...)` payload (driver positions, customer names, run status, COD collections).

### Background jobs
- **`server.js`:** starts `sapSyncWorker`, `dailyDigestWorker`, `cleanupWorker`, `ceoBriefScheduler`, `davoMixReportScheduler` (`server.js:165-169`).
- **`demoServer.js`:** starts only `liveSimulation.js` (synthetic GPS movement every 5s; `demoServer.js:3410`). **None of the production workers run today.** That means since 2026-05-06 22:16 — for ~10 days — there has been no daily digest email, no SAP retry sync, no cleanup of unbounded tables, no CEO brief, no DAVO weekly report execution from the platform itself.

### Write operations
- **`server.js`:** real Logistics-DB writes via `db/logisticsDb.js`; real SAP writes via `services/sap/serviceLayer.js`. Both gated by `requireAuth`/`requireRole`.
- **`demoServer.js`:**
  - All editable state → `backend/data/store.json` (`persistentStore.js:64-73`).
  - SAP writes via `demo/sapWriter.js`. Two endpoints: `POST /api/sap/write/delivery-note/:id` (`demoServer.js:412`) and `POST /api/sap/write/invoice/:id` (`demoServer.js:434`). **Both anonymous.**

### Routes that exist ONLY in demoServer (~40)
Selected highlights — full table in **§4**:
- `/api/pickers/*` + `/api/auth/picker-login` (warehouse picker terminal)
- `/api/runs/:id/{loading-plan,optimize,optimize-order,wave,split,approve-departure,cancel-departure,generate-invoices,duplicate}`
- `/api/runs/auto-plan`, `/api/runs/force-include`
- `/api/stops/:stopId/{*move-up,move-down,move-to-run,orders,line-deliveries,document-preview,generate-delivery-notes}`
- `/api/cod/*` (Cash on Delivery)
- `/api/customers/{hours,policies/bulk}`, `/api/zones/{suggest,cities,cities/:city}`
- `/api/analytics/{stock-prediction,anomalies,customer-profitability,suggest-drivers/:zoneCode}`
- `/api/notify/eta/:stopId`
- `/api/{delivery-notes,invoices,documents/*}` (entire Documents Hub)
- `/api/sap/{writer/status,write/delivery-note/:id,write/invoice/:id}`
- `/api/reports/{runs/bulk-manifest.pdf,runs/:id/manifest.pdf,runs/:id/distribution-summary.pdf,runs/:id/loading-manifest.pdf,waves/:id/picking.{xlsx,pdf},delivery-notes.xlsx,invoices.xlsx}` — **every printable report**
- All `/api/picking/*` mutations beyond what `routes/picking.js` exposes (`routes/picking.js` has only 1 GET + 1 POST; demoServer has the entire scan/pick/QC flow at `demoServer.js:2407-2536`)
- `/api/auth/{mobile-link,mobile-link/:shortId}` and `GET /m/admin/:shortId` (the QR-mobile-onboarding flow)
- `/api/demo/reset` (resets all state — anonymous)

### Routes that exist ONLY in server.js
- `/api/davo-mix/*` (the entire DAVO Mix Tracker)

---

## 3. Boot / dependency status

### Does `server.js` boot today?

**Yes.** Direct evidence: it ran successfully for ~25 hours between 2026-05-05 10:49 and 2026-05-06 00:51:10 (10 startup banners in `combined.log`). No git changes have rendered it un-bootable since.

`config/env.js` will validate the env at boot. Required keys are present:

| Required | Present in `.env`? |
|---|---|
| `JWT_SECRET` | ✓ |
| `LOGISTICS_SQL_HOST` | ✓ |
| `LOGISTICS_SQL_USER` | ✓ |
| `LOGISTICS_SQL_PASSWORD` | ✓ |
| `LOGISTICS_SQL_DB` | ✓ |
| `CORS_ORIGINS` | ✓ |

Optional keys also present: `ANTHROPIC_API_KEY`, `SAP_SQL_HOST`, `SAP_SL_URL`, `SMTP_HOST`.

### What's missing (and why it doesn't block boot)

| Missing | Effect |
|---|---|
| `SAP_WRITE_ENABLED` | demoServer's anonymous SAP-write endpoints fail closed. Server.js doesn't read this env. |
| `SAP_SERVICE_LAYER_URL` | Same as above (this is what `demo/sapWriter.js` reads). Server.js uses `SAP_SL_URL` instead, which IS present. |
| `database/migrations/PENDING.md`'s 4 unapplied migrations (009-012) | `server.js` boots without them. The features they enable (`IntelligenceEvents`, `Insights`, `Alerts`, `AiSpendBudget`) are gated; the relevant route is `routes/intelligenceEvents.js`, which exists but is NOT mounted in `server.js`. |

### Crash-loop history

`backend/logs/error.log` shows recurring `[worker] tick failed Connection is closed` from `workers/dailyDigestWorker.js` and the SAP sync worker between 2026-05-05 ~10:49 and 2026-05-06 06:58:20. These are **transient mssql connection-pool errors**, not fatal — server.js stayed up across them. They do not explain the demoServer regression.

The `pm2 jlist` from earlier shows `unstable_restarts: 0` for `sap-logistics` — no crash loop.

For comparison, **`sap-bi-api` (a different PM2 app) has 23,008 restarts** — that one is genuinely crashing. Not the system under review here, but worth noting because it makes diagnosing PM2 issues on this host harder.

### `demoServer was introduced after failures` — REJECTED

demoServer existed long before server.js (the original development scaffold; see commits `3f866e2`). It was never "introduced as a fallback after server.js failed." server.js was introduced LATER (2026-05-05) to replace demoServer. demoServer was meant to be retired but the daemon snapshot regression preserved it.

---

## 4. Concrete production exposures from running demoServer

Beyond the route table above:

### Anonymous high-impact mutations exposed today
1. **User CRUD** — `POST /api/users` (1137), `PATCH /api/users/:id` (1146), `POST /api/users/:id/reset-password` (1156), `DELETE /api/users/:id` (1166). Anyone with HTTP access to port 4000 can create an admin, change any admin's password, or delete users. `store.addUser` does no auth check (`persistentStore.js`).
2. **Driver / picker / zone CRUD** — same pattern, all anonymous.
3. **Run mutations** — auto-plan, force-include, departure approval/cancellation, split, duplicate, generate-invoices.
4. **Stop mutations** — move between runs, edit, delete, create line-deliveries, generate delivery notes.
5. **`/api/demo/reset`** (3243) — anonymous, wipes the entire `store.json` to defaults.
6. **`POST /api/sap/write/delivery-note/:id`** and **`/invoice/:id`** — the highest-impact endpoints. Currently fail-closed because `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are absent in `.env`. **The day either of those is set to enable real SAP writes, this becomes a fully exploitable anonymous SAP write vector.**
7. **Mobile QR onboarding** — `GET /m/admin/:shortId` (3289) serves an HTML page that writes a 30-day JWT to `localStorage` for any visitor with a valid 8-char short id. IDs persist in memory until process restart and are never cleaned up. `server.js` has no equivalent.
8. **Socket.IO with no auth, `cors:'*'`** — anyone on the network can subscribe to `driver:position`, `run:created`, `run:departure-approved`, etc. and read live operations data.

### Real SAP data is returned anonymously
`/api/customers/search?q=…` (3255) returns real OCRD rows from SAP companies A and B (`sapBridge.js:24-29`) when `sapLive` is true. Confirmed live during the verification pass: query returned `{"customers":[…],"source":"sap"}`.

### Operational degradation (silent)
- No daily digest email since 2026-05-06.
- No SAP sync retry queue processing — failed Delivery Notes and Return Requests are accumulating with no retry worker.
- No cleanup worker — `IntelligenceEvents`, `AgentRuns`, GPS pings, audit log are growing unbounded (per `prisma-analysis.md`, this was already a problem; demoServer makes it worse by not running cleanup at all).
- No CEO Brief.
- No DAVO Mix weekly report (the Sunday 08:00 schedule has not fired since the regression).

---

## Required answers (per task spec)

### Why is demoServer running in production?
Accidental regression from a missing `pm2 save` on 2026-05-05. The daemon restart on 2026-05-06 22:16 resurrected from a stale dump.pm2 snapshot. No deliberate revert, no operational fallback, no infrastructure block. See timeline in §1.

### What would break if switched to server.js today?
Three classes of breakage, all real:

1. **~40 endpoints would 404**, including: the entire warehouse picker scan/pick/QC flow, the planner's run-optimize/auto-plan/force-include, departure approval, line-level delivery editing, the entire Documents Hub (DN/Invoice list, "create invoice from DN", confirm SAP, mark exported), all 8 PDF/XLSX report exports, the COD module, customer hours / bulk policy edit, zone-by-city drag-drop, the 4 demoServer-only analytics dashboards (stock-prediction, anomalies, customer-profitability, suggest-drivers), customer ETA SMS, and the mobile QR onboarding flow. See §2 "Routes that exist ONLY in demoServer" for the full list with `demoServer.js:line` references.
2. **Empty UI on shared endpoints** because `server.js` reads from the Logistics SQL DB, which has none of the data accumulated in `backend/data/store.json` (1.6 MB / 58,726 lines representing every demo+real driver, user, zone, run, stop, COD record, document mapping accumulated since 2026-04-26).
3. **Socket.IO clients reconnect** — handshake now requires JWT. Any existing browser tab or driver phone gets disconnected until they refresh and re-auth.

### What infrastructure / env dependencies are missing?
**None that block server.js boot.** All required env keys are present in `.env`. Optional keys including SAP credentials are present. `node_modules` includes `@anthropic-ai/sdk` and `node-cron`. The 4 unapplied migrations in `database/migrations/PENDING.md` gate features that are **not mounted** in `server.js` today — irrelevant to boot.

### Is there SAP write risk?
**Today: no.** `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are absent from `.env`. demoServer's `/api/sap/write/*` endpoints return synthetic doc entries (`9000000 + DeliveryNoteId`) and skip the real HTTP call (`sapWriter.js:139,178`).

**Latent risk:** if any operator sets `SAP_WRITE_ENABLED=true` on this host while demoServer is still the running process, those endpoints become anonymous SAP write vectors. Anyone on the network can `POST /api/sap/write/delivery-note/123 {"dryRun": false}` and create real SAP B1 documents using the configured Service Layer credentials. Treat this as a P0 the moment SAP_WRITE_ENABLED is enabled.

### Is there data inconsistency risk?
**Yes, on switch.** `backend/data/store.json` and the Logistics SQL DB have been **diverging since 2026-05-06 22:16** — ~10 days of operational state (drivers, zones, runs, stops, COD collections, document records, line deliveries) accumulated only in the JSON file. Logistics SQL has whatever it had on 2026-05-06 06:58 (last server.js worker tick) plus whatever shadow state the `cleanupWorker` and `sapSyncWorker` had touched before. A direct switch presents the older DB state to users.

`/api/audit/:entityType/:entityId` differs in semantics: demoServer always returns `{"trail":[]}` (`demoServer.js:3240`), whereas server.js queries `routes/audit.js` against the real `AuditLog` table. After switch, any audit history that was happening client-side disappears — but no audit history was actually being recorded by demoServer in the first place, so no data is lost; users will just see an audit timeline they didn't see before.

### Is there outage risk?
**Yes, partial.** The switch is operationally a normal `pm2 delete sap-logistics; pm2 start ecosystem.config.cjs --only sap-logistics; pm2 save` — server.js boots in seconds (proven previously). But:
- **Frontend shows partial 404s** for ~40 endpoints until the demoServer-only logic is ported.
- **In-memory state is lost** — Socket.IO subscribers reconnect, the live driver-GPS simulation stops (this is a feature, not a bug — it was synthetic).
- **Workers wake up** — the dailyDigest, sapSync, cleanup, ceoBrief, and davoMixReport workers will start running. Make sure their SQL queries still match the current schema. The fact that `error.log` showed `[worker] tick failed Connection is closed` errors for ~24 hours during the previous server.js run (2026-05-05 → 06) suggests at least the dailyDigest worker has flaky SAP/MSSQL connection handling that should be sanity-checked before re-enabling.

### Recommended migration path

**Do NOT issue a blind `pm2 delete; pm2 start` switch today.** Recommended sequence (all out of this read-only investigation's authorized scope — operator action):

1. **Inventory the demo-only routes the frontend actually calls.** Grep `frontend/src/services/api.js` for the URLs in §2. Cross-reference with the "BREAK if switched" list. The result is the actual porting backlog.
2. **Port each demo-only route into `routes/*.js`.** Specifically:
   - `routes/picking.js` needs the full scan/pick/QC flow (currently 2 endpoints; demoServer has ~15 at lines 2407-2536).
   - Create `routes/cod.js`, `routes/documents.js`, port the 4 demo-only analytics endpoints into `routes/analytics.js`.
   - Move the 8 PDF/XLSX report generators from `demoServer.js:2345-3239` into `services/reports/` (the directory already exists with 3 files).
   - Each ported route gets `requireAuth` + `requireRole` per the existing pattern.
3. **Migrate `backend/data/store.json` content into Logistics SQL.** Write a one-shot script that reads each top-level key (drivers, users, zones, runs, stops, codCollections, deliveryNotes, invoices, documents, pickers, allocations, lineDeliveries) and INSERTs into the corresponding tables. The schema for most of these already exists from migrations 001-008. Do this **before** the switch so the post-switch UI isn't empty.
4. **Run server.js in shadow on a different port for ~24h** to validate the worker queries don't crash. `node src/server.js` with `PORT=4001` from `backend/`. Watch `pm2-error.log` for fatal patterns.
5. **Cut over:**
   ```
   pm2 stop sap-logistics
   pm2 delete sap-logistics
   pm2 start ecosystem.config.cjs --only sap-logistics
   pm2 save     # ← the missing step from 2026-05-05; do not skip again
   ```
6. **Verify** with the curls in `p0-fixes-applied.md` and `p0-verification-report.md`.

If the migration is too big for one operator-week, an interim hardening for demoServer is to merge `requireAuth` middleware into the inline route definitions — that addresses the most-painful security gaps without touching state migration. But this is a band-aid; the long-term answer is steps 1-5.

### Safe rollback plan

If after switching to `server.js` something breaks, rollback is fast:

```
pm2 stop sap-logistics
pm2 delete sap-logistics
# Edit ecosystem.config.cjs:56 — change `script: './src/server.js'` to './src/demo/demoServer.js'
pm2 start ecosystem.config.cjs --only sap-logistics
pm2 save
```

`backend/data/store.json` is untouched by the switch (server.js never reads it). It's still on disk, last good snapshot from 2026-05-05 09:59 + every demoServer write since 2026-05-06 22:16. Demo state is recoverable.

The Logistics SQL DB is also untouched by demoServer (demoServer doesn't open a pool to it). So switching back to demoServer simply resumes from where it was.

If the migration script in step 3 above wrote into Logistics SQL, those rows persist after rollback — they're harmless (just unused by demoServer).

**Prerequisite for safe rollback:** the operator should take a snapshot of `backend/data/store.json` BEFORE the cutover (`copy backend/data/store.json backend/data/store.json.cutover-20260510`) so any demoServer writes between cutover-prep and final cutover aren't lost.

---

## What I could not prove

| Question | Status | What it would take to confirm |
|---|---|---|
| Was 2026-05-06 22:16 daemon restart an OS reboot or `pm2 kill`? | NOT PROVEN | Windows Event Viewer system-startup logs around 22:15. |
| Who triggered the 2026-05-05 10:49 ecosystem switch? | NOT PROVEN | Shell history of the operator's session. Not preserved in repo. |
| Was `pm2 save` deliberately skipped on 2026-05-05? | NOT PROVEN | No notes either way. Most likely simply forgotten given no operational rationale to skip it. |
| Are the dailyDigest/sapSync workers' SQL queries compatible with the current schema after 10 days of demoServer-only operation? | NOT PROVEN | Run server.js in shadow per migration step 4; watch logs. |

End of investigation.
