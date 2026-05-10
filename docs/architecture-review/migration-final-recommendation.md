# Migration — Final Recommendation + Hidden Operational Risks

Final synthesis. Reads on top of:
- `route-matrix.md` (~46 demo-only routes; 8 CRITICAL)
- `store-json-analysis.md` (1.6 MB / 13-day window of operational state)
- `migration-architecture.md` (target shape + module fate)
- `cutover-plan.md` (6-phase plan)

---

## 1. Hidden operational risks (the things that bite during cutover)

### 1.1 Background workers wake up

The 5 schedulers in `server.js:165-169` have been **dormant for 10 days** (since 2026-05-06 22:16). On cutover, all five start ticking simultaneously:

| Worker | First action after cutover | Hidden risk |
|---|---|---|
| `sapSyncWorker` (every 30s) | Scans `RunOrders` for `Status='DELIVERED' AND SapDeliveryDocEntry IS NULL` (last 24h) plus `SapRetryQueue` rows | 0 rows match (store.json says all 1,307 RunOrders are PENDING, none DELIVERED) — so first tick is a no-op. **BUT** if the migration script accidentally INSERTed runOrders with DELIVERED status, the worker would attempt SAP writes within 30s of cutover. **Mitigation:** assert `Status='PENDING'` on every migrated row in Phase 2 dry-run. |
| `dailyDigestWorker` (cron daily) | Email summary of yesterday's runs/failures | First post-cutover email may compare migrated data to "yesterday" which is the day BEFORE migration — meaningless numbers. **Mitigation:** disable for 24h post-cutover via env var if `dailyDigestWorker` honors one (read its source before relying on this). |
| `cleanupWorker` (cron daily) | Hard-delete old GPS pings + uploads | Runs against tables that haven't been written to in 10 days. **First run after months will lock heavily** per `prisma-analysis.md` §10. **Mitigation:** Phase 0 add an env-var kill switch or run cleanup manually with explicit batch size before re-enabling. |
| `ceoBriefScheduler` (cron `0 7 * * *`) | Triggers Anthropic agent + sends email | Env-gated by `CEO_BRIEF_SCHEDULE_ENABLED`. Confirmed currently `unset` → worker won't fire. **Mitigation:** keep gate off through Phase 6. |
| `davoMixReportScheduler` (cron Sunday 08:00) | Triggers DAVO weekly report email | Env-gated by `DAVO_MIX_REPORT_ENABLED`. Confirmed currently `unset`. **Mitigation:** same. |

**Worker connection behavior:** the previous server.js run (2026-05-05→06) showed `[worker] tick failed Connection is closed` errors recurring. mssql connection-pool churn. Not fatal then, won't be fatal now, but operator should expect the same noise in `error.log` and not interpret it as a cutover failure.

### 1.2 Queue state — there isn't one

