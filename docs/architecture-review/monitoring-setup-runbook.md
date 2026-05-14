# Monitoring Setup Runbook

**Audience:** the operator who maintains sap-logistics on this Windows host.
**Purpose:** wire up the 3 monitoring scripts created in `C:\backups\automation\` so that production health is visible without spamming the operator with noise.

This is the operational complement to `production-monitoring-plan.md` (the design doc). All scripts are already on disk; this doc covers the steps Claude can't take (Task Scheduler registration, UptimeRobot signup, env var setup).

---

## 1. Files already created (Claude — Task 2)

| Path | Purpose | Cadence |
|---|---|---|
| `C:\backups\automation\monitor-host.ps1` | Host-local health: PM2, port 4000, /health, disk, memory, store.json, fatal log patterns, dump.pm2 freshness | every 5 min |
| `C:\backups\automation\monitor-tunnel.ps1` | Cloudflare quick-tunnel URL change detection + reachability probe | every 1 hour |
| `C:\backups\automation\monitor-watcher.ps1` | Reads host-monitor.log; surfaces new ALERT lines as Windows toast + optional webhook | every 15 min |

**Logs written:**
- `C:\backups\automation\host-monitor.log` — primary log; INFO + WARN + ALERT lines
- `C:\backups\automation\tunnel-url.txt` — last-known tunnel URL (state)
- `C:\backups\automation\watcher-state.txt` — last-seen line offset (state)
- `C:\backups\automation\watcher-fired.log` — alert delivery audit trail

---

## 2. Operator setup steps (one-time)

### 2.1 Smoke-test the scripts manually before scheduling

```powershell
# Open a PowerShell window. Run each script once and inspect output.

powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\backups\automation\monitor-host.ps1'
Get-Content 'C:\backups\automation\host-monitor.log' -Tail 20
# Expect: lines tagged INFO with current state. No ALERT/WARN unless something is genuinely wrong.

powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\backups\automation\monitor-tunnel.ps1'
Get-Content 'C:\backups\automation\host-monitor.log' -Tail 5
# Expect: "Tunnel URL baseline established: https://..." on first run.

powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\backups\automation\monitor-watcher.ps1'
# Expect: silent (no alerts to surface yet) OR Windows toast if ALERTs were already in host-monitor.log.
```

If any script errors out, fix the path/permission before scheduling.

### 2.2 Register Task Scheduler entries

Run **as Administrator** in PowerShell:

```powershell
# --- Task A: monitor-host every 5 minutes ---
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\backups\automation\monitor-host.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'sap-logistics-monitor-host' `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force

# --- Task B: monitor-tunnel every hour ---
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\backups\automation\monitor-tunnel.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'sap-logistics-monitor-tunnel' `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force

# --- Task C: monitor-watcher every 15 minutes ---
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\backups\automation\monitor-watcher.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'sap-logistics-monitor-watcher' `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force

# --- Verify all 3 registered ---
Get-ScheduledTask -TaskName 'sap-logistics-*' | Select TaskName, State, @{n='LastRun';e={(Get-ScheduledTaskInfo $_).LastRunTime}}
```

### 2.3 Optional: webhook for Slack/Discord/Telegram

If you want alerts in a chat channel beyond Windows toasts:

```powershell
# Set as user-level env var (persists across reboots; doesn't affect production)
[System.Environment]::SetEnvironmentVariable('OPS_WEBHOOK_URL', 'https://hooks.slack.com/services/T.../B.../...', 'User')

# Sign out + sign back in OR restart Task Scheduler to pick up the new env var
```

The `monitor-watcher.ps1` reads `$env:OPS_WEBHOOK_URL`. Slack-compatible JSON; Discord supports the same shape via `?wait=true`. Leave unset to disable webhook (toast still works).

### 2.4 Optional: UptimeRobot external probe

External "is the site up from outside the office network?" — separate from host-local checks because it covers tunnel + Cloudflare edge.

1. Sign up: https://uptimerobot.com (free tier: 50 monitors, 5-min interval)
2. Find current public URL:
   ```powershell
   $pub = ([regex]::Match((Get-Content 'C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs\cf-tunnel-error.log' |
                          Select-String 'trycloudflare\.com' | Select -Last 1).Line, 'https://[a-z0-9-]+\.trycloudflare\.com')).Value
   Write-Host "Current URL: $pub"
   ```
3. Add a monitor:
   - Type: HTTP(s) keyword
   - URL: `<pub>/health`
   - Keyword: `"ok":true`
   - Alert if: keyword does NOT exist
   - Alert contacts: your email + (optional) SMS
   - Interval: 5 min (free tier max)
4. **When the tunnel URL changes** (per `monitor-tunnel.ps1` alert), update the monitor URL manually. OR migrate to Cloudflare named-tunnel for a stable URL (see `tunnel-dependency-analysis.md` §7).

---

## 3. Daily verification (operator's 5-min routine)

