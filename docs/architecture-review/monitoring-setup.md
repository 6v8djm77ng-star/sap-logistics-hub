# External Monitoring Setup Plan — Phase 0

Operationalizes `observability-checklist.md` into a concrete, deployable monitoring stack. The checklist said WHAT to watch; this document says with WHICH tools, at WHAT thresholds, and WHO gets paged.

**Scope rule:** monitoring is read-side only. Per `freeze-policy.md`, no production code changes to support monitoring (e.g., no new `/internal/metrics` endpoint until Phase 1). Use existing endpoints + OS-level signals.

---

## 1. Monitoring tiers

| Tier | What it watches | Who acts | Latency budget |
|---|---|---|---|
| Tier 1 — External (SaaS) | `/health` reachability from outside the host | On-call paged | <2 min to detect, <30 min to act |
| Tier 2 — Host-side (PowerShell) | PM2 daemon, processes, ports, disk, memory | Operator email | <15 min to detect, next-day to act |
| Tier 3 — App-side (logs) | Worker errors, slow queries, SAP timeouts | Operator daily review | next-day |
| Tier 4 — Manual (weekly review) | Trend analysis, KPI drift | Operator/team | weekly |

---

## 2. Tier 1 — External health monitoring

### 2.1 Recommended tool: UptimeRobot (free tier)

**Why:** free for ≤50 monitors at 5-min intervals. Email + SMS alerts in free tier. Status page available. Industry-standard.
**Alternatives:** Pingdom (paid, faster polling), Better Uptime (paid, nicer UI), Healthchecks.io (heartbeat-style for the off-host backup tasks).

### 2.2 Endpoints to monitor

| Monitor name | Type | URL | Interval | Alert when |
|---|---|---|---|---|
| sap-logistics — health | HTTP(s) | `https://<public-host>/health` | 5 min | 2 consecutive non-200 |
| sap-logistics — listener | HTTP(s) | `https://<public-host>/health` | 5 min | response time > 5s |
| sap-logistics — wallboard | HTTP(s) | `https://<public-host>/wallboard` (SPA shell, public per `route-matrix.md` §Q) | 5 min | 2 consecutive non-200 |
| sap-logistics — public tracking | HTTP(s) | `https://<public-host>/api/public/track/test-token-that-doesnt-exist` | 15 min | 2 consecutive 5xx (404 expected = healthy) |

> The "public-host" is whatever URL the cf-tunnel / cloudflared / ngrok exposes. Per `pm2-stabilization.md`, three tunnel-style apps (`sap-bi-tunnel`, `sap-bi-ngrok`, `cloudflare-tunnel`) are running on this host. Operator must confirm which one routes to port 4000 and use that URL.

