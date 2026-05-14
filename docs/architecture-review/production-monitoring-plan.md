# Production Monitoring Plan

**Audience:** the operator who maintains sap-logistics in production.
**Goal:** detect production problems within minutes, not after a customer complains. Monitor what matters, ignore what doesn't.

This document complements `wave-a-observation-window.md` (which is short-term Wave-A-specific) by laying out the durable monitoring baseline.

---

## 1. Tiered monitoring philosophy

| Tier | Update freq | Purpose | Cost |
|---|---|---|---|
| **Tier 1 — External** | every 60s | "Is the site up?" — view from outside, like a customer would | Free or near-free |
| **Tier 2 — Host-local** | every 5 min | OS-level health: PM2, ports, disk, memory | Free |
| **Tier 3 — Application logs** | continuous tail + daily review | Behavior signals: error patterns, request rates | Free |
| **Tier 4 — Aggregated metrics** (future) | every 15s with retention | Trends, capacity planning | Paid (post-Phase-6) |

Phase 0 + Wave A observation only needs Tiers 1-3. Tier 4 belongs to the post-cutover world.

---

## 2. Tier 1 — External monitoring

### 2.1 What to monitor
A single endpoint: `<public-tunnel-URL>/health`. The response body is parseable JSON; we can assert specific fields.

### 2.2 Recommended tooling

| Tool | Tier | Notes |
|---|---|---|
| **UptimeRobot** | Free (50 monitors, 5-min interval) | Easiest. Email/SMS/Slack alerts. HTTP keyword check supported. |
| **Better Uptime / BetterStack** | Free 10 monitors | Status page included. Slack/Discord/SMS. |
| **Pingdom** | Paid (€10/mo) | Mature, multi-region. Worth it if SLAs matter. |
| **Cronitor** | Free 5 monitors | Good for cron-style scheduled checks. |

**Recommendation: UptimeRobot.** Free tier is sufficient. Set up:

```
Monitor 1: https://<current-tunnel-URL>/health
  Check interval:   5 min (free tier; paid 1 min)
  Type:             HTTP(S) keyword
  Keyword:          "ok":true
  Alert if missing
  Alert contacts:   operator email + (optional) SMS

Monitor 2: localhost monitor (run from a separate machine inside LAN, OR skip)
  Same /health path
```

**Watch out:** the tunnel URL changes when cloudflared restarts (per `tunnel-dependency-analysis.md` and the Wave A deploy lesson). UptimeRobot's monitor URL is fixed. Either:
- Switch to a Cloudflare named-tunnel (stable URL) — see `tunnel-dependency-analysis.md` §7
- OR maintain a manual process: check cf-tunnel-error.log weekly; update UptimeRobot URL when it changes

### 2.3 Alert thresholds
- **Page on-call:** /health != 200 for 2 consecutive checks (10 min downtime)
- **Page on-call:** keyword `"ok":true` missing (system reports ok=false)
- **Page on-call:** /health latency >3s (degraded performance)

---

## 3. Tier 2 — Host-local monitoring

### 3.1 PowerShell script (recommended)
Save as `C:\backups\automation\monitor-host.ps1`:

```powershell
# Runs every 5 minutes via Task Scheduler. Writes to a log.
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$log = "C:\backups\automation\host-monitor.log"

function Write-Log($msg) {
  Add-Content -Path $log -Value "$ts $msg"
}

# A. PM2 daemon responsive?
$daemon_ok = $false
try {
  $j = pm2 jlist | ConvertFrom-Json
  $daemon_ok = ($j -ne $null)
} catch { Write-Log "ALERT pm2 jlist failed: $_" }

# B. sap-logistics state
if ($daemon_ok) {
  $sl = $j | Where-Object { $_.name -eq 'sap-logistics' }
  if (-not $sl) { Write-Log "ALERT sap-logistics not in pm2 list" }
  elseif ($sl.pm2_env.status -ne 'online') { Write-Log "ALERT sap-logistics status = $($sl.pm2_env.status)" }
  elseif ($sl.monit.memory -gt 700MB) { Write-Log "ALERT sap-logistics memory = $([math]::Round($sl.monit.memory/1MB,1)) MB (over 700MB)" }
  elseif ($sl.pm2_env.restart_time -gt 1) { Write-Log "WARN  sap-logistics restart_time = $($sl.pm2_env.restart_time) (expected 1)" }
}

# C. Port 4000 listener?
$port = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if (-not $port) { Write-Log "ALERT port 4000 not bound" }

# D. /health localhost
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:4000/health' -TimeoutSec 8 -UseBasicParsing
  if ($r.StatusCode -ne 200) { Write-Log "ALERT /health localhost = $($r.StatusCode)" }
  $body = $r.Content | ConvertFrom-Json
  if (-not $body.ok) { Write-Log "ALERT /health localhost ok=false" }
} catch { Write-Log "ALERT /health localhost failed: $_" }

# E. Disk free
$disk = Get-PSDrive C
$free_gb = [math]::Round($disk.Free / 1GB, 1)
if ($free_gb -lt 20) { Write-Log "ALERT C: free = $free_gb GB (under 20 GB)" }

# F. store.json sanity
$store = Get-Item "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\data\store.json" -EA SilentlyContinue
if ($store) {
  $age_hr = [math]::Round(((Get-Date) - $store.LastWriteTime).TotalHours, 1)
  if ($age_hr -gt 24) { Write-Log "WARN  store.json mtime $age_hr hours old (demoServer should write hourly)" }
} else { Write-Log "ALERT store.json missing" }

# G. error.log fresh fatal patterns
$today_str = Get-Date -Format 'yyyy-MM-dd'
$err = Get-Content "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs\error.log" -EA SilentlyContinue |
       Where-Object { $_ -match $today_str -and $_ -match 'TypeError|ReferenceError|jwt malformed|EBUSY|EADDRINUSE' }
if ($err) {
  Write-Log "ALERT new fatal pattern in error.log:"
  $err | ForEach-Object { Write-Log "       $_" }
}

# Always log heartbeat at INFO
Write-Log "INFO  monitor-host.ps1 tick complete"
```

