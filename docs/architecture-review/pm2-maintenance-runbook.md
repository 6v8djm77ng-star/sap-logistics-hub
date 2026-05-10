# PM2 Maintenance Runbook

**Use this runbook to execute the PM2 stabilization window.** This is the operational companion to `pm2-stabilization.md` (which is the analysis). Follow it linearly.

**Pre-requisite read:** `pm2-stabilization.md` §1-3 (root causes), `freeze-policy.md` §3 (mandatory rules), `backup-inventory.md` §2 (backup commands).

**Estimated downtime:** 0 minutes for `sap-logistics`, **5-15 minutes** for `sap-bi-api` (out of scope but in same daemon).
**Estimated total operator time:** 60 minutes (45 active + 15 buffer).
**Recommended window:** Sunday 22:00 → 23:00 Israel time.
**Operators required:** 1 primary + 1 watching.

---

## Section A — Pre-flight (T-30 min)

Goal: confirm everything you need is present before touching the daemon.

### A.1 Personnel ready

```text
[ ] Primary operator at console
[ ] Backup operator on call (separate machine)
[ ] Both have repo cloned and up to date
[ ] Both have read this runbook
[ ] freeze-policy.md is in effect
[ ] No concurrent code merges expected during window
```

### A.2 Backup the dump

```powershell
# Save current daemon state to dump.pm2
pm2 save
# Note: this command may take 60-120 seconds today due to daemon congestion.
# Wait for it to return BEFORE proceeding.

# Snapshot the dump file off-daemon
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
New-Item -ItemType Directory "C:\backups\pm2" -Force | Out-Null
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.PRE-CLEANUP-$ts" -Force
Test-Path "C:\backups\pm2\dump.pm2.PRE-CLEANUP-$ts"
# Expected output: True
```

### A.3 Backup store.json

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
New-Item -ItemType Directory "$root\data\archive" -Force | Out-Null
Copy-Item "$root\data\store.json" "$root\data\archive\store.json.PRE-PM2-CLEANUP-$ts" -Force
# Verify size and parse cleanly
Get-Item "$root\data\archive\store.json.PRE-PM2-CLEANUP-$ts" | Select Name, Length, LastWriteTime
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); console.log('parse OK')" "$root\data\archive\store.json.PRE-PM2-CLEANUP-$ts"
# Expected output: 'parse OK'
```

### A.4 Snapshot Logistics SQL (operator/DBA)

```sql
-- Run via sqlcmd or SSMS
DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_PRE-PM2-CLEANUP_' + @ts + N'.bak';
BACKUP DATABASE SAP_Logistics_Hub TO DISK = @path
  WITH FORMAT, INIT, COMPRESSION, CHECKSUM, STATS = 10;
```

### A.5 Identify orphan processes (CRITICAL — do not skip)

```powershell
# Step 1: list listeners on the relevant ports
"=== Port listeners ==="
Get-NetTCPConnection -LocalPort 4000,4001,3001 -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' } |
  Select-Object LocalPort, State, OwningProcess |
  Format-Table -AutoSize

# Step 2: map the pids to commandlines
"=== Node processes ==="
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, CreationDate, ParentProcessId,
    @{n='CmdLine';e={ if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(150, $_.CommandLine.Length)) } else { '<unknown>' } }} |
  Sort-Object ProcessId |
  Format-Table -AutoSize -Wrap
