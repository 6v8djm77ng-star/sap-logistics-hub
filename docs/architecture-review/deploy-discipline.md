# Deploy Discipline Policy

**Effective:** 2026-05-10 (post-Wave-A).
**Applies to:** any change to `sap-logistics` (the PM2 app + the codebase under `cowork/sap-logistics-hub/`).
**Owner:** the operator who applies a change owns compliance.

This document is the durable companion to `freeze-policy.md`. The freeze policy says *what* you can change during Phase 0; this document says *how* you change anything, ever — at any phase.

## Why this exists

Two production incidents informed every rule below:

1. **2026-05-06 22:16:31 — `pm2 resurrect` regression.** A `pm2 reload` of the new ecosystem.config.cjs was executed at 2026-05-05 10:49 but `pm2 save` was never run. When the daemon restarted on 2026-05-06 22:16 (machine reboot or `pm2 kill`), it resurrected from the stale `dump.pm2` and re-launched the OLD `demoServer.js` instead of the new `server.js`. **Cause: missing `pm2 save` after the change.**

2. **2026-05-09 22:50:49 — sap-bi-api crash loop + orphan-on-port-4001.** A memory-cap restart triggered on sap-bi-api. PM2's WMI-based pidusage timed out checking the new fork; bookkeeping marked it dead while the OS process kept running and held the port. PM2 spawned ~23,000 replacement forks, each immediately dying with EADDRINUSE. **Cause: PM2's tree-kill on Windows can't kill a process holding files in OneDrive.**

Every rule below is a direct mitigation against re-experiencing one of these.

---

## 1. Mandatory backups before any production change

### 1.1 Always-required (no exceptions)
Before touching anything in production:

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmm'

# A. PM2 dump
pm2 save
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-<change-name>-$ts"

# B. store.json (if change could affect demoServer state)
Copy-Item "...\backend\data\store.json" "...\backend\data\archive\store.json.PRE-<change-name>-$ts"

# C. Tag git baseline
cd "...\sap-logistics-hub"
git tag pre-<change-name>-$ts
```

### 1.2 Required for invasive changes
Add to the above:
```powershell
# D. SQL FULL backup (if change touches Logistics DB or migrations)
sqlcmd -Q "BACKUP DATABASE SAP_Logistics_Hub TO DISK='C:\backups\sql\SAP_Logistics_Hub_full_$ts.bak' WITH FORMAT, INIT, COMPRESSION, CHECKSUM"

# E. Encrypted .env backup (if change touches .env)
& "C:\Program Files (x86)\7-Zip\7z.exe" a -p"<passphrase>" "C:\backups\env\env-$ts.7z" "...\backend\.env"
```

### 1.3 Verify the backup before proceeding
```powershell
# Read it back; confirm size > 0 and content is sensible
Get-Item "C:\backups\pm2\dump.pm2.PRE-<change-name>-$ts" | Select Length
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" `
  "...\backend\data\archive\store.json.PRE-<change-name>-$ts"
```

If the verification fails, **STOP**. Don't proceed with a backup that can't be read back.

---

## 2. Rollback-first deployment principle

### 2.1 Define the rollback BEFORE you define the deploy
Every change must have a written rollback procedure that the operator could execute under pressure (3 AM, page received, half-asleep).

**Bad rollback note:** "if it breaks, just revert"
**Good rollback note:**
```
Rollback:
  cd "...\sap-logistics-hub"
  git revert <commit-sha> --no-edit
  $port_pid = (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue).OwningProcess
  $pm2_pid  = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pid
  if ($port_pid -and $port_pid -ne $pm2_pid) { Stop-Process -Id $port_pid -Force }
  pm2 restart sap-logistics
  curl -s http://localhost:4000/health  # expect 200
  curl -s http://localhost:4000/api/users -o NUL -w "%{http_code}"  # expect old behavior
```

### 2.2 The rollback note lives in the commit message
Every commit that touches production code ends with a `Rollback:` block. Example:
```
Wave A emergency mitigation for public demoServer exposure

[summary]

