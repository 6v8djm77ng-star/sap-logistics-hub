# Wave A Mitigation Report

**Status:** ✅ DEPLOYED SUCCESSFULLY
**Deploy date:** 2026-05-10 12:21:08 Israel
**Operator:** Claude (per explicit "Execute Wave A deployment now" authorization)
**Outcome:** Anonymous public-internet exposure of admin / customer / driver / SAP-write CRUD on demoServer is now CLOSED. All business flows verified intact.

(Replaces the prior aborted-attempt report with the same filename.)

---

## 1. TL;DR

Wave A patch was applied to `backend/src/demo/demoServer.js` only (~30 lines of middleware, ~50 lines of related changes). After ~3 seconds of `pm2 restart sap-logistics`, every Wave A endpoint stopped serving anonymous PII to the internet. ADMIN authentication continues to work; DRIVER tokens correctly receive 200 on broad reads and 403 on admin-gated mutations; customer SMS tracking is unchanged.

Total customer-visible downtime: **~3 seconds** (the restart window).

Public exposure on the new active tunnel URL `https://automatic-incoming-rankings-kept.trycloudflare.com`:
- `/api/users` — was 200 with admin enumeration → **now 401**
- `/api/customers/search?q=test` — was 200 with PII → **now 401**
- `/api/drivers` — was 200 with PII → **now 401**
- `/api/sap/write/delivery-note/1` — was 200 (env-gated dry-run) → **now 401** (gated before env check)
- `/m/admin/:shortId` — single-use enforcement live; mobile-link TTL reduced 30d → 1h

---

## 2. Files changed

**One file: `backend/src/demo/demoServer.js`** (79 insertions, 12 deletions).

| Section | Change |
|---|---|
| Lines 90-128 (after logger middleware) | Added `requireAuthBasic` and `adminOnly` middleware functions (~38 lines including comment header) |
| Line 220 (`mobile-link` JWT signer) | TTL `'30d'` → `'1h'` |
| Line 367 (before `/api/customers/policies` handler) | Inserted `app.use('/api/customers', requireAuthBasic);` |
| Line 455 (before `/api/sap/write/delivery-note/:id` handler) | Inserted `app.use('/api/sap/write', adminOnly);` |
| Lines 1146-1149 (before `/api/drivers` handlers) | Inserted `app.use('/api/drivers', requireAuthBasic);` |
| Lines 1152, 1158, 1165, 1173 | Added `adminOnly` middleware arg to `app.post`/`app.patch`/`app.delete` for `/api/drivers` mutations |
| Lines 1186, 1188, 1196, 1209, 1219 | Added `adminOnly` middleware arg to all 5 `/api/users` admin-CRUD handlers |
| Lines 1237, 1241 | Added `requireAuthBasic` to `/api/users/me/subscriptions` GET + PUT |
| Lines 3354-3367 (`/m/admin/:shortId`) | Inserted single-use guard: 410 Gone if `entry.usedAt` set; otherwise mark `entry.usedAt = Date.now()` |

**No other files modified.** No env, no schema, no other services, no other routes.

---

## 3. Middleware added (verbatim)

```js
// =====================================================================
// EMERGENCY MITIGATION (Wave A) — added 2026-05-10
// Closes anonymous public-internet exposure of admin / customer / driver /
// SAP-write CRUD on this demoServer. See docs/architecture-review/
// emergency-mitigation-plan.md and external-reachability-report.md.
// Inert under future server.js cutover (server.js has its own auth chain
// via middleware/auth.js).
// Rollback: git revert <wave-a-sha>; pm2 restart sap-logistics
// =====================================================================
function requireAuthBasic(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

---

## 4. Commit + tag verification

```
SHA:    ae18787f2d743551c93c16067f7eef742160dd9e
Branch: wave-a-mitigation
Tags:   wave-a-mitigation, wave-a-deployed
File:   1 file changed, 79 insertions(+), 12 deletions(-) — backend/src/demo/demoServer.js only

git log --oneline -3:
  ae18787 Emergency Wave A mitigation for public demoServer exposure
  0d36879 Phase 0 baseline: P0 fixes + architecture review docs (inert under demoServer)
  8086cb6 Phase B cleanup: fix test isolation for intelligence flags
```

SHA written to `C:\backups\pm2\wave-a-commit-sha.txt` for rollback reference.

**Not pushed to remote** (per task instruction: local only).

---

## 5. PM2 restart result

```
Restart command:    pm2 restart sap-logistics
Issued at:          2026-05-10 12:21:05 Israel
Returned at:        2026-05-10 12:21:08 Israel  (3 seconds)
Output:             [PM2] [sap-logistics](6) ✓
                    sap-logistics  pid 2148  status online  uptime 0s  ↺ 1
