# Backup Inventory — Phase 0

Comprehensive inventory of every artifact that needs to survive a worst-case cutover (or daemon-corruption event), with explicit backup + restore + validation procedures. Read together with `pm2-stabilization.md` and `cutover-plan.md`.

**Owner:** the on-call operator. Backups are useless without a rehearsed restore.

---

## 1. Backup inventory table

| # | Artifact | Path | Size (typical) | Update freq | Phase 0 backup cadence | Where to store backup |
|---|---|---|---|---|---|---|
| 1 | PM2 daemon dump | `C:\Users\izik\.pm2\dump.pm2` | ~170 KB | On `pm2 save` | Daily + before any PM2 command | `C:\backups\pm2\dump.pm2.YYYYMMDD-HHmm` |
| 2 | PM2 daemon log | `C:\Users\izik\.pm2\pm2.log` | 23 MB (rotates) | Continuous | Weekly archive | `C:\backups\pm2\pm2.log.YYYYMMDD` |
| 3 | PM2 module config | `C:\Users\izik\.pm2\module_conf.json` | 2 KB | Rare | Weekly | `C:\backups\pm2\` |
| 4 | PM2 per-app logs | `C:\Users\izik\.pm2\logs\*` | varies | Continuous | Skip — too noisy; rely on app-side `backend/logs/` |
| 5 | ecosystem config | `sap-logistics-hub\ecosystem.config.cjs` | 3 KB | Manual edits | Before any change | git + `C:\backups\ecosystem.config.cjs.YYYYMMDD` |
| 6 | demoServer state | `sap-logistics-hub\backend\data\store.json` | 1.6 MB (growing ~50 KB/day) | Every demoServer write | Daily, kept 30 days | `sap-logistics-hub\backend\data\archive\store.json.YYYYMMDD-HHmm` |
| 7 | Logistics SQL DB | MS SQL Server `SAP_Logistics_Hub` | varies | Continuous | Daily full + hourly diff (operator/DBA tooling) | offsite + `C:\backups\sql\` |
| 8 | env file | `sap-logistics-hub\backend\.env` | 2 KB | Manual edits | Before any change | encrypted off-host (NEVER in git) |
| 9 | env backup file (legacy) | `sap-logistics-hub\backend\.env.bak.20260505` | 2 KB | Static | Once → encrypt + remove from disk | encrypted off-host then DELETE local |
| 10 | App logs | `sap-logistics-hub\backend\logs\*.log` | 0-2 MB each | Continuous | Weekly archive (compressed) | `C:\backups\app-logs\YYYYMMDD\` |
| 11 | Server log | `sap-logistics-hub\backend\server.log` | 1.8 KB | Continuous | Weekly | as above |
| 12 | Report templates | `sap-logistics-hub\backend\fonts\*` | 2 MB | Static | Once on-site | git (already committed) |
| 13 | Uploaded files (signatures, photos) | `sap-logistics-hub\backend\uploads\` | varies | On driver completions | Daily incremental | `C:\backups\uploads\YYYYMMDD\` (rsync-style copy) |
| 14 | TLS certs | `sap-logistics-hub\backend\certs\cert.pfx` | varies | Rare | On any cert change | encrypted off-host |
| 15 | SQL migrations | `sap-logistics-hub\database\migrations\*.sql` | <1 MB | On migration commits | git only | git |
| 16 | Frontend built bundle | `sap-logistics-hub\frontend\dist\` | ~10 MB | On `npm run build` | Before each rebuild | `C:\backups\frontend-dist\YYYYMMDD-HHmm\` |
| 17 | Redis state | NONE — no Redis deployed | — | — | n/a | n/a |
| 18 | Rollback artifacts | `git tag pre-migration-baseline`, `git tag pre-demo-removal-…` | n/a | Tagged at phase boundaries | Push tags to remote | git |
| 19 | INCIDENTS.md / TASKS.md | `cowork\INCIDENTS.md`, `cowork\TASKS.md` | varies | On change | git | git |

> **No Redis state to back up.** Confirmed — `package.json` has no `redis`, `ioredis`, or `bullmq` dependency. The only "queue" is the `SapRetryQueue` SQL table, which is included in #7.

> **`sap-bi-api` and other PM2 apps' state** are out of scope for this inventory — see `pm2-stabilization.md`.

---

## 2. Backup commands

### 2.1 PM2 dump (every Phase 0 day, plus before any pm2 command)

```powershell
# Save current daemon state
pm2 save

