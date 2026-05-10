# Post-Mitigation Verification Matrix — Wave A

**Use this document during Section I of `operator-execution-checklist.md`.** It is the gate that decides whether the Wave A deployment is accepted (advance to Section K) or rejected (jump to Section J rollback).

**Trigger context:** `external-reachability-report.md` confirmed PUBLIC_INTERNET_EXPOSED. This matrix verifies that Wave A actually closes the exposure without breaking business flows.

---

## 1. Three vectors to test from

```
Vector L (localhost):  http://localhost:4000
Vector W (LAN/Wi-Fi):  http://192.168.0.14:4000     (verify with ipconfig if changed)
Vector P (Public):     https://contribute-maker-archives-metres.trycloudflare.com
                       (or whatever URL is current in cf-tunnel-error.log)
```

A complete verification runs each row of the matrix from at least Vectors L and P. Vector W is recommended for confidence but not required.

---

## 2. Matrix conventions

- **PRE** = expected status BEFORE Wave A deploy (status quo, the "bug we're fixing").
- **POST anonymous** = expected status AFTER deploy with no `Authorization` header.
- **POST authed (ADMIN)** = with `Authorization: Bearer <ADMIN_TOKEN>`.
- **POST authed (DRIVER)** = with `Authorization: Bearer <DRIVER_TOKEN>` (DRIVER role; not ADMIN).
- **PASS criteria** = the ALL-CAPS expected result. If actual matches, ☑.
- **FAIL → action** = if actual doesn't match, what to do. Anything in this column triggers Section J rollback unless explicitly marked "tolerable."

---

## 3. Wave A core matrix — MUST PASS

### 3.1 W-A1 — `/api/users/*` (anonymous user CRUD closure)

| # | Method | URL | PRE | POST anon | POST ADMIN | POST DRIVER | PASS criteria |
|---|---|---|---|---|---|---|---|
| 3.1.1 | GET | `/api/users` | 200 (users list) | **401** | **200** | **403** | anon=401 AND admin=200 AND driver=403 |
| 3.1.2 | POST | `/api/users` *(no body sent — just headers)* | 400 (validation) | **401** | 400 (still validates) | **403** | anon=401 AND driver=403 |
| 3.1.3 | PATCH | `/api/users/9999` | 404 (not found) | **401** | 404 (still routes correctly) | **403** | anon=401 AND driver=403 |
| 3.1.4 | POST | `/api/users/9999/reset-password` *(no body)* | 400 | **401** | 400 | **403** | anon=401 AND driver=403 |
| 3.1.5 | DELETE | `/api/users/9999` | 404 | **401** | 404 | **403** | anon=401 AND driver=403 |
| 3.1.6 | GET | `/api/users/me/subscriptions` | 200 (stub) | **401** | **200** | **200** | anon=401 (newly enforced) |
| 3.1.7 | PUT | `/api/users/me/subscriptions` | 200 (stub) | **401** | **200** | **200** | anon=401 |
| 3.1.8 | POST | `/api/users/me/change-password` *(no body)* | 401 (no token) | **401** (unchanged) | 400 (validation) | 400 (validation) | unchanged behavior |

**FAIL → action:** any 200 from anonymous probe on rows 3.1.1-3.1.5 = patch did not load OR middleware not in path. Section J rollback. Rows 3.1.6-3.1.7 anon=401 enforces a previously-missing guard; if they return 200 anonymously after deploy → middleware not effective, Section J.

> **CRITICAL — do NOT actually create a real user.** Send the POST/PATCH/DELETE probes WITHOUT a body or with intentionally-invalid data so they return 400 if auth passes. The only expected status from a successful auth+invalid-body is 400 — that confirms the auth gate works.

### 3.2 W-A2 — `/api/customers/*` (PII exfil closure)