New pid:            2148  (was pid 12164 — pre-emptive cleanup not needed; PM2 had self-reconciled)
Status:             online  (NOT errored — bookkeeping mismatch from yesterday is RESOLVED)
restart_time:       1
```

Notable: the bookkeeping mismatch (status=errored since 2026-05-09T17:59) **self-resolved at 12:05:40** when PM2 spontaneously restarted sap-logistics from pid 20112 to pid 12164. By the time Wave A restart fired at 12:21:08, PM2 was already in clean state. No `Stop-Process -Force` needed; the `pm2 restart` cleanly stopped pid 12164 and forked pid 2148.

`backend/logs/pm2-error.log` shows only the standard env.js startup warnings (SAP not fully configured, TLS trustServerCertificate notes) — same warnings present on every previous start. **No new error patterns.**

---

## 6. Before/after public endpoint matrix

Tested via the **new active** tunnel URL `https://automatic-incoming-rankings-kept.trycloudflare.com` (the prior URL `contribute-maker-archives-metres.trycloudflare.com` was retired when cloudflare-tunnel restarted at 12:05:46 — quick-tunnels get fresh URLs on every cloudflared start).

### 6.1 Wave A endpoints (anonymous from public URL)

| Endpoint | Before deploy | After deploy | Status |
|---|---|---|---|
| `GET /api/users` | 200 with admin user list | **401 `{"error":"Authentication required"}`** | ✅ CLOSED |
| `GET /api/customers/search?q=test` | 200 with real SAP customer phones | **401** | ✅ CLOSED |
| `GET /api/drivers` | 200 with driver name+phone+plate | **401** | ✅ CLOSED |
| `POST /api/sap/write/delivery-note/1` | 200 (env-gated dry-run) | **401 (gated before env check)** | ✅ CLOSED |
| `GET /m/admin/test` (no shortId) | 404 | 404 (unchanged) | ✅ |
| `GET /m/admin/<valid>` (first scan) | 200 (HTML auto-login) | 200 (HTML auto-login) | ✅ unchanged |
| `GET /m/admin/<valid>` (second scan) | 200 (could replay) | **410 Gone** | ✅ single-use |
| `mobile-link` JWT TTL | 30 days | **1 hour** | ✅ reduced |

### 6.2 Wave A endpoints (with ADMIN token from public URL)

| Endpoint | Before | After | Status |
|---|---|---|---|
| `GET /api/users` | 200 | 200 | ✅ unchanged |
| `GET /api/customers/policies` | 200 | 200 | ✅ unchanged |
| `GET /api/drivers` | 200 | 200 | ✅ unchanged |

### 6.3 Wave A endpoints (with DRIVER token from public URL)

| Endpoint | Before | After | Status |
|---|---|---|---|
| `GET /api/users` | 200 (anon-equivalent — bug) | **403 `{"error":"Admin role required"}`** | ✅ proper |
| `GET /api/drivers` | 200 | 200 | ✅ requireAuthBasic accepts |
| `POST /api/drivers` (no body) | 400 | **403** | ✅ proper |

### 6.4 Non-Wave-A endpoints (must remain UNCHANGED — verifies no scope creep)

| Endpoint | Status | Notes |
|---|---|---|
| `GET /health` | 200 | unchanged |
| `GET /api/runs` | 200 (still anon — not in Wave A) | unchanged |
| `GET /api/picking/waves` | 200 (still anon — not in Wave A) | unchanged |
| `GET /api/analytics/anomalies` | 200 (still anon — not in Wave A) | unchanged |
| `GET /api/orders/open` | 200 (still anon — not in Wave A) | unchanged |
| `POST /api/auth/login` | 200 (with valid creds) | unchanged |
| `POST /api/auth/driver-login` | 200 | unchanged |
| `GET /api/public/track/<token>` | 200 | unchanged (customer-facing, intentional) |

No scope creep observed.

---

## 7. Business smoke-test results

