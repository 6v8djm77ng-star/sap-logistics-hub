# Backup Automation Plan — Phase 0

Operationalizes `backup-inventory.md` into scheduled, monitored, off-host automation. The inventory document said WHAT to back up and HOW to do it manually. This document says WHEN, FROM WHERE, HOW WE KNOW IT WORKED, and WHAT FIRES IF IT DOESN'T.

**Scope rule:** automation that does NOT modify the running system. Read-side scheduled tasks only. Per `freeze-policy.md`, no production restarts to "deploy" automation.

---

## 1. Schedule overview

| Artifact | Frequency | Time (Israel) | Window | Method |
|---|---|---|---|---|
| `dump.pm2` | Daily | 02:00 | 1 min | Windows Task Scheduler → PowerShell |
| `dump.pm2` (off-host) | Daily | 02:30 | 5 min | Robocopy / S3 / OneDrive separate folder |
| `store.json` | Daily | 02:05 | 30 sec | Windows Task Scheduler |
| `store.json` (off-host) | Daily | 02:30 | (combined with above) | same |
| Logistics SQL — full | Weekly Sunday | 03:00 | 5-15 min | SQL Server Agent OR scheduled `sqlcmd` |
| Logistics SQL — diff | Daily Mon-Sat | 03:00 | 1-3 min | same |
| Logistics SQL — log | Hourly | xx:00 | <30 sec | same |
| Logistics SQL (off-host) | Daily | 04:00 | 5-15 min | copy `.bak` files |
| App logs (compress) | Weekly Sunday | 04:00 | 1 min | Task Scheduler |
| App logs (off-host) | Weekly Sunday | 04:30 | 5 min | copy zip |
| Uploads (incremental) | Daily | 02:30 | 1-10 min | Robocopy /XO |
| Uploads (off-host) | Weekly Sunday | 05:00 | 30 min | full sync |
| `.env` (encrypted) | On change only | n/a | manual | 7zip + manual transfer |
| `ecosystem.config.cjs` | On change only | n/a | git | git push |
| Frontend `dist` | On rebuild | n/a | manual | copy before each rebuild |
| Restore drill | Weekly | Sunday 21:00 | 30 min | manual; log in INCIDENTS.md |

All times are Israel local. Windows Task Scheduler runs in local time by default.

---

## 2. Automated `store.json` snapshot

### 2.1 Script
Create `C:\scripts\backup-store-json.ps1`:

```powershell
# Daily store.json snapshot — runs under Task Scheduler
$ErrorActionPreference = 'Stop'
$logFile = 'C:\backups\automation\store-json-backup.log'

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Tee-Object -FilePath $logFile -Append | Out-Null
    Write-Host $line
}

try {
    $root = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend"
    $src  = "$root\data\store.json"
    $arch = "$root\data\archive"
    New-Item -ItemType Directory $arch -Force | Out-Null

    if (-not (Test-Path $src)) {
        throw "Source not found: $src"
    }

    $ts = Get-Date -Format 'yyyyMMdd-HHmm'
    $dst = "$arch\store.json.$ts"

    # Atomic-ish: copy to .tmp, parse-validate, rename
    Copy-Item $src "$dst.tmp" -Force
    & node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$dst.tmp"
    if ($LASTEXITCODE -ne 0) { throw "JSON parse failed for snapshot $dst.tmp" }
    Move-Item "$dst.tmp" $dst -Force

    $size = (Get-Item $dst).Length
    Write-Log "OK snapshot=$dst size=$size"

    # Retention: keep 30 most recent
    $stale = Get-ChildItem "$arch\store.json.*" |
        Where-Object { $_.Name -notmatch '\.tmp$' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 30
    foreach ($f in $stale) {
        Remove-Item $f.FullName -Force
        Write-Log "Pruned $($f.Name)"
    }

    # Heartbeat file for monitoring
    New-Item -ItemType File -Path "C:\backups\automation\heartbeat-store-json" -Force | Out-Null
    Set-Content -Path "C:\backups\automation\heartbeat-store-json" -Value (Get-Date -Format 'o') -Force
}
catch {
    Write-Log "ERROR $_"
    # Drop a marker so the monitor can detect failure
    Set-Content -Path "C:\backups\automation\error-store-json" -Value $_.Exception.Message -Force
    exit 1
}
```