| # | Method | URL | PRE | POST anon | POST ADMIN | POST DRIVER | PASS |
|---|---|---|---|---|---|---|---|
| 3.2.1 | GET | `/api/customers/search?q=test` | 200 with PII | **401** | **200** | **200** | anon=401 only |
| 3.2.2 | GET | `/api/customers/A/220` | 200 | **401** | **200** | **200** | anon=401 |
| 3.2.3 | GET | `/api/customers/A/220/recent-items` | 200 | **401** | **200** | **200** | anon=401 |
| 3.2.4 | GET | `/api/customers/policies` | 200 | **401** | **200** | **200** | anon=401 |
| 3.2.5 | PATCH | `/api/customers/policies/test` *(no body)* | 400 | **401** | 400 | 400 | anon=401 |
| 3.2.6 | GET | `/api/customers/hours/test` | 200 (or empty) | **401** | **200** | **200** | anon=401 |

> Driver tokens passing requireAuthBasic on customer routes is acceptable for Wave A (per `emergency-mitigation-plan.md` §2.3). Tightening to ADMIN/PLANNER only is server.js cutover work.

### 3.3 W-A3 — `/api/drivers/*` (driver PII closure)

| # | Method | URL | PRE | POST anon | POST ADMIN | POST DRIVER | PASS |
|---|---|---|---|---|---|---|---|
| 3.3.1 | GET | `/api/drivers` | 200 (driver PII) | **401** | **200** | **200** | anon=401 |
| 3.3.2 | POST | `/api/drivers` *(no body)* | 400 | **401** | 400 | **403** | anon=401 AND driver=403 |
| 3.3.3 | PATCH | `/api/drivers/1` *(no body)* | 200/404 | **401** | varies | **403** | anon=401 AND driver=403 |
| 3.3.4 | PATCH | `/api/drivers/1/zones` *(no body)* | 400 | **401** | 400 | **403** | anon=401 AND driver=403 |
| 3.3.5 | DELETE | `/api/drivers/9999` | 404 | **401** | 404 | **403** | anon=401 AND driver=403 |

### 3.4 W-A4 — `/api/sap/write/*` (latent SAP write closure)

| # | Method | URL | PRE | POST anon | POST ADMIN | POST DRIVER | PASS |
|---|---|---|---|---|---|---|---|
| 3.4.1 | POST | `/api/sap/write/delivery-note/1` *(no body)* | 200 (dry-run) or 503 | **401** | 200 (dry-run) | **403** | anon=401 AND driver=403 |
| 3.4.2 | POST | `/api/sap/write/invoice/1` *(no body)* | 200 (dry-run) or 503 | **401** | 200 (dry-run) | **403** | anon=401 AND driver=403 |
| 3.4.3 | GET | `/api/sap/writer/status` | 200 | 200 (NOT in Wave A — read-only stub) | 200 | 200 | unchanged |

> **Do NOT send `{"dryRun":false}` even with auth.** That would attempt a real SAP write if `SAP_WRITE_ENABLED` happened to flip. Test with no body or `{"dryRun":true}` only.

### 3.5 W-A5 — `/m/admin/:shortId` + mobile-link (credential vending closure)

| # | Method | URL / scenario | PRE | POST | PASS |
|---|---|---|---|---|---|
| 3.5.1 | GET | `/m/admin/INVALID12` (bogus shortId) | 404 (not in map) | **404** (unchanged) | unchanged |
| 3.5.2 | POST | `/api/auth/mobile-link` (no Bearer) | 401 (already gated) | 401 (unchanged) | unchanged |
| 3.5.3 | POST | `/api/auth/mobile-link` (ADMIN Bearer) — inspect response token TTL | response.token has `exp` 30 days from now | **response.token has `exp` ~1 hour from now** | exp ≈ 3600s |
| 3.5.4 | GET | `/m/admin/<freshly-minted-shortId>` first time | 200 (HTML auto-login) | **200** (HTML auto-login) | unchanged on first scan |
| 3.5.5 | GET | `/m/admin/<same-shortId-again>` second time | 200 (still works — bug) | **410** (single-use enforced) | second scan returns 410 |

