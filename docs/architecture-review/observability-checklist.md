# Observability Checklist — Phase 0

Operational visibility while the system is in pre-migration freeze. Goal: detect regressions early and have data when something goes wrong, **without changing application behavior**.

This is a checklist — work through it once during Phase 0 setup, then keep it as a reference.

---

## 1. Health endpoints

### 1.1 Primary health
- **URL:** `http://localhost:4000/health`
- **Expected today (demoServer):** HTTP 200, JSON `{"ok":true,"mode":"DEMO+SAP","sapConnected":true,"checks":{"logisticsDb":{"ok":false,"note":"Using in-memory demo data"},"sapSqlA":{...},"sapSqlB":{...}}}`
- **Expected post-cutover (server.js):** HTTP 200, JSON without `mode:"DEMO+SAP"`; `logisticsDb.ok=true`.
- **Source:** `backend/src/demo/demoServer.js:284` (current); `backend/src/server.js:103` + `services/health.js` (future).
- **Monitor cadence:** every 60s from a separate machine (Pingdom / UptimeRobot / Windows Task Scheduler curl).
- **Alert thresholds:**
  - HTTP != 200 for 2 consecutive checks → page on-call.
  - `sapConnected=false` for 5+ minutes → page (SAP outage).
  - Response > 5s → page (DB pool saturated or SAP slow).

### 1.2 Process liveness (independent of health endpoint)
- **Command:** `Get-NetTCPConnection -LocalPort 4000 -State Listen`
- **Expected:** one row, `State=Listen`, owning pid matches `pm2 jlist | grep sap-logistics` pid.
- **Alert:** zero rows = process not listening.

### 1.3 PM2 status
- **Command:** `pm2 jlist | ConvertFrom-Json | Where-Object { $_.name -eq 'sap-logistics' } | Select-Object name, pm2_env, monit`
- **Expected:** `pm2_env.status: 'online'`, `pm2_env.restart_time` not climbing.
- **Note:** `pm2 jlist` may take 2 minutes to return on this host until PM2 stabilization completes per `pm2-stabilization.md`. Use a 3-minute timeout.

---

## 2. Worker monitoring

Today (demoServer running): only `liveSimulation.js` runs. The 5 production workers are dormant.

### 2.1 demoServer simulator
- **Evidence of life:** `[sim] New return: RET-...` lines in `backend/logs/pm2-out.log`.
- **Expected cadence:** ~1 entry per minute (per `pm2-out.log` review showing entries every 30s-3min).
- **Alert:** no `[sim]` line for 30+ minutes = simulator hung. Less critical than real-worker failures, but still a smoke test.

### 2.2 Production workers (post-cutover)
Once `server.js` is running:

| Worker | File | Expected | Alert |
|---|---|---|---|
| `sapSyncWorker` | `backend/src/workers/sapSyncWorker.js` (every 30s) | `[worker] Retrying N failed Delivery Notes` lines, OR silence if queue is empty | `[worker] tick failed` for 10+ minutes consecutive → page |
| `dailyDigestWorker` | `backend/src/workers/dailyDigestWorker.js` (cron daily) | One run/day, "Digest sent to N recipients" log | No daily digest log for 26 hours → page |
| `cleanupWorker` | `backend/src/workers/cleanupWorker.js` (cron daily) | One run/day, "Deleted N old GPS pings" | Same |
| `ceoBriefScheduler` | `backend/src/workers/ceoBriefScheduler.js` (cron 0 7 * * *) | Env-gated. If enabled: agent runs, email sent. | If `CEO_BRIEF_SCHEDULE_ENABLED=true` and no run for 26h → page |
| `davoMixReportScheduler` | `backend/src/workers/davoMixReportScheduler.js` (cron Sunday 8AM) | Env-gated. Weekly email. | Same logic |

### 2.3 Worker health from DB

```sql
-- Recent SAP retry queue depth (post-cutover)
SELECT Status, COUNT(*) AS Cnt, MAX(LastAttemptAt) AS LastAttempt
FROM dbo.SapRetryQueue
GROUP BY Status;
-- Expected: Pending small, FAILED_PERMANENT zero or growing very slowly
-- Alert: FAILED_PERMANENT > 5 → investigate

-- Stuck deliveries: marked DELIVERED but no SAP DocEntry for >1h
SELECT COUNT(*) AS StuckDeliveries
FROM dbo.RunOrders ro
INNER JOIN dbo.DeliveryStops s ON s.StopId = ro.StopId
WHERE ro.Status='DELIVERED' AND ro.SapDeliveryDocEntry IS NULL
  AND s.CompletedAt < DATEADD(HOUR, -1, SYSUTCDATETIME());
-- Alert: > 0 → SAP write failing silently
```

---

## 3. Queue monitoring

There is no Bull/Redis. The only queue is the `SapRetryQueue` table (post-cutover) and the `liveSimulation.js` in-process timer (today).

### 3.1 SapRetryQueue (post-cutover)
- Query #1 above tracks depth.
- Add a 5-minute polled query; alert on depth > 50 PENDING for 30+ minutes.

