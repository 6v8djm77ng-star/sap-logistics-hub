# Migration Workstream Board

The Phase 1 porting work, sliced into 8 parallel workstreams. Each workstream is independently mergeable; together they unblock cutover. Driver here is `cutover-plan.md` Phase 1; this file is the operational planning view.

**Convention:**
- **Scope** — what's in.
- **Out of scope** — what's deferred.
- **Dependencies** — what this workstream needs from another to land.
- **Risks** — concrete failure modes.
- **Effort** — engineer-days (single competent dev). S=1-3, M=4-7, L=8-15.
- **Rollback complexity** — how easy is it to back out the change if cutover fails.
- **Business criticality** — if this workstream slips, can we cutover anyway?

---

## WS-1 — Warehouse / Picking

**Lead routes:** `routes/picking.js`, new `services/picking.js`. Source: `demoServer.js:2407-2536` + `134-153` (pickers).

### Scope
- Port the full warehouse picking flow from demoServer:
  - `GET /api/picking/waves` — list of pickable waves
  - `POST /api/picking/:waveId/scan` — scanner barcode handler
  - `POST /api/picking/:waveId/qc-approve`, `/qc-reject` — QC gate
  - `POST /api/picking/lines/:lineId/shortage`, `/reset`
  - `POST /api/picking/allocations/:allocId/pick`, `/reset`
- Picker auth + CRUD:
  - `POST /api/auth/picker-login`
  - `GET/POST/PATCH/DELETE /api/pickers`
- Schema migration `013_pickers.sql` (Pickers table) + `015_qc.sql` (QC columns on PickingWaves).
- `pickerOwnsAllocation()` helper analogous to `driverOwnsEntity()`.
- `requireRole('ADMIN','WAREHOUSE')` on all mutations; `requireAuth` on reads.

### Out of scope
- Refactor of `services/wavePicking.js` to use new patterns (port verbatim, refactor post-Phase 6).
- New picker analytics (covered partially by WS-3 / Reports if at all).
- Mobile picker terminal redesign (same UX as today).

### Dependencies
- Schema migration runs (independent of other workstreams).
- WS-4 Auth provides the `signPickerToken` helper if it's not in `middleware/auth.js` already.
- WS-5 store.json migration must port pickers + waves + allocations.

### Risks
- **High** — `PickingAllocations` natural key is `(CompanyCode, SapDocEntry, SapOrderLineNum)` not `RunOrderId`. Migration script must JOIN to find `RunOrderId`. Bug here = pickers see wrong/missing allocations post-cutover.
- **Medium** — QC approval is currently auditless; new schema columns need to default sensibly for migrated rows (set `QcApprovedAt = NULL`).
- **Low** — picker token TTL: demoServer issues 30-day; align to driver-token's 7-day per `middleware/auth.js`.

### Effort
**L (10-12 days)** — largest workstream. ~250 lines of inline route logic + ~150 lines of state mutation in `persistentStore.js` to port + new schema + frontend tests.

### Rollback complexity
- Code: `git revert` is clean (new files; routes added but inert until cutover).
- Schema: forward migrations with no-data-loss are safe to leave applied even if cutover rolls back.
- Frontend: same `services/api.js` URLs; no frontend change needed.

### Business criticality
**CRITICAL.** Without this, the warehouse cannot pick after cutover. This is a cutover-blocker.

---

## WS-2 — Driver / Mobile

**Lead routes:** `routes/driver.js` (already has F2 P0 fix), new `routes/notify.js`, new `routes/stops.js` line-deliveries POST.

### Scope
- Verify `routes/driver.js` F2 ownership-check works for all 3 mutations.
- Port `POST /api/stops/:stopId/line-deliveries` to allow drivers to record per-line POD (`demoServer.js:968-988`). Requires `driverOwnsEntity` ownership check.
- Port `GET /api/notify/eta/:stopId` (`demoServer.js:1651`) — generates `wa.me`/`sms:` URLs. Driver-scoped.
- Verify `/api/driver/runs/:id/manifest` returns parity-shape to demoServer's version.
- Confirm mobile PWA service-worker cache invalidation strategy works.
- Confirm Socket.IO room subscription (`driver:<driverId>`) works post-cutover.

### Out of scope
- New driver app features (offline mode improvements, etc.).
- Push notifications (would be Phase 2+).
- Refactor of the GPS tracking polling loop.

### Dependencies
- Logistics SQL has `DeliveryStops`, `RunOrders`, `Drivers` tables migrated and populated (WS-5).
- `services/deliveryNotes.createDeliveryNoteForOrder` works against migrated data.