### 2.2 Task Scheduler config
- **Name:** `Backup — store.json`
- **Trigger:** Daily 02:05
- **Action:** `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\scripts\backup-store-json.ps1`
- **Run as:** the user who owns the OneDrive account (must have read access to `backend\data\`).
- **Run whether user is logged on or not:** yes.
- **If the task is already running:** do not start a new instance.

### 2.3 Validation
Each run logs to `C:\backups\automation\store-json-backup.log`. Monitor:
- Heartbeat file `heartbeat-store-json` mtime should be <26 hours old.
- Error marker `error-store-json` should NOT exist (delete it manually after acknowledged).

---

## 3. Automated `dump.pm2` snapshot

### 3.1 Script
Create `C:\scripts\backup-pm2-dump.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$logFile = 'C:\backups\automation\pm2-dump-backup.log'

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $logFile -Append | Out-Null
}

try {
    $src = "$env:USERPROFILE\.pm2\dump.pm2"
    if (-not (Test-Path $src)) {
        throw "dump.pm2 not found"
    }

    $arch = "C:\backups\pm2"
    New-Item -ItemType Directory $arch -Force | Out-Null

    $ts = Get-Date -Format 'yyyyMMdd-HHmm'
    $dst = "$arch\dump.pm2.$ts"
    Copy-Item $src $dst -Force

    # Parse-validate (PM2 dump is JSON when extracted)
    $content = Get-Content $dst -Raw
    if (-not $content.StartsWith('[')) {
        throw "dump.pm2 doesn't look like JSON array (starts with: $($content.Substring(0,[Math]::Min(50,$content.Length))))"
    }

    $size = (Get-Item $dst).Length
    Write-Log "OK snapshot=$dst size=$size"

    # Retention: keep 30 most recent
    $stale = Get-ChildItem "$arch\dump.pm2.*" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 30
    foreach ($f in $stale) {
        Remove-Item $f.FullName -Force
        Write-Log "Pruned $($f.Name)"
    }

    Set-Content -Path "C:\backups\automation\heartbeat-pm2-dump" -Value (Get-Date -Format 'o') -Force
}
catch {
    Write-Log "ERROR $_"
    Set-Content -Path "C:\backups\automation\error-pm2-dump" -Value $_.Exception.Message -Force
    exit 1
}
```

### 3.2 Task Scheduler config
- **Name:** `Backup — PM2 dump`
- **Trigger:** Daily 02:00 (BEFORE store.json so PM2 state precedes app-state)
- **Critical:** does NOT call `pm2 save` first. Snapshots whatever's already on disk. If you want a fresh save before snapshot, that requires a `pm2 save` call which currently takes 60-120s due to daemon congestion — too risky to put in an unattended task. Manual `pm2 save` happens during maintenance windows only.

### 3.3 Validation
Same as §2.3.

---

## 4. Logistics SQL backups

### 4.1 SQL Server Agent jobs (preferred)

**Job: SAP_Logistics_Hub_FullBackup**
- Schedule: Sunday 03:00.
- Step (T-SQL):
  ```sql
  DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
  DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_FULL_' + @ts + N'.bak';
  BACKUP DATABASE SAP_Logistics_Hub TO DISK = @path
    WITH FORMAT, INIT, COMPRESSION, CHECKSUM, STATS = 10;
  ```
- On Failure: notify (configure SQL Server Database Mail; out of scope here).

**Job: SAP_Logistics_Hub_DiffBackup**
- Schedule: Mon-Sat 03:00.
- Step:
  ```sql
  DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
  DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_DIFF_' + @ts + N'.bak';
  BACKUP DATABASE SAP_Logistics_Hub TO DISK = @path
    WITH DIFFERENTIAL, INIT, COMPRESSION, CHECKSUM, STATS = 10;
  ```

**Job: SAP_Logistics_Hub_LogBackup**
- Schedule: every hour.
- Step:
  ```sql
  -- Only meaningful if recovery model = FULL. Confirm:
  -- SELECT recovery_model_desc FROM sys.databases WHERE name='SAP_Logistics_Hub';
  -- If SIMPLE, log backups don't apply; remove this job.
  DECLARE @ts NVARCHAR(20) = REPLACE(REPLACE(CONVERT(NVARCHAR, GETDATE(), 120), ':', ''), ' ', '_');
  DECLARE @path NVARCHAR(500) = N'C:\backups\sql\SAP_Logistics_Hub_LOG_' + @ts + N'.trn';
  BACKUP LOG SAP_Logistics_Hub TO DISK = @path
    WITH INIT, COMPRESSION, CHECKSUM, STATS = 10;
  ```

### 4.2 Validation
- Each job writes a row to `msdb.dbo.sysjobhistory`. Query:
  ```sql
  SELECT TOP 30 j.name, h.run_date, h.run_time, h.run_status, h.message
  FROM msdb.dbo.sysjobhistory h
  INNER JOIN msdb.dbo.sysjobs j ON j.job_id = h.job_id
  WHERE j.name LIKE 'SAP_Logistics_Hub_%'
  ORDER BY h.run_date DESC, h.run_time DESC;
  ```
- `run_status = 1` = success.
- Verify backup file exists and `>0 bytes` after each run.

### 4.3 Validation drill (monthly)
- Restore the latest FULL into a `_TEST` database. Confirm row counts match prod (within ±1%).
- Document in `INCIDENTS.md` as "monthly SQL restore drill — passed".

### 4.4 Off-host
- After each backup, copy `.bak` and `.trn` files to off-host storage (NAS / cloud).
- Recommended: Robocopy with /MIR mirroring at 04:00.
  ```powershell
  robocopy C:\backups\sql \\nas\share\sql-backups /MIR /R:2 /W:5 /LOG+:C:\backups\automation\sql-offhost.log
  ```

---

## 5. App-log compression

### 5.1 Script
`C:\scripts\backup-app-logs.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$logFile = 'C:\backups\automation\app-logs-backup.log'

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $logFile -Append | Out-Null
}