### 3.2 Schedule via Task Scheduler

```powershell
# One-time setup (operator runs once):
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\backups\automation\monitor-host.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'sap-logistics-monitor' -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -Force
```

### 3.3 Alerts that escape the log file
The script writes to `host-monitor.log`. To get notified on `ALERT` lines:

**Option A — file-tail pop-up notifier (simple):**
```powershell
# Save as monitor-watcher.ps1 — runs continuously OR scheduled hourly
$alert_log = "C:\backups\automation\host-alert-pings.log"
$now = Get-Date
$one_hour_ago = $now.AddHours(-1)
$alerts = Get-Content "C:\backups\automation\host-monitor.log" |
          Where-Object {
            $_ -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ALERT' -and
            ([DateTime]::ParseExact(($_ -split ' ', 3)[0..1] -join ' ', 'yyyy-MM-dd HH:mm:ss', $null)) -gt $one_hour_ago
          }
if ($alerts) {
  # Show Windows toast notification
  Add-Type -AssemblyName System.Windows.Forms
  $balloon = New-Object System.Windows.Forms.NotifyIcon
  $balloon.Icon = [System.Drawing.SystemIcons]::Warning
  $balloon.BalloonTipTitle = 'sap-logistics ALERT'
  $balloon.BalloonTipText = ($alerts | Select -First 3 | Out-String)
  $balloon.Visible = $true
  $balloon.ShowBalloonTip(15000)
  Add-Content $alert_log "$now $($alerts.Count) alerts"
}
```

**Option B — outbound webhook (Slack/Discord/Telegram):**
Add to `monitor-host.ps1` `Write-Log` ALERT branches:
```powershell
$webhook = $env:OPS_SLACK_WEBHOOK   # set once in operator's env
if ($webhook) {
  $payload = @{ text = "[sap-logistics] $msg" } | ConvertTo-Json
  Invoke-WebRequest -Uri $webhook -Method POST -ContentType 'application/json' -Body $payload -EA SilentlyContinue | Out-Null
}
```

---

## 4. Tier 3 — Application logs

### 4.1 What lives where (recap)

| Log | Path | Cadence | Rotation |
|---|---|---|---|
| sap-logistics stdout (PM2 capture) | `backend/logs/pm2-out.log` | continuous | manual weekly |
| sap-logistics stderr (PM2 capture) | `backend/logs/pm2-error.log` | on error | manual |
| Custom Winston output | `backend/logs/error.log`, `combined.log` | continuous | per Winston config |
| Server.log | `backend/logs/server.log` | continuous | manual |
| PM2 daemon log | `C:\Users\izik\.pm2\pm2.log` | continuous | PM2 internal (~50 MB rotate) |
| Cloudflared | `backend/logs/cf-tunnel-error.log`, `cf-tunnel-out.log` | continuous | none |
| sap-bi-api error log (different project) | `C:\Users\izik\OneDrive - OIG\שולחן העבודה\sap-bi\logs\api-err.log` | continuous | none |

### 4.2 Daily review (manual, 5 min)
Run as part of the `wave-a-observation-window.md` daily routine:

```powershell
$today = Get-Date -Format 'yyyy-MM-dd'

# Fresh errors not matching known noise
Get-Content "...\backend\logs\error.log" |
  Where { $_ -match $today -and $_ -notmatch 'tick failed Connection is closed|trustServerCertificate|SAP is not fully configured' } |
  Select -Last 20

# PM2 events for sap-logistics today
Select-String 'sap-logistics' "$env:USERPROFILE\.pm2\pm2.log" |
  Where { $_.Line -match $today }

# 4xx/5xx HTTP responses today (from morgan logger output)
Get-Content "...\backend\logs\pm2-out.log" |
  Where { $_ -match $today -and $_ -match '\b(4\d\d|5\d\d)\b' } |
  Select -Last 30
```