### Risks
- **High** — `signDriverToken` issues 7-day tokens but demoServer issues 30-day. After cutover, driver phones with 30-day tokens should still validate (lax JWT mode), but as TTL approaches, drivers must re-login. Mass re-login on a single day if all tokens were issued the same day = dispatch chaos.
- **Medium** — Socket.IO disconnect: drivers' phones get 1-2 minutes of "no live update" during cutover. Acceptable.
- **Low** — `notify/eta` SMS provider: `services/notifications.js` is currently a `console.log` stub (per `tech-debt.md`). After cutover, real SMS won't fire until provider is wired.

### Effort
**M (5-7 days)** — including the line-deliveries port and notify endpoint.

### Rollback complexity
- Code: `git revert` clean.
- F2 ownership check is already in place (P0 fix); no rollback risk there.

### Business criticality
**CRITICAL** — driver app is how deliveries get marked complete and how SAP delivery notes get created. Cutover-blocker.

---

## WS-3 — Reports / PDF / XLSX

**Lead:** new files in `services/reports/`, extensions in `routes/reports.js`. Source: `demoServer.js:2345-3239`.

### Scope
- Port 5 PDF generators: bulk-manifest, run/manifest, distribution-summary, loading-manifest, picking.
- Port 2 XLSX generators: delivery-notes.xlsx, invoices.xlsx.
- Each generator becomes its own file under `services/reports/` (separating data fetch from layout).
- `requireRole('ADMIN','PLANNER','WAREHOUSE')` on all report routes.
- **Frontend fix (CRITICAL):** modify `frontend/src/services/api.js:86-87` to attach Authorization on PDF/XLSX downloads. Two valid approaches:
  - (a) `fetch` + `Blob` URL pattern, OR
  - (b) signed-URL pattern (HMAC of path + expiry, validated by a new `requireSignedUrl` middleware).
  - Approach (a) is simpler; approach (b) is closer to industry standard.

### Out of scope
- New report templates.
- Layout polish.
- Excel formatting beyond what demoServer does today.

### Dependencies
- WS-1 (picking schema for pick-list reports).
- WS-5 (data populated in SQL — DeliveryRuns, DeliveryStops, RunOrders, etc.).

### Risks
- **High** — frontend fix forgotten = "Print Manifest" button 401s after cutover. Most-likely-to-be-missed task.
- **Medium** — PDF generator in `pdfkit` on Windows has font-rendering quirks; a font that works in demoServer may render differently if loaded from a different path. Verify font files in `backend/fonts/` are correctly pathed in the new services.
- **Medium** — Hebrew RTL rendering. `pdfkit` doesn't natively handle RTL; demoServer does manual reversal for Hebrew strings. Port the same logic, don't try to "fix" it.
- **Low** — XLSX file size; large bulk reports may exceed memory limits.

### Effort
**L (8-10 days)** — ~700 lines of inline `pdfkit`/`exceljs` to split + new frontend download flow.

### Rollback complexity
- Code: revert clean.
- Frontend fix can be deployed separately as a `frontend/dist/` build hot-swap.

### Business criticality
**HIGH** — drivers print manifests every morning; warehouse prints picking lists. Without this, day-of-cutover gets ugly fast even if everything else works.

---

## WS-4 — Auth / RBAC

**Lead:** `middleware/auth.js`, `routes/auth.js`, `sockets/index.js`.

### Scope
- Audit every route for correct `requireRole` per `route-matrix.md`.
- Add `signPickerToken` helper if not present (mirrors `signDriverToken`).
- Confirm Socket.IO handshake JWT verification works for picker tokens.
- `pickerOwnsAllocation()` and re-verify `driverOwnsEntity()`.
- Plan for `JWT_STRICT_VERIFY=true` flip post-cutover (T+8 days).

### Out of scope
- JWT revocation list (security-analysis F16) — deferred.
- TokenVersion column (F16) — deferred.
- 2FA — out of scope.

### Dependencies
- All other workstreams: each route they introduce must use `requireAuth` + `requireRole`.

### Risks
- **High** — overly tight role gates that break legitimate use (e.g., `requireRole('ADMIN')` on something planners need). Catch in shadow-run review.
- **Medium** — JWT_STRICT_VERIFY flip too early — drivers with legacy 30-day tokens 401. Must wait until rollout-stats counter is zero.
- **Low** — `JWT_AUDIENCE`/`JWT_ISSUER` mismatch between issuer and verifier — already correctly configured in `config/env.js`.

### Effort
**S-M (3-5 days)** — most of the work is review, not new code. Most route files already have `requireAuth`.

### Rollback complexity
- Per-route gates: revert clean.
- JWT flip: just unset env var.

### Business criticality
**CRITICAL** — every other workstream depends on this for security correctness. WS-4 is a precondition more than a blocking item.

---

## WS-5 — store.json migration

**Lead:** new `backend/scripts/migrate-store-to-sql.js`.

