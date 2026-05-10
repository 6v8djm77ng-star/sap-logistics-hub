# Operator Execution Checklist — Emergency Wave A Deployment

**Use this checklist when actually deploying.** Print it; tick boxes as you go. **Do not skip steps.**

**Companion docs:**
- `emergency-mitigation-plan.md` — full plan + Wave A patch design
- `pm2-maintenance-runbook.md` — required prerequisite
- `tunnel-dependency-analysis.md` — context for keeping tunnel up
- `post-mitigation-verification.md` — full probe matrix
- `external-reachability-report.md` — why we're doing this

**Conventions:**
- ☐ = unchecked, ☑ = done, ⚠ = partial / needs attention.
- Each section ends with an OPERATOR SIGNOFF line — date + initials.
- Any unchecked box past its section: **do not advance**.

---

## Section A — Pre-deploy backups verified

Goal: every artifact that could need restoration is backed up and validated within the last 12 hours.

```text
☐ A.1 dump.pm2 backup exists with mtime within last 12h:
       Get-ChildItem 'C:\backups\pm2\dump.pm2.*' | Sort LastWriteTime -Descending | Select -First 1
       — confirm mtime < 12h ago

☐ A.2 store.json backup exists with mtime within last 12h:
       Get-ChildItem '..backend\data\archive\store.json.*' | Sort LastWriteTime -Descending | Select -First 1
       — confirm mtime < 12h ago AND parse-OK:
       node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <path>

☐ A.3 Logistics SQL backup taken within last 24h.
       Run from sqlcmd:
       SELECT TOP 1 backup_finish_date FROM msdb.dbo.backupset
         WHERE database_name='SAP_Logistics_Hub' AND type='D' ORDER BY backup_finish_date DESC;
       — confirm date is today or yesterday.

☐ A.4 .env file is backed up encrypted off-host (per backup-inventory.md §2.5).
       Confirm backup file mtime is recent if .env was edited recently;
       if .env hasn't changed in months, the existing backup is fine.

☐ A.5 git working tree is clean OR has only documentation changes:
       cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"
       git status --short
       — expect only docs/architecture-review/ changes; no backend/src/ changes.

☐ A.6 git remote pushable:
       git remote -v
       git fetch origin
       — confirm fetch succeeds (network reachable).
```

OPERATOR SIGNOFF Section A: __________ (date) __________ (initials)

---

## Section B — PM2 stabilization completed

Goal: confirm the daemon is responsive and sap-logistics is the original 2026-05-06 child OR a controlled restart.

```text
☐ B.1 pm2 list returns within 10 seconds:
       Measure-Command { pm2 list } | Select TotalSeconds
       — expect <10s.

☐ B.2 sap-logistics is online:
       pm2 describe sap-logistics | Select-String 'status'
       — expect "status: online".

☐ B.3 sap-logistics restart_time logged value matches last documented value
       (per pm2-stabilization.md or last INCIDENTS.md restart entry).
       pm2 jlist | ConvertFrom-Json | Where {$_.name -eq 'sap-logistics'} | Select pm2_env.restart_time
       — match against last known.

☐ B.4 No orphan on port 4000 other than sap-logistics:
       $tcp = Get-NetTCPConnection -LocalPort 4000 -State Listen
       $j = pm2 jlist | ConvertFrom-Json
       $expected = ($j | Where {$_.name -eq 'sap-logistics'}).pid
       — confirm $tcp.OwningProcess -eq $expected (single match).

☐ B.5 No orphan on port 4001:
       Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue
       — expect nothing returned (sap-bi-api drained per pm2-maintenance-runbook).

☐ B.6 PM2 daemon log not erupting:
       Get-Content 'C:\Users\izik\.pm2\pm2.log' -Tail 20
       — should NOT see "Process with pid X could not be killed" or fresh pidusage storms.

☐ B.7 INCIDENTS.md has a recent (within 7 days) PM2 maintenance entry confirming success.
```

If any box ⚠ or ☐, **STOP**. Re-run `pm2-maintenance-runbook.md` first. Wave A deploy attempted on a wedged daemon will hang at Step 7.

OPERATOR SIGNOFF Section B: __________ (date) __________ (initials)

---

## Section C — Tunnel status confirmed

