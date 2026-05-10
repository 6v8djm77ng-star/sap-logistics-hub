# Cutover Plan — `demoServer.js` → `server.js`

Companion to `migration-architecture.md`. This is a phased plan optimized for **stability and reversibility over elegance**. Every phase has a validation gate, a rollback path, and a duration estimate.

## Plan-level guidance

- **Total estimated effort: 4-6 weeks of engineer time** + 1 cutover window.
- **Suggested cutover window:** Saturday 22:00 → Sunday 06:00 Israel time (lowest delivery activity per `pm2-out.log` pattern; warehouse closed).
- **Hard prerequisite for cutover:** every CRITICAL demo-only route from `route-matrix.md` is ported AND data migration script is dry-run-verified at least 3 times.
- **Soft prerequisite:** SAP_WRITE_ENABLED stays UNSET through cutover. Production SAP writes turn on as a separate, post-cutover decision after at least 1 week of stable operation.
- **No business-day cutover.** Even with low warehouse activity, weekday lunchtime would risk losing 100+ stops in the migration window.

---

## Phase 0 — Hardening + freeze

**Goal:** make the current production state safe and prevent further drift before migration work starts.

**Duration:** 2-3 days.

### Tasks

1. **Apply the 9 P0 fixes already in `git diff`** (already done — see `p0-fixes-applied.md`). They are inert until cutover but applying now reduces total cutover delta.
2. **Snapshot `backend/data/store.json` daily** to `backend/data/archive/store.json.YYYYMMDD-frozen` (cron or scheduled task on the host). Recovery point if demoServer crashes during Phase 1-3.
3. **Snapshot the Logistics SQL DB.** Full backup file copied off-host. Operator action; not Claude-scoped.
4. **Confirm `SAP_WRITE_ENABLED` is UNSET** in `.env`. Currently confirmed unset; document the policy that it stays unset until Phase 6.
5. **Add a minimal anonymous-route block in demoServer** if the operator is willing to make a focused edit: gate `/api/users`, `/api/sap/write/*`, `/api/demo/reset`, `/api/drivers`, `/api/zones` mutations behind a check for any valid Bearer token. Token check is 4 lines of middleware. Skip this if you'd rather not touch demoServer; this is a band-aid not the migration.
6. **Freeze new feature work** on demoServer-only routes. Any new endpoint goes into `routes/*.js` from this point on.
7. **Tag the commit:** `git tag pre-migration-baseline`.
8. **Communicate freeze** to anyone who pushes code to this repo.

### Validation
- `pm2 jlist` shows `sap-logistics` still on demoServer.js, `online`, no crash loops.
- Daily `store.json` snapshot exists for at least 2 days.
- Tag visible: `git tag --list pre-migration-baseline`.

### Rollback
Nothing to rollback — this phase only adds, never modifies running code.

### Outage risk
None.

### Business risk
Low. Some operators may be impatient with the freeze on demoServer-only feature work.

---

## Phase 1 — Port CRITICAL routes from demoServer to server.js

**Goal:** make every CRITICAL endpoint listed in `route-matrix.md` available in `server.js` with proper auth, before any data migration. Endpoints must compile and lint clean. Behavior parity with demoServer is the bar — refactoring is explicitly out of scope.

**Duration:** 2-3 weeks.

### Workstreams (parallelizable)

#### 1A. Picking flow (largest)
- New endpoints in `routes/picking.js`:
  - `GET /api/picking/waves`
  - `POST /api/picking/:waveId/scan`
  - `POST /api/picking/:waveId/qc-approve`
  - `POST /api/picking/:waveId/qc-reject`
  - `POST /api/picking/lines/:lineId/shortage`
  - `POST /api/picking/lines/:lineId/reset`
  - `POST /api/picking/allocations/:allocId/pick`
  - `POST /api/picking/allocations/:allocId/reset`
- Source: `demoServer.js:2407-2536`. Logic moves into a new `services/picking.js`.
- Auth: `requireRole('ADMIN','WAREHOUSE')` for mutations; `requireAuth` for the GET.
- Schema additions: `015_qc.sql` (PickingWaves QC columns).
- Out-of-scope: refactor to use `services/wavePicking.js`. Keep demoServer's algorithm verbatim.

