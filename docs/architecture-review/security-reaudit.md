# Security Re-Audit — Phase 0

Read-only verification of the F1-F30 list from `security-analysis.md` against the **production reality** (demoServer.js running, server.js patched but inert), plus identification of new findings that the original audit missed.

**Investigation method:** grep + file reads + `.env` key-only inspection (no values printed). No code modifications.

---

## 1. Production reality check

The original `security-analysis.md` audit assumed `server.js` was the running entry. **It is not.** `pm2.log:226449` confirms `sap-logistics` runs `backend/src/demo/demoServer.js` since 2026-05-06T22:16:32. So the F1-F10 P0 fixes in `routes/*.js` and `server.js` are inert in production.

The realistic threat model is therefore: **anyone who can reach `http://localhost:4000` (or the public URL routed there) can do almost anything except actually write to SAP and except brute-forcing `/api/auth/login`.** This is significantly worse than the original audit framed.

---

## 2. F1-F17 status table (production reality, demoServer running)

| # | Original finding | Status NOW | Closes on cutover? | Evidence |
|---|---|---|---|---|
| F1 | Socket.IO `cors:'*'` | **OPEN** | yes (server.js loads sockets/index.js) | `demoServer.js:57` `new SocketServer(server, { cors: { origin: '*' } })` |
| F2 | DRIVER IDOR on stops/orders | **OPEN — and far worse:** demoServer's driver endpoints are anonymous, not just IDOR | yes (routes/driver.js fix is in place) | `demoServer.js:1968-2103` are unauth'd |
| F3 | DRIVER reads any GPS / trail | **OPEN — anonymous** | yes | `demoServer.js:1903` |
| F4 | DRIVER reads SAP customer DB | **OPEN — anonymous** | yes | `demoServer.js:3255` |
| F5 | DRIVER reads DAVO Mix | **N/A** — demoServer doesn't expose `/api/davo-mix` | yes (server.js mounts it with role gate after F5) | `server.js:129` mounts `routes/davoMix.js` |
| F6 | DRIVER reads all KPI dashboards | **OPEN — anonymous** | yes | `demoServer.js:571,667,794,1017,1797` |
| F7 | DRIVER reads driver contact info | **OPEN — anonymous** | yes | `demoServer.js:1100` |
| F8 | Audit trail open to any authed | **OPEN — anonymous (but stub returns `{trail:[]}`)** | yes | `demoServer.js:3240` |
| F9 | Reports PDF/XLSX | **OPEN — anonymous** | yes | `demoServer.js:2345,2376,2544,2616,2700,2892,3096,3155` |
| **F10** | cf-tunnel.log committed | **CLOSED** | n/a | File deleted; URL only appears now in `security-analysis.md:83,219` |
| F11 | `LOGISTICS_SQL_TRUST_SERVER_CERT=true` | **OPEN** (config default) | unchanged | `config/env.js:73` |
| F12 | `SAP_SQL_TRUST_SERVER_CERT=true` | **OPEN** (config default) | unchanged | `config/env.js:60` |
| F13 | `JWT_STRICT_VERIFY=false` | **OPEN** (lax mode) | unchanged | `middleware/auth.js:71-73` |
| F14 | `/me/change-password` not rate-limited | **OPEN** | unchanged | `demoServer.js:263` lacks `loginLimiter`; `routes/users.js:206-228` same |
| F15 | Public tracking exposes driver/plate/GPS | **OPEN** | unchanged | `services/trackingTokens.js:51-117` |
| F16 | No JWT revocation, 7-day driver TTL | **OPEN — and worse** | unchanged | demoServer issues **30-day** driver tokens at `demoServer.js:104,125,181` (vs `middleware/auth.js`'s 7-day) |
| F17 | `/uploads` static, no auth | **accidentally CLOSED** in PROD (demoServer doesn't mount it) — **REOPENS at cutover** | reopens | `server.js:97-100` will rebind on cutover |

Net: **only F10 is durably closed.** Everything else is open in production today.

---

## 3. New findings (additions to P0/P1 tracker)

The original F1-F30 list assumed server.js. The following were not in that list because they live exclusively in demoServer.js's inline routes.

### F31 — Anonymous HTML credential vending (P0)
- **Path:** `GET /m/admin/:shortId` (`demoServer.js:3289-3372`).
- **Behavior:** serves an HTML page that mints a 30-day JWT for a real user and writes it to `localStorage` via inline script. Inline script also clears Service Workers and caches before injecting.
- **Risk:** anyone who guesses or steals an 8-char base32 shortId from the in-memory `mobileShortLinks` map gets a 30-day prod-signed token.
  - Keyspace 32^8 ≈ 1e12 (large, but not infinite).
  - In-memory storage means TTL = process lifetime (which is 13 days and counting).
  - No rate limiting at the `/m/admin/` URL (only `/api/*` has the 200 req/min limiter).
  - 30-day TTL with no revocation (F16 still applies).
- **Closes at cutover:** route is not in `server.js`. Removed.

### F32 — Anonymous SAP delivery-note write (P0, currently fail-closed by env)
- **Path:** `POST /api/sap/write/delivery-note/:id` (`demoServer.js:412`).
- **Behavior:** anonymous; inside the handler `sapWriter.js:46` short-circuits if `!isWriteEnabled()`. `SAP_WRITE_ENABLED` is currently UNSET in `.env`, so all calls return synthetic doc entries.
- **Risk:** the day someone flips `SAP_WRITE_ENABLED=true`, this becomes an anonymous SAP-write vector. Anyone reachable can `POST {"dryRun":false}` and create real SAP B1 delivery notes.
- **Closes at cutover:** route doesn't exist in server.js. The post-cutover SAP-write path goes through `routes/driver.js` which has F2 ownership check, so even if `SAP_WRITE_ENABLED=true` post-cutover, only authed drivers writing to their own stops can trigger.

### F33 — Anonymous SAP invoice write (P0, currently fail-closed by env)
- **Path:** `POST /api/sap/write/invoice/:id` (`demoServer.js:434`).
- **Same envelope as F32.**

### F34 — Anonymous user CRUD (P0)
- **Paths:** `POST /api/users` (`demoServer.js:1137`), `PATCH /api/users/:id` (1146), `POST /api/users/:id/reset-password` (1156), `DELETE /api/users/:id` (1166).
- **Behavior:** anonymous. `store.addUser` (in `persistentStore.js`) accepts a password, hashes it, and inserts. No auth check.
- **Risk:** **account takeover trivially possible from any IP.** An attacker resets the admin password, then logs in normally via `/api/auth/login` (which IS rate-limited but allows valid logins).
- **Closes at cutover:** `routes/users.js:26,91,135,182,206` all have `requireRole('ADMIN')`.

### F35 — Anonymous run management (P0)
- **Paths:** `POST /api/runs` (1206), `PATCH /api/runs/:id` (1220), `DELETE /api/runs/:id` (1235), `POST /api/runs/auto-plan` (1308), `POST /api/runs/:id/optimize` (519).
- **Risk:** anyone can plan/cancel/reroute deliveries. Operational-disruption surface.
- **Closes at cutover:** `routes/runs.js` has role gates on all mutations.

### F36 — Anonymous picker management + 30-day picker tokens (P0)
- **Paths:** `POST /api/pickers` (`demoServer.js:137`), `PATCH /api/pickers/:id` (145), `DELETE /api/pickers/:id` (150), `POST /api/auth/picker-login` (109).
- **Risk:** anyone can create/edit pickers. Picker-login mints a 30-day token (vs the future planned 7-day).
- **Closes at cutover:** new `routes/pickers.js` (per WS-1 in `workstreams.md`) will gate with `requireRole('ADMIN')` for CRUD; picker-login becomes rate-limited and 7-day TTL.

### F37 — cf-tunnel-error.log mined for trycloudflare URLs (P1)
- **Behavior:** `demoServer.js:200-208` reads `backend/logs/cf-tunnel-error.log` and parses out trycloudflare URLs, exposing them via `POST /api/auth/mobile-link`.
- **Risk:** auth-required, so the immediate exfiltration risk is LOW. But the original F10 declared that file should be the only place that URL lives — and demoServer is still mining it.
- **Closes at cutover:** demoServer route goes away. Verify the new mobile-link replacement (if any) doesn't repeat the pattern.

---

## 4. server.js routes still on P1 (post-cutover audit needed)

These were P1 in `security-analysis.md`. Given that demoServer leaks them anonymously today, they are NOT freshly elevated — they remain P1 per the original framing — but worth re-flagging because once cutover closes the demoServer leaks, these become the next-most-exposed surface:

- **`/api/runs/:id/*` IDOR** — any authed user can read any run's full detail. (Driver tokens limited to F2-protected paths under `routes/driver.js`; but a planner can read any run regardless of association.) `routes/runs.js` line 25-onwards.
- **`/api/returns/:id/*` IDOR** — same. `routes/returns.js`.
- **`/api/picking/*` IDOR** — any picker can mark any line; no `pickerOwnsAllocation` check yet. WS-1 in `workstreams.md` includes adding this helper.
- **`/api/orders/*`** — any authed user can read any open order. `routes/orders.js`.
- **`/api/audit/:entityType/:entityId`** — F8 closes via `requireRole('ADMIN')` already. Remaining concern: audit log content if `auditMiddleware` (`services/auditLog.js:67-88`) ever gets applied to a token-returning endpoint.

---

## 5. Audit middleware review

`services/auditLog.js:67-88` defines `auditMiddleware()` which logs the **entire response body** of any route it wraps.

**Status:** zero callers. Confirmed via `grep -rn "auditMiddleware" backend/src/`. **No risk today.**

**Forward-looking risk:** if a future developer wraps it on `/api/auth/login` "for compliance," every login response (which contains the JWT) lands in `AuditLog.NewValue`. Permanent credential leak.

**Recommendation:** keep this in the freeze policy — `auditMiddleware` is on the "do not use" list. Either delete the function or add the `pickFields:` hardening (F22 in `security-analysis.md`).

---

## 6. Public tracking surface

`services/trackingTokens.js:44-134` (mounted by both `routes/trackPublic.js:33` in server.js and `demoServer.js:2103`).

**Confirmed unchanged from F15:**
- 128-bit token, 48-hour TTL.
- Returns: customer street + building number + city + lat/lng (line 51), driver full name + plate (51, 113-114), live GPS (52, 117-123) when run is `IN_TRANSIT` or `LOADED`.
- No revocation endpoint. `grep revoke|revoked|blacklist` against `services/` returns 0 hits.
- ViewCount tracking on every fetch (line 70-73) — abuse is at least visible in the audit trail, but no automated alert.

**No change needed in Phase 0.** F15 fix is post-cutover work per `recommendations.md` Tier 1.

---

## 7. `/uploads/*` static surface

**Today (demoServer running):** demoServer does NOT mount `/uploads`. Confirmed via grep — no `app.use('/uploads', …)` in `demoServer.js`. **F17 accidentally closed in PROD.**

**Post-cutover:** server.js:97-100 mounts `express.static(UPLOADS_ROOT, { maxAge: '7d', immutable: true })` with no auth. **F17 reopens.**

**No new upload paths added since the original audit.** `services/fileStorage.js` is the only writer; `multer` is not used anywhere.

**Recommendation:** WS-2 (Driver) workstream's verification step should include "confirm `/uploads/*` is auth-gated post-cutover" — even if it requires expanding scope by one route handler. Otherwise F17 sits open.

---

## 8. Driver token TTL

**demoServer issues 30-day driver tokens** (`demoServer.js:104,125,181`).
**`middleware/auth.js:55-61` issues 7-day driver tokens** (post-cutover).

**Implication:** drivers logging in today get 30-day tokens. After cutover (lax JWT mode), those 30-day tokens remain valid until expiry. So:
- A driver who logged in today can use the app for 30 days post-cutover even though the new code paths assume 7-day TTL.
- When the operator eventually flips `JWT_STRICT_VERIFY=true` (T+8 days from cutover), all demoServer-era tokens lacking `aud`/`iss` claims 401 simultaneously.

**Recommendation:** the JWT strict-verify flip must coincide with a coordinated driver re-login. Don't flip mid-business-day. Per `migration-final-recommendation.md §1.8`.

---

## 9. SAP_WRITE_ENABLED posture

```
$ grep -c "^SAP_WRITE_ENABLED" backend/.env
0
$ grep -c "^SAP_SERVICE_LAYER_URL" backend/.env
0
```

Both keys are absent. demoServer's `sapWriter.js:46,149,188` short-circuits to dry-run.

**No SAP writes happen today.** Confirmed safe.

**Forward-looking risk per `cutover-plan.md` Phase 6:** real SAP writes turn on as a separate post-cutover decision tied to `sync-analysis.md` recommendation 1.1 (idempotency UDF). This is independent of the cutover itself.

---

## 10. cors:'*' + tunnel/log leak surface

### 10.1 cors:'*' grep
Only one match in production source: `backend/src/demo/demoServer.js:57`. (Plus `app.use(cors())` at line 59 — same effect.) Server.js has the allow-list. **F1 status confirmed: OPEN in production.**

### 10.2 Cloudflare tunnel artifacts
- `cf-tunnel.log` at repo root: **DELETED** ✓
- `funk-aircraft-gains-gulf.trycloudflare.com` URL: appears now ONLY in `docs/architecture-review/security-analysis.md:83,219` (documentation). No runtime artifact.
- `backend/logs/cf-tunnel-out.log` (0 bytes): empty, harmless.
- `backend/logs/cf-tunnel-error.log` (40 KB): **still being mined by demoServer** for trycloudflare URLs (`demoServer.js:200-208`). **Tracked as F37.**
- `backend/ngrok/` directory: empty.

### 10.3 No other tunnel/QR/log leaks
Searched all top-level `.log` files in repo + `backend/logs/`. No URLs leaked beyond the one tracked in F37.

---

## 11. Threat model validity

The original `security-analysis.md` threat model was based on server.js running. **It is invalid in production today.** demoServer.js does not enforce auth on most endpoints — the threat model that applies is roughly "anyone who can reach the URL can do anything except actually write to SAP and except brute-force `/api/auth/login`."

The original framing remains correct for the post-cutover world. The framing in `p0-verification-report.md` ("F1-F10 P0 fixes are inert because demoServer.js is what's actually running") is supported and confirmed by this re-audit.

---

## 12. Phase 0 recommendations (security-only — no migration)

Per the freeze policy in `freeze-policy.md`, the only allowed work in Phase 0 is stabilization + security + observability. Specifically allowed:

### 12.1 No-touch posture (default)
The default position is to **leave demoServer alone** for 4-6 weeks while WS-1 through WS-7 land. F31-F36 close on cutover. Acceptable risk if:
- The system is on an internal network only (verify with operator — currently the cf-tunnel public URL is gone since F10).
- `SAP_WRITE_ENABLED` stays UNSET.
- Backups per `backup-inventory.md` are taken daily.

### 12.2 If a band-aid is necessary (operator approved)
The most-exposed surfaces in priority order (matching `freeze-policy.md §4` exception clause):

1. **F34 (anonymous user CRUD)** — 4 lines of middleware on demoServer.js:1135 area. Requires `Authorization: Bearer ` header containing any valid JWT issued by `/api/auth/login`. Stops account takeover.
2. **F31 (`/m/admin/:shortId`)** — disable the route entirely by commenting out lines 3289-3372. Verify with operator whether the QR-onboarding flow is still in use; if not (likely), drop.
3. **F32/F33 (anonymous SAP writes)** — env-gated; lower urgency. If the operator wants belt-and-suspenders, the same auth middleware as F34.
4. **F36 (anonymous picker CRUD)** — same auth middleware on demoServer.js:137,145,150.

Each band-aid must follow `freeze-policy.md §3` (reversibility + rollback notes). Mark in `INCIDENTS.md`.

### 12.3 Allowed during freeze without exception
- TLS cert fixes (F11/F12 — install a CA-signed cert on the SQL Server, flip `*_TRUST_SERVER_CERT=false`). No code change required; env edit only. Operator action with sign-off.
- Move `.env.bak.20260505` to encrypted off-host storage and delete from disk (F21 cleanup). Per `backup-inventory.md` §2.5.

### 12.4 Defer to post-cutover
- F13 (`JWT_STRICT_VERIFY=true`) — tied to migration timeline.
- F15 (public tracking surface reduction) — code change in `services/trackingTokens.js`; deferred per `recommendations.md`.
- F16 (JWT revocation) — schema + code change. Deferred.
- F17 (`/uploads` auth) — code change. Deferred (only relevant post-cutover).
- F22 (audit middleware hardening) — defer; just leave it un-applied.

---

## 13. Audit conclusion

**Phase 0 security posture:** acceptable IF the operator commits to:
- Keeping `SAP_WRITE_ENABLED` UNSET through cutover.
- Daily backups per `backup-inventory.md`.
- The "no band-aid" default unless an active exploit is observed.
- Logging any production change in `INCIDENTS.md`.

**Largest unmitigated risk during freeze:** F34 (anonymous user CRUD). The mitigation (4 lines of middleware) is small, but per the freeze policy it requires operator approval before applying. **Recommendation: bring this to the operator and get a yes/no decision documented in `INCIDENTS.md`.** A "no" is acceptable given the 4-6 week migration timeline; a "yes" plus a band-aid is also acceptable.

**Document inventory updated for security:**
- `security-analysis.md` (original audit)
- `p0-fixes-applied.md` (F1-F10 fixes — inert in PROD)
- `p0-verification-report.md` (verified inert state)
- `security-reaudit.md` (this file — production-reality view + new findings F31-F37)

End of re-audit.