Goal: confirm the tunnel is up (so the post-deploy probes can validate from the public URL) AND that disabling it isn't part of this window's scope.

```text
☐ C.1 cloudflare-tunnel PM2 app is online:
       pm2 describe cloudflare-tunnel | Select-String 'status'
       — expect "status: online".

☐ C.2 cloudflared.exe processes running:
       tasklist | Select-String "cloudflared"
       — expect at least 2 processes (cloudflare-tunnel + sap-bi-tunnel).

☐ C.3 Latest tunnel URL extracted from cf-tunnel-error.log:
       grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' backend/logs/cf-tunnel-error.log | tail -1
       — record the URL: ____________________________________________
       — expected at investigation time: https://contribute-maker-archives-metres.trycloudflare.com

☐ C.4 Public URL responds 200 to /health:
       curl -s -o NUL -w "%{http_code}" --connect-timeout 8 https://<URL>/health
       — expect 200.

☐ C.5 Operator confirmed (per tunnel-dependency-analysis.md §8):
       — customer SMS tracking is in active use:  yes / no
       — mobile-link admin onboarding is in active use:  yes / no
       — if EITHER yes: do NOT disable the tunnel as part of this window.
```

OPERATOR SIGNOFF Section C: __________ (date) __________ (initials)

---

## Section D — Probe matrix prepared

Goal: confirm all the endpoints we'll be testing are responding as expected BEFORE the deploy. Use the table from `post-mitigation-verification.md`.

```text
☐ D.1 Pre-deploy baseline curls executed against the public URL.
      Record results in worksheet (filename: pre-wave-a-probe-<TS>.txt).
      Expected pre-deploy:
        /health                                  → 200
        /api/customers/search?q=test (no auth)   → 200 with PII (the bug we're fixing)
        /api/drivers (no auth)                   → 200 with PII
        /api/users (no auth)                     → 200 with users
        /api/sap/write/delivery-note/1 (no auth) → 503 or 200 (env-gated dry-run)
        /m/admin/<random-fake-id> (no auth)      → 404 (no map entry)

☐ D.2 ADMIN token obtained (login via UI; copy from devtools network tab).
       Record: ADMIN_TOKEN=__________________________________________ (NEVER commit)

☐ D.3 DRIVER token obtained (login on a driver phone or via curl).
       Record: DRIVER_TOKEN=_________________________________________

☐ D.4 Authed pre-deploy probes executed:
        /api/customers/search authed (ADMIN)     → 200
        /api/users authed (ADMIN)                → 200
        /api/users authed (DRIVER)               → 200 (currently! that's the bug we're closing)

☐ D.5 Frontend smoke test (browser):
        — Login to UsersPage with ADMIN: shows users list ☐
        — Login to RunsPage with PLANNER: shows runs ☐
        — Customer SMS tracking link from a recent run: opens TrackingPage ☐
        — Driver mobile app login: works ☐

       Take screenshots; save to incidents folder for before/after comparison.
```

OPERATOR SIGNOFF Section D: __________ (date) __________ (initials)

---

## Section E — Health endpoints ready

Goal: monitoring is in place to detect any post-deploy regression within 5 minutes.

```text
☐ E.1 UptimeRobot monitor on /health is active and showing UP.
       (External monitor; verify in UptimeRobot dashboard.)

☐ E.2 monitor-host.ps1 (per monitoring-setup.md §3) is scheduled and last ran <10 min ago.
       Get-ScheduledTaskInfo -TaskName 'Monitor — host' | Select LastRunTime, LastTaskResult
       — expect LastRunTime within 10 min, LastTaskResult = 0.

☐ E.3 Local /health is 200:
       curl http://localhost:4000/health
       — expect "ok":true.

☐ E.4 ALERT.log inspected; no unresolved alerts:
       Get-Content 'C:\backups\automation\HOST-ALERTS.log' -Tail 20
       — review; expect nothing fresh.
```

OPERATOR SIGNOFF Section E: __________ (date) __________ (initials)

---

## Section F — Rollback verified

Goal: prove the rollback path works BEFORE the deploy that might need it.