| Flow | Pre-deploy | Post-deploy | Status |
|---|---|---|---|
| Admin login (`POST /api/auth/login`) on public URL | 200 with token | 200 with token | ✅ |
| Driver login (`POST /api/auth/driver-login`) on public URL | 200 with token | 200 with token | ✅ |
| ADMIN-authed customer/policies / drivers / users reads | 200 | 200 | ✅ |
| DRIVER-authed driver list read | 200 | 200 | ✅ |
| Customer SMS tracking endpoint (`/api/public/track/<token>`) | 200 | 200 | ✅ |
| `/health` | 200 | 200 | ✅ |
| `pm2-error.log` for new fatal patterns | n/a | only standard env warnings | ✅ |
| `pm2 list` reports sap-logistics online | n/a | yes (pid 2148, status=online, restart=1) | ✅ |

No regression observed in any business flow.

---

## 8. Rollback readiness

Status: **READY but NOT TRIGGERED.**

If a problem surfaces in the next 24-48 hours:
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"
git revert ae18787 --no-edit
# Pre-restart orphan check (per pm2-maintenance-runbook.md):
$port_pid = (Get-NetTCPConnection -LocalPort 4000 -State Listen -EA SilentlyContinue).OwningProcess
$pm2_pid  = (pm2 jlist | ConvertFrom-Json | Where { $_.name -eq 'sap-logistics' }).pid
if ($port_pid -and $port_pid -ne $pm2_pid) { Stop-Process -Id $port_pid -Force }
pm2 restart sap-logistics
# Verify: /api/users now 200 (back to anonymous = rollback succeeded)
```

Snapshots preserved for emergency restore:
- `C:\backups\pm2\dump.pm2.PRE-WAVE-A-20260510-121941` (PM2 state immediately before deploy)
- `C:\backups\pm2\dump.pm2.POST-WAVE-A-20260510-122342` (PM2 state after deploy)
- `C:\backups\pm2\wave-a-commit-sha.txt` (`ae18787f2d743551c93c16067f7eef742160dd9e`)
- `backend\data\archive\store.json.PRE-WAVE-A-20260510-121941` (1.6 MB)

State preserved during rollback:
- `backend/data/store.json` untouched by deploy (no edits during patch).
- Logistics SQL untouched.
- `JWT_SECRET` unchanged → existing user/driver tokens valid post-rollback.
- `cloudflare-tunnel` untouched (the URL change at 12:05:46 was independent of Wave A).

---

## 9. Remaining public exposures (outside Wave A — by design)

These are still anonymously reachable from the new public URL `https://automatic-incoming-rankings-kept.trycloudflare.com`. They are NOT Wave A's job to close:

**Operational state mutations (Wave B candidates):**
- `POST/PATCH/DELETE /api/runs/*` — anonymous
- `POST /api/runs/auto-plan`, `force-include`, `:id/optimize`, `:id/duplicate`, etc.
- `POST/PATCH/DELETE /api/stops/*`
- `POST /api/picking/:waveId/scan`, `/qc-approve`, `/qc-reject`, `/lines/:id/shortage`, etc.
- `POST/PATCH/DELETE /api/pickers/*`
- `POST /api/auth/picker-login` (issues tokens — separate from F36)
- `GET/POST/PATCH /api/cod/*`
- `PATCH /api/zones/cities/:city`, `DELETE /api/zones/:id`

**Operational reads (Wave C candidates):**
- `GET /api/orders/open`, `unified`, `stats`, `:c/:d/lines`
- `GET /api/runs`, `GET /api/runs/:id`
- `GET /api/picking/waves`, `GET /api/picking/:id`
- `GET /api/zones`, `/api/zones/cities`, `/api/zones/suggest`
- `GET /api/audit/:type/:id` (returns stub `[]`)
- `GET /api/tracking/drivers`, `/api/tracking/drivers/:id/trail`
- `GET /api/failures`, `/api/failures/reasons`
- `GET /api/delivery-notes`, `/api/invoices`, `/api/documents/stats`
- `GET /api/reports/*` (PDF + XLSX)
- `GET /api/analytics/anomalies`, `/customer-profitability`, `/driver-performance`, `/stock-prediction`
- `GET /api/notify/eta/:stopId`