There is no Bull/BullMQ/Redis. The only queue is `SapRetryQueue` (a SQL table polled every 30s). On cutover:
- Any rows in `SapRetryQueue` from the previous server.js run (2026-05-05→06) are **still there**, with `NextAttemptAt` in the past. The worker will pick them up immediately and attempt SAP writes within 30s.
- Rows are addressed by `(EntityType='RunOrder', EntityId)`. If the migration renumbered EntityIds (it shouldn't if migration is FK-stable), retries POST against wrong orders → **could create duplicate SAP delivery notes**.
- **Mitigation:** before cutover, `SELECT * FROM SapRetryQueue WHERE Status='PENDING'`. If non-empty, decide whether to fail-permanent-them all or let them retry. The safest move is `UPDATE SapRetryQueue SET Status='FAILED_PERMANENT' WHERE Status='PENDING' AND CreatedAt < migrationCutoverDate` — operator action.

### 1.3 Stale jobs

Per `pm2.log`, the PM2 daemon itself has had `pidusage` errors. `tunnel-url-watcher` is in `errored` state. `sap-bi-api` has 23,008 restarts. The daemon is unhealthy.

- **Risk:** during cutover, `pm2 stop sap-logistics` may hang (per the verification report — pm2 commands took ~2 minutes to return).
- **Mitigation:** **before** cutover day, operator should run `pm2 kill && pm2 resurrect` to restart the daemon cleanly. This flushes the daemon state. Then verify `pm2 jlist` returns promptly. Do this in Phase 0.

### 1.4 SAP write risk during the cutover window

Currently no SAP writes are flowing because both `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are unset. After cutover, the new `services/sapWriter.js` (per `migration-architecture.md`) reads **only** the production env keys (`SAP_SL_URL`, etc., which ARE set).

- **Risk:** the new path doesn't have the demo's env-gate fail-closed behavior. If `routes/driver.js` (the F2-protected path) calls `services/deliveryNotes.createDeliveryNoteForOrder` after cutover, it WILL POST to SAP. demoServer's anonymous `/api/sap/write/*` was env-gated; the production driver-flow is not.
- **Mitigation:** introduce a TEMPORARY `HUB_SAP_WRITES_ALLOWED=false` env that gates all SAP writes for the first 7 days post-cutover. Confirmed sync-analysis recommendation 1.1 (idempotency UDF) is in place before flipping.
- **Mitigation 2:** with all 1,307 store.json runOrders in PENDING status, the first SAP write only happens when a real driver completes a real stop post-cutover. There's a natural cooldown — but a planner force-completing a backlog stop would trigger it immediately.

### 1.5 Duplicate delivery risk

This is the most dangerous edge case. Two ways it can happen:

1. **store.json migration creates a duplicate.** A run+stop+order migrated yesterday is also re-migrated by the cutover-day delta script if natural-key dedup is broken. Then a driver completes the stop → two SAP delivery notes.
2. **`SapRetryQueue` from May 5-6 fires against migrated orders.** Same outcome.

**Mitigation 1:** every entity in the migration script has a deterministic natural key (Drivers.Code, Users.Username, SapDocEntry+Company for orders, etc. — see `store-json-analysis.md`). Phase 2 dry-runs prove no double-INSERT.

**Mitigation 2:** sync-analysis recommendation 1.1 — implement `U_HubRunOrderId` UDF idempotency before allowing any SAP write post-cutover.

**Mitigation 3:** for the first 7 days post-cutover, manually monitor `ODLN` row counts daily. Alert on any same-day duplicate `(CardCode, Total)` pairs.

### 1.6 Inventory corruption risk

store.json has 826 PickingAllocations and 505 waveLines for active picking waves. Per `store-json-analysis.md`, allocations don't have a direct `RunOrderId` FK in the JSON — keyed on `(CompanyCode, SapDocEntry, SapOrderLineNum)`. The migration script joins to find the matching `RunOrderId`.

- **Risk:** if a join misses (because the RunOrder was inserted with a different `SapOrderLineNum` due to demoServer/server.js logic divergence), allocations end up orphaned. Picker scans then 404 or update wrong allocations.
- **Mitigation:** Phase 2 dry-run validation explicitly counts allocations with NULL RunOrderId post-INSERT. Any orphan blocks cutover until the join logic is fixed.

### 1.7 Report generation breaks silently

The PDF/XLSX endpoints (manifest, picking, distribution, loading, delivery-notes, invoices) are accessed via `<a href>` in the SPA — no `Authorization` header. Under demoServer (anonymous), they return 200. After cutover, `requireAuth` returns 401.

- **Risk:** drivers, dispatchers, and operations staff click "Print Manifest" and get a blank tab or download a JSON error.
- **Mitigation:** Phase 1G workstream MUST include the frontend fix — either:
  - Convert the anchor click to a `fetch` + Blob URL pattern (requires a small `frontend/src/services/downloads.js` module), OR
  - Implement signed-URL pattern: `GET /api/reports/runs/:id/manifest.pdf?token=<signed>` where the token is a short-lived HMAC of the path. Backend validates the token instead of `Authorization`.
- **Both options are implementation effort >2h. Don't underestimate.**

### 1.8 Mobile clients (driver phones)

Driver tokens have 7-day TTL. Tokens issued by demoServer lack `aud`/`iss` claims. server.js in lax mode (`JWT_STRICT_VERIFY=false`) accepts them.

- **Risk during cutover:** none if lax mode stays on.
- **Risk later:** when the operator flips `JWT_STRICT_VERIFY=true` (per security-analysis F13), every driver phone with a demoServer-era token 401s simultaneously. Drivers stuck mid-route can't complete stops.
- **Mitigation:** flip `JWT_STRICT_VERIFY=true` only AFTER all driver tokens have rotated naturally (≥7 days post-cutover). `getJwtRolloutStats()` from `middleware/auth.js:34` exposes the legacy-token counter; flip when it hits zero for 24h consecutive.
- **Socket.IO disconnects on cutover.** Drivers' phones need to re-establish WebSocket connection (handshake now requires JWT after F1 P0 fix). Most apps reconnect automatically; verify by watching one phone in the cutover window.

### 1.9 Cached frontend assumptions

The browser has aggressive caching of `/assets/index-*.js` (Vite content-hash). After cutover:
- A user who logged in last week may hit endpoints that return new shape. If frontend `dist/` was rebuilt with shape changes during Phase 1, old cached JS sees new server response.
- **Mitigation:** rebuild `frontend/dist/` as the LAST step of Phase 1. The Vite content-hash forces browsers to re-download on next visit. PM2 picks up the new bundle when it serves `frontend/dist/index.html` (server.js:144).
- **Mitigation 2:** force-clear PWA cache (`navigator.serviceWorker.getRegistrations().forEach(r=>r.unregister())`) — driver app uses `vite-plugin-pwa`. Provide a "force refresh" link.

### 1.10 SocketIO event scope expansion

demoServer broadcasts every `io.emit(...)` to every connected client (no rooms). server.js auto-joins drivers to `driver:<driverId>` rooms only.

- **Risk:** any frontend code that listens for, say, `'order:delivered'` and assumed it would receive every order's event will silently stop receiving them post-cutover (the server emits to `'planner'` room only).
- **Mitigation:** grep `frontend/src/` for `socket.on(` and confirm each listener is in a UI that has the right role. This is a Phase 1 validation task that's easy to skip.

---

## 2. Final answers (per task spec)

### Is migration safe NOW?
**No.** Today, switching `pm2` from demoServer to server.js would:
- 404 ~46 endpoints, 8 of them CRITICAL (entire warehouse picking flow, run-stop creation, departure approval, picker-login).
- Present an empty UI on routes that work in both servers (Logistics SQL has none of the 13 days of accumulated state in `store.json`).
- Wake up 5 dormant workers whose tick-correctness is unproven against the current schema.
- Disconnect Socket.IO clients without notice.

The path to safe migration is the 6-phase plan in `cutover-plan.md`. **Estimated 4-6 weeks of engineering + a weekend cutover window.**

### What MUST be migrated first?
In order of cutover-blocker severity:

1. **Picking flow** (8 endpoints, demoServer.js:2407-2536) — without these, the warehouse is offline.
2. **Run-stop mutations** (10 endpoints across `runs`, `stops`, `run-orders`) — without these, the planner board is read-only.
3. **Picker login + Pickers CRUD** — without these, no one can scan-and-pick.
4. **Departure approval** — without these, no run can transition to IN_TRANSIT.
5. **Documents Hub** (delivery-notes, invoices, generate-from-DN, confirm-sap) — without these, finance can't reconcile SAP writes.
6. **Cash on Delivery** — without these, drivers can't record cash collections.
7. **Customer policy + hours + zone-by-city** — without these, planner config is read-only.
8. **5 PDF + 2 XLSX report generators** — without these, every "Print" button breaks.
9. **The 4 demo-only analytics dashboards** (anomalies, customer-profitability, driver-performance, stock-prediction) — without these, those 4 frontend pages 404.
10. **store.json → SQL data migration script** with all 9 new tables.

### What can be deprecated (dropped without porting)?
- **`/m/admin/:shortId`** HTML credential vending page — security risk, no production use.
- **`/api/auth/mobile-link*`** — verify with operations whether the QR-onboarding flow is still used; if not, drop.
- **`/api/demo/reset`** — dev tool, never in production.
- **`/api/runs/:id/duplicate`** — likely low-use; verify with planner team.
- **`/api/runs/:id/optimize`** (the demo's own version) — server.js already has `/optimize-order`; consolidate to one.
- **`/api/analytics/anomalies`** — `recommendations.md` Tier 3 calls for moving anomaly detection to a real warehouse; fine to drop the demoServer version and rebuild later.
- **`/api/analytics/driver-performance`** — duplicates `/api/analytics/drivers` from server.js. Merge.

### What should be REWRITTEN instead of migrated?
- **`demo/sapWriter.js`** — its idempotency model is broken (no SAP-side dedup token). Rewrite as `services/sapWriter.js` with `U_HubRunOrderId` UDF per sync-analysis 1.1. Don't port the bug.
- **`demo/persistentStore.js` save logic** — `fs.writeFileSync` to a 1.6 MB JSON on every mutation is fragile under concurrent writes. Don't carry forward; the database replaces this.
- **PDF generator code (~700 lines)** — the inline `pdfkit` calls in demoServer 2544-3239 mix layout and data. Move into `services/reports/` with one file per generator, separating data fetching from layout.
- **Picker login** — demoServer's picker-login is similar to driver-login but separate. Consolidate with `signDriverToken` pattern using a `pickerId` claim.
- **Anonymous routes** — every demo-only route gets `requireAuth` + `requireRole` on rewrite. This is the security upgrade.
- **`liveSimulation.js`** — does not migrate. It's synthetic GPS for demo only. Real drivers post real positions via `/api/tracking/position`.

### Estimated safest cutover window
**Saturday 22:00 → Sunday 06:00 Israel time.** Specifically:
- Warehouse closed.
- Driver shift ended.
- `pm2-out.log` shows lowest "[sim] New return" frequency in this window (proxy for low real activity).
- 8 hours of buffer for monitoring + rollback if needed.
- Operator + 1 backup person on call.

Avoid:
- Sunday-Thursday business hours (Israel work week).
- Friday afternoon (warehouse lighter but Saturday closure means longer rollback delay).
- Eve of Israeli holidays.
- During cutover: no other production change anywhere on the host (sap-bi-api, davo-price-monitor, oig-listener should all stay running but not be modified).

### Biggest remaining technical risk
**The data migration script.** Specifically: the join from `PickingAllocations(CompanyCode, SapDocEntry, SapOrderLineNum)` → `RunOrders.RunOrderId` after a fresh INSERT. If this join misses for any allocation, post-cutover picker scans either 404 or update wrong rows.

Phase 2's third dry-run on a 24-hour-stale snapshot is specifically designed to catch this — but it requires real attention. **A bug here corrupts inventory tracking silently.**

Second-biggest: `services/sapWriter.js` correctness. demoServer never wrote to SAP (env-gated). server.js will, the first time a driver completes a stop. If the idempotency UDF isn't sent on the first POST, and the worker retries, **duplicate ODLN entries appear in SAP B1.** Customer invoices double-count. Finance team rebuilds shipments by hand.

### Biggest business risk
**A missed PDF report on the day of cutover.** Drivers print manifests every morning. Dispatchers print picking lists for warehouse. If Phase 1G's frontend-fix workstream is incomplete and "Print Manifest" returns 401 on cutover Sunday morning:
- Drivers leave without manifests.
- Warehouse can't print picking lists.
- The CTO/operator gets paged at 06:00 on Sunday.
- Rollback to demoServer is the right move.

This is also the most likely failure mode because it's a frontend-side bug in code that no developer will touch during Phase 1's backend porting. Easy to forget. Specifically call it out in the cutover checklist (added to `cutover-plan.md` Phase 4 checklist as "PDF download verification").

---

## 3. Decision matrix — for the operator

| Question | Recommendation |
|---|---|
| Should we migrate at all? | **Yes.** demoServer's anonymous-route surface is unsustainable. Every passing day adds operational state to store.json that's harder to migrate. |
| Should we migrate this month? | **No.** Phase 1's 2-3 weeks of porting is the binding constraint. Plan for next quarter's first weekend after Phase 0+1+2 are complete. |
| Should we migrate before any new feature ships? | **Yes.** Phase 0 says freeze new demoServer-only feature work. Anything new lands in `routes/*.js` from Day 1. |
| Should we keep `SAP_WRITE_ENABLED=false` through cutover? | **Absolutely yes.** Real SAP writes are a Phase 6+ decision tied to sync-analysis 1.1 idempotency UDF. |
| Should we run an interim band-aid (auth-gate demoServer's anon routes)? | **Optional.** 4 lines of middleware closes the worst exposures without touching state. But it's pure tech debt; either commit to migration or commit to band-aid, not both. |
| If migration script fails dry-run #3, do we cutover anyway? | **No.** Roll back Phase 2 to script-fix mode. The shadow run is non-negotiable. |

---

## 4. What this plan does NOT cover

- **The unrelated `sap-bi-api` crash loop** (23,008 restarts) — separate system, separate triage.
- **Long-term scaling** — `recommendations.md` Tier 2/3 (read replica, warehouse, semantic layer) is independent of this migration.
- **AI cost cap** — `p0-fixes-applied.md` D5 deferred. Independent.
- **Schema fix for `Insights.AgentRunId`** — `p0-fixes-applied.md` D4 deferred. Independent.
- **Multi-instance / horizontal scale** — single-instance assumption is preserved through cutover. Scale-out is post-Phase 6.

---

## 5. Document inventory

The full migration package consists of:

| File | Purpose |
|---|---|
| `route-matrix.md` | Complete endpoint → backend → frontend → criticality table |
| `store-json-analysis.md` | Per-entity deep dive of `backend/data/store.json`; FK graph; migration difficulty per row |
| `migration-architecture.md` | Target shape, what stays/moves/dies, auth unification, anonymous-access elimination |
| `cutover-plan.md` | 6 phases (0-6) with tasks, validation, rollback, outage risk, business risk, duration |
| `migration-final-recommendation.md` (this file) | Operational risks + the 7 explicit answers |

Plus prior context:
- `system-overview.md` — high-level architecture
- `prisma-analysis.md` — schema + table classifications
- `sync-analysis.md` — SAP sync + idempotency requirements
- `kpi-analysis.md` — KPI governance gaps
- `security-analysis.md` — auth gaps closed by migration
- `performance-analysis.md` — performance gaps
- `technical-debt.md` — accumulated debt
- `recommendations.md` — Tier 0-3 prioritized roadmap (this migration is Tier 0)
- `p0-fixes-applied.md` — F1-F10 fixes (inert until cutover)
- `p0-verification-report.md` — verification of fix state (and discovery of the demoServer regression)
- `demo-server-root-cause.md` — forensic timeline of the 2026-05-06 regression

End of final recommendation.