```text
☐ F.1 git revert <a-prior-commit> dry-run to confirm clean revert capability:
       git log --oneline -5
       — visually confirm the previous commit can be reverted without conflicts.

☐ F.2 PM2 dump restore drill (against a copy, not production):
       Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" 'C:\backups\pm2\test-restore.dump' -Force
       — confirm copy succeeded.

☐ F.3 PRE-CLEANUP dump.pm2 from pm2-maintenance-runbook still on disk:
       Get-ChildItem 'C:\backups\pm2\dump.pm2.PRE-CLEANUP-*'
       — at least one file present.

☐ F.4 Rollback command rehearsed by reading aloud:
       "If anonymous probe of /api/users returns 200 post-deploy:
        1. git revert HEAD
        2. git push
        3. pm2 restart sap-logistics
        4. curl /health to confirm
        5. Update INCIDENTS.md with rollback record."
```

OPERATOR SIGNOFF Section F: __________ (date) __________ (initials)

---

## Section G — Apply patch

Goal: get the patch into git, validated locally, ready to activate.

```text
☐ G.1 git tag pre-wave-a-mitigation
       git tag pre-wave-a-mitigation
       git push origin pre-wave-a-mitigation

☐ G.2 git checkout -b wave-a-mitigation

☐ G.3 Edit backend/src/demo/demoServer.js per emergency-mitigation-plan.md §2.
       — Add adminOnly + requireAuthBasic middleware around line 88.
       — Per-endpoint adminOnly on /api/users (lines 1135-1182).
       — app.use('/api/customers', requireAuthBasic) before line 327.
       — app.use('/api/drivers', requireAuthBasic) before line 1100; adminOnly on mutations.
       — app.use('/api/sap/write', adminOnly) before line 412.
       — Reduce mobile-link TTL: line 181, '30d' → '1h'.
       — Add single-use check at /m/admin/:shortId line 3289.

☐ G.4 git diff backend/src/demo/demoServer.js | Out-File patch.diff
       — review patch.diff; confirm:
       — only lines mentioned in §2 changed
       — no other sections touched
       — no large-scale formatting changes
       — diff is ~30-50 lines net

☐ G.5 node --check backend/src/demo/demoServer.js
       — expect no output (success).

☐ G.6 Local smoke test on PORT=4101:
       cd backend
       $env:DEMO_PORT='4101'
       Start a fresh PowerShell window, run: node src/demo/demoServer.js
       — Watch for "🎬 SAP Logistics Hub - DEMO SERVER" banner.
       — In another shell:
         curl -o NUL -w "%{http_code}\n" http://localhost:4101/health     → expect 200
         curl -o NUL -w "%{http_code}\n" http://localhost:4101/api/customers/search?q=t → expect 401
         curl -o NUL -w "%{http_code}\n" http://localhost:4101/api/drivers  → expect 401
         curl -o NUL -w "%{http_code}\n" http://localhost:4101/api/users    → expect 401
         curl -o NUL -w "%{http_code}\n" http://localhost:4101/api/sap/write/delivery-note/1 → expect 401
       — Stop test server: Ctrl+C in the first shell.
       — Unset env: $env:DEMO_PORT=$null

☐ G.7 git add + commit:
       git add backend/src/demo/demoServer.js
       git commit -m "Wave A emergency mitigation..." (per emergency-mitigation-plan.md §3 Step 5)

☐ G.8 git push origin wave-a-mitigation
```

OPERATOR SIGNOFF Section G: __________ (date) __________ (initials)

---

## Section H — Activate (PM2 restart)

Goal: ~10-15 second deploy window. Operator + backup operator BOTH watching.

```text
☐ H.1 Final pre-restart pm2 jlist healthy check (re-run B.1, B.4 just before restart):
       — pm2 list <10s ☐
       — port 4000 owned only by sap-logistics ☐

☐ H.2 PM2 dump snapshotted as PRE-WAVE-A-<TS>:
       $ts = Get-Date -Format 'yyyyMMdd-HHmm'
       Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-WAVE-A-$ts"

☐ H.3 store.json snapshotted as PRE-WAVE-A-<TS>:
       Copy-Item '...\backend\data\store.json' '...\backend\data\archive\store.json.PRE-WAVE-A-<TS>'

☐ H.4 Issue the restart:
       pm2 restart sap-logistics
       — note start time: ___________________
       — wait for 'Successfully restarted' or equivalent.

☐ H.5 Within 10 seconds: curl /health locally:
       curl http://localhost:4000/health
       — expect 200 with "🎬"-style banner in pm2-out.log
       — note response time: ___________________

☐ H.6 Confirm new code loaded (sanity check):
       curl -s http://localhost:4000/api/customers/search?q=test
       — expect HTTP 401, body: {"error":"Authentication required"}
       — if response is 200 with customer data: PATCH NOT LOADED. Investigate immediately.
```