#### 1B. Run mutations (planner board)
- Extend `routes/runs.js` with the 9 demo-only run endpoints (force-include, duplicate, split, optimize, loading-plan, approve-departure, cancel-departure, generate-invoices, PATCH/:id, DELETE/:id, /:runId/stops POST).
- New `routes/stops.js` for stop-level mutations (move, edit, delete, line-deliveries, generate-delivery-notes).
- New `routes/run-orders.js` for `DELETE /api/run-orders/:runOrderId`.
- Auth: `requireRole('ADMIN','PLANNER')` for all mutations except line-deliveries which is `DRIVER` with `driverOwnsEntity`.
- Schema: `015_run_departure.sql` (DeliveryRuns approval columns).

#### 1C. Driver login flow
- Add `POST /api/auth/picker-login` to `routes/auth.js`.
- Add `routes/pickers.js` (CRUD).
- Auth on picker-login matches driver-login (same `signDriverToken` pattern).
- Schema: `013_pickers.sql`.

#### 1D. CoD module
- New `routes/cod.js` + `services/cod.js`.
- Schema: `017_cod.sql`.
- Auth: `requireRole('ADMIN','PLANNER','DRIVER')` with `driverOwnsEntity` for driver deposits.

#### 1E. Documents Hub
- New `routes/documents.js` + `services/documents.js`:
  - `GET /api/delivery-notes`, `GET /api/invoices`, `GET /api/documents/stats`
  - `POST /api/delivery-notes/:dnId/generate-invoice`
  - `POST /api/documents/:type/:id/confirm-sap`
  - `POST /api/documents/mark-exported`
- Schema: `019_documents.sql` (DeliveryNotes + Invoices Hub-side mirror tables).
- Auth: `requireRole('ADMIN','PLANNER')`.

#### 1F. Customer policy / hours / zones / drivers extensions
- Extend `routes/customers.js` with policy + hours endpoints.
- Extend `routes/zones.js` with PATCH/DELETE + cities + suggest.
- Extend `routes/drivers.js` with PATCH/DELETE.
- Schemas: `013_pickers.sql`, `013_city_zone_overrides.sql`, `014_customer_doc_policies.sql` (combined `014_customer_policy_hours.sql`).
- Auth: `ADMIN` / `ADMIN/PLANNER` per route-matrix.

#### 1G. Reports (PDF/XLSX)
- Move 5 PDF generators + 2 XLSX generators from `demoServer.js:2345-3239` into `services/reports/`:
  - `services/reports/distributionSummary.js`
  - `services/reports/loadingManifest.js`
  - `services/reports/bulkManifest.js`
  - `services/reports/pickingPdf.js`
  - `services/reports/deliveryNotesXlsx.js`
  - `services/reports/invoicesXlsx.js`
- Wire into `routes/reports.js`.
- **Critical:** PDF/XLSX URLs are used as raw `<a href>` in the SPA — fix `frontend/src/services/api.js` to attach a one-time signed query token, or convert to `fetch` + Blob. Without this, every PDF download 401s after cutover.
- Auth: `requireRole('ADMIN','PLANNER','WAREHOUSE')`.

#### 1H. Analytics extensions
- Extend `routes/analytics.js` with anomalies, customer-profitability, driver-performance, stock-prediction, suggest-drivers/:zoneCode.
- Logic moves into `services/analytics.js` extensions.
- Auth: already `requireRole('ADMIN','PLANNER')` after P0 fix F6.

#### 1I. Notify ETA SMS
- New `routes/notify.js` + integration with `services/notifications.js` and `services/customerComms.js`.
- Auth: `requireRole('ADMIN','PLANNER','DRIVER')` with `driverOwnsEntity`.

#### 1J. SAP write idempotency (per `sync-analysis.md` 1.1)
- Replace `demo/sapWriter.js` with `services/sapWriter.js` that:
  - Sends `U_HubRunOrderId` UDF in payload
  - Pre-checks SAP for existing doc with that UDF
  - Wraps "POST + UPDATE Hub row" in retry-safe logic