Per `wave-a-observation-window.md` §2, but the monitoring scripts now do most of the work automatically. Daily routine becomes:

```powershell
# A. Did monitoring run today?
Get-ScheduledTask -TaskName 'sap-logistics-*' | ForEach-Object {
  $info = Get-ScheduledTaskInfo $_
  "$($_.TaskName) -> last ran $($info.LastRunTime); next $($info.NextRunTime); result $($info.LastTaskResult)"
}
# Expect: LastRunTime within last 5/15/60 min depending on task; LastTaskResult = 0

# B. Any ALERT lines today?
$today = Get-Date -Format 'yyyy-MM-dd'
$alerts = Get-Content 'C:\backups\automation\host-monitor.log' |
          Where-Object { $_ -match $today -and $_ -match '\sALERT\s' }
Write-Host "ALERTs today: $($alerts.Count)"
$alerts | Select-Object -Last 10

# C. Any WARN lines today?
$warns = Get-Content 'C:\backups\automation\host-monitor.log' |
         Where-Object { $_ -match $today -and $_ -match '\sWARN\s' }
Write-Host "WARNs today: $($warns.Count)"

# D. Watcher fired any alerts?
Get-Content 'C:\backups\automation\watcher-fired.log' -Tail 20 -ErrorAction SilentlyContinue
```

If both `ALERTs today` and `WARNs today` are 0 → green. Move on with your day.
If either > 0 → read the lines, decide if action needed.

---

## 4. Tuning thresholds

After 3-7 days of data, the operator should review and tune:

### 4.1 If false alarms:
- **Memory `WARN` at 300 MB too low?** — sap-logistics steady-state may be ~300+ MB after caching is warm. Edit `monitor-host.ps1` `$MEM_WARN_MB` upward.
- **store.json age `WARN` too eager?** — if demoServer goes hours without writes during quiet periods, raise `$STORE_JSON_AGE_WARN_HR` to 48.

### 4.2 If false negatives (missed real issues):
- **Add a new fatal pattern** to `$LOG_FATAL_PATTERN` in `monitor-host.ps1`. Example: `'OutOfMemory|FATAL ERROR'`.
- **Add a new noise pattern** to `$LOG_NOISE_PATTERN` to filter known-acceptable noise.

### 4.3 Where tuning lives
All thresholds are at the top of `monitor-host.ps1`. Edit, save. Next scheduled run picks up new values (no restart).

---

## 5. Stopping the monitoring (rollback)

If monitoring scripts cause issues OR need to be paused:

```powershell
# Disable all 3 tasks (keeps the registration; just doesn't run)
Get-ScheduledTask -TaskName 'sap-logistics-*' | Disable-ScheduledTask

# Remove all 3 tasks entirely
Get-ScheduledTask -TaskName 'sap-logistics-*' | Unregister-ScheduledTask -Confirm:$false

# Delete the scripts
Remove-Item 'C:\backups\automation\monitor-host.ps1'
Remove-Item 'C:\backups\automation\monitor-tunnel.ps1'
Remove-Item 'C:\backups\automation\monitor-watcher.ps1'

# Logs remain in C:\backups\automation\ for audit
```

**No production impact** from disabling/removing monitoring. The scripts are read-only against production; removing them just blinds the operator.

---

## 6. What this does NOT cover

- **External probe (Tier 1)** — UptimeRobot must be set up by operator (§2.4)
- **Centralized log aggregation** — out of scope for Phase 0
- **Application-level metrics** (req/s, latency p99, etc.) — would require code changes to demoServer.js; defer to post-cutover (Prometheus per `recommendations.md` Tier 3)
- **Alert escalation** beyond webhook (PagerDuty, OpsGenie) — paid; out of Phase 0 scope
- **Dashboard UI** — out of scope; `Get-Content` on the log files is sufficient for a single-operator deployment

---

## 7. Validation checklist (after operator setup)

```text
[ ] monitor-host.ps1 ran successfully when invoked manually (Section 2.1)
[ ] monitor-tunnel.ps1 ran successfully and established URL baseline
[ ] monitor-watcher.ps1 ran successfully (silent OR toast)
[ ] All 3 Task Scheduler entries registered (sap-logistics-monitor-host/tunnel/watcher)
[ ] First scheduled run completed (LastTaskResult = 0)
[ ] host-monitor.log has INFO heartbeats matching the 5-min cadence
[ ] (Optional) OPS_WEBHOOK_URL env var set; webhook test message received
[ ] (Optional) UptimeRobot monitor configured + test alert received
[ ] cowork/INCIDENTS.md updated with monitoring-setup entry
```

---

## 8. Refs

- `production-monitoring-plan.md` — design rationale + alert thresholds
- `wave-a-observation-window.md` — how monitoring data feeds the daily review
- `tunnel-dependency-analysis.md` §7 — long-term named-tunnel migration option
- `deploy-discipline.md` — anti-patterns these scripts help avoid

End of monitoring setup runbook.