> If NO public URL is acceptable for monitoring (office-LAN-only deployment), Tier 1 can ping `http://localhost:4000/health` from a small monitor agent on the SAME host — but that defeats half the purpose (it can't detect host-down).

### 2.3 Setup steps
1. Create UptimeRobot account.
2. Add the 4 monitors above.
3. Configure alert contacts: at least 2 (operator + backup).
4. Set up "Maintenance Window" feature for the planned PM2 stabilization window so it doesn't page during expected downtime.
5. Subscribe operator's phone for SMS alerts (free tier supports email; SMS may be a paid upgrade).

### 2.4 Thresholds (UptimeRobot)
- Down threshold: 2 consecutive failed checks.
- Re-test interval: every 5 minutes.
- Confirmation: yes (re-test once before alerting to filter transient blips).

---

## 3. Tier 2 — Host-side PowerShell monitoring

### 3.1 The check script

Create `C:\scripts\monitor-host.ps1`. Runs every 5 minutes via Task Scheduler.

```powershell
$ErrorActionPreference = 'Continue'
$alertFile = 'C:\backups\automation\HOST-ALERTS.log'
$alerts = @()

function Add-Alert($severity, $msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$severity] $msg"
    Write-Host $line
    $script:alerts += $line
}

# 1. /health is reachable AND mode is what we expect
try {
    $resp = Invoke-WebRequest -Uri 'http://localhost:4000/health' -TimeoutSec 5 -UseBasicParsing
    $body = $resp.Content | ConvertFrom-Json
    if ($resp.StatusCode -ne 200) { Add-Alert 'P1' "/health HTTP $($resp.StatusCode)" }
    if ($body.ok -ne $true)      { Add-Alert 'P1' "/health ok=$($body.ok)" }
    # Currently: mode=DEMO+SAP. After cutover, this should change.
    # if ($body.mode -ne 'DEMO+SAP') { Add-Alert 'P2' "/health mode=$($body.mode) (expected DEMO+SAP)" }
}
catch {
    Add-Alert 'P0' "/health unreachable: $_"
}

# 2. Port 4000 has a listener
$tcp = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if (-not $tcp) {
    Add-Alert 'P0' "Port 4000: no listener"
}

# 3. PM2 sap-logistics process is alive
$j = pm2 jlist 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
if ($j) {
    $logistics = $j | Where-Object { $_.name -eq 'sap-logistics' }
    if (-not $logistics) {
        Add-Alert 'P0' "PM2: sap-logistics not in jlist"
    } elseif ($logistics.pm2_env.status -ne 'online') {
        Add-Alert 'P0' "PM2: sap-logistics status=$($logistics.pm2_env.status)"
    }
    # Watch restart_time for unexpected increments
    $rt = $logistics.pm2_env.restart_time
    $rtFile = 'C:\backups\automation\sap-logistics-restart-time'
    if (Test-Path $rtFile) {
        $prev = [int](Get-Content $rtFile -Raw).Trim()
        if ($rt -gt $prev) {
            Add-Alert 'P1' "PM2: sap-logistics restart_time jumped $prev → $rt"
        }
    }
    Set-Content $rtFile $rt
    # Memory check
    $memMb = [math]::Round($logistics.monit.memory / 1MB, 0)
    if ($memMb -gt 700) {
        Add-Alert 'P1' "PM2: sap-logistics memory ${memMb} MB (cap 1024)"
    }
}
else {
    Add-Alert 'P1' "pm2 jlist returned nothing or unparseable"
}

# 4. Disk free
$drive = Get-PSDrive C
$freeGb = [math]::Round($drive.Free / 1GB, 1)
if ($freeGb -lt 20) {
    Add-Alert 'P0' "Disk C: ${freeGb} GB free (threshold 20)"
} elseif ($freeGb -lt 50) {
    Add-Alert 'P2' "Disk C: ${freeGb} GB free (warning 50)"
}

# 5. Memory
$os = Get-CimInstance Win32_OperatingSystem
$freePct = [math]::Round(($os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
if ($freePct -lt 10) {
    Add-Alert 'P0' "Free memory ${freePct}% (threshold 10)"
}

# 6. backend/data/store.json size sanity
$store = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\data\store.json"
if (Test-Path $store) {
    $sizeMb = [math]::Round((Get-Item $store).Length / 1MB, 2)
    if ($sizeMb -gt 100) {
        Add-Alert 'P1' "store.json ${sizeMb} MB (threshold 100)"
    }
} else {
    Add-Alert 'P0' "store.json missing!"
}

# 7. log-file growth (warn if any single log file > 100 MB)
$logsDir = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs"
Get-ChildItem "$logsDir\*.log" -ErrorAction SilentlyContinue | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    if ($mb -gt 100) {
        Add-Alert 'P2' "log $($_.Name) is ${mb} MB"
    }
}

# 8. Backup heartbeat freshness
$hbs = @{
    'store-json'   = 26
    'pm2-dump'     = 26
    'app-logs'     = 192   # weekly + buffer
    'uploads'      = 26
    'offhost'      = 26
}
foreach ($name in $hbs.Keys) {
    $f = "C:\backups\automation\heartbeat-$name"
    if (-not (Test-Path $f)) { Add-Alert 'P1' "Backup heartbeat missing: $name"; continue }
    $age = ((Get-Date) - (Get-Item $f).LastWriteTime).TotalHours
    if ($age -gt $hbs[$name]) {
        Add-Alert 'P1' "Backup heartbeat stale: $name ($([math]::Round($age,1))h, max $($hbs[$name])h)"
    }
}

# 9. Error markers from backup automation
Get-ChildItem 'C:\backups\automation\error-*' -ErrorAction SilentlyContinue | ForEach-Object {
    $msg = Get-Content $_.FullName -ErrorAction SilentlyContinue
    Add-Alert 'P1' "Error marker: $($_.Name) => $msg"
}

# 10. Any orphan on port 4001 (means sap-bi-api regressed)
$tcp4001 = Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue
if ($tcp4001 -and $j) {
    $bi = $j | Where-Object { $_.name -eq 'sap-bi-api' }
    if (-not $bi -or $bi.pm2_env.status -ne 'online') {
        Add-Alert 'P1' "Port 4001 has listener but sap-bi-api not online (orphan)"
    }
}

# Output
if ($alerts.Count -gt 0) {
    Add-Content -Path $alertFile -Value ($alerts -join "`r`n")
    Add-Content -Path $alertFile -Value '---'
    # Optional: Send-MailMessage (requires SMTP config — operator fills in)
    # Send-MailMessage ...
    exit 1
} else {
    # Refresh OK heartbeat
    Set-Content 'C:\backups\automation\heartbeat-host-monitor' (Get-Date -Format 'o')
    exit 0
}
```

### 3.2 Task Scheduler config
- **Name:** `Monitor — host`
- **Trigger:** every 5 min
- **Action:** PowerShell + `monitor-host.ps1`
- **If task is already running:** do not start a new instance.

### 3.3 Output
- All alerts append to `C:\backups\automation\HOST-ALERTS.log`.
- The operator should configure either:
  - **Send-MailMessage** for immediate email on alert (if SMTP credentials available).
  - **A separate dashboard/SIEM ingester** that tails `HOST-ALERTS.log`.
  - Or at minimum: a daily `Get-Content HOST-ALERTS.log -Tail 50` review by the operator.

---

## 4. Tier 3 — App-side (log) monitoring

### 4.1 What to watch
The application writes to:
- `backend/logs/error.log` — winston error level
- `backend/logs/combined.log` — all log levels
- `backend/logs/pm2-error.log` — captured stderr from PM2
- `backend/logs/pm2-out.log` — captured stdout

Patterns of interest:
- `[worker] tick failed` — known noisy pattern; alert ONLY if rate >5/min for 30+ min.
- `Connection is closed` (mssql) — same.
- `EADDRINUSE` — port collision; immediate alert.
- `Cannot find module` — startup failure; immediate.
- `unhandledRejection` / `UncaughtException` — depends on Winston format; should be P0.
- `Login failed for user` (mssql) — P1.
- HTTP 5xx in morgan logs — track count per minute; alert if >10/min.

### 4.2 Implementation — minimum viable
A daily PowerShell digest script that greps the logs and sends a summary to the operator:

```powershell
# C:\scripts\daily-log-digest.ps1
$today = Get-Date -Format 'yyyy-MM-dd'
$logsDir = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs"
$out = @"
sap-logistics daily log digest — $today

== Error counts (last 24h, error.log) ==
"@
$cutoff = (Get-Date).AddDays(-1)
$errCount = (Get-Content "$logsDir\error.log" -ErrorAction SilentlyContinue |
    Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}' -and [datetime]::Parse(($_ -split ' ')[0..1] -join ' ') -gt $cutoff }).Count
$out += "`n  Total error lines: $errCount`n"

# Pattern counts
$patterns = @{
    'tick failed'     = '\[worker\] tick failed'
    'EADDRINUSE'      = 'EADDRINUSE'
    'Login failed'    = 'Login failed for user'
    'unhandledReject' = 'unhandledRejection'
}
foreach ($name in $patterns.Keys) {
    $count = (Select-String -Path "$logsDir\error.log" -Pattern $patterns[$name] -ErrorAction SilentlyContinue).Count
    $out += "  $name : $count`n"
}