- This is referenced from `services/deliveryNotes.js` and the new `routes/documents.js`.
- **Stays gated by `SAP_WRITE_ENABLED`** (still UNSET in .env). The unsafe-anonymous demoServer endpoint goes away on cutover regardless.

### Validation per workstream
- `node --check` clean on every modified file.
- Unit tests for new services (where existing patterns have tests — e.g., `services/addressNormalizer.test.js`).
- Smoke test against a local dev DB:
  - `cd backend && npm run dev` (NOT against production .env — use a copied .env with Logistics SQL pointed at a dev DB)
  - hit each new endpoint with curl + ADMIN token, confirm 200 with realistic shape.
- Confirm DRIVER token still 403s on planner endpoints.

### Rollback
Workstream-level rollback by reverting the merge commit. No production impact since demoServer.js is still the running entry.

### Outage risk
**None during this phase.** demoServer.js is still serving production. New code is unmounted from production until Phase 4.

### Business risk
Workstream slip. Picking and Documents Hub are the two largest workstreams (~700 lines of PDF generation + ~250 lines of picking flow). If 1A or 1G slips, cutover slips. Other workstreams are independent.

---

## Phase 2 — Data migration (one-shot script)

**Goal:** write and dry-run the migration script that ports `store.json` content into MS SQL. **Do not execute against production yet.**

**Duration:** 1 week.

### Tasks

1. **Author `backend/scripts/migrate-store-to-sql.js`** per the design in `migration-architecture.md` §3.
2. **Apply the new schema migrations** (013-019) against a **dev** Logistics DB. Verify `_Migrations` table records each.
3. **Dry-run the migration script three times** against a clean dev DB:
   - Run 1: from `store.json` snapshot. Confirm INSERT counts.
   - Run 2: same script, same DB. Confirm idempotency — should INSERT zero new rows.
   - Run 3: from a fresh `store.json` snapshot taken 24h later. Confirm only the delta is inserted.
4. **Verify FK consistency** post-migration: `SELECT COUNT(*) FROM RunOrders WHERE StopId NOT IN (SELECT StopId FROM DeliveryStops)` and similar checks across every FK edge in `store-json-analysis.md`. All counts must be 0.
5. **Verify counts match** between `store.json` (run a `node -e` count) and the dev DB (`SELECT COUNT(*) FROM …`). The discrepancy reveals skipped rows.
6. **Document each skipped row** with reason — usually missing FK target. Decide per skip: fix or accept.
7. **Time the script.** If it takes >30 minutes against production-sized data, optimize before cutover. Target: <10 minutes.
8. **Sample verification:** pick 10 random runs, 50 stops, 100 runOrders from dev DB and confirm fields match the JSON.

### Validation
- 3 dry-runs all pass with idempotency proven.
- Zero FK violations.
- `<10 min` runtime.
- Sample verification matches JSON exactly.

### Rollback
N/A — script runs against dev DB only. Production is untouched.

### Outage risk
None.

### Business risk
Migration script bugs are the #1 risk. A bad script that runs into production deletes or corrupts state. Phase 5's rollback validation specifically tests this.

---

## Phase 3 — Shadow run

**Goal:** run `server.js` on a different port, against the migrated dev DB, and exercise the frontend against it for at least 24 hours.

**Duration:** 3-7 days.

### Tasks

1. **Provision a shadow process:**
   - `cd backend && PORT=4001 node src/server.js` (NOT under PM2; manual run for visibility).
   - Use a copy of `.env` with `LOGISTICS_SQL_DB=SAP_Logistics_Hub_Shadow` pointing at the migrated dev DB.
2. **Workers:** all 5 schedulers will start. Watch their first ticks:
   - `sapSyncWorker` runs every 30s — should attempt SAP retry on `RunOrders.SapDeliveryDocEntry IS NULL`. Confirm it queries cleanly.
   - `cleanupWorker` runs daily — should not fire mid-shadow unless triggered manually.
   - `dailyDigestWorker` runs daily — same.
   - `ceoBriefScheduler` and `davoMixReportScheduler` are env-gated; keep gates OFF in shadow env.
