# Operational Risk Register — Phase 0

Comprehensive register of every identified risk in the system today, ordered by category. Each risk has: probability, impact, detection method, mitigation, rollback option, owner, and status.

**Conventions:**
- **Probability:** L (Low <10%), M (Medium 10-50%), H (High >50%) — over the next 4-6 weeks (Phase 0 + early Phase 1).
- **Impact:** L (recoverable, single-user), M (multi-user, half-day), H (multi-day outage / data loss / financial), C (Critical — business-stopping).
- **Status:** OPEN / MITIGATED / CLOSED / ACCEPTED. ACCEPTED means we know about it but choose not to mitigate during Phase 0.

---

## A. Production outage risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| A1 | sap-logistics process crash (OOM, unhandled rejection, OneDrive lock) | M | C | UptimeRobot /health; PM2 monitoring §3 | `pm2-maintenance-runbook.md`; orphan-aware restart procedure | `dump.pm2.PRE-CLEANUP-*` snapshot | Operator | OPEN — to mitigate via PM2 maintenance window |
| A2 | PM2 daemon wedge (cannot stop/start any app) | H | H | `pm2 jlist` >180s response | `pm2-maintenance-runbook.md` Section D | reboot host as last resort | Operator | OPEN — daemon currently congested per pm2-stabilization.md |
| A3 | Port 4000 collision after a future restart (orphan-on-port pattern from sap-bi-api) | H | C | `Get-NetTCPConnection -LocalPort 4000` returns multiple | Pre-restart: kill orphan first; runbook B.1 + D.1 | Section D.1 of runbook | Operator | OPEN |
| A4 | Host reboot triggers `pm2 resurrect` from stale dump | M | M | `pm2 jlist` after reboot shows wrong `pm_exec_path` | Keep `dump.pm2` snapshot; document reboot procedure (kill orphans first) | restore `dump.pm2.PRE-CLEANUP-*` | Operator | OPEN — same root cause as 2026-05-06 regression |
| A5 | OneDrive sync lock blocks file writes (store.json, logs, dump.pm2) | M | M | EBUSY/EPERM in error.log; backup automation logs | OneDrive paused during maintenance windows | Restart OneDrive; manual unlock | Operator | OPEN — long-term fix is moving data/ off OneDrive (Phase 1) |
| A6 | Backend SQL connection pool exhausted | L | M | `[worker] tick failed Connection is closed` storm | Restart sap-logistics in maintenance window | restart restores fresh pool | Operator | OPEN — known recurring noise; not currently fatal |
| A7 | Anthropic API outage breaks /api/agents/* | L | L | 5xx from /api/agents endpoints | none — graceful degradation already returns 503 | wait for vendor recovery | Operator | ACCEPTED — out of scope; LLM endpoints are non-critical |
| A8 | Disk full on C: | M | C | monitor-host.ps1 disk check | Daily backup retention; weekly log compression; uploads off-host weekly | manual cleanup of `C:\backups\` | Operator | OPEN |
| A9 | Cloudflare quick-tunnel URL changes (silent reachability drop) | M | M | UptimeRobot down-alert | `tunnel-url-watcher` updates Vercel; cf-tunnel-error.log mining (F37 lifecycle) | restart cloudflared | Operator | ACCEPTED for Phase 0; named-tunnel migration is post-cutover |
| A10 | Public-LAN routing change blocks driver phones | L | H | drivers report inability to login | Confirm LAN routing weekly | revert network change | Network admin | OPEN |
| A11 | All 5 production workers wake on cutover with stale schema queries | M | H | error.log floods with `[worker] tick failed` | Phase 3 shadow run validates worker queries | env kill-switches per `cutover-plan.md` Phase 4 | Operator | OPEN — to mitigate during Phase 3 |

---

## B. Data loss risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| B1 | `store.json` corruption (truncated write, OneDrive partial sync) | L | H | `node -e JSON.parse` fails on backup validation | atomic write pattern in persistentStore.js (write to .tmp first); daily snapshots | restore latest valid snapshot per `backup-inventory.md` §3.3 | Operator | MITIGATED via daily backup |
| B2 | `dump.pm2` corruption (manual edit, OneDrive sync, daemon crash mid-save) | L | M | `pm2 resurrect` fails or restores wrong apps | daily dump snapshots; `pm2 save` logs success | restore `dump.pm2.PRE-CLEANUP-*` | Operator | MITIGATED via daily backup |
| B3 | `backend/.env` accidentally committed to git | M | C (credentials leak) | git pre-commit hook (NOT installed today); manual review | `.gitignore` lists .env; encrypted off-host backup | rotate ALL credentials immediately | Operator | OPEN — recommend pre-commit hook |
| B4 | Logistics SQL data corruption (page tear, disk failure, schema drift) | L | C | DBCC CHECKDB; failed queries | Weekly FULL backup; daily DIFF; hourly LOG; `BACKUP VERIFYONLY` | restore from latest good backup | DBA / Operator | MITIGATED if SQL Agent jobs are configured per `backup-automation-plan.md` §4 |
| B5 | Uploads (signatures, photos) lost (disk failure, accidental delete) | L | H | spot-check via curl on a recent upload URL | daily incremental backup via robocopy; weekly full sync off-host | restore from `C:\backups\uploads\<TS>\` | Operator | MITIGATED via daily backup |
| B6 | Cutover-window data loss (writes between snapshot and PM2 switch) | M | M | count-diff between store.json snapshot and migrated DB rows | Phase 4 cutover sequence: T-30 snapshot, T-15 freeze, T-0 switch | manually replay 1-2 hour delta from store.json archive | Engineer | OPEN — to address during Phase 4 |
| B7 | Encrypted .env backup decryption failure (forgotten passphrase) | L | C | quarterly restore drill | passphrase stored separately from backup; documented in operator's password manager | re-acquire credentials manually from each provider | Operator | OPEN — passphrase storage is operator responsibility |
| B8 | git history loss (force-push, repo deletion) | L | M | git fsck weekly | mirror to second remote (GitHub fork or local Gitea) | clone from local working copies | Operator | OPEN — recommend secondary remote |
| B9 | OneDrive sync deletes files thinking they're orphaned | L | M | OneDrive activity log; daily backups | OneDrive sync paused on backend/data/ during maintenance windows | restore from local backup | Operator | OPEN |

---

## C. Inventory corruption risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| C1 | PickingAllocations FK orphan after migration (RunOrderId join misses) | M | H | Phase 2 dry-run validation: `SELECT COUNT(*) FROM PickingAllocations WHERE RunOrderId IS NULL` | 3× dry-run before cutover; Phase 4 abort gate on count diff | restore SQL DB to PRE-CLEANUP backup | Engineer | OPEN — primary risk per `migration-final-recommendation.md` §1.6 |
| C2 | Picker scans wrong allocation post-migration (because IDs renumbered) | M | H | spot-check: pick a known SapDocEntry, verify scan resolves | natural-key dedup in migration script | revert SQL + replay store.json to known good | Engineer | OPEN |
| C3 | Driver marks wrong stop delivered (because StopId IDENTITY collided) | L | C | post-cutover spot-check; SAP DocEntry-to-stop reconciliation | migration script asserts no IDENTITY conflict | revert; rebuild | Engineer | OPEN — covered by Phase 2 dry-runs |
| C4 | Wave allocation lost during migration (505 waveLines + 826 allocations) | L | H | count diff at end of migration script | Phase 2 dry-run validates counts | re-run idempotent migration | Engineer | OPEN |
| C5 | Address synthesis dedup fails (city has trailing ZIP, branch has quote variations) | M | M | duplicate AddressId rows per the same physical address | manual sample + fuzzy-match validation | manual cleanup post-cutover | Engineer | OPEN — known fragile per `store-json-analysis.md` |

---

## D. Duplicate SAP write risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| D1 | sapSyncWorker retry creates duplicate ODLN (delivery note) without idempotency UDF | M | H | post-cutover SAP audit: same `(CardCode, Total)` two days running | `sync-analysis.md` recommendation 1.1 — `U_HubRunOrderId` UDF; `SAP_WRITE_ENABLED` stays UNSET until UDF in place | manually cancel duplicate ODLN in SAP | Engineer + SAP admin | OPEN — gating gate is `SAP_WRITE_ENABLED` env |
| D2 | Anonymous `/api/sap/write/delivery-note/:id` triggered while `SAP_WRITE_ENABLED=true` | L | C | SAP audit; sapWriter logs | F32 / `freeze-policy.md`: env stays UNSET; consider `adminOnly` band-aid (`exposure-reduction-options.md` §6) | manual SAP cleanup | Operator | OPEN — env-gated; band-aid optional |
| D3 | SapRetryQueue rows from before 2026-05-06 fire after cutover with wrong EntityIds | M | H | `SELECT * FROM SapRetryQueue WHERE Status='PENDING'` before cutover | Phase 4 pre-cutover step: `UPDATE SapRetryQueue SET Status='FAILED_PERMANENT' WHERE CreatedAt < cutoverDate` | manual SAP audit; cancel duplicates | Engineer | OPEN — to address in Phase 4 prep |
| D4 | Driver completes a stop twice (offline replay or double-tap) | L | M | per-stop `CompletedAt` + idempotent server-side check | demoServer's idempotency: checks `SapDeliveryDocEntry IS NULL` before POST | manual SAP cancel | Operator | ACCEPTED — current demoServer behavior is the floor |
| D5 | Worker tick races itself (two workers in cluster mode) | L | H | duplicate processing logs | PM2 single-instance configured; cluster mode NOT used | `pm2 stop` + restart single-instance | Operator | MITIGATED — confirmed `instances: 1` in ecosystem |

---

## E. Authentication / authorization bypass risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| E1 | Anonymous user CRUD (F34) — account takeover from any IP | H if internet-reachable | C | curl-from-internet probe; HTTP-access logs | `exposure-reduction-options.md` §2 Option B — 10-line `adminOnly` band-aid | revert band-aid commit | Operator | OPEN — band-aid pending operator approval |
| E2 | `/m/admin/:shortId` (F31) credential vending — leaked URL = 30d JWT | M | H | abuse pattern in access logs; suspicious user-agent | Option D — TTL → 1h, single-use | revert | Operator | OPEN — band-aid pending |
| E3 | Anonymous run management (F35) — operational disruption | H if internet-reachable | M | unexpected runs created/deleted | `plannerOrAdmin` middleware (10 lines) | revert | Operator | OPEN — band-aid pending |
| E4 | Anonymous picker management (F36) + 30d picker tokens | H if internet-reachable | M | picker enumeration | adminOnly + TTL 12h | revert | Operator | OPEN |
| E5 | Anonymous customer/analytics/drivers reads (F4/F6/F7) — PII exfil | H if internet-reachable | H | curl probe | requireAuthBasic middleware | revert | Operator | OPEN |
| E6 | DRIVER token IDOR on stops/orders (F2 closed in routes/driver.js but inert today) | N/A — demoServer is anon | n/a | n/a | F2 P0 fix already in routes/driver.js; activates at cutover | revert that commit | Engineer | MITIGATED for post-cutover; OPEN today (because demoServer's driver routes are anonymous) |
| E7 | Socket.IO `cors:'*'` (F1 closed in sockets/index.js but inert today) | N/A — demoServer has anon | n/a | n/a | F1 P0 fix activates at cutover | revert | Engineer | MITIGATED for post-cutover |
| E8 | JWT_STRICT_VERIFY flip too early — driver phones 401 | L | C | mass driver-login failures | flip only after `getJwtRolloutStats().legacyAccepted == 0` for 24h | unset env var | Operator | ACCEPTED for Phase 0; flip is post-cutover decision |
| E9 | Stolen JWT used until 7-day TTL (no revocation) | L | M | unusual usage patterns; abuse reports | JWT_SECRET rotation forces all tokens to expire | rotate JWT_SECRET (forces re-login of everyone) | Operator | ACCEPTED — F16 deferred to post-cutover |
| E10 | demoServer's 30-day driver/picker tokens valid post-cutover (lax JWT mode) | M | M | driver-login dates from before cutover | JWT_STRICT_VERIFY flip at T+8 days; coordinated re-login | unset strict mode | Operator | OPEN — to address in Phase 4/5 |
| E11 | `auditMiddleware` accidentally applied to a token endpoint, leaking JWT | L | C | code review at PR time | freeze policy + documentation in `security-reaudit.md` §5 | revert | Engineer | MITIGATED via documentation |

---

## F. PM2 / infrastructure risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| F-pm1 | PM2 daemon wedge during operator command (RPC hang) | H | M | `pm2 list` >2min | runbook B.1; orphan-kill before `pm2 stop` | reboot host last resort | Operator | OPEN |
| F-pm2 | Future `pm2 restart sap-logistics` repeats sap-bi-api's crash loop on port 4000 | H | C | restart_time spikes; EADDRINUSE in error.log | runbook D.1: kill orphan first | restore prior dump | Operator | OPEN — to address in maintenance window |
| F-pm3 | `tunnel-url-watcher` cron pollution of pm2.log | H | L | `pm2.log` grows >5 MB/4h | optional `pm2 stop tunnel-url-watcher` (with sap-bi project owner approval) | `pm2 start tunnel-url-watcher` | Operator | ACCEPTED — log noise only |
| F-pm4 | OneDrive sync intercepts a `dump.pm2` save mid-write | L | M | corrupt `dump.pm2`; resurrect fails | OneDrive paused during pm2 save; daily dump snapshot | restore from `C:\backups\pm2\` | Operator | OPEN — long-term fix is moving off OneDrive |
| F-pm5 | sap-bi-api memory cap retriggers; another orphan-on-4001 cycle | H | L (out of scope app) | UptimeRobot has no probe for 4001; pm2 jlist | runbook B.1 | redo runbook | Operator | OPEN — recurring; not our app |
| F-pm6 | PM2 update via `pm2 update` mid-operation breaks daemon | L | C | upgrade rolled in | freeze policy: do NOT update PM2 during freeze | restore daemon from backup | Operator | MITIGATED via documentation |
| F-pm7 | `sap-bi-api` 23,008 restarts have eaten file handles / memory | M | M | host-side memory + handle counts climbing | runbook B.1 stops the loop | host reboot | Operator | OPEN — addressed in maintenance window |

---

## G. store.json corruption risks (specific subset)

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| G1 | Concurrent writes during process crash (writeFileSync mid-write) | L | M | parse failure on read | persistentStore writes to .tmp first then renames (verify in code review) | restore latest snapshot | Operator | MITIGATED — pattern is in persistentStore.js |
| G2 | OneDrive thinks store.json conflict, creates `store-Backup-(1).json` | M | M | unexpected files in `data/` | Pause OneDrive on data/ during writes; daily snapshot | merge or replace | Operator | OPEN |
| G3 | Disk full mid-write → truncated file | L | H | parse failure | disk monitor §3.1 step 4; retain last 30 snapshots | restore | Operator | OPEN — disk monitoring is mitigation |
| G4 | Manual edit corrupts JSON | L | M | parse failure on next demoServer startup | atomic-restore; daily snapshots | restore | Operator | ACCEPTED — operator discipline |
| G5 | demoServer crashes mid-write while data/ is on OneDrive | L | M | parse failure | atomic-write pattern; daily snapshots; OneDrive pause during maintenance | restore latest snapshot | Operator | OPEN |

---

## H. Manifest / report failure risks

| # | Risk | Prob. | Impact | Detection | Mitigation | Rollback | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| H1 | Frontend PDF/XLSX `<a href>` 401s after cutover (no Authorization header) | H | H | smoke test on cutover day | WS-3 / WS-7: convert to fetch+Blob OR signed-URL pattern | hot-swap frontend dist from backup | Engineer | OPEN — primary cutover-day risk |
| H2 | pdfkit Hebrew RTL rendering breaks after port to services/reports/ | M | M | visual check against demoServer's output | port verbatim, don't "fix" RTL | revert PDF generator file | Engineer | OPEN |
| H3 | Font path break post-port (fonts in `backend/fonts/`) | L | M | PDF without proper font, falls back to default | verify path resolution at boot | revert | Engineer | OPEN |
| H4 | XLSX bulk export OOM | L | M | server crashes generating large report | streaming write pattern in exceljs; cap row count per request | abort request | Engineer | OPEN |
| H5 | Manifest contents inconsistent post-cutover (data fetched from new SQL but generator expects old shape) | M | H | side-by-side comparison with demoServer output | Phase 3 shadow run validates each report visually | revert | Engineer | OPEN |
| H6 | Public tracking URL exposes more data than intended after refactor | L | M | Code review of trackingTokens.js | F15 mitigation deferred to post-cutover; no change planned in Phase 0 | revert any refactor | Engineer | ACCEPTED |

---

## I. Risk priority matrix (top 10 to mitigate this week)

Ranked by `Probability × Impact` — over the next 4-6 weeks (Phase 0 + early Phase 1):

| Rank | Risk | Why top |
|---|---|---|
| 1 | **A2** PM2 daemon wedge | Daemon already congested; every `pm2 list` takes 2 min today |
| 2 | **A3** Future `pm2 restart` triggers orphan-on-port-4000 | `sap-bi-api`'s exact pattern is one bad command away from sap-logistics |
| 3 | **F-pm2** Future restart repeats sap-bi-api's crash loop | Same as #2 from a different angle |
| 4 | **E1** F34 anonymous user CRUD | Account takeover from any IP if internet-reachable |
| 5 | **E5** F4/6/7 anonymous reads (PII exfil) | Same network condition |
| 6 | **A8** Disk full | 24 GB free already noted on initial inspection — needs monitoring |
| 7 | **D1** Duplicate SAP write via sapSyncWorker without UDF | Cutover-day risk; mitigated by `SAP_WRITE_ENABLED` staying UNSET |
| 8 | **B6** Cutover-window data loss | 100+ stops written per hour during business; minimize gap |
| 9 | **A4** Host reboot triggers stale `pm2 resurrect` | The exact 2026-05-06 regression — could happen any time |
| 10 | **H1** Frontend PDF/XLSX 401 after cutover | Most-likely-to-be-missed cutover-day failure |

---

## J. Phase 0 mitigation roadmap (week-by-week)

### Week 1 (now)
- [ ] **A1, A2, A3, F-pm1, F-pm2, F-pm5:** Schedule PM2 maintenance window per `pm2-maintenance-runbook.md`. ~60 min Sunday.
- [ ] **B1, B2, B5, A8:** Set up backup automation per `backup-automation-plan.md`. 4-6 hours.
- [ ] **A1, A8, F-pm5:** Set up monitoring per `monitoring-setup.md`. 4-6 hours.
- [ ] **E1 (F34):** Operator decides on band-aid per `exposure-reduction-options.md` §12. Document choice in `cowork/INCIDENTS.md`.

### Week 2
- [ ] **E1, E2, E5:** If band-aids approved, deploy in single PR after PM2 maintenance succeeds.
- [ ] **B7:** Verify .env encrypted backup; rehearse restore.
- [ ] **B3:** Install pre-commit hook to block .env from git.
- [ ] **A4:** Document host-reboot procedure (kill orphans first; restore PRE-CLEANUP dump).
- [ ] **A10:** Operator confirms current network reachability. Update §10 of `exposure-reduction-options.md`.

### Week 3-4
- [ ] **D3:** Audit `dbo.SapRetryQueue` — flag anything older than 7 days as `FAILED_PERMANENT`.
- [ ] **B4:** Rehearse SQL restore monthly drill.
- [ ] **E10:** Track `getJwtRolloutStats().legacyAccepted` — must reach zero before strict mode flip.
- [ ] **A11:** Begin Phase 3 prep (shadow runtime planning).

### Week 5-6 (overlap with Phase 1)
- [ ] **C1, C2, C4, C5:** Phase 2 migration script dry-runs.
- [ ] **H1, H5:** Phase 1 frontend PDF/XLSX fix (WS-3 + WS-7).
- [ ] **A11:** Phase 3 shadow run captures any worker-query incompatibility.

---

## K. Out-of-scope risks (acknowledged, not mitigated in Phase 0)

| # | Risk | Why deferred | Tracked in |
|---|---|---|---|
| K1 | Long-term scaling (single-host bottleneck) | Tier 3 in `recommendations.md` | `recommendations.md` |
| K2 | AI cost runaway (no aiCostGuard enforcement) | P0 D5 deferred for budget decision | `p0-fixes-applied.md` D5 |
| K3 | Insights.AgentRunId schema mismatch | P0 D4 deferred; no business impact today | `p0-fixes-applied.md` D4 |
| K4 | KPI inconsistency (3 revenue definitions) | P0 D3 deferred for finance decision | `p0-fixes-applied.md` D3 |
| K5 | sap-bi-api crash loop | Different project | `pm2-stabilization.md` |
| K6 | tunnel-url-watcher cron design | Different project | `pm2-stabilization.md` |
| K7 | Public tracking surface (F15 — driver name + plate + GPS exposed for 48h) | Tier 1 deferred per `recommendations.md` | `recommendations.md` |
| K8 | Driver token revocation (F16) | Schema change required; deferred | `security-analysis.md` F16 |
| K9 | `/uploads/*` static auth (F17 — accidentally closed today, reopens at cutover) | WS-2 handles at cutover | `workstreams.md` WS-2 |
| K10 | Multi-instance horizontal scale | post-Phase-6 | `recommendations.md` Tier 3 |

---

## L. Owner roster

| Owner | Responsibilities |
|---|---|
| **Operator** (primary) | All A* and F-pm* risks; Phase 0 hands-on; INCIDENTS.md |
| **Backup operator** | Coverage during maintenance windows |
| **DBA / Operator** | B4 SQL backups; C* schema risks during migration |
| **Engineer** | Phase 1 porting; H1 frontend fix; D1 idempotency UDF; migration script |
| **SAP admin** | D1, D2 SAP-side investigation if duplicates appear |
| **Network admin** | A10 LAN/cloud routing; tunnel transitions |
| **Finance / Cost owner** | K2 AI budget; K4 revenue definition |

---

## M. Document references

- `freeze-policy.md` — what's allowed during Phase 0
- `pm2-stabilization.md` — root cause of A2/A3/F-pm*
- `pm2-maintenance-runbook.md` — operational fix for A2/A3
- `backup-inventory.md` + `backup-automation-plan.md` — mitigation for B*
- `observability-checklist.md` + `monitoring-setup.md` — detection layer for everything
- `exposure-reduction-options.md` — band-aid options for E*
- `route-matrix.md`, `store-json-analysis.md`, `migration-architecture.md`, `cutover-plan.md`, `workstreams.md` — Phase 1+ scope (mitigates C*, D*, H*)
- `migration-final-recommendation.md` — synthesis
- `security-analysis.md` + `security-reaudit.md` — sources for E*
- `cowork/INCIDENTS.md` — where mitigation actions are logged

End of risk register.