### 3.2 In-process queues (today, no observable queue)
- demoServer.js does no queueing. Ignore.

---

## 4. Socket.IO monitoring

### 4.1 Connection count
- **Today:** `pm2-out.log` lines like `[demo] Socket connected: <id>` (`demoServer.js:3405`).
- **Post-cutover:** `Socket connected` / `disconnected` logs from `sockets/index.js:33,47`.
- **Smoke test:** open the planner in a browser, watch the log for the connect.
- **Alert:** sustained zero connections during business hours = clients can't reach Socket.IO.

### 4.2 Event throughput
- **Today:** `[sim]`-driven `driver:position` events every 5s.
- **Post-cutover:** real driver phones POST to `/api/tracking/position` and the backend `io.to('planner').emit('driver:position', ...)`.
- **No metrics endpoint exposes this currently.** Recommendation: add `apiLogger.info('socket emit', { event, room })` inside `routes/tracking.js:33` post-cutover. **Phase 0 freeze does not allow this** — defer to Phase 1.

---

## 5. SAP connectivity

### 5.1 SAP SQL pools
- **Today (demoServer):** `demo/sapBridge.js:9` opens an mssql pool to SAP company A and B.
- **Health endpoint** reflects this: `sapSqlA.ok=true`, `sapSqlB.ok=true` in `/health` JSON. Alert on either flipping to false.
- **Connection-error patterns to grep for** in `pm2-error.log`: `ConnectionError`, `Login failed for user`, `Connection is closed`. The 2026-05-05 server.js run produced these regularly under `[worker] tick failed Connection is closed` — known noisy pattern, acceptable below 1/minute.

### 5.2 SAP Service Layer (writes)
- **Today:** `demo/sapWriter.js` — env-gated by `SAP_WRITE_ENABLED` which is UNSET. No writes today.
- **Post-cutover:** real writes via `services/sap/serviceLayer.js`. Add log analysis on `[SL]` prefixed lines.
- **Alert:** any 4xx response from SL during a write = stuck delivery. Already covered by SapRetryQueue monitoring.

---

## 6. Report generation (PDF / XLSX)

Today, all reports are demoServer-generated via `pdfkit` + `exceljs`.

### 6.1 PDF generation health
- **Smoke test command:**
  ```
  curl -o /tmp/test-manifest.pdf http://localhost:4000/api/reports/runs/<runId>/manifest.pdf
  ```
- **Expected:** binary output 50-500 KB, opens in a PDF viewer.
- **Alert:** zero-byte response or HTML error → PDF generator broken.

### 6.2 XLSX generation health
- Same idea with `/api/reports/waves/<waveId>/picking.xlsx`.

### 6.3 Latency
- PDF generation can take 2-10s for large manifests. Anything >30s = something is wrong (likely DB query in the PDF data fetch).

### 6.4 Post-cutover risk
- The PDF/XLSX URLs in `frontend/src/services/api.js:86-87` are used as raw `<a href>` (no Authorization header). After cutover, server.js's `requireAuth` 401s these. Track via:
  - `Status code != 200` count in access logs on `/api/reports/*`.
  - User reports of "Print Manifest" returning blank tab.

---

## 7. Memory usage

### 7.1 sap-logistics process
- **Command:** `pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' } | Select monit`
- **Expected baseline:** 200-400 MB resident (demoServer + node).
- **PM2 cap:** `max_memory_restart: '1G'` per `ecosystem.config.cjs:62`.
- **Alert thresholds:**
  - >700 MB sustained for 30+ min → memory leak; investigate before PM2 hits the cap.
  - >1 GB → PM2 restart imminent. **In current daemon state, this triggers the orphan-and-EADDRINUSE bug per `pm2-stabilization.md`.** Page on-call immediately.

### 7.2 Host-level
- **Command:** `Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory, TotalVisibleMemorySize`
- **Alert:** free < 10% of total = host memory pressure; PM2 daemon and OneDrive sync may both stall.

---

## 8. Disk usage

### 8.1 Logs directory
- **Path:** `backend/logs/`
- **Total size today:** ~3 MB across pm2-out.log, error.log, combined.log, pm2-error.log, server.log.
- **Growth rate:** ~50 KB/hour from demoServer's `[sim]` lines + request logs.
- **Alert:** any single log file > 100 MB = log rotation broken or noisy worker. Compress + truncate per `backup-inventory.md` §2.6.

### 8.2 store.json
- **Path:** `backend/data/store.json`
- **Size today:** 1.6 MB.
- **Growth rate:** ~50 KB/day per `store-json-analysis.md`.
- **Alert:** size > 100 MB = something wrong (likely uncontrolled append). Check with operator.

### 8.3 Uploads
- **Path:** `backend/uploads/`
- **Growth rate:** depends on driver completions (signatures + photos).
- **Alert:** >5 GB = consider archiving older partitions.

### 8.4 SQL DB file
- **Operator/DBA action.** Track free space on the SQL Server data drive separately.