3. **Frontend dual-mode test:**
   - Open the production frontend in one browser tab (against `:4000` / demoServer).
   - Open a copy of frontend `dist/` against the shadow at `:4001`.
   - Walk every page: Login, Planner, Runs, RunDetails, Picking, Driver, Wallboard, Documents, DAVO Mix, Analytics, Settings, Users, Zones, Drivers, COD.
   - Click every CRITICAL action: create run, assign driver, force-include, build wave, scan, QC approve, departure-approve, complete stop, deliver order, generate invoice, confirm SAP.
   - Compare responses for shape/count parity (manual eyeballing acceptable; full automation out of scope).
4. **Watch logs for 24h:**
   - `backend/logs/error.log` — any `[worker] tick failed` or new errors.
   - `backend/logs/pm2-out.log` for the shadow run — but since it's not PM2, just `nohup node src/server.js > shadow.log 2>&1 &` works.
   - Anthropic agent runs (CEO Brief manual trigger only) — confirm `AgentRuns` rows persist correctly.
5. **Re-run data migration script** at end of shadow period to capture the delta from store.json that demoServer wrote during shadow. This is a rehearsal for the real cutover.
6. **Confirm no production impact** during the entire shadow period.

### Validation
- 24h of uptime on shadow with no crashes.
- All worker tick errors are connection-transient (already documented in `error.log` from the previous server.js run).
- Frontend walk-through completes without 4xx/5xx on CRITICAL paths.
- Migration delta script runs cleanly twice.

### Rollback
Stop the shadow process. Production is untouched.

### Outage risk
None on production. Shadow process owns its own DB and port.

### Business risk
Discovery of new bugs (shadow shows endpoints that 500 or return wrong shape). These either get fixed before cutover or the cutover is postponed.

---

## Phase 4 — Controlled cutover

**Goal:** switch PM2 from demoServer.js to server.js with bounded data loss.

**Duration:** 1 cutover window — target: Saturday 22:00 Israel → Sunday 06:00 next morning. **Active hands-on time: 30-90 minutes.** Buffer for verification and possible rollback.

### Pre-cutover checklist (T-24h)

- [ ] Phase 1 done; all PRs merged.
- [ ] Phase 2 dry-runs successful 3+ times.
- [ ] Phase 3 shadow run stable for 24+ hours.
- [ ] All P0 fixes applied (already done).
- [ ] `pm2-error.log`, `combined.log`, `error.log` recently archived.
- [ ] `backend/data/store.json` snapshotted to `backend/data/archive/store.json.PRE-CUTOVER-YYYYMMDD-HHmm`.
- [ ] Logistics DB full backup taken.
- [ ] Operator confirms cutover window with operations / warehouse.
- [ ] Operator has `pm2 delete; pm2 start; pm2 save` rehearsed locally.

### Cutover sequence

```
# T-30 min — last-pass migration
[01]  Take a fresh store.json snapshot to backend/data/archive/store.json.SNAPSHOT-CUTOVER
[02]  Run migrate-store-to-sql.js against PROD Logistics DB
      (note: this is the first time the migration touches production —
       Phase 2 was dev only)
[03]  Verify counts: drivers, users, zones, runs, stops, runOrders, etc.
      Compare to store.json counts. Discrepancy > 1% → ABORT cutover, rollback.

# T-15 min — final freeze
[04]  Communicate to dispatchers / drivers: "system briefly unavailable T-0 to T+15 min"
[05]  pm2 logs sap-logistics --lines 30 — note the last log line for diff later

# T-0 — switch
[06]  pm2 stop sap-logistics
[07]  pm2 delete sap-logistics
[08]  pm2 start ecosystem.config.cjs --only sap-logistics
[09]  pm2 save                     ← THE STEP MISSED ON 2026-05-05
[10]  pm2 jlist | grep sap-logistics     # confirm pm_exec_path = src/server.js

# T+1 to T+5 min — health
[11]  curl http://localhost:4000/health  # expect "mode":"production" (NOT "DEMO+SAP")
[12]  curl http://localhost:4000/api/runs (with ADMIN token) → expect 200 with rows
[13]  Check pm2-out.log for the "🚚 SAP Logistics Hub API listening" banner
[14]  Check pm2-error.log for any startup error

# T+5 to T+15 min — smoke test
[15]  Browser: log in, navigate to Wallboard, Planner, RunDetails for an active run,
      Picking, Documents, Driver mobile (separate device).
      Confirm each page loads data (no 404, no 500).
[16]  Driver-side smoke: actual driver app re-login, manifest loads, can mark a stop.
      Choose a low-stakes stop. If 500/timeout → ROLLBACK.
[17]  Run the curls in p0-fixes-applied.md "verification suggestion" against new server
      to confirm the F1-F10 P0 fixes are now live.

# T+15 min onward — monitoring window
[18]  Watch pm2-out.log for 1 hour. Watch pm2-error.log for any worker tick errors
      that don't match the existing pattern.
[19]  Operator stays on call for 4 hours.
```

