# Wave A — 24-Hour Review Template

**Use this template at T+24 hours from Wave A deploy** (deploy time: 2026-05-10 12:21 → 24h review at 2026-05-11 12:21).

Fill in the template, archive the filled copy under `docs/architecture-review/wave-a-24h-review-YYYYMMDD.md`, and append a one-paragraph summary to `cowork/INCIDENTS.md`.

The same template applies for T+48h, T+7d if the operator wants additional checkpoint snapshots — copy and rename.

---

## Header

```
Review window:    T+0   = 2026-05-10 12:21 Israel
                  T+24h = 2026-05-11 12:21 Israel  (fill in actual time of review)
Operator:         <name>
Backup operator:  <name or "n/a">
Reviewer:         <if different from operator>
```

---

## 1. PM2 stability

```text
☐ pm2 list response time          : ____ s              (baseline <5s)
☐ sap-logistics status            : ____                (baseline: online)
☐ sap-logistics restart_time      : ____                (baseline: 1)
☐ sap-logistics pm_uptime         : ____                (baseline: 2026-05-10T09:21:08Z)
☐ sap-logistics memory            : ____ MB             (baseline: ~57 MB)
☐ sap-logistics pid               : ____                (baseline: 2148)
☐ Number of unexpected restarts   : ____                (baseline: 0)
☐ Other PM2 apps with new issues  : ____                (sap-bi-api should still be stopped;
                                                          tunnel-url-watcher errored = pre-existing)

Verdict (PM2):  STABLE / MINOR_DRIFT / DEGRADED
Notes:
  -
```

Quick commands:
```powershell
$j = pm2 jlist | ConvertFrom-Json
$sl = $j | Where { $_.name -eq 'sap-logistics' }
$sl | Select pid, @{n='status';e={$_.pm2_env.status}}, @{n='restart_time';e={$_.pm2_env.restart_time}}, @{n='mem_mb';e={[math]::Round($_.monit.memory/1MB,1)}}, @{n='uptime';e={[math]::Round((Get-Date - $_.pm2_env.pm_uptime).TotalHours,1)}}

# Unexpected restarts in pm2.log since deploy
Select-String 'sap-logistics.*starting' "$env:USERPROFILE\.pm2\pm2.log" |
  Where { $_.Line -match '2026-05-10|2026-05-11' } |
  Where { ($_.Line -split 'T')[0] + 'T' + (($_.Line -split 'T')[1] -split ':')[0..2] -join ':' -gt '2026-05-10T09:21:08' }
```

---

## 2. Authentication metrics

```text
☐ Anonymous /api/users          : ____ (expect 401)
☐ Anonymous /api/customers/search: ____ (expect 401)
☐ Anonymous /api/drivers         : ____ (expect 401)
☐ Anonymous /api/sap/write/*    : ____ (expect 401)
☐ ADMIN-authed /api/users        : ____ (expect 200)
☐ ADMIN-authed /api/drivers      : ____ (expect 200)
☐ DRIVER-authed /api/users       : ____ (expect 403)
☐ DRIVER-authed /api/drivers     : ____ (expect 200)
☐ Customer SMS tracking endpoint : ____ (expect 200/404 — unchanged)
☐ /api/auth/login (admin)        : ____ (expect 200)
☐ /api/auth/driver-login         : ____ (expect 200)

Total 401s in pm2-out.log since deploy: ____
  Top sources (User-Agent / IP):
    -
    -

Total 403s in pm2-out.log since deploy: ____
  Top paths:
    -
    -

Verdict (auth): EXPECTED / SOME_INTEGRATION_BROKEN / GATE_TOO_TIGHT / GATE_TOO_LOOSE
Notes:
  -
```

Quick commands:
```powershell
# Active tunnel URL
$pub = (Select-String 'trycloudflare\.com' "...\backend\logs\cf-tunnel-error.log" |
        Select -Last 1).Line -replace '.*?(https://[a-z0-9-]+\.trycloudflare\.com).*','$1'
Write-Host "Public URL: $pub"

# Anonymous probes
foreach ($p in '/api/users','/api/customers/search?q=test','/api/drivers') {
  $code = (curl -s -o NUL -w "%{http_code}" "$pub$p")
  Write-Host "$p -> $code (expect 401)"
}

# 401/403 totals from pm2-out.log
$today = Get-Date -Format 'yyyy-MM-dd'
$yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$auth_lines = Get-Content "...\backend\logs\pm2-out.log" |
  Where { ($_ -match $today -or $_ -match $yesterday) -and $_ -match '\b40[13]\b' }
Write-Host "401/403 count last 24h: $($auth_lines.Count)"
$auth_lines | ForEach { ($_ -split ' ')[3] } | Group-Object | Sort Count -Descending | Select -First 5
```

---

## 3. Customer complaints

```text
☐ Total customer-facing tickets/calls received in 24h: ____
☐ Tickets related to tracking links broken             : ____
☐ Tickets related to "page X doesn't load"             : ____
☐ Tickets related to login                              : ____
☐ Tickets confirmed root-caused to Wave A                : ____
☐ Tickets believed unrelated to Wave A                  : ____

Verdict (customer impact): NONE / MINOR_TRIAGED / WAVE_A_RELATED / RESOLVED
Notes:
  -
```