### 4.3 Log rotation discipline

Manual weekly rotation (per `backup-inventory.md` §2.6):
```powershell
$ts = Get-Date -Format 'yyyyMMdd'
$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs"
Compress-Archive -Path "$src\*.log" -DestinationPath "C:\backups\app-logs\app-logs-$ts.zip" -Force
# Don't truncate live logs while sap-logistics runs (Node holds the FD); just snapshot.
# PM2 internal pm2.log auto-rotates at ~50MB.
```

---

## 5. PM2-specific monitoring

### 5.1 The two states that matter
- **`online`** = process running. Good.
- **anything else** (`errored`, `stopped`, `launching`, `stopping`) = NOT good. Investigate.

### 5.2 The two counters that matter
- **`restart_time`** — should stay flat at 1 (post-Wave-A). Any increase = unexpected restart.
- **`unstable_restarts`** — should stay 0. Any value = crash loop pattern (sap-bi-api had 23K).

### 5.3 The one memory cap
- PM2 ecosystem.config.cjs sets `max_memory_restart: '1G'` for sap-logistics.
- **Hitting this triggers exactly the crash-loop pattern we saw with sap-bi-api on 2026-05-09 22:50.**
- Pre-emptive: alert at 700 MB, intervene at 900 MB (manual gc / restart in a controlled window before PM2 forces it under load).

### 5.4 PM2 daemon process itself
- Single `node.exe` process running PM2's God daemon.
- If it dies (rare on Windows), `pm2 jlist` returns "PM2 not running" and the operator must `pm2 resurrect` from `dump.pm2`.
- **Risk:** the dump.pm2 always reflects the LAST `pm2 save`. If we deployed Wave A but didn't save, the resurrect would launch pre-Wave-A code. **We did save** — verified `dump.pm2.POST-WAVE-A-20260510-122342` exists at 165,062 bytes.

---

## 6. Tunnel monitoring

### 6.1 Active URL detection
The current public URL is in `cf-tunnel-error.log`. To extract programmatically:
```powershell
$pub = (Select-String 'trycloudflare\.com' "...\backend\logs\cf-tunnel-error.log" |
        Select -Last 1).Line -replace '.*?(https://[a-z0-9-]+\.trycloudflare\.com).*','$1'
```

### 6.2 URL-change detection
Track previous URL; alert when it changes:
```powershell
# Save as monitor-tunnel.ps1, run hourly via Task Scheduler
$state = "C:\backups\automation\tunnel-url.txt"
$current = (Select-String 'trycloudflare\.com' "...\backend\logs\cf-tunnel-error.log" |
            Select -Last 1).Line -replace '.*?(https://[a-z0-9-]+\.trycloudflare\.com).*','$1'
$prev = if (Test-Path $state) { Get-Content $state } else { '' }
if ($current -and ($current -ne $prev)) {
  $alert = "Tunnel URL changed: $prev → $current"
  Add-Content "C:\backups\automation\host-monitor.log" "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ALERT $alert"
  Set-Content $state $current
  # Optional: push to Slack/email
  # Optional: update UptimeRobot via API
}
```

### 6.3 Tunnel process health
```powershell
$cf = Get-Process cloudflared -EA SilentlyContinue
if (-not $cf) { Write-Log 'ALERT cloudflared.exe not running' }
elseif ($cf.Count -lt 2) { Write-Log "WARN  only $($cf.Count) cloudflared processes (expected 2-3)" }
```

### 6.4 Connectivity from outside
Tier 1 UptimeRobot is the primary signal here. If UptimeRobot reports DOWN but localhost /health is UP, the tunnel is broken (cloudflared crashed, network issue, Cloudflare edge issue).

---

## 7. Disk + memory thresholds

### 7.1 Disk
| Threshold | Action |
|---|---|
| Free <50 GB | Trend-watch; identify what's growing |
| Free <20 GB | Investigate; archive logs; consider cleanup |
| Free <5 GB | Page on-call; immediate cleanup needed |

### 7.2 Memory (system-wide)
| Threshold | Action |
|---|---|
| Free physical <30% | Trend-watch |
| Free physical <10% | Investigate; identify hog process |
| Free physical <2% | Page on-call; OS instability imminent |

### 7.3 Per-process (sap-logistics)
| Threshold | Action |
|---|---|
| <300 MB | Normal |
| 300-700 MB | Trend; possible leak; review |
| 700-900 MB | Investigate; plan controlled restart |
| >900 MB | Page on-call; controlled restart before PM2 cap |
| >1 GB | PM2 will auto-restart in seconds — could trigger orphan-on-port-4000 if OneDrive locks |