```

### A.6 Confirm sap-logistics state matches expectation

The pid for `sap-logistics` should be the original 2026-05-06 child. Confirm:

```powershell
# pm2 jlist may take 2 minutes to return — patient
$j = pm2 jlist | ConvertFrom-Json
$logistics = $j | Where-Object { $_.name -eq 'sap-logistics' }
$logistics | Select-Object name, pid, @{n='status';e={$_.pm2_env.status}}, @{n='restart_time';e={$_.pm2_env.restart_time}}, @{n='pm_uptime';e={[datetime]'1970-01-01' + [timespan]::FromMilliseconds($_.pm2_env.pm_uptime)}}, @{n='exec_path';e={$_.pm2_env.pm_exec_path}}
# Expected:
#   status:        online
#   restart_time:  1   (sometimes 0; both ok)
#   pm_uptime:     2026-05-06T07:34Z or similar — confirm it's the SAME pid as last check
#   exec_path:     ...\backend\src\demo\demoServer.js
```

If `restart_time` has incremented since the last documented value, **STOP** and consult the on-call engineer. The process has been auto-restarted unexpectedly and the runbook may not apply cleanly.

### A.7 Pre-flight gate

```text
[ ] dump.pm2 backup verified (Test-Path returned True)
[ ] store.json snapshot verified (parse OK)
[ ] SQL backup file present and >0 bytes
[ ] Orphan processes identified — note pids: ____________
[ ] sap-logistics pm_uptime matches last known value
[ ] pm2 jlist returned in <180 seconds (slow but functioning)
[ ] cloudflared external tunnel (if any) stopped: taskkill /IM cloudflared.exe /F (verify needed first)
[ ] OneDrive sync paused on backend/data/ folder
```

If ANY box unchecked, **abort the maintenance window** and reschedule. Do not proceed under uncertainty.

---

## Section B — Cleanup execution (T-0 to T+30 min)

### B.1 Drain sap-bi-api (NOT sap-logistics)

Goal: stop the 23,008-restart crash loop on `sap-bi-api` by killing the orphan that holds port 4001, then telling PM2 to stay stopped.

```powershell
"=== Step B.1.1 — pm2 stop sap-bi-api ==="
# This will hang ~60-120 seconds because daemon is busy. Wait it out.
# DO NOT Ctrl+C if it hangs — that leaves PM2 in an even worse state.
$start = Get-Date
pm2 stop 2
$elapsed = (Get-Date) - $start
"pm2 stop took $($elapsed.TotalSeconds) seconds"
```

If `pm2 stop 2` returns within 60s with `[PM2] Applying action stopProcessId on app [2]` and "[PM2] sap-bi-api is stopped" — you're done with this app. Skip to B.2.

If `pm2 stop 2` is still hanging after 90s, the orphan is blocking the daemon. Continue:

```powershell
"=== Step B.1.2 — Manual kill of orphan on port 4001 ==="
$orphan = (Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($orphan) {
  "Found orphan on port 4001: pid $orphan"
  # Confirm it's really sap-bi-api before killing — match against the cmdline
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$orphan"
  "CmdLine: $($proc.CommandLine.Substring(0, [Math]::Min(120, $proc.CommandLine.Length)))"
  # If cmdline contains 'start-with-env.cjs' AND 'sap-bi/apps/api', kill it.
  if ($proc.CommandLine -match 'sap-bi.apps.api.start-with-env') {
    Stop-Process -Id $orphan -Force
    "Killed pid $orphan"
  } else {
    "ABORT: pid $orphan does NOT match expected sap-bi-api cmdline. Stop and investigate."
    exit 1
  }
} else {
  "No orphan listening on 4001 — safe to proceed"
}
```

```powershell
# Now retry pm2 stop — should return within 5-10s
pm2 stop 2
# Verify
pm2 describe sap-bi-api | Select-String 'status'
# Expected: status: stopped
```

### B.2 Verify daemon responsiveness has recovered

```powershell
"=== Step B.2 — Daemon responsiveness ==="
$start = Get-Date
pm2 list
$elapsed = (Get-Date) - $start
"pm2 list took $($elapsed.TotalSeconds) seconds"
# Pass: <10 seconds
# Fail: >30 seconds — daemon hasn't drained, wait 60s and retry.
# If still slow after retry, ABORT and consult on-call.
```

### B.3 sap-logistics health check (READ-ONLY — do NOT restart)

```powershell
"=== Step B.3 — sap-logistics liveness ==="
pm2 describe sap-logistics
# Expected: status online, pid unchanged from A.6
curl -s -w "`nHTTP_CODE: %{http_code}`nTIME: %{time_total}s`n" http://localhost:4000/health
# Expected: HTTP_CODE 200, TIME <2s, mode "DEMO+SAP"
```

If sap-logistics shows `errored` or pid changed, STOP. The cleanup destabilized the process unexpectedly. Go to Section D rollback.

### B.4 Persist new dump

```powershell
"=== Step B.4 — Persist clean state ==="
pm2 save
# Wait for 'Successfully saved in ...' message

# Snapshot the new dump
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.POST-CLEANUP-$ts" -Force
# Verify
$lines = (Get-Content "C:\backups\pm2\dump.pm2.POST-CLEANUP-$ts" | Measure-Object -Line).Lines
"New dump.pm2 has $lines lines"
# Should be similar to PRE-CLEANUP version (sap-bi-api just changed status, not removed)
```

### B.5 (Optional) Quiet tunnel-url-watcher noise

```powershell
"=== Step B.5 — Optional: silence tunnel-url-watcher cron noise ==="
# The watcher spams 'failed to kill' every 10 minutes. Cosmetic noise; not a real failure.
# Disable ONLY if the operator confirms with the sap-bi project owner that
# the Vercel env update job is no longer needed.
#
# If approved:
# pm2 stop tunnel-url-watcher
# pm2 save
#
# DO NOT pm2 delete — that loses the cron schedule entirely.
```

### B.6 Validation gate

Run all of these and require every "Expected" to match:

```powershell
"=== B.6.1 — port 4001 should be free ==="
Get-NetTCPConnection -LocalPort 4001 -ErrorAction SilentlyContinue
# Expected: nothing returned (no listener)

"=== B.6.2 — pm2 list snappy ==="
$start = Get-Date
pm2 list
"pm2 list took $((( Get-Date) - $start).TotalSeconds) seconds"
# Expected: <10 seconds

"=== B.6.3 — sap-logistics still online ==="
pm2 describe sap-logistics | Select-String 'status|pid|restart time'
# Expected: status online, pid unchanged, restart time unchanged

"=== B.6.4 — /health 200 ==="
curl -s -o NUL -w "%{http_code}`n" http://localhost:4000/health
# Expected: 200

"=== B.6.5 — sap-bi-api stopped ==="
pm2 describe sap-bi-api | Select-String 'status|pid'
# Expected: status stopped, pid 0

"=== B.6.6 — POST-CLEANUP dump exists ==="
Get-ChildItem "C:\backups\pm2\dump.pm2.POST-CLEANUP-*"
# Expected: file exists

"=== B.6.7 — backend logs not erupting ==="
Get-Content "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs\error.log" -Tail 20
# Expected: nothing new since the window started, or only the pre-existing
# '[worker] tick failed Connection is closed' pattern (acceptable)
```

If ALL pass: maintenance complete. Go to Section C.
If ANY fail: go to Section D rollback.

---

## Section C — Post-window (T+30 to T+60 min)

### C.1 Resume external services

```powershell
"=== C.1.1 — Resume OneDrive sync ==="
# OneDrive auto-resumes on next sync interval; manually trigger via:
# right-click OneDrive icon in taskbar -> Resume sync
# (manual; no PowerShell equivalent that works reliably)

"=== C.1.2 — Restart cf-tunnel if it was running before window ==="
# If you stopped cloudflared in A.7 and it's needed:
# Start cloudflared via PM2 (it should already be in dump.pm2 as 'cloudflare-tunnel')
pm2 start cloudflare-tunnel
# Verify
pm2 describe cloudflare-tunnel | Select-String 'status'
```

### C.2 Off-host backup of new dump

```powershell
# Push the POST-CLEANUP dump to off-host storage (per backup-inventory.md §5)
# Operator: copy C:\backups\pm2\dump.pm2.POST-CLEANUP-* to your off-host destination
```

### C.3 Update INCIDENTS.md

Add an entry to `cowork/INCIDENTS.md`:

```markdown
## 2026-05-XX — PM2 stabilization maintenance window

**Operator:** <name>
**Window:** 22:00–23:00 Israel
**Outcome:** sap-bi-api drained; sap-logistics undisturbed. Daemon responsive again.

**Actions taken:**
1. Backed up dump.pm2 to PRE-CLEANUP-<ts>
2. Identified orphan pid <N> on port 4001 (sap-bi-api)
3. Stop-Process -Force on pid <N>
4. pm2 stop sap-bi-api (returned in <s>)
5. Confirmed pm2 list responsive (<s>)
6. Confirmed sap-logistics still online with original pid
7. pm2 save → POST-CLEANUP-<ts>

**Validation gates:** all passed (B.6.1 through B.6.7).

**Rollback:** not needed.

**Follow-up:** sap-bi-api root cause not addressed (out of scope per pm2-stabilization.md §2.2). Operator of sap-bi project notified separately.
```

### C.4 Communicate window closed

Notify ops/dispatch via the usual channel: "Maintenance complete; sap-logistics operations normal."

---

## Section D — Rollback (only if validation gate failed)

### D.1 If sap-logistics became unhealthy during cleanup

This shouldn't happen if you followed the runbook (cleanup never touched sap-logistics directly). But if pid changed or `/health` is non-200:

```powershell
"=== D.1.1 — Identify any orphan on port 4000 ==="
$orphan = (Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($orphan) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$orphan"
  "Orphan: pid=$orphan cmd=$($proc.CommandLine.Substring(0, [Math]::Min(120, $proc.CommandLine.Length)))"
  # If cmdline matches demoServer:
  if ($proc.CommandLine -match 'sap-logistics-hub.backend.src.demo.demoServer') {
    Stop-Process -Id $orphan -Force
  } else {
    "Refusing to kill non-demoServer process"
  }
}

"=== D.1.2 — Restart sap-logistics from dump ==="
pm2 restart sap-logistics
# Wait 30 seconds, then verify
Start-Sleep -Seconds 30
curl -s -o NUL -w "%{http_code}`n" http://localhost:4000/health
# Expected: 200
```

### D.2 If daemon is completely wedged

Last resort. Only if pm2 commands hang >5 minutes consistently:

```powershell
"=== D.2.1 — Kill ALL orphans first ==="
# Identify every node.exe child of the PM2 daemon
$pm2pid = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'PM2 v\d' }).ProcessId
"PM2 daemon pid: $pm2pid"