# Snapshot file (idempotent, survives daemon kill)
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
Copy-Item "$env:USERPROFILE\.pm2\dump.pm2" "C:\backups\pm2\dump.pm2.$ts" -Force

# Verify
Test-Path "C:\backups\pm2\dump.pm2.$ts"
```

### 2.2 ecosystem config (before any change)

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\ecosystem.config.cjs"
Copy-Item $src "C:\backups\ecosystem.config.cjs.$ts" -Force
git -C "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub" status -- ecosystem.config.cjs
```

### 2.3 store.json (daily — automate via Task Scheduler)

```powershell
# Daily snapshot at 02:00 (operator sets up Windows Task Scheduler once)
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$src = "$root\data\store.json"
$dst = "$root\data\archive\store.json.$ts"
New-Item -ItemType Directory "$root\data\archive" -Force | Out-Null
# Atomic copy: write to .tmp first, then rename
Copy-Item $src "$dst.tmp"
Move-Item "$dst.tmp" $dst -Force
# Retention: keep last 30 days
Get-ChildItem "$root\data\archive\store.json.*" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 30 |
  Remove-Item -Force
```

### 2.4 Logistics SQL DB (daily full backup)

```sql
-- Run from sqlcmd or SSMS, scheduled via SQL Server Agent or a Windows task
DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_full_' + @ts + N'.bak';
BACKUP DATABASE SAP_Logistics_Hub
  TO DISK = @path
  WITH FORMAT, INIT, COMPRESSION, CHECKSUM, STATS = 10;
```

```sql
-- Hourly differential (smaller, faster recovery point)
DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_diff_' + @ts + N'.bak';
BACKUP DATABASE SAP_Logistics_Hub
  TO DISK = @path
  WITH DIFFERENTIAL, INIT, COMPRESSION, CHECKSUM, STATS = 10;
```

> Operator action: schedule via SQL Server Agent or Task Scheduler. NOT Claude-scoped.

### 2.5 .env (before any edit)

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\.env"
# Use 7-Zip or built-in encryption — DO NOT store .env plaintext anywhere
& "C:\Program Files\7-Zip\7z.exe" a -p"<paste-passphrase>" "C:\backups\env\env.$ts.7z" "$src"
```

> Never `Copy-Item` .env to a plaintext file. Use 7-Zip with password OR Windows EFS. The existing `.env.bak.20260505` should be moved to encrypted storage and the plaintext deleted (per F21 in `security-analysis.md`).

### 2.6 App logs (weekly compression + archive)

```powershell
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs"
$ts = Get-Date -Format 'yyyyMMdd'
Compress-Archive -Path "$root\*.log" -DestinationPath "C:\backups\app-logs\app-logs-$ts.zip" -Force
# After successful zip, truncate the live logs (PM2 reopens on next write)
Get-ChildItem "$root\*.log" | ForEach-Object { Clear-Content $_.FullName }
```

> Truncating logs while demoServer is running is safe — Node fs writes append; truncating doesn't break the write handle on Windows. But if the operator is uneasy, skip the truncate step; logs grow until the next maintenance window.

### 2.7 Uploads (signatures, photos — daily incremental)

```powershell
$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\uploads"
$ts  = Get-Date -Format 'yyyyMMdd'
$dst = "C:\backups\uploads\$ts"
New-Item -ItemType Directory $dst -Force | Out-Null
# robocopy with /MIR mirrors — /XO skips older. Use /S /XO /R:1 /W:1
robocopy $src $dst /S /XO /R:1 /W:1 /LOG:"C:\backups\uploads\$ts.robocopy.log"
```

### 2.8 Frontend dist (before any rebuild)

```powershell
$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\frontend\dist"
$ts  = Get-Date -Format 'yyyyMMdd-HHmm'
$dst = "C:\backups\frontend-dist\$ts"
Copy-Item -Path $src -Destination $dst -Recurse -Force
```

---

## 3. Restore commands

### 3.1 PM2 dump restore (worst case: daemon corrupted, dump.pm2 unreadable)

```powershell
# Stop the daemon
pm2 kill

