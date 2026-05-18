# Health monitoring — `/health` endpoint + external alerts

This doc covers (a) what the backend's `/health` endpoint exposes today
and (b) the recommended path to add external uptime monitoring so the
operator finds out about outages BEFORE the operators do.

---

## The endpoint

```
GET /health         (no auth required)
```

Located at `backend/src/demo/demoServer.js:793`.

### Response (200 always — even when degraded)

```json
{
  "ok": true,
  "time": "2026-05-18T08:30:00.000Z",
  "mode": "DEMO+SAP" | "DEMO",
  "sapConnected": true | false,
  "checks": {
    "logisticsDb": { "ok": true|false, "note": "..." },
    "sapSqlA":     { "ok": true,        "stats": {...} },
    "sapSqlB":     { "ok": true,        "stats": {...} }
  }
}
```

### Important behavior

- The endpoint returns **HTTP 200** even when SAP is unreachable. The
  `sapConnected: false` field is the degradation signal — the HTTP
  status alone won't catch this.
- The endpoint does NOT check tunnel reachability (the tunnel
  process is separate from the backend).
- The endpoint does NOT check PM2 process health for other services
  (sap-bi, davo, etc.) — those have their own concerns.
- The endpoint does NOT check disk space, RAM, CPU.

### What the operator can derive

| Signal | Meaning |
|---|---|
| HTTP 200 + `ok: true` + `sapConnected: true` | Healthy. SAP reads/writes work. |
| HTTP 200 + `ok: true` + `sapConnected: false` | Degraded. App is up but SAP is unreachable. Reads will fail, writes will fail. |
| HTTP 500 or no response | Backend crashed or PM2 process is dead. |
| Connection refused | Port 4000 is bound by something else, or PM2 process never started. |
| Cannot resolve hostname | Tunnel is down OR you have the wrong tunnel URL. |

---

## Suggested external monitoring

The goal: get an alert (email/SMS) when the URL stops responding for
2+ minutes, so an operator can intervene before users notice.

### Tier 1 — free, takes 5 minutes to set up

**UptimeRobot** (free tier: 50 monitors, 5-minute checks).

1. Sign up at https://uptimerobot.com (no payment needed)
2. Add Monitor:
   - Type: HTTPS
   - URL: `https://<your-current-tunnel-url>/health`
   - Friendly name: `sap-logistics`
   - Monitoring interval: 5 minutes
3. Add Alert Contact:
   - Type: Email (free)
   - Or Telegram / SMS (paid)
4. Done. You get an email if `/health` is unreachable 2 checks in a row.

**Limitations**:
- HTTP status only — it can't detect "ok:true, sapConnected:false" degradation
- 5-min granularity means you find out within 5-10 minutes

**Once the named tunnel is set up** (see
`docs/cloudflare-tunnel-setup.md`), point UptimeRobot at the stable
URL (e.g., `logistics.oig.co.il/health`) so you don't have to update
the monitor when the quick tunnel rotates.

### Tier 2 — same UptimeRobot, smarter check

Use UptimeRobot's **Keyword Monitor** instead of plain HTTP:
- URL: same `/health` URL
- Keyword: `"sapConnected":true`
- Trigger: alert if keyword **NOT FOUND** in response

Now you get alerted on both "endpoint dead" AND "SAP disconnected".

### Tier 3 — internal watchdog (no external account)

A local cron-style watchdog that polls `/health` every minute and
restarts PM2 if 3 checks fail. Useful as a self-healing layer for
flaky failures. Sketch:

```powershell
# scripts/health-watchdog.ps1 — run as Task Scheduler every 1 min
$url = "http://localhost:4000/health"
$stateFile = "$env:TEMP\sap-logistics-watchdog.txt"
$failures = 0
if (Test-Path $stateFile) { $failures = [int](Get-Content $stateFile -Raw) }

try {
  $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  $body = $r.Content | ConvertFrom-Json
  if ($body.ok -eq $true) {
    Set-Content $stateFile -Value 0
    exit 0
  }
  throw "health.ok is false"
} catch {
  $failures++
  Set-Content $stateFile -Value $failures
  if ($failures -ge 3) {
    & "C:\Program Files\nodejs\node.exe" "$env:APPDATA\npm\node_modules\pm2\bin\pm2" restart sap-logistics
    # Append to a watchdog log
    "$(Get-Date -Format 'o') restarted after $failures failures" | Add-Content "logs\watchdog.log"
    Set-Content $stateFile -Value 0
  }
}
```

Trade-off: this masks problems (you only see them in the log). Tier 1
or 2 are better for visibility.

---

## What's NOT covered today (gaps to consider)

| Gap | Risk | Fix |
|---|---|---|
| Tunnel goes down but backend stays up | Users get DNS failure, no alert | Set up tier 1 UptimeRobot on the **public URL** (not localhost) |
| store.json grows beyond a healthy bound | UI gets slow, eventually OOMs | Add a `storeSizeKB` field to `/health` response, threshold-alert |
| Disk fills up | Backend can't write store.json | Windows already has disk space alerts (see `SAP BI - Disk Space Alert` task) |
| RAM pressure | PM2 starts restarting processes | `pm2 monit` shows it live, but no proactive alert |
| Anthropic API rate limit / billing | AI features fail | Anthropic console has spend alerts; enable them |
| SAP B1 server (192.168.0.220) reboots | `sapConnected:false` for an hour | UptimeRobot keyword monitor catches it |

---

## Quick-add fields to `/health` (sketch — not required)

If you ever want to enhance `/health`, here's a non-breaking superset:

```json
{
  "ok": true,
  "time": "...",
  "mode": "DEMO+SAP",
  "sapConnected": true,
  "uptime": 3600,
  "storeSize": { "bytes": 2725900, "warnAbove": 50000000 },
  "memory": { "rssMB": 71, "heapUsedMB": 50 },
  "openConnections": 0,
  "lastBackupAge": { "seconds": 7200, "warnAbove": 90000 },
  "checks": { ... }
}
```

`storeSize.warnAbove`, `lastBackupAge.warnAbove` would be the
threshold-based alerts UptimeRobot keyword monitor can check.

But — none of this is needed today. Tier 1 catches the common failure
(server down). Add fields as you encounter the corresponding failure.