# Get all node.exe processes whose parent is PM2 daemon
$children = Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=$pm2pid"
$children | Select ProcessId, @{n='CmdLine';e={$_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length))}}

# WAIT for human review of this list before killing anything
# If it looks right (sap-bi-api orphans + sap-logistics + others), proceed:
# $children | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

```powershell
"=== D.2.2 — pm2 kill (only AFTER orphans are gone) ==="
pm2 kill
# Daemon stops. Confirm.

"=== D.2.3 — Restore the PRE-CLEANUP dump (returns to original state) ==="
$pre = Get-ChildItem "C:\backups\pm2\dump.pm2.PRE-CLEANUP-*" |
  Sort-Object LastWriteTime -Descending | Select -First 1
Copy-Item $pre.FullName "$env:USERPROFILE\.pm2\dump.pm2" -Force

"=== D.2.4 — pm2 resurrect ==="
pm2 resurrect
# Wait
Start-Sleep -Seconds 30

"=== D.2.5 — Verify ==="
pm2 list
curl -s -o NUL -w "%{http_code}`n" http://localhost:4000/health
# Expected: sap-logistics online, /health 200
```

### D.3 If even resurrect fails

This means file-handle locks on dump.pm2 from OneDrive or stuck WMI handles. Don't escalate further from PowerShell — this is the **call-the-on-call-engineer** state.

Steps:
1. Reboot the host.
2. After reboot, before allowing OneDrive to start syncing, restore `dump.pm2` from `C:\backups\pm2\dump.pm2.PRE-CLEANUP-<ts>`.
3. Start PM2 manually: `pm2 resurrect`.
4. Verify with `pm2 list` and `curl /health`.

Reboot is a 5-minute outage on `sap-logistics`. Acceptable in a true emergency; never the first move.

---

## Section E — Validation checklist (single sheet)

Print and tick:

```text
PRE-FLIGHT (Section A)
[ ] A.1 personnel ready
[ ] A.2 dump.pm2 backed up + verified
[ ] A.3 store.json backed up + parsed cleanly
[ ] A.4 Logistics SQL backed up
[ ] A.5 orphan pids identified
[ ] A.6 sap-logistics pm_uptime confirmed unchanged
[ ] A.7 pre-flight gate all green