Rollback: git revert HEAD; pre-empt orphan on port 4000 if needed; pm2 restart sap-logistics
```

### 2.3 Reversibility is non-negotiable
Every change MUST be reversible by:
- `git revert <commit>` (reverses code), AND
- 1-2 PM2 commands (reactivates previous behavior)

Changes that can't be cleanly reverted (DROP TABLE, file deletions, env-key removals) require a separate documented restore procedure AND operator + backup operator sign-off in `INCIDENTS.md`.

---

## 3. No direct production experimentation

### 3.1 Never edit demoServer.js directly on the live host without git
Even "just adding a console.log to debug" is forbidden:
- The change isn't in version control; rollback impossible
- The next `pm2 restart` may pick up half-applied edits
- OneDrive sync may corrupt the in-flight write

If you need to test something, do it on a local clone OR use a smoke-test instance (per §6).

### 3.2 No `pm2 stop sap-logistics` for "diagnostic" reasons
The 2026-05-09 21:01:28 "could not be stopped" event was triggered by exactly this — someone ran `pm2 stop sap-logistics` and it left a bookkeeping mismatch that took 14 hours to self-resolve. **`pm2 stop sap-logistics` is now a forbidden command** unless preceded by a documented rollback context.

### 3.3 No "while you're in there" feature additions
A bug-fix PR fixes ONE bug. If you notice another problem while fixing the first, file it; don't bundle. Reasoning:
- Bundled changes = bigger blast radius if rollback needed
- Bundled changes hide the root cause of issues that surface later
- Bundled changes violate the freeze policy if any sub-change is feature-y

---

## 4. Restart procedure (canonical)

For ANY `pm2 restart sap-logistics`:

```powershell
# Step 1 — pre-restart orphan check (mandatory)
$port_pid = (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue).OwningProcess
$pm2_pid  = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pid
$status   = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pm2_env.status

Write-Host "port 4000 pid: $port_pid"
Write-Host "pm2 tracked pid: $pm2_pid"
Write-Host "pm2 status: $status"

if ($port_pid -and ($port_pid -ne $pm2_pid -or $status -eq 'errored')) {
  Write-Host "Pre-empting orphan / bookkeeping mismatch — Stop-Process $port_pid"
  Stop-Process -Id $port_pid -Force
  Start-Sleep -Seconds 2
  $still = Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue
  if ($still) { Write-Host "FAIL — port 4000 still bound; investigate"; exit 1 }
}

# Step 2 — pre-restart snapshot
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
pm2 save
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-restart-$ts"

# Step 3 — restart
pm2 restart sap-logistics

# Step 4 — verify within 30s
Start-Sleep -Seconds 5
curl -s -o NUL -w "code=%{http_code}`n" http://localhost:4000/health

# Step 5 — pm2 save + post-restart snapshot
pm2 save
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-restart-$ts"

# Step 6 — verify pm2 status post-restart
pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' } |
  Select pid, @{n='status';e={$_.pm2_env.status}}, @{n='restart_time';e={$_.pm2_env.restart_time}}