# Optional: identify orphans on relevant ports per pm2-stabilization.md before restore

# Restore the most recent good dump
$latest = Get-ChildItem "C:\backups\pm2\dump.pm2.*" | Sort-Object LastWriteTime -Descending | Select -First 1
Copy-Item $latest.FullName "$env:USERPROFILE\.pm2\dump.pm2" -Force

# Resurrect from the restored dump
pm2 resurrect

# Verify
pm2 list
pm2 logs sap-logistics --lines 20
```

### 3.2 ecosystem config restore

```powershell
# Use git first (preferred — keeps history)
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"
git log -- ecosystem.config.cjs   # find the SHA you want
git checkout <sha> -- ecosystem.config.cjs

# Fallback: copy from backup
$latest = Get-ChildItem "C:\backups\ecosystem.config.cjs.*" | Sort-Object LastWriteTime -Descending | Select -First 1
Copy-Item $latest.FullName "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\ecosystem.config.cjs" -Force
```

### 3.3 store.json restore (worst case: file corrupted or truncated)

```powershell
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
$latest = Get-ChildItem "$root\data\archive\store.json.*" | Sort-Object LastWriteTime -Descending | Select -First 1

# Stop demoServer FIRST (otherwise it'll overwrite the restore on next mutation)
pm2 stop sap-logistics

# Move the bad file aside, restore the good one
Move-Item "$root\data\store.json" "$root\data\store.json.broken-$(Get-Date -Format yyyyMMddHHmm)" -Force
Copy-Item $latest.FullName "$root\data\store.json" -Force

# Restart
pm2 start sap-logistics

# Verify by hitting an endpoint that reads store.json
curl http://localhost:4000/health
curl -s http://localhost:4000/api/drivers | head -c 200
```

### 3.4 Logistics SQL restore

```sql
-- Full restore (point-in-time recovery uses log chain; this is the simple case)
USE master;
GO
ALTER DATABASE SAP_Logistics_Hub SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE SAP_Logistics_Hub
  FROM DISK = 'C:\backups\sql\SAP_Logistics_Hub_full_<TS>.bak'
  WITH REPLACE, RECOVERY, STATS = 10;
ALTER DATABASE SAP_Logistics_Hub SET MULTI_USER;
GO
```

> Operator-DBA action. Verify connection from the app: `cd backend; node -e "import('./src/db/logisticsDb.js').then(m=>m.getPool()).then(()=>console.log('ok'))"`.

### 3.5 .env restore

```powershell
# Decrypt the most recent backup
$latest = Get-ChildItem "C:\backups\env\env.*.7z" | Sort-Object LastWriteTime -Descending | Select -First 1
& "C:\Program Files\7-Zip\7z.exe" x -p"<paste-passphrase>" -o"C:\restore-tmp\" $latest.FullName