> 3.5.3 verification: decode the JWT response. PowerShell:
> ```powershell
> $token = '<token-from-response>'
> $payload = $token.Split('.')[1]
> # JWT base64url → base64 padding
> $b64 = $payload.Replace('-','+').Replace('_','/')
> while ($b64.Length % 4 -ne 0) { $b64 += '=' }
> $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
> $json | ConvertFrom-Json | Select sub, role, exp, iat
> # exp - iat should be 3600 (1h)
> ```

---

## 4. Routes NOT in Wave A — must remain UNCHANGED

These rows verify that Wave A's middleware didn't accidentally regress flows outside its scope. If any of these flip from 200 → 401 → 200 unexpectedly, that's a side-effect bug.

| # | Method | URL | PRE | POST anon | POST authed | PASS |
|---|---|---|---|---|---|---|
| 4.1 | GET | `/health` | 200 | **200** | 200 | unchanged |
| 4.2 | GET | `/api/runs` | 200 (anonymous; bug) | **200** | 200 | unchanged (Wave B will fix) |
| 4.3 | POST | `/api/runs/auto-plan` *(no body)* | 400 | **400** (still anon — bug) | 400 | unchanged |
| 4.4 | GET | `/api/picking/waves` | 200 (anon; bug) | **200** | 200 | unchanged |
| 4.5 | GET | `/api/cod` | 200 (anon; bug) | **200** | 200 | unchanged |
| 4.6 | GET | `/api/analytics/anomalies` | 200 (anon) | **200** | 200 | unchanged |
| 4.7 | GET | `/api/orders/open` | 200 (anon) | **200** | 200 | unchanged |
| 4.8 | GET | `/api/audit/User/1` | 200 (stub) | **200** | 200 | unchanged |
| 4.9 | GET | `/api/tracking/drivers` | 200 (anon) | **200** | 200 | unchanged |
| 4.10 | GET | `/api/zones` | 200 (anon) | **200** | 200 | unchanged |
| 4.11 | GET | `/api/failures` | 200 (anon) | **200** | 200 | unchanged |
| 4.12 | GET | `/api/delivery-notes` | 200 (anon) | **200** | 200 | unchanged |
| 4.13 | GET | `/api/invoices` | 200 (anon) | **200** | 200 | unchanged |
| 4.14 | GET | `/api/documents/stats` | 200 (anon) | **200** | 200 | unchanged |
| 4.15 | POST | `/api/auth/login` *(invalid creds)* | 401 | **401** | n/a | unchanged + still rate-limited |
| 4.16 | POST | `/api/auth/driver-login` *(invalid creds)* | 401 | **401** | n/a | unchanged |
| 4.17 | POST | `/api/auth/picker-login` *(invalid creds)* | 401 | **401** | n/a | unchanged |
| 4.18 | GET | `/api/public/track/<random>` | 404 (token not in DB) | **404** | n/a | unchanged |
| 4.19 | GET | `/api/driver/my-runs` (DRIVER token) | 200 | n/a | **200** | unchanged |
| 4.20 | GET | `/api/davo-mix/summary` | 404 (server.js-only; demoServer doesn't have it) | **404** | 404 | unchanged |

> If any 4.x row flips to a non-expected status post-deploy, the patch has unintended scope. Investigate before declaring success.

---

## 5. Frontend smoke tests (manual, browser-based)

Required before final signoff. Use a real browser tab logged in as ADMIN, plus a driver phone (or device emulator).

| # | Page / flow | PRE | POST | PASS |
|---|---|---|---|---|
| 5.1 | Login at `/login` with admin credentials | succeeds | **succeeds** | unchanged |
| 5.2 | Navigate to `pages/UsersPage.jsx` (`/users`) | shows users list | **shows users list** | unchanged |
| 5.3 | Click "Create user" in UsersPage | dialog opens | **dialog opens** | unchanged |
| 5.4 | Submit valid new user form | 201 created | **201 created** | unchanged |
| 5.5 | Open `MobileLinkDialog` ("send link to phone") | generates QR + URL | **generates QR + URL** | URL includes the public tunnel + shortId |
| 5.6 | Scan/click the link from a phone (1st scan) | logs in | **logs in** | unchanged |
| 5.7 | Reload the same `/m/admin/...` URL | logs in again (BUG) | **shows 410 / "already used"** | single-use enforced |
| 5.8 | Wait 65 minutes, click the link | logs in (BUG) | **token expired; cannot log in** | 1h TTL enforced |
| 5.9 | Driver login at `/driver/login` with code | succeeds | **succeeds** | unchanged |
| 5.10 | Driver app `pages/driver/DriverRunsPage.jsx` | loads my-runs | **loads my-runs** | unchanged |
| 5.11 | Driver app `DriverManifestPage` | loads manifest | **loads manifest** | unchanged |
| 5.12 | Customer SMS tracking link from a recent run | opens TrackingPage with data | **opens TrackingPage with data** | unchanged |
| 5.13 | RunsPage as PLANNER | shows runs | **shows runs** | unchanged |
| 5.14 | DriversPage as ADMIN | shows drivers | **shows drivers** | unchanged |
| 5.15 | DriversPage as PLANNER (no admin) | shows drivers | **shows drivers** | unchanged (driver list = requireAuthBasic) |
| 5.16 | DocumentsPage "send to SAP" button | dry-run response | **dry-run response (auth-gated)** | unchanged for ADMIN |
| 5.17 | Wallboard | live updates | **live updates** | unchanged |

> 5.8 is a slow check; it's optional same-day verification (the operator can verify next day). Document the result whenever it lands.

---

## 6. Worker / log sanity (15-minute observation window)

After Section I checks pass, watch logs for 15 minutes:

```text
☐ 6.1 backend/logs/error.log — no NEW error patterns:
       Get-Content backend/logs/error.log -Tail 50 -Wait
       — pre-existing '[worker] tick failed Connection is closed' is OK (acceptable historical noise)
       — anything new ('TypeError', 'Cannot read property', 'jwt malformed', 'ReferenceError') = problem

☐ 6.2 backend/logs/pm2-out.log — [sim] entries continue:
       Get-Content backend/logs/pm2-out.log -Tail 30
       — expect '[sim] New return:' lines roughly every 1-3 minutes (per liveSimulation.js)

☐ 6.3 backend/logs/pm2-error.log — empty or pre-existing only:
       Get-Content backend/logs/pm2-error.log -Tail 30
       — should be quiet

☐ 6.4 No 401 storm from cf-tunnel:
       Search pm2-out.log for repeated '401' on previously-200 endpoints by frequency.
       — sustained 401s from the same IP/UA every few seconds = a stuck client; investigate but
         not necessarily a rollback trigger (the client may need to refresh).
```

---

## 7. Rollback trigger criteria

**Trigger immediate Section J rollback if ANY of:**
- Any row in §3.1-3.4 fails (anon=200 on a Wave A route): patch didn't load.
- Any row in §4.1-4.20 changed unexpectedly: scope creep.
- Frontend test 5.2 fails (UsersPage broken for ADMIN).
- Frontend test 5.10 fails (driver app broken).
- Frontend test 5.12 fails (customer tracking broken).
- New error patterns in error.log.
- /health stops returning 200.

**Do NOT trigger rollback for:**
- Slow responses (cf-tunnel can have variable latency; check Vector L if Vector P is slow).
- Single 401 from a stuck client that hasn't refreshed.
- Non-Wave-A routes still being anonymous (they're Wave B/C work).
- F2/F3/F5/F6/F8/F9 from `security-reaudit.md` — those are post-cutover work; demoServer doesn't have them under Wave A scope.

---

## 8. Probe scripts (paste into operator's shell)

### 8.1 Anonymous public probes

```powershell
$PUB = 'https://contribute-maker-archives-metres.trycloudflare.com'  # current per cf-tunnel-error.log

$probes = @(
    @{ m='GET';    u="$PUB/health";                              expect=200 },
    @{ m='GET';    u="$PUB/api/customers/search?q=test";         expect=401 },
    @{ m='GET';    u="$PUB/api/customers/policies";              expect=401 },
    @{ m='GET';    u="$PUB/api/drivers";                         expect=401 },
    @{ m='GET';    u="$PUB/api/users";                           expect=401 },
    @{ m='POST';   u="$PUB/api/users";                           expect=401 },
    @{ m='POST';   u="$PUB/api/sap/write/delivery-note/1";       expect=401 },
    @{ m='GET';    u="$PUB/m/admin/INVALID12";                   expect=404 },
    # Non-Wave-A — must remain unchanged:
    @{ m='GET';    u="$PUB/api/runs";                            expect=200 },
    @{ m='GET';    u="$PUB/api/picking/waves";                   expect=200 },
    @{ m='GET';    u="$PUB/api/analytics/anomalies";             expect=200 }
)

$results = @()
foreach ($p in $probes) {
    try {
        $r = Invoke-WebRequest -Uri $p.u -Method $p.m -Headers @{ 'User-Agent'='wave-a-verification' } -TimeoutSec 8 -UseBasicParsing -SkipHttpErrorCheck
        $code = $r.StatusCode
    } catch {
        $code = 'ERR'
    }
    $pass = if ($code -eq $p.expect) { 'PASS' } else { 'FAIL' }
    $results += [PSCustomObject]@{ Method=$p.m; URL=$p.u; Expected=$p.expect; Got=$code; Result=$pass }
}
$results | Format-Table -AutoSize
$results | Where { $_.Result -eq 'FAIL' } | ForEach-Object { Write-Host "FAIL: $($_.URL)" -ForegroundColor Red }
```

### 8.2 Authed probes (with ADMIN token)

```powershell
$PUB = 'https://contribute-maker-archives-metres.trycloudflare.com'
$ADMIN = '<paste-admin-token-here>'   # do NOT commit
$h = @{ Authorization = "Bearer $ADMIN"; 'User-Agent' = 'wave-a-verification' }

$probes = @(
    @{ u="$PUB/api/customers/search?q=test"; expect=200 },
    @{ u="$PUB/api/drivers";                 expect=200 },
    @{ u="$PUB/api/users";                   expect=200 }
)
foreach ($p in $probes) {
    try {
        $r = Invoke-WebRequest -Uri $p.u -Method GET -Headers $h -TimeoutSec 8 -UseBasicParsing -SkipHttpErrorCheck
        Write-Host "$($p.u) → $($r.StatusCode) (expect $($p.expect))"
    } catch {
        Write-Host "$($p.u) → ERR" -ForegroundColor Red
    }
}
```

### 8.3 Authed probes (with DRIVER token)

```powershell
$DRIVER = '<paste-driver-token-here>'
$h = @{ Authorization = "Bearer $DRIVER"; 'User-Agent' = 'wave-a-verification' }
# Expect /api/users → 403 (adminOnly), /api/drivers GET → 200, /api/customers GET → 200
```

---

## 9. Pre/post comparison report

After Section I verification, generate a short report from §3 + §4 results. Save to `cowork/INCIDENTS.md` per Section L of the operator checklist.

Template:

```markdown
### Wave A verification report — <timestamp>

**Vectors tested:** localhost (✓), LAN 192.168.0.14 (✓ optional), public <URL> (✓)

**Wave A core matrix (§3):** N/N pass
**Out-of-scope unchanged matrix (§4):** N/N pass
**Frontend smoke tests (§5):** N/N pass
**Log observation (§6):** clean

**FAIL count:** 0 → ACCEPTED.
**Rollback triggered:** no.
```

If FAIL count > 0, replace the conclusion with:

```markdown
**FAIL count:** N
**Failed rows:** <list>
**Rollback triggered:** YES, reason: <which row tipped it>
**Time to rollback complete:** <minutes>
```

---

## 10. Document references

- `emergency-mitigation-plan.md` §2 — what each Wave A change does
- `operator-execution-checklist.md` Section I — calls into this matrix
- `external-reachability-report.md` §4 — pre-mitigation probe results (the baseline)
- `route-matrix.md` — full inventory; rows 4.x come from there
- `cowork/INCIDENTS.md` — where the verification report goes

End of verification matrix.