try {
    $logsDir = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\logs"
    $arch    = "C:\backups\app-logs"
    New-Item -ItemType Directory $arch -Force | Out-Null

    $ts = Get-Date -Format 'yyyyMMdd'
    $dst = "$arch\app-logs-$ts.zip"

    Compress-Archive -Path "$logsDir\*.log" -DestinationPath $dst -Force
    $size = (Get-Item $dst).Length
    Write-Log "OK archive=$dst size=$size"

    # Optional: truncate live logs (PM2 reopens write handle on append)
    # Uncomment ONLY if operator confirms truncation is safe in their setup
    # Get-ChildItem "$logsDir\*.log" | ForEach-Object { Clear-Content $_.FullName }

    # Retention: keep 12 weekly archives = 3 months
    $stale = Get-ChildItem "$arch\app-logs-*.zip" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 12
    foreach ($f in $stale) {
        Remove-Item $f.FullName -Force
        Write-Log "Pruned $($f.Name)"
    }

    Set-Content -Path "C:\backups\automation\heartbeat-app-logs" -Value (Get-Date -Format 'o') -Force
}
catch {
    Write-Log "ERROR $_"
    Set-Content -Path "C:\backups\automation\error-app-logs" -Value $_.Exception.Message -Force
    exit 1
}
```

### 5.2 Task Scheduler
- **Name:** `Backup — app logs`
- **Trigger:** Sunday 04:00
- **Action:** PowerShell + script

---

## 6. Uploads (signatures, photos)

### 6.1 Script
`C:\scripts\backup-uploads.ps1`:

```powershell
$ErrorActionPreference = 'Continue'  # robocopy returns non-zero for "files copied" — not an error
$logFile = 'C:\backups\automation\uploads-backup.log'

