# Phase 0 — Freeze Policy

**Effective:** 2026-05-09 (start of Phase 0).
**Lifts:** when cutover (Phase 4) completes successfully and Phase 6 closes.
**Owner:** the operator who applies a change is responsible for compliance.
**Companion docs:** `cutover-plan.md`, `migration-architecture.md`.

The system is in a fragile pre-migration state. `demoServer.js` is what production traffic hits today; the safer `server.js` exists but is not mounted; ~10 days of operational state lives only in `backend/data/store.json`; the PM2 daemon itself has known instabilities. **Any change to this baseline that isn't strictly stabilizing-or-securing must wait.**

---

## 1. What is FROZEN (no exceptions)

### 1.1 No new features
- No new business logic in `routes/*.js`, `services/*.js`, or `frontend/src/pages/*.jsx`.
- No new dashboards, reports, KPIs, or visualizations.
- No new `/api/*` endpoints in either `server.js` or `demoServer.js`.
- "Bug fix that adds a flag to a response shape so the frontend can do something new" counts as a feature. Reject.

### 1.2 No AI / LLM / forecasting work
- No changes to `agents/*` or `lib/intelligence/*`.
- No new prompts, no new tool definitions for the CEO Brief agent.
- No new model rollouts (don't bump from `claude-sonnet-4-5` to a newer model "while you're in there").
- No work on `aiCostGuard` enforcement (P0 D5 stays deferred).
- No new forecasting models, no anomaly-detection tweaks, no stock-prediction algorithm changes.

### 1.3 No dashboard redesigns
- No restructuring of `pages/DashboardPage.jsx`, `WallboardPage.jsx`, `AnalyticsPage.jsx`, etc.
- No changes to layout, theme, navigation, or charts.
- No "make it more responsive" or "polish the UX while we're paused."
- Bug-fixes to *existing* UI behavior are allowed only if they meet §3 (reversibility + rollback notes).

### 1.4 No schema rewrites
- No changes to `database/migrations/001-012`.
- No `ALTER TABLE` against the live Logistics SQL DB beyond what migration files prescribe.
- No new migrations except those required by the migration plan itself (013-019 in `migration-architecture.md` §3 — those land during Phase 1, not Phase 0).
- Do NOT apply the 4 PENDING migrations (009-012 — already applied per `prisma-analysis.md`; the plan's reference to "PENDING" was stale). Confirm with operator before any migration `node src/db/migrate.js` run.

### 1.5 No SAP_WRITE_ENABLED flips
- `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` stay UNSET in `.env` for the entire freeze.
- This is the single most important rule. demoServer's anonymous `/api/sap/write/*` endpoints depend on this gate to not be a P0 SAP-write vector.
- Any operator considering enabling it must first read `migration-final-recommendation.md §1.4` and `sync-analysis.md §3` (idempotency UDF requirement).

### 1.6 No new PM2 apps, no ecosystem changes
- Do not add apps to `ecosystem.config.cjs`.
- Do not change the `script:` line of `sap-logistics`.
- Do not run `pm2 update`, `pm2 install pm2-windows-startup`, or `pm2 plus`.
- Migrating the daemon to a newer PM2 version is explicitly out of scope.

### 1.7 No state-format changes
- No changes to `backend/data/store.json` schema (don't add new top-level keys).
- No changes to `backend/src/demo/persistentStore.js` field names or types.
- No new entities introduced into demoServer that would expand the migration surface.

---

## 2. What IS allowed (the narrow lane)

### 2.1 Stabilization — applying the migration plan
- Phase 1 work: porting demoServer routes into `routes/*.js` per `cutover-plan.md`. These changes land in `server.js`-imported files only and are inert until cutover.
- Phase 2 work: writing the data migration script in `backend/scripts/`. Inert against production.
- Phase 3 work: shadow runtime on `PORT=4001`. Does not touch production.

### 2.2 Security — closing P0/P1 from `security-reaudit.md`
- Patches that close the F1-F36 list, applied to `routes/*.js` (already done for F1-F10) — **do not modify demoServer.js inline routes** unless the operator explicitly approves a band-aid (see §4).
- Rate-limit additions on auth endpoints.
- TLS posture flips (F11-F13) are ALLOWED but require ops sign-off (env change + restart).

### 2.3 Observability — adding monitoring without changing behavior
- Adding `apiLogger.info(...)` calls.
- Adding metrics endpoints (e.g., `/internal/metrics` if needed) behind `requireRole('ADMIN')`.
- Improving error messages (without leaking new info).
- Setting up external monitoring (Pingdom, UptimeRobot) against `/health`.

### 2.4 Operations — backups, snapshots, log archival
- Daily `store.json` snapshot per `backup-inventory.md`.
- Logistics SQL backups.
- Archiving rotated logs.
- PM2 `dump.pm2` snapshots.

### 2.5 Documentation
- All `docs/architecture-review/*.md` files.
- `INCIDENTS.md`, `TASKS.md` updates.
- `README.md` and runbook clarifications.

---

## 3. Mandatory rules for any production change

If a change passes the §2 filter, it MUST also satisfy:

### 3.1 Reversibility
- Every change is reversible by `git revert <commit>` plus at most one PM2 command.
- No destructive actions (DROP TABLE, DELETE without WHERE, file deletions outside `cf-tunnel.log`-style audited cleanups).
- No env-key removals — env keys can be added but not deleted during freeze.

### 3.2 Rollback notes
- Every commit message ends with a "Rollback:" line:
  ```
  feat(picking): add scan endpoint stub

  Inert until cutover. No-op for current demoServer process.

  Rollback: git revert <this-sha>; backend/src/routes/picking.js returns to prior state.
  ```
- Every PM2-affecting change ends with explicit recovery steps:
  ```
  Rollback:
  1. pm2 stop sap-logistics
  2. git revert <sha>
  3. pm2 start ecosystem.config.cjs --only sap-logistics
  4. pm2 save
  ```

### 3.3 No production restart unless required
- Phase 0 expects the production process to keep running undisturbed.
- The only sanctioned restart in Phase 0 is the controlled PM2 stabilization window (see `pm2-stabilization.md`).
- `pm2 restart sap-logistics --update-env` is forbidden during Phase 0 — it would re-trigger the same orphan-port issue documented in `pm2-stabilization.md`.

### 3.4 Audit trail
- Every production change is logged in `cowork/INCIDENTS.md` with:
  - Date/time
  - Operator name
  - Change description
  - Files touched
  - Rollback command
  - Verification step performed

### 3.5 Two-person review for risky changes
- Any change to `ecosystem.config.cjs`, `backend/.env`, `backend/src/demo/`, or `backend/data/store.json` requires a second person's review before merge.
- Any change that involves running a `pm2 start`/`pm2 delete` against production requires a second person on call.

---

## 4. Band-aid policy (demoServer hardening)

There's a temptation to "just add `requireAuth` to demoServer's most exposed routes" mid-freeze. The migration plan (`cutover-plan.md` Phase 0 §5) lists this as optional. **Default position: do NOT band-aid.** Reasons:

- demoServer's anonymous routes are an known issue tracked as F31-F36 in `security-reaudit.md`. They close on cutover.
- Any edit to demoServer.js increases the chance of a stale-PM2-dump regression like the 2026-05-06 one.
- Mid-freeze edits to demoServer make it harder to compare migrated route behavior to the "frozen baseline" during shadow run.
- The two CRITICAL anonymous endpoints (`/api/sap/write/delivery-note/:id`, `/api/sap/write/invoice/:id`) are environment-gated — `SAP_WRITE_ENABLED` is UNSET. The risk is latent, not active.

**Exception clause:** if the operator confirms via `cowork/INCIDENTS.md` that an active exploit attempt was observed (CRITICAL-severity log entry), a focused 4-line `requireAuth`-style middleware patch on the abused endpoint is acceptable. Document the patch with a `Rollback:` clause that explicitly removes the patch on cutover day.

---

## 5. What to do when an exception comes up

| Situation | Action |
|---|---|
| Sales/marketing pushes for a new dashboard feature | Cite this doc; queue for post-Phase-6. |
| Driver reports a bug in demoServer behavior | Triage. If pure UX → defer to post-cutover. If data-loss → operator + second reviewer + `INCIDENTS.md` entry + minimal `Rollback:` patch. |
| Security finding lands (new CVE in dependency) | If actively exploitable → patch via `npm audit fix` only on the specific package (no broad upgrade). If theoretical → defer to post-cutover. |
| Anthropic releases a newer model | Ignore until post-Phase-6. |
| Operator wants to enable `SAP_WRITE_ENABLED` | Hard NO during freeze. If business pressure, escalate to plan owner — answer is still no until idempotency UDF is in place (sync-analysis 1.1). |
| `pm2 restart` is needed because of an unrelated incident | Use the `pm2-stabilization.md` procedure. Don't take shortcuts. |
| Frontend asset change request (logo update, copy fix) | Allowed if (a) pure assets, no JS logic, (b) can ship by replacing files in `frontend/dist/` without rebuild, (c) has a `git revert`-clean rollback. |

---

## 6. End-of-freeze criteria

The freeze lifts when ALL of these are true:

1. Cutover (Phase 4) completes and the validation gates in `cutover-plan.md` Phase 4 all pass.
2. Phase 5 rollback drill executes successfully.
3. 7 days of post-cutover stable operation (workers ticking, no `[worker] tick failed Connection is closed` storm beyond historical baseline, no SAP write anomalies).
4. Phase 6 retirement complete (demoServer code archived; `store.json` archived).
5. `cowork/TASKS.md` migration task closed.

Until then, this freeze is in force.

---

## 7. Sign-off

This document is a policy. Compliance is mandatory for anyone with commit access or PM2 access during the freeze period. Violations should be logged in `cowork/INCIDENTS.md` and rolled back per §3.2.