**Pre-existing P1 unchanged (per `security-reaudit.md`):**
- F11/F12 TLS `trustServerCertificate=true` (config defaults)
- F13 `JWT_STRICT_VERIFY=false`
- F14 `/me/change-password` not rate-limited
- F15 public tracking exposes driver name + plate + GPS for 48h
- F16 no JWT revocation (driver tokens 30d in demoServer / 7d in server.js)
- F17 `/uploads/*` static (currently moot — demoServer doesn't mount /uploads, only server.js does)

---

## 10. Recommendation for Wave B/C timing

### 10.1 Observation period (5-7 days)
Watch the system for any user-reported issues caused by Wave A. Specifically:
- Backend integrations (cron jobs, external systems) that may have hit `/api/users`, `/api/customers`, `/api/drivers`, `/api/sap/write/*` without a Bearer token. If any team reports "our integration broke", investigate before Wave B.
- Mobile-link short-URL flow: confirm the 1-hour TTL is sufficient for the actual operator workflow. If admins complain "I scanned the link 10 minutes after creation and it failed" → bump TTL to 24h. If they complain "the second scan didn't work" → that's the single-use guard working as designed; document.

### 10.2 Wave B scope (recommended for ~7 days post-Wave-A)
**~25 lines.** Same pattern as Wave A. Targets operational mutations:
- `app.use('/api/runs', requireAuthBasic)` + per-mutation `adminOnly` (or PLANNER role check)
- `app.use('/api/stops', requireAuthBasic)` + per-mutation
- `app.use('/api/picking', requireAuthBasic)` + per-mutation `WAREHOUSE` role check (introduce a `warehouseOrAdmin` middleware)
- `app.use('/api/cod', requireAuthBasic)` + DRIVER ownership check on deposit
- `app.use('/api/pickers', requireAuthBasic)` + adminOnly on mutations
- `app.use('/api/auth/picker-login', loginLimiter)` (already there) — but reduce picker token TTL 30d → 12h

Same deploy mechanics: branch from `wave-a-deployed`, ~30 min operator-active, single restart.

### 10.3 Wave C scope (recommended for ~14 days post-Wave-A)
**~25 lines.** Targets operational reads + reports:
- `app.use('/api/orders', requireAuthBasic)`
- `app.use('/api/zones', requireAuthBasic)` + adminOnly on mutations
- `app.use('/api/audit', adminOnly)`
- `app.use('/api/tracking', requireAuthBasic)` (POST /position is driver-self; gate explicitly)
- `app.use('/api/failures', requireAuthBasic)`
- `app.use('/api/delivery-notes', requireAuthBasic)`
- `app.use('/api/invoices', requireAuthBasic)`
- `app.use('/api/documents', requireAuthBasic)`
- `app.use('/api/analytics', requireAuthBasic)`
- Reports PDF/XLSX — needs frontend change too (anchor → fetch+blob OR signed-URL pattern). **Plan extra time for the frontend fix.**
- `app.use('/api/notify', requireAuthBasic)`

### 10.4 Long-term (post Wave B/C)
- Cloudflare named-tunnel migration with Access policies (per `tunnel-dependency-analysis.md` §7) — durably solves the "URL in logs" exposure model.
- Server.js cutover (Phase 1 → Phase 6 of `cutover-plan.md`) — the actual destination architecture.

### 10.5 Wave B/C are NOT urgent
With Wave A deployed, the highest-impact exposures (account takeover via `/api/users`, PII exfil via `/api/customers`/`/api/drivers`, latent SAP-write vector) are closed. The remaining anonymous routes are operational disruption surface — bad, but not customer-data leak.

**Recommendation: do Wave B in 7 days, Wave C in 14 days.** Sequential, observable, easy to roll back if anything breaks. Don't bundle.

---

## 11. Lessons learned

### 11.1 Cloudflare quick-tunnel URL changed mid-deploy
Between the prerequisite remediation (11:30) and the Wave A deploy (12:21), `cloudflare-tunnel` PM2 app restarted (pm_uptime shows 15m at deploy time — restart at ~12:05). Quick-tunnels generate a fresh URL on every restart. This caused initial public-URL probes to return `Could not resolve host`. New URL is in `cf-tunnel-error.log`.

**For future deploys:** always re-extract the active tunnel URL from `cf-tunnel-error.log` at deploy time — don't trust an URL captured hours earlier. Or, better, migrate to a Cloudflare named-tunnel with a stable URL.

### 11.2 sap-logistics PM2 bookkeeping self-resolved
The status=errored mismatch from 2026-05-09T17:59 (the `pid 20112 could not be stopped` event) cleared itself when PM2 restarted sap-logistics fresh at 12:05:40 (pid 12164). The pre-restart orphan-kill mitigation was never needed — PM2's state machine did the right thing eventually.

**For future deploys:** the runbook's pre-restart orphan check is still correct as a precaution, but it may often be a no-op when the daemon has had time to settle.

### 11.3 Smoke test on PORT=4101 caught nothing new
The smoke test did its job — confirming all gates work — but didn't surface anything I hadn't already designed for. The local validation step is worth keeping; it was 30 seconds of cost for full confidence.

### 11.4 admin/admin123 default still works
Confirmed via the smoke test that `admin/admin123` (per `docs/PRODUCTION.md:45`) is the live admin credential. This was already documented as F27 in `security-analysis.md`. **Not a Wave A concern**, but worth raising again: an attacker who guesses these credentials (which are documented in the repo) can authenticate from the public URL and bypass Wave A's gates. Recommend rotating the admin password as a separate post-Wave-A operator action.

---

## 12. Final state

```
PM2:
  sap-logistics  pid 2148  status online  restart_time 1
                 uptime since 2026-05-10T09:21:08Z
                 exec: backend/src/demo/demoServer.js

Git:
  HEAD: ae18787 (wave-a-mitigation branch)
  Tags: pre-wave-a-baseline, wave-a-mitigation, wave-a-deployed
  NOT pushed to remote (per instruction)

Backups:
  C:\backups\pm2\dump.pm2.PRE-CLEANUP-20260510-112930  (174,144 B — pre-PM2-stabilization)
  C:\backups\pm2\dump.pm2.POST-CLEANUP-20260510-112930 (164,922 B — after pm2 stop 2 + pm2 save)
  C:\backups\pm2\dump.pm2.PRE-WAVE-A-20260510-121941   (164,922 B — immediately before deploy)
  C:\backups\pm2\dump.pm2.POST-WAVE-A-20260510-122342  (165,062 B — after deploy + pm2 save)
  backend\data\archive\store.json.MANUAL-PRE-WAVE-A-20260510-112930
  backend\data\archive\store.json.PRE-WAVE-A-20260510-121941
  C:\backups\pm2\wave-a-commit-sha.txt → ae18787f2d743551c93c16067f7eef742160dd9e

Public exposure (https://automatic-incoming-rankings-kept.trycloudflare.com):
  /api/users                            anon → 401  ✅ closed
  /api/customers/search                 anon → 401  ✅ closed
  /api/drivers                          anon → 401  ✅ closed
  /api/sap/write/delivery-note/1        anon → 401  ✅ closed
  /m/admin/<valid> first scan            anon → 200  (auto-login HTML)
  /m/admin/<valid> second scan           anon → 410  ✅ single-use enforced
  mobile-link JWT TTL                          → 1h  (was 30d)

Outstanding (NOT Wave A):
  /api/runs/*, /api/stops/*, /api/picking/*, /api/cod/*, /api/pickers/*,
  /api/orders/*, /api/zones/*, /api/audit/*, /api/tracking/*, /api/failures/*,
  /api/delivery-notes, /api/invoices, /api/documents/*, /api/reports/*,
  /api/analytics/*, /api/notify/*
  → all still anonymous (Wave B/C scope)

  TLS posture (F11/F12), JWT_STRICT_VERIFY (F13), public tracking surface (F15),
  JWT revocation (F16), /uploads (F17 — moot under demoServer), admin/admin123
  default (F27)
  → unchanged
```

---

## 13. Next operator action (recommended; not blocking)

Update `cowork/INCIDENTS.md` with the deploy entry. Suggested template:

```markdown
## 2026-05-10 — sap-logistics-hub: Wave A emergency mitigation deployed

**Operator:** Claude (per "Execute Wave A deployment now" authorization)
**Deploy time:** 2026-05-10 12:21:08 Israel
**Customer-visible downtime:** ~3 seconds (pm2 restart window)
**Outcome:** SUCCESS — anonymous public exposure of admin/customer/driver/SAP-write CRUD CLOSED

**Files changed:** backend/src/demo/demoServer.js only (+79/-12)
**Commit:** ae18787 (branch wave-a-mitigation, NOT pushed)
**Tags:** wave-a-mitigation, wave-a-deployed

**Verification:** all 4 Wave A endpoints return 401 anon from public URL;
ADMIN-authed access preserved (200); DRIVER-authed correctly 403 on adminOnly
routes and 200 on requireAuthBasic routes; customer SMS tracking unchanged.

**Public URL:** changed mid-deploy from contribute-maker-archives-metres to
automatic-incoming-rankings-kept (cloudflare-tunnel restart at 12:05:46
generated a fresh trycloudflare URL — independent of Wave A).

**Rollback path (unused):** git revert ae18787; pm2 restart sap-logistics
(with orphan-check pre-step from pm2-maintenance-runbook.md).

**Wave B/C decision:** scheduled for 7 + 14 days post-deploy.

**Refs:** docs/architecture-review/wave-a-mitigation-report.md
```

End of report.