function Write-Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Tee-Object -FilePath $logFile -Append | Out-Null
}

$src = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\uploads"
$ts  = Get-Date -Format 'yyyyMMdd'
$dst = "C:\backups\uploads\$ts"
New-Item -ItemType Directory $dst -Force | Out-Null

# /S = include subdirs; /XO = skip older (only copy new/changed); /R:1 /W:1 = 1 retry, 1 sec wait
robocopy $src $dst /S /XO /R:1 /W:1 /LOG+:C:\backups\automation\uploads-robocopy.log
$rc = $LASTEXITCODE
# robocopy exit codes: 0 = no files copied, 1 = files copied, 2-7 = various but not error
if ($rc -gt 7) {
    Write-Log "ERROR robocopy exit=$rc"
    Set-Content -Path "C:\backups\automation\error-uploads" -Value "robocopy exit $rc" -Force
    exit 1
} else {
    Write-Log "OK robocopy exit=$rc destination=$dst"
    Set-Content -Path "C:\backups\automation\heartbeat-uploads" -Value (Get-Date -Format 'o') -Force
}
```

### 6.2 Task Scheduler
- **Name:** `Backup — uploads`
- **Trigger:** Daily 02:30
- **Action:** PowerShell + script

### 6.3 Retention
Robocopy mirrors per-day folders. Retention is implicit: each day = a separate folder. Manual prune monthly:
```powershell
Get-ChildItem 'C:\backups\uploads' -Directory |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } |
  Remove-Item -Recurse -Force
```

---

## 7. Off-host copy strategy

### 7.1 Where "off-host" means
The local backups under `C:\backups\` survive most failures EXCEPT:
- Drive failure / corruption.
- Ransomware (encrypts everything reachable).
- Building disaster (fire, flood, theft of the host).

Off-host = a copy that lives on a different physical machine OR a different account on a cloud service.

### 7.2 Options (operator choice)

| Option | Cost | Reliability | Setup time |
|---|---|---|---|
| OneDrive personal account, separate folder NOT under OIG account | $0 if existing OneDrive plan | Medium — same vendor; account compromise risks both | 30 min |
| Google Drive separate account | $0 (15 GB free) | Medium-high — different vendor | 30 min |
| AWS S3 standard (IA) | ~$0.01/GB-month | High | 1-2 hours |
| BackBlaze B2 | ~$0.005/GB-month | High | 1-2 hours |
| Local NAS (e.g., Synology) | hardware cost | High; on-site only | 4-8 hours |
| Encrypted USB drive rotated weekly | ~$50 | High; manual; brittle | 30 min |

### 7.3 Recommended setup
- **Primary off-host:** OneDrive personal (different account from OIG). Free, no new accounts to manage.
- **Secondary:** weekly USB drive snapshot kept off-site (someone's home).

### 7.4 Off-host script
`C:\scripts\backup-offhost.ps1`:

```powershell
# Run after the local backups complete (04:00 ish)
$ErrorActionPreference = 'Stop'
$offhost = 'D:\OneDrive-personal\sap-logistics-hub-backups'  # adjust per operator's setup

$sources = @(
    @{ src = 'C:\backups\pm2'; flags = '/MIR' },
    @{ src = 'C:\backups\sql'; flags = '/MIR' },
    @{ src = 'C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend\data\archive'; flags = '/MIR' },
    @{ src = 'C:\backups\app-logs'; flags = '/MIR' },
    @{ src = 'C:\backups\uploads'; flags = '/MIR' }
)