```

**Don't skip Step 1.** The orphan check is what prevents the sap-bi-api crash-loop pattern from repeating on sap-logistics.

**Don't skip Step 5.** Without `pm2 save`, the next daemon restart resurrects from a stale dump — exactly the 2026-05-06 regression mode.

---

## 5. PM2 orphan handling

### 5.1 If port 4000 (or any sap-logistics-related port) is bound by a pid that PM2 doesn't know about
This is an orphan. It will block PM2 from starting a fresh fork → EADDRINUSE → crash loop.

**Identification:**
```powershell
$port_pid = (Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$port_pid"
$proc | Select ProcessId, Name, CommandLine, CreationDate | Format-List
```

**Confirm it's an orphan (not the legitimate PM2 child):**
```powershell
$pm2_pid = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pid
if ($port_pid -ne $pm2_pid) { 'ORPHAN — pid ' + $port_pid + ' not tracked by PM2' }
```

**Kill the orphan:**
```powershell
Stop-Process -Id $port_pid -Force
Start-Sleep -Seconds 2
Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue   # expect empty
```

### 5.2 NEVER `pm2 kill` to "fix" an orphan
- `pm2 kill` only kills processes PM2 knows about. Orphans survive.
- After `pm2 kill`, `pm2 resurrect` re-launches from dump.pm2; new fork hits EADDRINUSE on the orphan-held port; crash loop.
- The Sept 2026-05-09 sap-bi-api 23K-restart pattern is the textbook example.

**Use `Stop-Process -Force` on the specific orphan pid, not `pm2 kill`.**

### 5.3 OneDrive considerations
The cwd is under `OneDrive - OIG`. OneDrive sync can hold file handles, blocking taskkill.

**Before any sensitive PM2 operation:**
- Pause OneDrive sync on `backend/` for the duration of the operation
- After the operation, resume sync

```powershell
# Pause OneDrive (Windows tray icon → Pause syncing for 2 hours)
# OR programmatically:
Stop-Process -Name OneDrive -Force -EA SilentlyContinue
# To resume: launch C:\Users\izik\AppData\Local\Microsoft\OneDrive\OneDrive.exe
```

---

## 6. Tagging policy

Every production deploy creates two tags:

```powershell
# 1. pre-tag — captures the state BEFORE the change
git tag pre-<change-name>-baseline

# 2. post-tag — captures the state AFTER the change is verified successful
git tag <change-name>-deployed
```

Examples:
- `pre-wave-a-baseline` (commit 0d36879) → `wave-a-deployed` (commit ae18787)
- `pre-wave-b-baseline` → `wave-b-deployed`
- `pre-cutover-baseline` → `cutover-deployed`

**Don't push tags to origin** until the operator approves (per task instruction). Tags are a local rollback marker first; remote-push is a publishing step.

---

## 7. Observation windows

### 7.1 Mandatory window after any change
| Change scope | Minimum observation | Reason |
|---|---|---|
| Frontend asset hot-swap (no JS logic change) | 1 hour | Browser cache + service worker check |
| Single-file route gate change (Wave A pattern) | 5-7 days | User flow + integration discovery |
| Multi-file backend change | 7-14 days | Behavior chains take time to surface |
| Schema migration | 14-30 days | Worker tick frequencies, daily/weekly cron cycles |
| server.js cutover | 30-90 days (per `cutover-plan.md` Phase 6) | Worker queries, weekly reports, monthly cycles |

### 7.2 What "observation window" means in practice
- Daily verification per `wave-a-observation-window.md` daily-log template
- No additional production changes during the window (hotfix exception per §8.4)
- Operator on call; backup operator informed
- Any anomaly logged in `INCIDENTS.md`

### 7.3 Bypass requires explicit policy override
Skipping an observation window requires:
- Operator + backup operator sign-off in `INCIDENTS.md`
- Documented business reason
- Rollback plan rehearsed

Pressure to "ship fast" is not a valid override reason.

---

## 8. Freeze policy interaction

### 8.1 Freeze policy is for SCOPE; this policy is for PROCESS
- `freeze-policy.md` says: during Phase 0, only stabilization/security/observability changes allowed.
- This policy says: HOW any change happens, regardless of phase.

Both apply simultaneously during Phase 0. Post-cutover, `freeze-policy.md` lifts; this one stays.

### 8.2 Phase 0 explicit allowed-actions (per freeze)
- Phase 1+ porting (inert until cutover)
- Phase 2 data migration script (dev only)
- Phase 3 shadow runtime
- Wave B + C mitigations (same pattern as Wave A)
- Backups + monitoring + observability
- Documentation

### 8.3 Phase 0 explicit forbidden-actions (per freeze)
- New features
- AI / LLM / forecasting work
- Dashboard redesigns
- Schema rewrites (except migrations 013-019 in cutover plan)
- `SAP_WRITE_ENABLED=true`
- New PM2 apps
- New worker schedulers in production

### 8.4 Hotfix exception
A genuinely-emergency fix (e.g., active customer-data exfil observed) can bypass §7 observation windows IF:
- Severity is documented in `INCIDENTS.md` BEFORE the fix
- Operator + backup operator both on call
- Rollback rehearsed
- Hotfix is the smallest possible patch
- Post-deploy `INCIDENTS.md` entry within 1 hour

---

## 9. Incident logging discipline

### 9.1 What gets logged in `cowork/INCIDENTS.md`
- Every production change (deploy / restart / config edit)
- Every unexpected restart
- Every outage (defined as `/health` != 200 for 5+ min)
- Every customer-facing complaint that hits the operator
- Every rollback (with trigger reason)
- Every PM2 daemon issue (orphan, hang, crash)
- Every backup that fails verification

### 9.2 Entry format
Each entry has:
```markdown
## YYYY-MM-DD HH:MM — <short title>

**Severity:** P0 / P1 / P2 / P3
**Operator:** <name> (+ backup if applicable)
**Outcome:** SUCCESS / ROLLBACK / OPEN

### What happened
<2-5 sentences>

### Root cause
<if known>

### What was changed
<files, commits, commands>

### Verification
<how it was confirmed>

### Rollback path
<if applicable>

### Next-day attention
<follow-ups>

### Refs
<docs/issues/PRs>
```

The existing INCIDENTS.md (last entry 2026-05-10) follows this pattern; continue the convention.

### 9.3 Hebrew or English?
The repo's INCIDENTS.md is mixed — pre-2026-05-10 entries are Hebrew (operator's preference per memory), the 2026-05-10 prerequisite-remediation entry is bilingual. Both are fine. Consistency within an entry matters more than the language choice.

---

## 10. Operator approval flow

### 10.1 Single-operator changes (default)
- Backups, log rotation, observation routine, monitoring tuning, `INCIDENTS.md` updates
- Documentation
- Read-only investigations
- Hotfix to a frontend asset (CSS, copy, image) with no JS change

### 10.2 Two-operator changes (require sign-off in INCIDENTS.md)
- Any `pm2 restart sap-logistics`
- Any change to `backend/src/`
- Any change to `ecosystem.config.cjs`
- Any change to `backend/.env`
- Any change to `backend/data/store.json`
- Any change to PM2 daemon state (`pm2 kill`, `pm2 resurrect`, `pm2 delete`, `pm2 reload`)
- Any schema migration
- Any cutover phase action

### 10.3 Three-person changes
- Cutover from demoServer.js to server.js
- `SAP_WRITE_ENABLED=true` flip
- `JWT_SECRET` rotation
- demoServer.js retirement

For three-person changes, operator + backup operator + a stakeholder (CEO / CTO / business owner) must explicitly approve in `INCIDENTS.md` with timestamps. The stakeholder isn't expected to understand the technical details — their role is "are we ready to risk this for the business value?"

---

## 11. Anti-patterns (what NOT to do)

| ❌ Don't | Reason | What to do instead |
|---|---|---|
| `pm2 restart all` | Restarts apps in pm_id order; sap-logistics (id 6) restart times out behind earlier crash-loops | Restart specific apps individually with the §4 procedure |
| `pm2 kill && pm2 resurrect` | Doesn't kill orphans; resurrect re-launches into EADDRINUSE | Stop-Process orphans first, THEN pm2 kill if necessary |
| Edit `.env` while sap-logistics runs | Operator habit is to restart after .env edit, but restart on this daemon has known risks | Plan a maintenance window |
| `pm2 update` mid-business-day | Forks new daemon; loses state | Plan a Sunday window |
| `pm2 delete sap-logistics` to "fix" anything | Loses metrics, history, env; rebuild requires `pm2 start ecosystem.config.cjs` | Use `pm2 restart` instead |
| Force-merge a branch without `node --check` | Syntax errors land in production | Always `node --check` before commit |
| Skip `pm2 save` after a change | Daemon resurrect re-launches old code (the 2026-05-06 regression) | Always pm2 save after intentional changes |
| Push tags to remote prematurely | Tags become public commitments; harder to retract | Push tags only after operator approves |
| Manually `kill` PM2 children | PM2 doesn't know they're dead → bookkeeping mismatch | Use `pm2 stop <id>` instead of OS kill |
| Edit code on the production host directly | Untracked changes; OneDrive sync corruption risk | Clone elsewhere, push to git, deploy from git |

---

## 12. Discipline drift signals

If you find yourself:
- Skipping the orphan check "just this once"
- Pushing without `node --check` "because it's a small change"
- Restarting without a snapshot "because we just did one yesterday"
- Editing demoServer.js inline to "test something quickly"
- Bundling a feature into a bug-fix PR "while you're in there"
- Bypassing the observation window "because it's blocking sales"

…stop. You're rebuilding the conditions that caused the 2026-05-06 and 2026-05-09 incidents. The discipline rules exist to prevent specific failure modes, not to slow you down arbitrarily.

If a rule genuinely doesn't fit a situation, propose a change to this document via PR. Don't bypass silently.

---

## 13. Document references

- `freeze-policy.md` — phase 0 scope policy (the *what*, not the *how*)
- `pm2-stabilization.md` — root cause of pre-existing daemon issues
- `pm2-maintenance-runbook.md` — orphan-handling procedure
- `wave-a-observation-window.md` — Wave A specific observation
- `production-monitoring-plan.md` — monitoring tools + thresholds
- `backup-inventory.md` — backup paths
- `cutover-plan.md` — phase boundaries
- `cowork/INCIDENTS.md` — the audit trail this policy populates

End of deploy discipline policy.