If any ticket is Wave-A-related: document the URL, the user-agent, the response code, and the planned fix.

---

## 4. Mobile-driver issues

```text
☐ Driver login attempts (24h)              : ____
☐ Driver login successes                    : ____
☐ Driver login failures                     : ____
☐ Driver-reported issues (manifest empty,
   can't mark stop, GPS not posting)         : ____
☐ Driver re-logins flagged unusual           : ____  (drivers log in once/shift typically)
☐ /api/driver/* error rate                   : ____ %

Verdict (driver flow): NORMAL / MINOR_NOISE / DRIVER_REGRESSION
Notes:
  -
```

Quick commands:
```powershell
# Driver login attempts in pm2-out.log
$today = Get-Date -Format 'yyyy-MM-dd'
$yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
Get-Content "...\backend\logs\pm2-out.log" |
  Where { ($_ -match $today -or $_ -match $yesterday) -and $_ -match '/api/auth/driver-login' } |
  Measure
```

---

## 5. Tunnel issues

```text
☐ Public tunnel URL at T+0      : https://automatic-incoming-rankings-kept.trycloudflare.com
☐ Public tunnel URL at T+24h    : ________________________________
☐ URL changed during window?    : YES / NO
☐ If YES: stakeholders notified : YES / NO  (when, who)
☐ cloudflared.exe processes      : ____ (baseline 2-3)
☐ cf-tunnel-error.log new errors  : ____ count

Verdict (tunnel): STABLE / URL_ROTATED / TUNNEL_FAILED
Notes:
  -
```

Quick commands:
```powershell
$pub_now = (Select-String 'trycloudflare\.com' "...\backend\logs\cf-tunnel-error.log" |
            Select -Last 1).Line -replace '.*?(https://[a-z0-9-]+\.trycloudflare\.com).*','$1'
Write-Host "Current URL: $pub_now"

$cf_errors = Get-Content "...\backend\logs\cf-tunnel-error.log" |
  Where { $_ -match '2026-05-10|2026-05-11' -and $_ -match 'ERR ' }
Write-Host "cf errors last 24h: $($cf_errors.Count)"
$cf_errors | Select -Last 5
```

---

## 6. Performance drift

```text
☐ /health latency localhost         : avg ____ ms     (baseline ~89 ms)
☐ /health latency public URL        : avg ____ ms     (baseline ~600 ms first probe; ~200 ms steady)
☐ Memory growth rate                : ____ MB/24h     (baseline near-zero)
☐ store.json growth rate             : ____ KB/24h    (baseline ~50 KB/day)
☐ Disk free                          : ____ GB        (baseline >>50 GB)
☐ Avg request rate (req/min)         : ____           (compare against pre-Wave-A if possible)

Verdict (performance): NO_DRIFT / MILD_DRIFT_NORMAL / MEMORY_LEAK_SUSPECTED / DEGRADED
Notes:
  -
```

Quick commands:
```powershell
# /health latency sample (5 probes)
$times = 1..5 | ForEach { (Measure-Command { Invoke-WebRequest http://localhost:4000/health -UseBasicParsing | Out-Null }).TotalMilliseconds }
Write-Host "localhost /health avg: $([math]::Round(($times | Measure -Average).Average,1)) ms"

$pub_times = 1..5 | ForEach { (Measure-Command { Invoke-WebRequest "$pub/health" -UseBasicParsing | Out-Null }).TotalMilliseconds }
Write-Host "public /health avg: $([math]::Round(($pub_times | Measure -Average).Average,1)) ms"

# Memory
$mem = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).monit.memory
Write-Host "memory now: $([math]::Round($mem/1MB,1)) MB"
```

---

## 7. New error patterns

```text
☐ pm2-error.log fresh entries since deploy : ____ count
☐ Match against known-noise patterns?       : ALL_KNOWN / SOME_NEW
☐ New patterns observed                     :
   1. ____________________________________
   2. ____________________________________

☐ error.log fresh fatal patterns since deploy: ____ count
   (Filter: TypeError|ReferenceError|jwt malformed|EBUSY|EADDRINUSE)
☐ Patterns observed                         :
   1. ____________________________________

Verdict (errors): NO_NEW / NOISE_ONLY / NEW_PATTERN_INVESTIGATE / FATAL
Notes:
  -
```

Quick commands:
```powershell
$today = Get-Date -Format 'yyyy-MM-dd'
$yesterday = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')

# pm2-error.log fresh
Get-Content "...\backend\logs\pm2-error.log" |
  Where { $_ -match $today -or $_ -match $yesterday } |
  Where { $_ -notmatch 'tick failed Connection is closed|trustServerCertificate|SAP is not fully configured' } |
  Select -Last 20

# error.log fatal patterns
Get-Content "...\backend\logs\error.log" |
  Where { ($_ -match $today -or $_ -match $yesterday) -and
          $_ -match 'TypeError|ReferenceError|jwt malformed|EBUSY|EADDRINUSE' }
```