foreach ($s in $sources) {
    $name = Split-Path $s.src -Leaf
    $dst = Join-Path $offhost $name
    New-Item -ItemType Directory $dst -Force | Out-Null
    robocopy $s.src $dst $s.flags.Split() /R:2 /W:5 /LOG+:'C:\backups\automation\offhost-robocopy.log'
}

Set-Content -Path 'C:\backups\automation\heartbeat-offhost' -Value (Get-Date -Format 'o') -Force
```

Schedule: daily 04:30.

---

## 8. Failure alerting

### 8.1 What gets alerted
- Heartbeat file mtime > 26 hours old → backup didn't run.
- Error marker file present → backup ran but failed.
- Off-host heartbeat > 26 hours old → off-host copy didn't run.
- Logistics SQL backup file `>0 bytes` and dated within 24 hours.

### 8.2 Alert mechanism — Phase 0 minimal
The simplest viable approach for Phase 0:
- A single PowerShell script `C:\scripts\check-backups.ps1` runs hourly via Task Scheduler.
- It checks each heartbeat + error marker.
- If any check fails, it sends an email via `Send-MailMessage` (deprecated in PowerShell 7+ but works in Windows PowerShell 5.1) to the operator.

Sample (operator fills in SMTP creds — out of band):
```powershell
$alerts = @()

# Check each heartbeat
$hb = @(
    'C:\backups\automation\heartbeat-store-json',
    'C:\backups\automation\heartbeat-pm2-dump',
    'C:\backups\automation\heartbeat-app-logs',
    'C:\backups\automation\heartbeat-uploads',
    'C:\backups\automation\heartbeat-offhost'
)
foreach ($h in $hb) {
    if (-not (Test-Path $h)) { $alerts += "MISSING: $h"; continue }
    $age = (Get-Date) - (Get-Item $h).LastWriteTime
    if ($age.TotalHours -gt 26) {
        $alerts += "STALE: $h ($($age.TotalHours.ToString('F1')) hours)"
    }
}

# Check error markers
$errs = Get-ChildItem 'C:\backups\automation\error-*' -ErrorAction SilentlyContinue
foreach ($e in $errs) {
    $msg = Get-Content $e.FullName -ErrorAction SilentlyContinue
    $alerts += "ERROR FILE: $($e.Name) -> $msg"
}

# SQL last full backup check
try {
    $q = @'
SELECT TOP 1 backup_finish_date
FROM msdb.dbo.backupset
WHERE database_name = 'SAP_Logistics_Hub'
  AND type = 'D'
ORDER BY backup_finish_date DESC
'@
    # operator fills in credentials and connection string
    # $row = Invoke-Sqlcmd -Query $q -ServerInstance ...
    # if (((Get-Date) - $row.backup_finish_date).TotalDays -gt 8) {
    #   $alerts += "SQL full backup older than 8 days"
    # }
}
catch { $alerts += "SQL backup check failed: $_" }