# pm2-out.log size growth
$pm2Out = Get-Item "$logsDir\pm2-out.log" -ErrorAction SilentlyContinue
if ($pm2Out) {
    $out += "`n== pm2-out.log size: $([math]::Round($pm2Out.Length/1MB, 2)) MB ==`n"
}

Add-Content -Path 'C:\backups\automation\daily-digest.log' -Value $out
# Optional: Send-MailMessage with $out as body
```

Schedule daily 06:00.

### 4.3 Stretch: real log aggregation
Out of Phase 0 scope. Tools to consider post-cutover:
- **Loki + Promtail** (self-hosted, free).
- **Datadog Logs** (paid; nice UI).
- **Papertrail / LogDNA** (paid).
- **Windows Event Log forwarding** (built-in; needs central collector).

---

## 5. PM2 monitoring

### 5.1 Today's pain
`pm2 jlist` takes ~2 minutes due to daemon congestion (per `pm2-stabilization.md`). The host-monitor script in §3 sets a 5-min cadence which gives margin.

### 5.2 What we monitor
Already covered by §3 step 3:
- `pm2 jlist | Where { name='sap-logistics' }` returns the process
- `pm2_env.status == online`
- `pm2_env.restart_time` not climbing
- `monit.memory` < 700 MB

### 5.3 What we deliberately don't auto-restart
**No automatic `pm2 restart`** in monitoring. If sap-logistics is down, the operator MUST decide manually whether to restart (per `pm2-stabilization.md`, restart in current daemon state risks orphan-on-port-4000).

### 5.4 PM2 Plus / pm2.io
The PM2 vendor sells a hosted monitoring service. **Do not enable during Phase 0** — it requires `pm2 install pm2-server-monit`/`pm2 link` which forks a new daemon child (per `pm2-stabilization.md` §7 do-not list). Defer to post-cutover decision.

---

## 6. Worker monitoring

### 6.1 Today (demoServer running)
Only the simulator runs. Monitoring:
- `pm2-out.log` should contain `[sim] New return: RET-...` lines, ~1 per minute.
- Alert if no `[sim]` line for 30+ minutes (simulator hung).

```powershell
# Add to monitor-host.ps1 §3.1:
$pm2Out = "$logsDir\pm2-out.log"
if (Test-Path $pm2Out) {
    $lastSim = (Get-Content $pm2Out -Tail 200 | Select-String '\[sim\]' | Select-Object -Last 1)
    if ($lastSim) {
        # Parse the timestamp
        if ($lastSim.Line -match '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})') {
            $simAge = ((Get-Date) - [datetime]::Parse($matches[1])).TotalMinutes
            if ($simAge -gt 30) {
                Add-Alert 'P2' "[sim] last entry $([math]::Round($simAge,0)) minutes ago (threshold 30)"
            }
        }
    }
}
```

### 6.2 Post-cutover (server.js running)
Five real workers. Monitoring approach:
- **sapSyncWorker:** queries `dbo.SapRetryQueue` every 30s. Alert if `Status='FAILED_PERMANENT' COUNT > 5`.
- **dailyDigestWorker:** sends email daily. Alert if no email log entry for 26+ hours.
- **cleanupWorker:** alert if no cleanup-log entry for 26+ hours.
- **ceoBriefScheduler / davoMixReportScheduler:** env-gated; only monitor IF the relevant env flag is true.

These checks land in the host-monitor script after cutover. **Out of Phase 0 scope** since workers are dormant today.

---

## 7. Specific worker queries (post-cutover)

```sql
-- Stuck SAP retries
SELECT COUNT(*) FROM dbo.SapRetryQueue WHERE Status='FAILED_PERMANENT';