EXECUTION (Section B)
[ ] B.1 sap-bi-api drained (orphan killed if needed)
[ ] B.2 daemon responsive (<10s pm2 list)
[ ] B.3 sap-logistics still online (read-only check)
[ ] B.4 dump.pm2 saved POST-CLEANUP
[ ] B.5 (optional) tunnel-url-watcher decision made
[ ] B.6.1 port 4001 free
[ ] B.6.2 pm2 list snappy
[ ] B.6.3 sap-logistics online
[ ] B.6.4 /health 200
[ ] B.6.5 sap-bi-api stopped
[ ] B.6.6 POST-CLEANUP dump exists
[ ] B.6.7 backend logs not erupting

POST-WINDOW (Section C)
[ ] C.1 OneDrive resumed; cf-tunnel restarted if needed
[ ] C.2 dump pushed to off-host
[ ] C.3 INCIDENTS.md updated
[ ] C.4 ops notified

ROLLBACK (only if needed)
[ ] D.1 or D.2 executed
[ ] System verified back to known good state
```

---

## Section F — Estimated downtime + risk

### F.1 Downtime
- `sap-logistics`: **0 minutes**. Cleanup never touches it.
- `sap-bi-api`: **5-15 minutes** while pm2 stop drains and the orphan is killed. Out of scope for sap-logistics-hub but operationally relevant.
- All other apps: **0 minutes** if Section D rollback isn't triggered.

### F.2 Risk
- **Most likely failure:** pm2 stop hangs and the operator gets impatient → Ctrl+C → daemon stuck. **Mitigation:** the runbook's "DO NOT Ctrl+C" warning in B.1.
- **Second-most-likely:** orphan pid identified incorrectly, wrong process killed. **Mitigation:** the cmdline match check in B.1.2.
- **Worst case:** daemon completely wedges; needs reboot. **Mitigation:** Section D.3.
- **Probability of any rollback:** ~10% based on the failure modes documented in `pm2-stabilization.md`. Each individual step is well-bounded but interactions on a stressed Windows host can surprise.

### F.3 What happens if we DO NOTHING

If the operator skips this maintenance:
- `sap-bi-api` keeps crash-looping at 0.5 Hz, growing pm2.log by ~5 MB/day.
- The PM2 daemon's RPC queue stays clogged; future `pm2 restart sap-logistics` (e.g., during the eventual cutover) is at high risk of repeating sap-bi-api's pattern on port 4000.
- A future host reboot triggers `pm2 resurrect`, which spawns 9 apps simultaneously into a degraded daemon — likely failure cascade.
- Memory pressure builds (~50 MB/hr from sap-bi-api forks) until Windows starts paging.

The cleanup is not optional in the long run. Schedule it within 2 weeks.

---

## Section G — Commands to AVOID during this window

| ❌ Don't | Why |
|---|---|
| `pm2 delete sap-bi-api` | Orphan would survive forever; future port-4001 binds fail invisibly |
| `pm2 kill` without first stopping orphans | Daemon dies; orphans live; resurrect fails |
| `pm2 restart all` | Stops sap-logistics in addition to broken apps; sap-logistics will hit the same orphan-resistance bug |
| `pm2 update` or `pm2 install pm2-windows-startup` | Forks new daemon; loses cron config; never run mid-incident |
| `Ctrl+C` on a hanging pm2 command | Leaves daemon in worse state |
| `taskkill /IM node.exe /F` | Indiscriminate; kills sap-logistics + every other Node app |
| `Restart-Computer` as first move | Always last resort; prefer the staged Section D |
| Editing `ecosystem.config.cjs` mid-window | Defer all config changes to after window closes |
| Editing `backend/.env` mid-window | Same |
| `pm2 stop sap-logistics` | Triggers the orphan-resistance bug; not needed for cleanup |
| Deleting `dump.pm2` | Loses recovery state |
| Running migrations during this window | Phase 0 freeze; Phase 1+ work, not now |

---

## Section H — OneDrive / WMI lock considerations

The cwd `C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend` is on OneDrive. This contributes to PM2's kill failures because:

1. **OneDrive sync holds file handles** open on `data/store.json`, `logs/*.log`, etc. When PM2 tries to `taskkill /F` a child whose cwd is in the sync directory, Windows blocks until handles release.
2. **WMI provider on Windows** is the data source for `pidusage`. WMI is slow under load and times out with "Call cancelled" errors when many `Win32_Process` queries fire close together (which PM2 does at every memory check).
3. **OneDrive-Files-On-Demand** materializes files lazily. A spawning process whose interpreter path goes through a placeholder file can hang for seconds.

### H.1 Mitigations applied during the window

- **A.7:** OneDrive sync paused on `backend/data/` before window starts.
- **B.1:** `Stop-Process -Force` instead of `taskkill /F` — bypasses one of the WMI/handle paths.
- **C.1:** OneDrive resumed only after window closes.

### H.2 Long-term mitigation (NOT in scope of Phase 0)

Move the `backend/data/` directory off OneDrive entirely:
- Either to `C:\sap-logistics-data\` (requires updating `persistentStore.js:13` — code change, not Phase 0).
- Or to a junction point that bypasses OneDrive virtualization.

This is a Phase 1 or Phase 6 cleanup item, not a Phase 0 stabilization step. Tracked in `recommendations.md`.

### H.3 If OneDrive sync ate a handle anyway

Symptom: pm2 commands return EBUSY or EPERM on `dump.pm2` after Section D.
Recovery: `Restart-Computer`. After reboot, OneDrive starts in paused state by default for files actively being modified, so the locks clear.

---

## Section I — Document references

- `pm2-stabilization.md` — analysis (read first)
- `freeze-policy.md` — what's allowed during this window (no code changes etc.)
- `backup-inventory.md` — backup commands
- `observability-checklist.md` — what to monitor after the window
- `cowork/INCIDENTS.md` — where the post-window write-up lives
- `C:\Users\izik\.pm2\pm2.log` — the daemon log to inspect for new errors after the window

End of runbook.