### Scope
- Author the one-shot script per `migration-architecture.md` §3.
- Schema migrations 013-019 per `migration-architecture.md` §3 (CityZoneOverrides, CustomerDocPolicies, CustomerHours, run/QC columns, LineDeliveries, CodCollections, DriverStats, DeliveryNotes Hub-side, Invoices Hub-side).
- Address synthesis: 816 stops have `AddressId=NULL` in store.json. Script synthesizes `NormalizedAddresses` rows from `Street/City/BranchName` first.
- PickingAllocations join: `(CompanyCode, SapDocEntry, SapOrderLineNum) → RunOrderId`.
- Idempotency: `WHERE NOT EXISTS` clause keyed on natural keys per entity.
- Three dry-runs in dev DB (Phase 2 in cutover-plan).

### Out of scope
- Live two-way sync between store.json and SQL. One-shot only.
- Re-derived `driverStats` rows (regenerate from migrated data, don't migrate stats).

### Dependencies
- WS-4 (no auth dependency — script runs server-side).
- Schema migrations 013-019 applied to dev DB before dry-run.

### Risks
- **HIGHEST RISK in entire migration.** A bug here corrupts production state silently.
  - Address synthesis fragility: `City` has trailing ZIPs, `BranchName` has quote variations — dedup is fragile. Phase 2 dry-runs MUST validate FK consistency post-INSERT.
  - PickingAllocations FK gap: missed JOIN = orphan allocations = picker scans 404.
  - IDENTITY collision risk if server.js had been writing to the same tables in parallel (it hasn't recently — last server.js run was 2026-05-06).
- **Medium** — duplicate INSERTs if natural-key dedup fails. WHERE NOT EXISTS clauses must be tested with re-run.
- **Medium** — script runtime: target <10 minutes on production-sized data. Profile in Phase 2.

### Effort
**M (5-7 days)** — including the schema migrations and three dry-runs.

### Rollback complexity
- Schema: forward migrations with no-data-loss safe to leave.
- Script: idempotent — running it again is fine.
- Production data: if cutover fails, the migrated rows in SQL persist but are unused (server.js not running). Harmless.

### Business criticality
**CRITICAL** — without migration, server.js shows empty UI on shared routes. Cutover-blocker.

---

## WS-6 — Shadow runtime

**Lead:** Phase 3 of `cutover-plan.md`.

### Scope
- Provision a shadow process: `cd backend && PORT=4001 node src/server.js` against a copied-to-dev `.env` pointing at a shadow DB.
- Run for 24-72 hours.
- Frontend dual-mode test: open production frontend (`:4000` demoServer) AND a shadow frontend (`:4001`) side-by-side. Walk every page.
- Compare response shapes, verify all CRITICAL paths.
- Capture worker behavior: do the 5 schedulers tick cleanly? Any new errors?
- Re-run migration script at end of shadow period to capture delta.

### Out of scope
- Performance benchmarking.
- Stress / load testing.

### Dependencies
- WS-1 through WS-5 must merge before shadow run starts (or at least the CRITICAL parts).
- Logistics SQL shadow DB ready.

### Risks
- **Medium** — discovering NEW bugs in shadow run that weren't in unit tests. Time pressure: each bug found in shadow risks delaying cutover by a week.
- **Low** — shadow-DB drift from production.
- **Low** — workers' SQL queries may not match current schema (unproven for 10 days). Shadow run is the proof.

### Effort
**S-M (3-7 days wall-clock; 1-2 days active)** — most is observation.

### Rollback complexity
- Stop the shadow process. Production unaffected.

### Business criticality
**HIGH** — without a shadow run, cutover risk is much higher. Skipping it would only be acceptable if the migration timeline is compressed and we accept a higher rollback rate.

---

## WS-7 — Frontend compatibility

**Lead:** `frontend/src/services/api.js`, selected `frontend/src/pages/*.jsx`.

### Scope
- Audit every API call in the frontend (per `route-matrix.md` Frontend caller column).
- Confirm wrapper methods in `services/api.js` match the new route signatures (which match demoServer's signatures by design — no breaking change).
- **Frontend PDF/XLSX download fix** — see WS-3 §Risks.
- **Cache invalidation:** ensure `frontend/dist/index-*.js` content-hash bumps on rebuild so browsers re-download. Standard Vite behavior; verify after build.
- **Service Worker:** `vite-plugin-pwa` registers an SW. Plan a "force unregister" mechanism for drivers (one-time JS that runs on first post-cutover load).
- **Socket.IO event subscription:** verify each `socket.on('event', ...)` in frontend lands in the right room post-cutover (no events get lost when room scoping tightens).

### Out of scope
- New UX.
- React 19 upgrade.
- Bundle size optimization.

### Dependencies
- WS-3 (PDF/XLSX download fix is most urgent here).
- WS-4 (Socket.IO room semantics post-cutover).

### Risks
- **High** — PDF download bug (already covered WS-3).
- **Medium** — service-worker stale cache: a driver's phone serving an old `index-*.js` after cutover may fail to authenticate against new auth model.
- **Low** — environment-specific paths (e.g., `/api` prefix). Verify deployment serves frontend from same Express, not a separate Nginx.

### Effort
**S-M (3-5 days)** — mostly review + the PDF/XLSX download conversion.

### Rollback complexity
- Hot-swap `frontend/dist/` from `C:\backups\frontend-dist\<TS>\` per `backup-inventory.md` §3.7.

### Business criticality
**HIGH** — without this, the post-cutover UI 401s on report downloads and may show stale assets.

---

## WS-8 — Workers / Queues

**Lead:** `backend/src/workers/*.js`, `backend/src/lib/intelligence/*.js`.

### Scope
- Verify all 5 production workers' SQL queries match the schema (after migrations 013-019 land).
- Add env kill-switches if any worker is unsafe to wake on cutover day:
  - `dailyDigestWorker` — first run sees yesterday's data. Disable for 24h post-cutover.
  - `cleanupWorker` — first run after dormancy may lock heavily. Disable until manual run with explicit batch size.
  - `ceoBriefScheduler` — env-gated; keep `CEO_BRIEF_SCHEDULE_ENABLED=false`.
  - `davoMixReportScheduler` — env-gated; keep `DAVO_MIX_REPORT_ENABLED=false`.
  - `sapSyncWorker` — should run; verify `SapRetryQueue` is empty before cutover.
- Confirm `lib/intelligence/eventStore.js` is no-op (Phase-1 stub) and stays that way through cutover.

### Out of scope
- Implementing real Bull/Redis queue (Tier 2 recommendation).
- Rewriting workers' SQL.
- Implementing `aiCostGuard` enforcement (P0 D5 deferred).

### Dependencies
- WS-5 (DB schema must be in place for workers to query).

### Risks
- **High** — `sapSyncWorker` retry of stuck delivery → duplicate SAP write if idempotency UDF (sync-analysis 1.1) is not in place. **Therefore: do NOT enable SAP_WRITE_ENABLED until WS-8 + idempotency UDF both done.**
- **Medium** — `cleanupWorker` first-run lock storm. Mitigate with manual batch + monitoring.
- **Medium** — `dailyDigestWorker` sends garbage email comparing migrated data to "yesterday" (which is pre-migration day).

### Effort
**S (2-4 days)** — mostly review + a few env kill switches added to ecosystem.

### Rollback complexity
- env unsetters: trivial.
- Code revert: clean.

### Business criticality
**MEDIUM** — workers being silent for a few extra days post-cutover is acceptable. Worker writes (sapSync) being incorrect is unacceptable.

---

## Workstream priority sequence

If everything ran serially (it shouldn't — most workstreams parallelize), the order would be:

1. **WS-4 (Auth)** — precondition for all other work.
2. **WS-5 (data migration script)** — biggest risk; needs longest dry-run period.
3. **WS-1 (Picking)** + **WS-2 (Driver)** — parallel, both CRITICAL.
4. **WS-3 (Reports)** — depends on WS-1/2 schema being settled.
5. **WS-7 (Frontend)** — depends on WS-3 (PDF/XLSX fix).
6. **WS-8 (Workers)** — last; depends on schema and ports.
7. **WS-6 (Shadow run)** — overlay across WS-1 through WS-8 once they merge.

In practice, parallelize: WS-1, WS-2, WS-3, WS-5, WS-8 can all be in flight simultaneously with different developers. WS-4 and WS-7 are review-heavy and can interleave.

## Dependency graph (text)

```
WS-4 (Auth) ────────────────────────┐
                                    ↓
                      WS-1 (Picking) ─────┐
                      WS-2 (Driver)  ─────┤
                      WS-5 (Data)    ─────┼──→ WS-6 (Shadow run) ─→ Cutover
                      WS-8 (Workers) ─────┤
                                          │
                      WS-3 (Reports) ─────┤
                              ↓           │
                      WS-7 (Frontend) ────┘
```

## Total estimated effort

| Workstream | Effort (days) |
|---|---|
| WS-1 Warehouse / Picking | 10-12 |
| WS-2 Driver / Mobile | 5-7 |
| WS-3 Reports / PDF / XLSX | 8-10 |
| WS-4 Auth / RBAC | 3-5 |
| WS-5 store.json migration | 5-7 |
| WS-6 Shadow runtime | 3-7 (wall-clock; 1-2 active) |
| WS-7 Frontend compatibility | 3-5 |
| WS-8 Workers / Queues | 2-4 |
| **Total (serial)** | **39-57 days** |
| **Total (parallel, 2 devs)** | **~3-4 weeks** |
| **Total (parallel, 3 devs + reviewer)** | **~2-3 weeks** |

End of workstream board.