OPERATOR SIGNOFF Section H: __________ (date) __________ (initials)

---

## Section I — Post-deploy verification

Goal: every Wave A endpoint behaves as designed, every NON-Wave-A endpoint behaves unchanged, no business flow broken.

Run the FULL probe matrix from `post-mitigation-verification.md`. Tick:

```text
☐ I.1 Anonymous probe matrix (public URL):
       /health                                       → 200 ☐
       /api/customers/search?q=test                  → 401 ☐
       /api/customers/policies                       → 401 ☐
       /api/drivers                                  → 401 ☐
       /api/users                                    → 401 ☐
       POST /api/users (curl --data ...)             → 401 ☐ (do NOT actually create user)
       /api/sap/write/delivery-note/1                → 401 ☐ (do NOT include {"dryRun":false})
       /m/admin/randomFakeId12                        → 404 ☐
       /api/runs (NOT in Wave A)                     → 200 ☐ (still anonymous; expected)
       /api/picking/waves (NOT in Wave A)            → 200 ☐
       /api/analytics/anomalies (NOT in Wave A)      → 200 ☐
       /api/auth/login POST                          → 401 (rate-limited) ☐
       /api/public/track/<random-token>              → 404 ☐ (token not in DB; expected)

☐ I.2 Authed probe matrix (with ADMIN token):
       /api/customers/search?q=test (ADMIN)          → 200 ☐
       /api/drivers (ADMIN)                          → 200 ☐
       /api/users (ADMIN)                            → 200 ☐

☐ I.3 Authed probe matrix (with DRIVER token):
       /api/customers/search?q=test (DRIVER)         → 200 ☐ (requireAuthBasic accepts any role)
       /api/drivers (DRIVER)                         → 200 ☐ (GET requireAuthBasic)
       /api/users (DRIVER)                           → 403 ☐ (adminOnly rejects non-admin)

☐ I.4 Frontend smoke test (browser):
       UsersPage with ADMIN session: lists users ☐
       RunsPage with PLANNER session: shows runs ☐
       Customer SMS tracking link still opens TrackingPage ☐
       Driver mobile app login still works ☐
       MobileLinkDialog: clicking generates a link, link works on first scan ☐
       MobileShortLinkPage second-scan of the same shortId: shows 410 / "already used" ☐

☐ I.5 Worker / log sanity (15 min window):
       Get-Content backend/logs/error.log -Tail 30
       — expect no NEW error patterns (existing 'tick failed' is OK)
       Get-Content backend/logs/pm2-out.log -Tail 30
       — expect [sim] entries continuing as normal
```

If ANY ☐ fails → execute Section J rollback.

OPERATOR SIGNOFF Section I: __________ (date) __________ (initials)

---

## Section J — Rollback (only if Section I failed)

```text
☐ J.1 Identify which check failed.
       Record: ___________________________________________________

☐ J.2 git revert HEAD
       git push

☐ J.3 pm2 restart sap-logistics
       — wait for restart.

☐ J.4 Verify rollback:
       curl http://localhost:4000/api/customers/search?q=test
       — expect 200 with customer data (back to pre-Wave-A state).

☐ J.5 INCIDENTS.md updated with rollback record + reason.

☐ J.6 Wave A deploy NOT marked complete.
       Engineer reviews the failure mode; reschedules.
```

OPERATOR SIGNOFF Section J: __________ (date) __________ (initials)
*(only if executed)*

---

## Section K — Post-deploy housekeeping