---

## 8. Failed-auth monitoring

### 8.1 What to count
From `pm2-out.log` (morgan logs every request):
```powershell
$today = Get-Date -Format 'yyyy-MM-dd'
$auth_failures = Get-Content "...\backend\logs\pm2-out.log" |
  Where { $_ -match $today -and $_ -match '\b401\b' }
$by_path = $auth_failures | ForEach { ($_ -split ' ')[2] } | Group-Object | Sort Count -Descending | Select -First 10
$by_path | Format-Table
```

### 8.2 Expected baseline
- Pre-Wave-A: <10 401s/day (only `/api/auth/me` from expired sessions)
- Post-Wave-A: 50-200 401s/day expected during the first week (anonymous probes from scrapers, frontend pages still figuring out their tokens, etc.). After the observation window the rate should settle near pre-Wave-A baseline.

### 8.3 Alert thresholds
- >500 401s/hour from a single IP → likely scraper or brute-force; rate limiter should already cap login but other endpoints aren't rate-limited
- >50 401s/min sustained → frontend page broken (mass user impact)
- 401s on `/api/users/me/change-password` from same IP >3 → potential brute-force (per security-analysis F14)

---

## 9. Restart alerting

### 9.1 The critical signal
Any line matching `App \[sap-logistics:6\] starting` in `pm2.log` that's NEWER than the deploy time = unexpected restart.

```powershell
# Add to monitor-host.ps1
$last_restart = Select-String 'sap-logistics.*starting' "$env:USERPROFILE\.pm2\pm2.log" |
                Select -Last 1
if ($last_restart) {
  $when = [DateTime]::Parse(($last_restart.Line -split 'T')[0] + 'T' + (($last_restart.Line -split 'T')[1] -split ':')[0..2] -join ':')
  $deploy_ts = '2026-05-10T12:21:08Z'   # from wave-a-mitigation-report.md §5
  $deploy_dt = [DateTime]::Parse($deploy_ts)
  if ($when -gt $deploy_dt) {
    Write-Log "WARN  sap-logistics restarted at $when (after Wave A deploy)"
  }
}
```

### 9.2 Restart investigation procedure
When alerted:
1. `pm2-error.log` lines around the restart timestamp — fatal stack trace?
2. `pm2.log` immediately preceding — was it `Stopping app:sap-logistics` (manual or memory-cap) or `exited with code` (crash)?
3. If memory-cap: see §7.3 — investigate growth pattern over hours
4. If crash: copy the stack trace + assess whether Wave A is implicated

---

## 10. Recommended toolchain (consolidated)

For Phase 0 + Wave A observation, this is the minimum viable monitoring:

| Component | Tool | Cost | Setup time |
|---|---|---|---|
| External `/health` probe | UptimeRobot free | Free | 10 min |
| Host-local 5-min check | `monitor-host.ps1` + Task Scheduler | Free | 30 min |
| Tunnel URL change detection | `monitor-tunnel.ps1` hourly | Free | 15 min |
| Daily log review | Manual, per `wave-a-observation-window.md` | Free | 5 min/day |
| Alert delivery | Windows toast OR Slack webhook OR email | Free | 30 min |

**Total setup: ~1.5 hours.** Total ongoing cost: 5 min/day.

For post-cutover (Phase 6+), upgrade to:
- Prometheus + Grafana (per `recommendations.md` Tier 3)
- LogDNA / Datadog Logs (centralized log aggregation)
- Cloudflare named-tunnel + Access policies (eliminates URL-change problem)

These are NOT for Phase 0. Don't build them now.

---

## 11. What NOT to monitor (intentionally)

- **demoServer's `[sim]` simulator events** — synthetic, noisy, no operational signal. Filter out of dashboards.
- **SAP read latency** — SAP is on a remote host, latency varies, not actionable from this end.
- **mssql connection-pool churn** — pre-existing pattern (`tick failed Connection is closed` in error.log), not Wave A's problem.
- **Anthropic API usage** — `aiCostGuard` is a Phase-1 stub (per `security-reaudit.md`), no enforcement; agents only run on explicit operator trigger.
- **`/api/runs`, `/api/picking`, etc.** anonymous probes — these are intentionally still anonymous (Wave B/C scope). Their 401s would mean Wave B is live, which it isn't.

---

## 12. Document references

- `wave-a-observation-window.md` — daily checklist for the next 7 days
- `pm2-stabilization.md` — pre-existing PM2 issues + mitigations
- `pm2-maintenance-runbook.md` — orphan-handling procedure
- `tunnel-dependency-analysis.md` — why tunnel URL changes
- `backup-inventory.md` — backup paths referenced here
- `wave-a-mitigation-report.md` — deploy reference

End of monitoring plan.