-- Pending retries with NextAttemptAt in the past (worker should be picking them up)
SELECT COUNT(*) FROM dbo.SapRetryQueue
WHERE Status='PENDING' AND NextAttemptAt < SYSUTCDATETIME();

-- Stuck deliveries: marked DELIVERED but no SAP DocEntry for >1h
SELECT COUNT(*) FROM dbo.RunOrders ro
INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
WHERE ro.Status='DELIVERED' AND ro.SapDeliveryDocEntry IS NULL
  AND s.CompletedAt < DATEADD(HOUR, -1, SYSUTCDATETIME());
-- Alert: > 0 → SAP write failing silently

-- Recent agent runs (post-cutover, if AI is enabled)
SELECT COUNT(*) AS Last24h, MAX(CreatedAt) AS MostRecent
FROM dbo.AgentRuns
WHERE CreatedAt > DATEADD(HOUR, -24, SYSUTCDATETIME());
```

---

## 8. Disk + memory monitoring

Already covered by §3.1 steps 4-5.

Threshold rationale:
- **<20 GB free disk:** P0 because OneDrive sync, PM2 logs, SQL backups, store.json, and uploads all want disk.
- **<10% free memory:** P0 because PM2 daemon's pidusage WMI gets even slower under memory pressure.

---

## 9. Alert thresholds — single sheet

| Severity | When to trigger | Action expected |
|---|---|---|
| **P0** (page on-call) | /health unreachable for 10 min, sap-logistics not online, port 4000 no listener, disk <20 GB, memory <10%, store.json missing, EADDRINUSE on 4000 | Page primary on-call. Acknowledge within 5 min. |
| **P1** (alert email) | restart_time jumps, memory >700 MB, sap-logistics CPU sustained >80%, FAILED_PERMANENT >5, log files >100 MB, backup heartbeat stale, sapSqlA/B unhealthy >5 min, pm2 jlist >180s | Operator review same business hour. |
| **P2** (digest entry) | disk <50 GB, store.json >50 MB, memory >50% sustained, simulator silent >30 min, single log >50 MB, PDF generation >30s | Daily digest review. |
| **P3** (trend review) | KPI drift, growth rate anomalies, non-fatal recurring errors | Weekly review. |

Detailed conditions are in `observability-checklist.md` §10.

---

## 10. Escalation flow

```
External monitor (UptimeRobot)
       │
       │ /health down for 10 min
       ▼
   Primary on-call (SMS + email)
       │
       │ acknowledge within 5 min
       ▼
   Operator triages:
       - Check pm2 jlist (may take 2 min — be patient)
       - Check /health locally (curl http://localhost:4000/health)
       - Check pm2-error.log tail
       - Check disk + memory
       │
       ├── If sap-logistics is alive but external probe failed → tunnel issue
       │   → restart cf-tunnel; verify external probe recovers
       │
       ├── If sap-logistics is down → consult pm2-maintenance-runbook.md
       │   → DO NOT pm2 restart blindly (orphan risk)
       │
       └── If neither → escalate to backup operator
              │
              ▼
         Backup operator joins
              │
              │ if 30 min no resolution
              ▼
         Engineer escalation (the person who wrote this doc)
              │
              ▼
         If 60 min total downtime → consider rollback to last known good
            (pm2-maintenance-runbook.md Section D)
```

### 10.1 Contacts table

| Role | Contact | Hours |
|---|---|---|
| Primary on-call | <operator name + phone> | 24/7 during freeze |
| Backup on-call | <backup operator + phone> | 24/7 during freeze |
| Engineer escalation | <engineer + Slack> | business hours |
| Anthropic / API support | console.anthropic.com | self-service |
| SAP B1 admin | <SAP admin contact> | for SAP outages |
| Hosting / network | <ISP or IT support> | for connectivity |

Operator fills in. Documented in `cowork/INCIDENTS.md` separately for confidentiality.

---

## 11. Recommended free vs paid tools

### 11.1 Free tier sufficient for Phase 0

| Tool | Use | Free tier limit |
|---|---|---|
| **UptimeRobot** | External /health | 50 monitors @ 5min |
| **Healthchecks.io** | Backup heartbeat-style | 20 checks free |
| **Cloudflare** | DNS + free WAF (if exposed publicly) | Free plan |
| **Windows Task Scheduler** | All host-side monitoring | built-in |
| **PowerShell Send-MailMessage** | Email alerts | requires SMTP |
| **Gmail SMTP** | If operator has Gmail | 500/day free |

### 11.2 Worth paying for (post-cutover)

| Tool | Use | Approximate cost |
|---|---|---|
| **Datadog** | Centralized logs + metrics + APM | $15-31/host/mo |
| **Better Uptime** | Polished status page + on-call rotation | $24/mo |
| **PagerDuty** | On-call rotation + escalation | $19/user/mo |
| **Loki + Grafana Cloud** | Logs + dashboards (cheap end) | Free tier 50 GB |
| **Sentry** | Error tracking | Free tier 5k events/mo |

### 11.3 Phase 0 minimal stack
- UptimeRobot (external)
- Windows Task Scheduler + PowerShell scripts (host-side)
- Send-MailMessage via Gmail SMTP (alerts)
- `cowork/INCIDENTS.md` (incident log)

Total cost: $0. Setup time: 4-6 hours.

---

## 12. Setup checklist

```text
[ ] Operator confirms public URL for sap-logistics (or chooses LAN-only mode)
[ ] UptimeRobot account created
[ ] 4 monitors added per §2.2
[ ] Alert contacts configured (2 minimum)
[ ] C:\scripts\monitor-host.ps1 created
[ ] Task Scheduler entry: "Monitor — host" runs every 5 min
[ ] Manual run of monitor-host.ps1 verified (no false alarms)
[ ] HOST-ALERTS.log location agreed
[ ] SMTP creds in place (or fallback to manual log review documented)
[ ] C:\scripts\daily-log-digest.ps1 created
[ ] Task Scheduler entry: "Daily log digest" runs at 06:00
[ ] Contacts table populated in INCIDENTS.md
[ ] Escalation flow rehearsed once with operator + backup
[ ] First week of monitoring data reviewed; thresholds tuned
```

Estimated setup time: 4-6 hours.

---

## 13. Document references

- `observability-checklist.md` — full inventory of WHAT to watch
- `pm2-stabilization.md` — context for why we don't auto-restart
- `pm2-maintenance-runbook.md` — incident response steps
- `freeze-policy.md` — applies to monitoring (no production code changes)
- `backup-automation-plan.md` — sets up the heartbeat files monitored here
- `cowork/INCIDENTS.md` — incident log

End of monitoring setup plan.