### Validation gates (ABORT if any fail)

| Gate | Pass condition | If fail |
|---|---|---|
| Migration count diff | <1% on every entity | Roll back script, restore DB backup |
| `/health` mode | `"mode":"production"`, all checks ok | Roll back to demoServer, debug |
| Workers start | No fatal errors in `pm2-error.log` | Investigate; if not transient → roll back |
| Smoke test | All CRITICAL pages load | Roll back |
| Driver action | At least one DRIVER stop completion succeeds | Roll back |

### Rollback (if any gate fails)

```
[R1]  pm2 stop sap-logistics
[R2]  pm2 delete sap-logistics
[R3]  Edit ecosystem.config.cjs:56 → 'src/demo/demoServer.js'
[R4]  pm2 start ecosystem.config.cjs --only sap-logistics
[R5]  pm2 save
[R6]  Confirm via pm2 jlist + curl /health that mode is back to DEMO+SAP
[R7]  store.json was untouched by server.js — operations resume on demo state
[R8]  IF migration script wrote into PROD DB:
        Those rows persist (harmless to demoServer). Optionally clean up later.
[R9]  Communicate "system back to previous state" to operations.
```

### Outage risk
**5-15 minutes** of "create run / pick / approve" actions return errors during the switch. Read-only views (Wallboard, Driver `my-runs`) recover automatically as soon as `/health` flips to 200. Driver phones may need a refresh to re-establish Socket.IO connections.

### Business risk
**Any data lost between T-30 (migration snapshot) and T-0 (PM2 switch)** is the cutover-gap loss. With ~70 stops/day write rate, expect ~2-3 stops written to store.json after the snapshot but before the switch. These are recoverable manually from `store.json.SNAPSHOT-CUTOVER` if needed.

---

## Phase 5 — Rollback validation (post-cutover, even on success)

**Goal:** prove the rollback path works while the team is still in the cutover window.

**Duration:** 30 minutes.

### Tasks

1. After T+30 min, with everyone watching, **execute the rollback to demoServer.js** (steps R1-R5).
2. Confirm demoServer is back (`/health` returns `"mode":"DEMO+SAP"`).
3. Confirm `store.json` is unchanged (`md5sum` matches the snapshot from T-15).
4. **Cut over again** to server.js (steps 06-09 from Phase 4 with no migration step — DB already current).
5. Confirm the second cutover takes <2 minutes total.

### Validation
- Both cutover and rollback complete cleanly.
- Production functionality returns to expected state after both.

### Rollback
N/A — this phase IS the rollback test.

### Outage risk
**Two 5-min windows** of partial unavailability. This is intentional — proves the recovery path is real, not theoretical.

### Business risk
If the second cutover-back fails, the team knows immediately and can debug in the same window with everyone present. Far better than discovering it 3 weeks later under stress.

---

## Phase 6 — demoServer retirement

**Goal:** remove demoServer code and `store.json` from the codebase to prevent regression.

**Duration:** ≥30 days **after** cutover-success.

### Tasks