if ($alerts.Count -gt 0) {
    $body = $alerts -join "`r`n"
    # Send email — fill in credentials
    # Send-MailMessage -To 'ops@example.com' -From 'backup-monitor@example.com' \
    #   -Subject 'Backup alert(s)' -Body $body -SmtpServer ... -UseSsl -Credential ...

    # Alternative: write to a known log location for a separate monitor to pick up
    Add-Content -Path 'C:\backups\automation\ALERT.log' -Value "$(Get-Date -Format 'o')`r`n$body`r`n---"
}
```

### 8.3 Escalation if no email is set up
- Fallback: write alerts to `C:\backups\automation\ALERT.log`. Operator manually checks daily.
- Stretch: integrate with the existing `oig-listener` (Facebook service agent) to push notifications via the team's existing channel. Requires coordination with that project owner.

---

## 9. Restore testing schedule

| Test | Cadence | Owner | Validation |
|---|---|---|---|
| Restore latest `dump.pm2` to a non-prod scratch | Monthly | Operator | Dump parses, contains expected app names |
| Restore latest `store.json` to `data/store.json.test`, validate parse | Monthly | Operator | `node -e "JSON.parse(...)"` succeeds; record counts match |
| Restore latest Logistics SQL FULL to `_TEST` DB | Monthly | DBA/Operator | Row counts match within ±1%; sample query returns expected shape |
| Restore latest `.env` from encrypted backup | Quarterly | Operator | Decrypt succeeds; key names match expected list |
| Restore latest uploads folder for 1 random run | Quarterly | Operator | At least 1 signature + 1 photo restored to a scratch path |
| End-to-end disaster drill: simulate full host loss | Annually (or before any major migration) | Operator + DBA | Document in INCIDENTS.md |

Untested backups are theoretical. Every restore drill is logged in `cowork/INCIDENTS.md` with the date and outcome.

---

## 10. Backup-validation matrix (post-each-run)

For each automation run, the validator confirms ALL of:

| Check | What to verify | How |
|---|---|---|
| File exists | The `.bak`/`.json`/`.zip` file is on disk | `Test-Path` |
| File size > 0 | Not zero-byte | `(Get-Item $f).Length -gt 0` |
| Plausible size | Within ±50% of recent history | Compare to last 7 days median |
| Parse OK | JSON files parse, ZIP files extract test, SQL backups can `RESTORE VERIFYONLY` | Per-format check |
| Heartbeat fresh | `heartbeat-*` mtime within last 26h | Hourly monitor script |
| Off-host received | Counterpart file exists at off-host | After offhost task runs |

Implementation effort: ~30 lines added to each backup script for the per-run sanity check.

---

## 11. What is OUT of scope for Phase 0

These would be nice but require new infrastructure:

- Streaming/continuous backup (e.g., Litestream-style for SQL log shipping). Operator decision post-cutover.
- Backup encryption at rest beyond `.env`. The bulk data (store.json, uploads, logs) is not encrypted in `C:\backups\` today. Acceptable Phase 0 if the host's disk is BitLockered.
- Automated restore-drill (i.e., scheduled validation that ALSO restores). Manual monthly drill is sufficient for now.
- Cross-region replication. Out of scope.
- Backup-as-code (Terraform / Ansible manifest). Defer until the team has those tools in use elsewhere.

---

## 12. Setup checklist

The operator runs through this once:

```text
[ ] Create C:\backups\ structure (pm2, sql, app-logs, uploads, automation, env)
[ ] Create C:\scripts\ folder, save the four scripts (store-json, pm2-dump, app-logs, uploads, check-backups, offhost)
[ ] Create six Task Scheduler entries with the schedule from §1
[ ] Create three SQL Server Agent jobs per §4.1
[ ] Verify recovery_model_desc on SAP_Logistics_Hub (FULL or SIMPLE)
    — if SIMPLE, drop the LOG backup job
[ ] Configure off-host destination (OneDrive personal / S3 / NAS) per §7.3
[ ] Run each task ONCE manually (Right-click → Run) and verify output in C:\backups\automation\*.log
[ ] Verify heartbeat files appear under C:\backups\automation\heartbeat-*
[ ] Configure SMTP for Send-MailMessage (or skip and use ALERT.log)
[ ] Enable check-backups hourly
[ ] Wait 24h, then run the §10 validation matrix on the first auto-generated set
[ ] Document the schedule in INCIDENTS.md ("Backup automation set up 2026-MM-DD")
[ ] Schedule the first restore drill for 30 days out
```

Estimated total setup time: 4-6 hours.

---

## 13. Document references

- `backup-inventory.md` — what's being backed up (the inventory itself)
- `freeze-policy.md` §3 — applies to any change to the running system; backup automation does NOT touch the running system
- `pm2-stabilization.md` — why we don't run `pm2 save` in unattended automation today
- `cowork/INCIDENTS.md` — where setup confirmation and restore-drill outcomes are logged

End of automation plan.