# Move into place (after pm2 stop sap-logistics)
pm2 stop sap-logistics
Copy-Item "C:\restore-tmp\.env" "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\.env" -Force
Remove-Item "C:\restore-tmp\" -Recurse -Force
pm2 start sap-logistics
```

### 3.6 Uploads restore

```powershell
# Reverse robocopy
$src = "C:\backups\uploads\<TS>"
$dst = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\uploads"
robocopy $src $dst /S /XO /R:1 /W:1
```

### 3.7 Frontend dist restore

```powershell
$src = "C:\backups\frontend-dist\<TS>"
$dst = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\frontend\dist"
# demoServer doesn't serve dist (no app.use('/uploads')-style for dist in demoServer.js)
# server.js does — but it's not running in Phase 0. So restore is a no-op for current production.
Remove-Item $dst -Recurse -Force
Copy-Item -Path $src -Destination $dst -Recurse
```

---

## 4. Validation procedures

After ANY restore, run the corresponding validation block.

### 4.1 PM2 daemon validation
```powershell
pm2 list                                    # expect 9 apps; sap-logistics online
pm2 jlist | Select-String "sap-logistics"   # confirm pm_exec_path
curl http://localhost:4000/health           # expect 200, mode=DEMO+SAP
```

### 4.2 store.json validation
```powershell
$root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
node -e "const j=JSON.parse(require('fs').readFileSync('$($root.Replace('\','/'))/data/store.json','utf8')); console.log({drivers:j.drivers.length, runs:j.runs.length, stops:j.stops.length, runOrders:j.runOrders.length, lastWrite: require('fs').statSync('$($root.Replace('\','/'))/data/store.json').mtime})"
# Compare counts to the latest archive's counts (should be ≥ archive on each)
```

### 4.3 Logistics SQL validation
```sql
SELECT name, recovery_model_desc, state_desc FROM sys.databases WHERE name='SAP_Logistics_Hub';
SELECT COUNT(*) AS DeliveryRuns FROM SAP_Logistics_Hub.dbo.DeliveryRuns;
SELECT COUNT(*) AS DeliveryStops FROM SAP_Logistics_Hub.dbo.DeliveryStops;
SELECT TOP 1 * FROM SAP_Logistics_Hub.dbo._Migrations ORDER BY AppliedAt DESC;
```

### 4.4 .env validation
```powershell
# Confirm key presence (no values printed)
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
Get-Content .env | Select-String "^(JWT_SECRET|LOGISTICS_SQL_HOST|LOGISTICS_SQL_USER|LOGISTICS_SQL_PASSWORD|LOGISTICS_SQL_DB|CORS_ORIGINS|SAP_SQL_HOST|ANTHROPIC_API_KEY|SMTP_HOST)=" |
  ForEach-Object { ($_ -split '=')[0] }
# Expect 9 lines, all key names; no values leaked
```

### 4.5 SAP write gate validation
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
# Both should return zero matches:
Get-Content .env | Select-String "^SAP_WRITE_ENABLED="
Get-Content .env | Select-String "^SAP_SERVICE_LAYER_URL="
```

### 4.6 Frontend dist validation
```powershell
$dst = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\frontend\dist"
Test-Path "$dst\index.html"
Get-ChildItem "$dst\assets\index-*.js" | Select Name, LastWriteTime
```

### 4.7 Uploads validation
```powershell
$dst = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\uploads"
Get-ChildItem $dst -Recurse -Directory | Group-Object | Format-Table
# Expect at least signatures/, photos/ subdirs (or whatever fileStorage.js created)
```

---

## 5. Backup retention and rotation

| Artifact | Hot retention | Warm | Cold |
|---|---|---|---|
| PM2 dump | 7 days local | 30 days off-host | n/a |
| store.json | 30 days local archive | 90 days off-host | n/a |
| Logistics SQL full | 14 days local | 90 days off-host | 1 year quarterly |
| Logistics SQL diff | 7 days local | n/a | n/a |
| .env (encrypted) | 5 most recent local | encrypted vault permanent | n/a |
| App logs (compressed) | 30 days local | 90 days off-host | n/a |
| Uploads | live + last 30 days | 90 days off-host | n/a |
| Frontend dist | last 5 builds local | last 1 build per major version | n/a |
| ecosystem.config.cjs | git permanent | n/a | n/a |
| migrations/*.sql | git permanent | n/a | n/a |

---

## 6. Rehearsed restore drill (mandatory before Phase 4 cutover)

Before the cutover window, the operator MUST perform a dry-run restore of:
1. PM2 dump (to a non-production scratch host or VM if available; otherwise document the steps and sign off in `INCIDENTS.md`).
2. store.json (restore an old snapshot to `data/store.json.test`, validate parse, then revert).
3. Logistics SQL (restore to `SAP_Logistics_Hub_TEST` from a recent backup, run validation §4.3).

Untested backups don't count. The 2026-05-06 stale-dump regression is precisely the failure mode of relying on backups without rehearsing the restore.

---

## 7. Out-of-scope for this inventory

- Backups of OTHER PM2 apps (`sap-bi-*`, `davo-price-monitor`, `oig-listener`, `cloudflare-tunnel`, `tunnel-url-watcher`). Each project owns its own backup posture.
- Cloudflare configuration (named-tunnel JSON, Vercel env). Operator action.
- Domain registrar / SSL cert auto-renewal. Operator action.
- Anthropic console state, API key history. Manage via the Anthropic console, not from this host.

End of inventory.