```text
☐ K.1 PM2 dump snapshotted as POST-WAVE-A-<TS>:
       Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-WAVE-A-<TS>"

☐ K.2 pm2 save executed:
       pm2 save
       — confirm 'Successfully saved' message.

☐ K.3 INCIDENTS.md updated:
       — date / time of deploy
       — list of files changed (just demoServer.js)
       — verification results (all green per Section I)
       — operators present
       — rollback NOT triggered

☐ K.4 Wave B/C decision scheduled (within 1 week):
       — decision required: do we want to extend gating to /api/runs, /api/picking, /api/cod, /api/analytics?
       — if yes: schedule similar window per cutover-plan.md or this same checklist with Wave-B scope.

☐ K.5 Off-host backup of POST-WAVE-A dump.pm2 + SQL backup completed.

☐ K.6 monitor-host.ps1 alert thresholds reviewed; tune if 24h shows false alarms.

☐ K.7 Tunnel posture decision logged (per tunnel-dependency-analysis.md §7):
       — keep quick-tunnel for now, plan named-tunnel migration as Phase-0-tail
       — OR proceed with named-tunnel migration this week

☐ K.8 Operator hands off; backup operator stands down.
```

OPERATOR SIGNOFF Section K: __________ (date) __________ (initials)

---

## Section L — INCIDENTS.md template

Append the following block to `cowork/INCIDENTS.md`:

```markdown
## 2026-MM-DD — Wave A emergency mitigation deployed

**Trigger:** PUBLIC_INTERNET_EXPOSED confirmed 2026-05-10 per
docs/architecture-review/external-reachability-report.md.

**Operators:** <primary> + <backup>
**Window:** HH:MM - HH:MM Israel
**Outcome:** SUCCESS / ROLLBACK
**Customer-visible downtime:** ~15 seconds during pm2 restart

**Files changed:**
- backend/src/demo/demoServer.js — Wave A middleware (~30 lines net)

**Routes gated:**
- /api/users/* (adminOnly per-endpoint)
- /api/customers/* (requireAuthBasic prefix)
- /api/drivers/* (requireAuthBasic + adminOnly on mutations)
- /api/sap/write/* (adminOnly)
- /m/admin/:shortId TTL → 1h, single-use
- POST /api/auth/mobile-link TTL → 1h

**Verification:**
- Anonymous probes from public URL return 401 on Wave A routes ✓
- Authed (ADMIN) probes return 200 ✓
- Frontend UsersPage / RunsPage / TrackingPage / driver app smoke tests ✓
- No new errors in error.log within 15 min observation ✓

**Backups taken:**
- C:\backups\pm2\dump.pm2.PRE-WAVE-A-<TS>
- C:\backups\pm2\dump.pm2.POST-WAVE-A-<TS>
- backend/data/archive/store.json.PRE-WAVE-A-<TS>

**Tunnel posture:** quick-tunnel kept up (per tunnel-dependency-analysis.md);
named-tunnel migration scheduled for <date>.

**Rollback path (unused if SUCCESS):**
- git revert <commit-sha>
- git push
- pm2 restart sap-logistics
- pm2 save

**Wave B/C decision:** <pending — operator schedules within 1 week>

**Refs:**
- docs/architecture-review/emergency-mitigation-plan.md
- docs/architecture-review/operator-execution-checklist.md
- docs/architecture-review/post-mitigation-verification.md
- docs/architecture-review/external-reachability-report.md
```

---

## Section M — Final signoff

```text
☐ M.1 All Section A-K checkboxes are ☑ (or ☐ for J if rollback was not needed).
☐ M.2 No unresolved warnings.
☐ M.3 INCIDENTS.md entry committed (or saved if INCIDENTS.md is local-only).
☐ M.4 Tag the success commit: git tag wave-a-deployed
       git push origin wave-a-deployed
☐ M.5 Both operators acknowledge deploy complete.
```

OPERATOR FINAL SIGNOFF: __________ (date) __________ (initials)
BACKUP OPERATOR FINAL SIGNOFF: __________ (date) __________ (initials)

---

## Document references

- `emergency-mitigation-plan.md` — full plan + patch design
- `pm2-maintenance-runbook.md` — required prerequisite (Section B)
- `tunnel-dependency-analysis.md` — informs Section C decisions
- `post-mitigation-verification.md` — full probe matrix used in Section I
- `external-reachability-report.md` — the trigger
- `cowork/INCIDENTS.md` — operator audit trail

End of operator checklist.