### 8.5 Free disk on host
- **Command:** `Get-PSDrive C | Select Used, Free`
- **Alert:** Free < 20 GB = page on-call (logs, OneDrive sync, backups all need space).

---

## 9. PM2 daemon monitoring

### 9.1 Daemon process
- **Command:** `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where { $_.CommandLine -like '*pm2*' } | Select ProcessId, CreationDate`
- **Expected:** exactly one PM2 daemon process.

### 9.2 Daemon log volume
- **File:** `C:\Users\izik\.pm2\pm2.log`
- **Healthy growth:** ~1 MB/day.
- **Today (unhealthy):** 23 MB and climbing (sap-bi-api crash loop + pidusage errors).
- **Alert:** any 4-hour window where the file grows > 5 MB = daemon in trouble.

### 9.3 Specific error patterns
Watch for these substrings in pm2.log:
- `pidusage` — WMI timeouts (count rate of occurrence; >5/minute = daemon congested).
- `Process with pid X could not be killed` — orphan; investigate immediately per `pm2-stabilization.md`.
- `EADDRINUSE` — port collision.
- `New PM2 Daemon started` — daemon was restarted (intentional or crashed). Verify no stale-dump regression.

### 9.4 dump.pm2 mtime
- **Command:** `Get-ItemProperty $env:USERPROFILE\.pm2\dump.pm2 | Select LastWriteTime`
- **Expected:** updated when `pm2 save` is run intentionally (manually or by cleanup).
- **Alert:** if dump.pm2 mtime is newer than the most recent intended `pm2 save` and no operator can explain the change → investigate (could indicate someone ran `pm2 save` without notifying).

---

## 10. Alert thresholds — consolidated

Page-on-call (immediate):
- `/health` HTTP != 200 for 2 consecutive 60s checks
- Process not listening on port 4000
- sap-logistics `pm2_env.status` != `online`
- sap-logistics memory > 1 GB (cap-trigger imminent)
- `Process with pid X could not be killed` for ANY app holding ports 4000/4001
- Free disk < 20 GB
- Free physical memory < 10% of total

Investigate (next business hour):
- `/health` `sapConnected=false` for 5+ minutes
- SapRetryQueue depth > 50 PENDING for 30+ min (post-cutover)
- pm2.log error rate > 5/min for 30+ min
- store.json size > 100 MB
- Any log file > 100 MB
- Worker tick failed >10 consecutive minutes (post-cutover)

Trend monitoring (daily review):
- Daily store.json growth (should be ~50 KB/day)
- Daily backend/logs/ growth
- pm2_env.restart_time delta (should be 0 between observations)
- SAP latency (sapSqlA/B in /health response time)

---

## 11. Log locations — single reference table

| Source | Path | Cadence | Rotation |
|---|---|---|---|
| sap-logistics stdout (PM2 captures) | `backend/logs/pm2-out.log` | Continuous | None — manual rotate weekly |
| sap-logistics stderr (PM2 captures) | `backend/logs/pm2-error.log` | On error | None |
| App-specific | `backend/logs/error.log`, `combined.log`, `server.log` | Continuous | Per-Winston config (defined in `utils/logger.js`); confirm operator |
| PM2 daemon | `C:\Users\izik\.pm2\pm2.log` | Continuous | PM2 internal — typically 50 MB before rotate |
| sap-bi-api error log | `C:\Users\izik\OneDrive - OIG\שולחן העבודה\sap-bi\logs\api-err.log` | Continuous (crash storm) | n/a — different project |
| Cloudflare quick-tunnel | `cf-tunnel-error.log`, `cf-tunnel-out.log` (in `backend/logs/`) | Continuous if tunnel running | None |
| `cf-tunnel.log` at repo root | DELETED 2026-05-09 (P0 F10) — should not return | n/a | n/a |
| Uploads (binaries, not logs) | `backend/uploads/<category>/YYYY/MM/DD/` | Per file | n/a |
| Audit log (DB) | `dbo.AuditLog` table | Per audited action | Migration 001 doesn't define retention; recommend 1 year |
| SAP retry queue (DB) | `dbo.SapRetryQueue` table | Per retry | None — clean up `FAILED_PERMANENT` rows monthly |

---

## 12. Recommended monitoring tooling (operator decision)

Phase 0 doesn't add new tooling. Recommendations for post-cutover, NOT to be implemented during freeze:

| Tool | Purpose | Cost |
|---|---|---|
| UptimeRobot or Pingdom | External `/health` probe every 60s | Free tier sufficient |
| Windows Task Scheduler + custom PowerShell | Daily disk + memory snapshot to a log | Free |
| Prometheus + Grafana (per `recommendations.md` Tier 3) | Application metrics (latency, error rate, queue depth) | Self-hosted; multi-week project |
| LogDNA / Datadog Logs | Centralized log aggregation | Paid; not needed Phase 0 |

Phase 0 recommendation: **set up just UptimeRobot + the PowerShell snapshots.** Anything more is post-cutover work.

End of observability checklist.