1. **Wait at least 30 days** to allow worker queries (sapSync, cleanup, daily digest) to prove correct against the migrated DB. Some queries only run weekly (DAVO Mix report) — they need at least one cycle.
2. **Tag the commit:** `git tag pre-demo-removal-YYYYMMDD`.
3. **Move `backend/src/demo/` → `backend/archive/demo-2026-MM-DD/`** in a single commit. Keep the directory in repo for 90 days for emergency reference.
4. **Move `backend/data/store.json` → `backend/data/archive/store.json.RETIRED-YYYYMMDD`**.
5. **Search and remove demoServer references** from `backend/package.json` `main`, scripts; `Dockerfile` and `backend/Dockerfile`; `docker-compose.yml`; `start-dev.ps1` and `install.ps1`. The `ecosystem.config.cjs` already points at `server.js`.
6. **Update `cowork/INCIDENTS.md`** with the retirement entry: cutover date, dump.pm2 path issue resolved, who validated.
7. **Close the migration TASK in `cowork/TASKS.md`** per the close-before-open rule.
8. **Optionally — delete the archived `demo/` after 90 days** (T+120 from cutover).

### Validation
- `grep -r demoServer backend/src/` returns nothing.
- `grep -r store.json backend/src/` returns nothing.
- `pm2 jlist` confirms running entry is `server.js`.
- `cowork/TASKS.md` has the migration as `סגור / closed`.

### Rollback
At any point during the 30-day wait, if a new bug surfaces:
```
git revert <demo-removal-commit>
pm2 restart sap-logistics --update-env  # picks up demo/ files again
```
But this rollback DOES NOT restore `store.json` content — that's lost forever after retirement. The DB is the source of truth from cutover onward.

### Outage risk
None — code removal happens with `server.js` running.

### Business risk
Low. The 30-day wait specifically buffers against worker-tick edge cases that only manifest weekly.

---

## Cross-phase risk register

| Risk | Phase that mitigates | Severity |
|---|---|---|
| Migration script bug corrupts production DB | Phase 2 dry-runs + Phase 4 abort gate on count diff | HIGH |
| Worker query incompatibility with migrated schema | Phase 3 shadow + Phase 6 wait | MEDIUM |
| PDF/XLSX downloads 401 due to anchor href + Bearer auth | Phase 1G includes the frontend fix | MEDIUM |
| `SAP_WRITE_ENABLED` accidentally set during cutover → live SAP writes from new code without idempotency UDF tested in prod | Operator policy: stays unset through cutover; turn on only after Phase 6 + sync-analysis 1.1 | HIGH |
| Driver phones can't re-login after JWT_STRICT_VERIFY is later flipped | Phase 1 keeps lax mode through cutover; flip is post-migration decision | MEDIUM |
| Shadow run finds no bugs, real cutover finds one | Phase 5 rollback validation buys an extra "did it really work" check | MEDIUM |
| store.json gets a new top-level key between Phase 0 and Phase 4 (someone adds a feature mid-migration) | Freeze in Phase 0 + last-pass snapshot in Phase 4 | LOW |
| PM2 daemon itself is in a bad state on cutover day (per `pm2.log` errors observed in verification) | Operator restarts PM2 daemon (`pm2 kill`) before cutover, NOT during | MEDIUM |

---

## Estimated schedule

| Phase | Duration | Parallel? |
|---|---|---|
| 0. Hardening + freeze | 2-3 days | Sequential |
| 1. Port CRITICAL routes | 2-3 weeks | 1A-1J workstreams parallel |
| 2. Data migration script | 1 week | Sequential to Phase 1 close |
| 3. Shadow run | 3-7 days | Can overlap with Phase 4 prep |
| 4. Cutover | 1 weekend window (active 30-90 min) | Sequential |
| 5. Rollback validation | 30 min | Within Phase 4 window |
| 6. demoServer retirement | ≥30 days wait + 1 day cleanup | Sequential |

**Total wall-clock:** 4-6 weeks engineering + 4-week observation + 1-day cleanup.

The hardening freeze (Phase 0) starts on Day 1. If migration is rushed (Phase 1+2 collapsed to <2 weeks), risk goes up substantially — most of the failure modes in `route-matrix.md` and `store-json-analysis.md` need real time to discover.

End of cutover plan.