---

## 8. Frontend smoke (manual, browser-based)

If the operator can spend 5 minutes in a browser:

```text
☐ Login at /login (admin creds)         : succeeds   YES / NO
☐ /users page loads + shows users       :            YES / NO
☐ /drivers page loads + shows drivers   :            YES / NO
☐ /customer-policy page loads + data   :            YES / NO
☐ /davo-mix page loads (SAP-backed)     :            YES / NO  (note: server.js-only; should 404 under demoServer — that's existing behavior, not Wave A)
☐ Driver app /driver login + my-runs    :            YES / NO
☐ Customer SMS tracking link from a     :            YES / NO  (reuse a recent run's tracking-link)
   recent run
☐ MobileLinkDialog generates a URL      :            YES / NO  (admin → "send link to phone")
☐ Generated URL works on first scan     :            YES / NO
☐ Same URL fails (410) on second scan   :            YES / NO  ← single-use guard validation

Verdict (frontend): ALL_GREEN / MINOR_BROKEN / MAJOR_BROKEN
Notes:
  -
```

---

## 9. Backup health

```text
☐ Daily store.json snapshot taken (yesterday): YES / NO
   File: backend/data/archive/store.json.YYYYMMDD-HHmm
☐ PM2 dump still in /c/backups/pm2/         : YES / NO
☐ Disk space sufficient for next 30 days     : YES / NO
☐ host-monitor.log has heartbeat entries     : YES / NO

Verdict (backups): ON_TRACK / NEEDS_ATTENTION / FAILED
Notes:
  -
```

---

## 10. Rollback consideration

Walk through the rollback decision tree:

```text
☐ Is /api/users still 401 anonymously from public URL?    YES / NO
   If NO → ROLLBACK CANDIDATE
☐ Is ADMIN-authed /api/users still 200?                    YES / NO
   If NO → ROLLBACK CANDIDATE (gate too tight)
☐ Is /health 200?                                           YES / NO
   If NO → ROLLBACK CANDIDATE
☐ Are multiple frontend pages broken?                      YES / NO
   If YES → ROLLBACK CANDIDATE
☐ Are there fatal patterns in error.log?                   YES / NO
   If YES → INVESTIGATE; possible rollback
☐ Customer-facing tracking confirmed broken?               YES / NO
   If YES → URGENT ROLLBACK CANDIDATE

Final rollback assessment: NOT_NEEDED / CONSIDER / EXECUTE_NOW

If EXECUTE_NOW, see wave-a-observation-window.md §5.2 for the procedure.
```

---

## 11. Recommendation (must pick exactly one)

```text
☐ CONTINUE OBSERVATION       — Wave A deployed cleanly; no significant anomalies; resume daily
                               verification per wave-a-observation-window.md until T+7d.
                               Re-evaluate at T+7d.

☐ CONTINUE OBSERVATION + FIX — minor issues found that are explainable and addressable;
                               apply targeted fix; observe another 7 days before Wave B.

☐ PROCEED TO WAVE B          — Wave A is fully stable; observation window can be shortened;
                               Wave B planning can begin in parallel. (Reserved for T+7d
                               review; rare at T+24h.)

☐ ROLLBACK                   — material regression found that can't be quickly fixed;
                               revert per wave-a-observation-window.md §5.2.

☐ HOTFIX REQUIRED            — specific bug in Wave A code that needs same-day patch;
                               apply patch + restart per deploy-discipline.md §4.
                               Keep the wave-a-mitigation tag; new commit on top.

Selected: ____________

Justification (1-3 sentences):
  -
```

---

## 12. Action items for next 24h

```text
1. ___________________________________________  (owner: ____, due: ____)
2. ___________________________________________  (owner: ____, due: ____)
3. ___________________________________________  (owner: ____, due: ____)
```

---

## 13. INCIDENTS.md summary line

Append to `cowork/INCIDENTS.md`:

```markdown
**T+24h Wave A review (YYYY-MM-DD HH:MM):** verdict = <CONTINUE_OBSERVATION / CONTINUE_OBSERVATION_FIX / PROCEED_TO_WAVE_B / ROLLBACK / HOTFIX_REQUIRED>. No PM2 restarts. <N> 401s in 24h, <N> Wave-A-related. <N> customer complaints. Frontend smoke <N>/<N> green. See docs/architecture-review/wave-a-24h-review-YYYYMMDD.md.
```

---

## 14. Reviewer signoff

```text
Reviewer name:        ___________________________
Reviewer signature:   ___________________________
Date:                 ___________________________
Time:                 ___________________________
Backup operator:      ___________________________  (if checkpoint required two-person review)
```

---

## 15. Notes for future reviews

If you copy this template for T+48h or T+7d, update:
- Section 1: increase the "expected restart_time" baseline (no reason to expect drift)
- Section 6: compare delta from T+24h memory rather than from T+0
- Section 11: at T+7d, the "PROCEED TO WAVE B" option becomes more relevant

End of 24-hour review template.
