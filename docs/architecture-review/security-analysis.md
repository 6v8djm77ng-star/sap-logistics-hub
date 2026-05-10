# SAP Logistics Hub — Security Analysis

Read-only audit. Targets `backend/src/**` as it runs in production behind PM2 / Docker.
Scope: auth/RBAC, secrets, API risks, integrations, webhooks, token handling, hardening.

All file references are repo-relative; line numbers refer to current HEAD.

---

## 1. Auth & RBAC matrix

`server.js` mounts 21 routers under `/api/*` (lines 110–131). All except `/api/public/track`
sit behind a router-level `router.use(requireAuth)` (or stricter). Public mounts:

| Mount | File | Auth | Notes |
|---|---|---|---|
| `/api/public/track` | `routes/trackPublic.js:27` | none | rate-limited 30 req/min/IP only |
| `/health` | `server.js:103` | none | exposes presence/latency of Logistics DB and SAP SQL/SL endpoints |

`routes/intelligenceEvents.js` exists with a service-token guard but is **not** mounted
in `server.js` (verified — no `import` line for it). Dead code, zero exposure today.
This is fine, but if/when it's wired up, the missing-token path returns `503` (good)
instead of `401` (debatable but acceptable).

### Per-router gate matrix

| Router (`routes/`) | Router-level | Per-endpoint role gates | Public/no-auth endpoints | Rate limit |
|---|---|---|---|---|
| `auth.js` | none | none | `POST /login`, `POST /driver-login` (intentional). `GET /me` uses `requireAuth` (line 110). | `loginLimiter`: 20/15min/IP, applied to both login routes (lines 17–27). |
| `trackPublic.js` | `limiter` | n/a | `GET /:token` | 30/min/IP, in-memory only (line 17). Bypassed silently if `rateLimit` factory throws (line 23 — defensive `catch { next() }`). |
| `agents.js` | `requireAuth` (19) + 503-if-not-configured (21) | `requireRole('ADMIN')` on every endpoint | none | none |
| `audit.js` | `requireAuth` | none | none | none — see P1 below |
| `addresses.js` | `requireAuth` | `PATCH /:id` requires `ADMIN/PLANNER` | `GET /:id` open to any authed user (incl. DRIVER) | none |
| `analytics.js` | `requireAuth` | `GET /summary` is `ADMIN/PLANNER`. `/overall`, `/daily`, `/drivers`, `/zones`, `/failures`, `/sap-health` are **only** `requireAuth` — DRIVER and VIEWER can read all KPIs. | none | none |
| `customers.js` | `requireAuth` | none | all customer search + details + recent items + ensure-address open to any authed user (DRIVER included) | none |
| `davoMix.js` | `requireAuth` | only `POST /weekly-report/run` is `ADMIN`. The KPI/breakdown/buyer endpoints (incl. revenue/share by CardCode) are open to any authed user including DRIVER. | none | none |
| `driver.js` | `requireAuth` + `requireRole('DRIVER','ADMIN')` (line 16) | none past that | none | none |
| `drivers.js` | `requireAuth` | `POST /` and `PATCH /:id/zones` are `ADMIN`. `GET /` is **only** `requireAuth` — every authed user (DRIVER, VIEWER) can list every driver including phone, email, plate. | none | none |
| `failures.js` | `requireAuth` | `POST /:id/reschedule`, `POST /:id/resolve` are `ADMIN/PLANNER`. `POST /report` and `GET /` open to all authed (incl. DRIVER, VIEWER). | none | none |
| `orders.js` | `requireAuth` | none | every authed user (DRIVER, VIEWER) can list open orders, unified groups, and any order's lines | none |
| `picking.js` | `requireAuth` | `POST /lines/:lineId/pick` is `ADMIN/WAREHOUSE`. `GET /:id` open to all authed. | none | none |
| `reports.js` | `requireAuth` | none | any authed user can pull manifest PDFs and picking XLSX for any run/wave (no ownership check) | none |
| `returns.js` | `requireAuth` | `POST /` and `POST /:id/assign-to-run/:runId` are `ADMIN/PLANNER`. `POST /:id/pickup` is `ADMIN/DRIVER` (no check that the driver owns the run). `GET /` and `GET /:id` open to all authed. | none | none |
| `runs.js` | `requireAuth` | mutation endpoints are `ADMIN/PLANNER` (or `WAREHOUSE` for `/wave`). Reads + tracking-link create are `ADMIN/PLANNER` only on the create. `POST /stops/:stopId/tracking-link` is `ADMIN/PLANNER`. `GET /` and `GET /:id` and `GET /:id/wave` open to all authed. | none | none |
| `sap.js` | `requireAuth` | `GET /diagnose`, `/test/sql/:company`, `/test/sl/:company` are `ADMIN`. `GET /sample/:company` is `ADMIN/PLANNER`. | none | none |
| `settings.js` | `requireAuth` | `GET /` and `PUT /:key` are `ADMIN`. | none | none |
| `tracking.js` | `requireAuth` | none | `POST /position` (rejects if no `driverId` in token, line 28). `GET /drivers` and `GET /drivers/:id/trail` open to **any** authed user — DRIVER can see every other driver's live GPS and historical trail. | none |
| `users.js` | `requireAuth` | `GET /`, `POST /`, `PATCH /:id`, `POST /:id/reset-password` are `ADMIN`. `/me/subscriptions` (GET/PUT) and `/me/change-password` are open to any authed user (correct), but **no rate limit** on `/me/change-password`. | none | none |
| `zones.js` | `requireAuth` | `POST /` and `POST /:id/assign-address/:addressId` are `ADMIN(/PLANNER)`. Reads open to all authed. | none | none |

### RBAC gaps that matter

- **DRIVER reads everything.** Drivers authenticate with a 7-day token (`signDriverToken`, `middleware/auth.js:55`) and are then put through generic `requireAuth` everywhere. No router enforces "this DRIVER can only see their own data" except `routes/driver.js` (line 27 — and only for `/my-runs`). A compromised driver phone gets:
  - Full SAP customer search + addresses + 90-day item history (`routes/customers.js`).
  - Every other driver's live GPS position (`routes/tracking.js:43-48`).
  - Every other driver's historical trail (`routes/tracking.js:54-58`).
  - Every other driver's contact details, plate, email (`routes/drivers.js:14-25`).
  - Every CEO/Planner KPI dashboard (`routes/analytics.js`).
  - Every DAVO Mix revenue breakdown by CardCode (`routes/davoMix.js`).
  - PDF manifests and picking XLSX for any run (`routes/reports.js`).
  - Audit trail for any entity (`routes/audit.js`).
- **No IDOR check on any `/:id`.** None of the route handlers verify that the caller has any relationship to the entity. Examples worth highlighting:
  - `GET /api/runs/:id` → any authed user gets full run detail (driver name, customer addresses, SAP CardCodes).
  - `POST /api/runs/stops/:stopId/tracking-link` (`runs.js:124`) — generates a public tracking URL bound to a stop. ADMIN/PLANNER only, but no check that the planner is associated with the run.
  - `POST /api/driver/orders/:runOrderId/deliver` (`driver.js:150`) — a DRIVER token can deliver any `runOrderId` belonging to any other driver's run, creating a real SAP Delivery Note.
  - `PATCH /api/driver/stops/:stopId/status` (`driver.js:58`) — same: a DRIVER can mark any stop in any run delivered, with a forged signature/photo.
  - `POST /api/failures/report` (`failures.js:36`) — uses `req.user.driverId || null` but does not check the stop is on a run owned by that driver. Any DRIVER can file a failure on any other driver's stop.
  - `GET /api/audit/:entityType/:entityId` (`audit.js:10`) — every authed user can replay edit history of any entity (e.g. password resets are logged here, line 195 of `routes/users.js`).

---

## 2. Secrets exposure risks

### `.env` schema (inferred from `config/env.js`)

Required: `JWT_SECRET`, `LOGISTICS_SQL_HOST/USER/PASSWORD/DB`.
Optional: `SAP_SL_*` (URL, USERNAME, PASSWORD, COMPANY_DB_A/B), `SAP_SQL_*` (HOST, USER, PASSWORD, DB_A/B), `SMTP_PASSWORD`, `ANTHROPIC_API_KEY`, `INTEL_BUS_RECEIVER_TOKEN` (read by `lib/featureFlags.js:63`).

### Findings

- **`backend/.env.bak.20260505` exists on disk** (verified via `ls`). The root `.gitignore` line 36 specifically calls this out: *"backend/.env.bak.20260505 already exists with secrets"*. So the project is already aware that a `.env.bak` with live credentials sits beside the running `.env`. It is gitignored, but anyone with shell access to the box (or a stray `tar` of the directory for a "support bundle") gets a complete credential dump.
- **`backend/certs/cert.pfx`** is a PKCS#12 bundle = private key + cert in one file. Gitignored (line 95 of `.gitignore`). Risk is local file disclosure: it sits in a directory served as `/uploads/` is, but **only `/uploads/` is statically served** (`server.js:97`) — `certs/` is not. So the private key isn't leaking via HTTP. Still, the cert is from `Apr 25` — replace before going to real prod.
- **`cf-tunnel.log` in repo root** documents that this dev box was exposed via a Cloudflare quick-tunnel (`https://funk-aircraft-gains-gulf.trycloudflare.com`). Quick-tunnels publish to `trycloudflare.com` with **no auth at the tunnel layer**. The whole API (including `/api/auth/login` rate-limited to 20/15min) was world-reachable. This file is checked into the repo right now (visible in `ls` of root). **Delete `cf-tunnel.log`** and confirm the tunnel is down.
- **Static `/uploads` is served with `immutable` and 7-day cache** (`server.js:97-100`), no auth. Anybody who knows or guesses a path like `/uploads/signatures/2026/05/08/sig-1234-<uuid>.png` gets the customer signature. UUIDs are crypto-random (`fileStorage.js:80`) so guessing is hard, but URLs end up in logs, cached responses, and emails. Treat them as bearer-tokens-for-life. There is no expiry, no rotation, no auth check.
- **No password material is logged.** Verified — `grep` for `console.log.*password|JWT_SECRET|token` across `backend/src` returns no matches. Login failures log only `username` + `ip` (`routes/auth.js:47, 54`). Audit log records `passwordReset: true` as a marker (`routes/users.js:199`), not the password.
- **`AuditLog.NewValue` JSON-stringifies whatever the caller passes** (`services/auditLog.js:38`). Today the call sites (`routes/users.js:113-120, 169-176, 194-200`) only pass non-secret fields, but the contract is brittle: `auditMiddleware` (lines 67-88) auto-logs the entire response body on success. If anyone ever wraps it around an endpoint that returns a token or password reset payload, that secret will land in `AuditLog.NewValue` permanently.
- **`errorHandler.js`** correctly hides 5xx messages (line 38) and stack traces in prod (line 30). 4xx leak `err.message`, which is fine for Zod / auth errors but means anything thrown with `Object.assign(new Error(...), { status: 400 })` will surface verbatim. Spot-check `fileStorage.js:60-66` — the messages there ("Unsupported file type", "File too large") are intentional and safe.

---

## 3. API risks

### Input validation

Zod is used widely but inconsistently:

- **Mostly good:** `auth.js`, `users.js`, `runs.js`, `returns.js`, `picking.js`, `failures.js`, `tracking.js`, `addresses.js`, `drivers.js`, `zones.js`, `agents.js`, `settings.js` all wrap request bodies with `z.parse`.
- **Weakly typed query strings:** `routes/davoMix.js`, `routes/analytics.js`, `routes/orders.js` accept query params via `Number(req.query.x) || N` with no schema. The clamping in `services/davoMix.js:321-322` (`Math.min(Math.max(..., 7), 365)`) catches the values used in `SELECT TOP ${safeLimit}`, but downstream `days` becomes a `@days` parameter so injection is contained. Still, validation drift waiting to happen.
- **`routes/customers.js:22`** — `q` length checked but not type-checked (could be an array if duplicated). `findCustomerByName` parameterizes `@search` so no injection, but a query-shaped input like `q=foo&q=bar` will crash on `.length`.
- **`routes/sap.js:29, 41, 53`** — uses `req.params.company.toUpperCase()` with no whitelist. `companies` map (`config/env.js:130-133`) only knows `A` and `B`; an unknown code throws downstream and surfaces as a 500. Not a security issue, but a hardening miss.
- **`routes/settings.js:24`** — `value: z.any()` with no per-key validation. The `coerceValue` / `serializeValue` helpers (`systemSettings.js:88-107`) don't validate JSON shape. An ADMIN can poke garbage into a setting, but the gate is `requireRole('ADMIN')`, so impact is limited.

### SQL injection

Logistics DB queries route through `db.query/queryOne/execute` which use `mssql` parameterized inputs (`db/logisticsDb.js:38-46`). All user-controlled values flow through `@param` placeholders — verified across `routes/auth.js`, `users.js`, `runs.js`, `returns.js`, `customers.js`, `addresses.js`, etc.

**However**, raw template-string concatenation appears in:

| File:Line | Pattern | Source of injected value |
|---|---|---|
| `services/davoMix.js:325` | `SELECT TOP ${safeLimit}` | `safeLimit` clamped 1-50, integer — safe. |
| `services/sap/financialReader.js:70, 97, 123, 172, 204, 228` | `SELECT TOP ${safeLimit}` | clamped — safe. |
| `services/sap/sqlReader.js:146` | `SELECT TOP ${Math.min(Number(limit) || 25, 100)}` | clamped — safe. |
| `services/sap/sqlReader.js:252` | `WHERE W.ItemCode IN (${itemCodes.map((_,i)=>'@item'+i)})` | placeholders, not values — safe. |
| `services/sapSampleData.js:33, 42, 49` | `SELECT TOP ${Number(sampleSize)}` | `Number()` only, no clamp; if a non-finite value sneaks in you get a runtime error. ADMIN/PLANNER only via `routes/sap.js:51`. |
| `agents/store.js:89` | `SELECT TOP ${safeLimit}` | clamped — safe. |
| **`backend/src/demo/sapBridge.js:65`** | `SELECT TOP ${Math.min(limit, 50)}` | safe. |
| **`backend/src/demo/sapBridge.js:141, 217`** | `SELECT TOP ${limit}` | `limit` is **caller-supplied with no validation** in `getOpenOrdersUnified({ limit = 30 })` and `getOpenOrdersFlat({ limit = 100 })`. If demoServer ever exposes `?limit=` to the wire, this becomes a vector. Not currently mounted in `server.js`. |
| **`backend/src/demo/sapBridge.js:295`** | `WHERE L.DocEntry IN (${list})` where `list = docEntries.join(',')` | values come from `byCompany[code].push(Number(...))`, so coerced to numbers. Safe today; relies on caller. |
| **`backend/src/demo/sapBridge.js:325`** | `WHERE W.ItemCode IN (${escaped})` where `escaped = itemCodes.map(c => `'${c.replace(/'/g,"''")}'`).join(',')` | **manual escaping is a smell**. The doubling of single quotes is correct for T-SQL string literals, but anything else (Unicode quotes, `]`, comments) is unprotected. Not currently in the production path (demo only) but copy-paste risk. |

### IDOR

Already covered in §1. Worth restating because it spans many files:
- `routes/runs.js` — `GET/:id`, `GET/:id/wave`, `POST/:id/wave`, `POST/stops/:stopId/tracking-link`, `POST/:id/optimize-order` accept any id with no ownership check.
- `routes/driver.js` — `PATCH/stops/:stopId/status`, `POST/stops/:stopId/complete`, `POST/orders/:runOrderId/deliver` accept any id; auth only checks role=DRIVER, not run ownership.
- `routes/audit.js`, `routes/reports.js`, `routes/customers.js`, `routes/tracking.js` — any authed user reads any entity.

### Mass assignment

`routes/users.js:139` builds a dynamic UPDATE from an allow-listed schema (`updateUserSchema`, lines 126-133). No `Object.assign(user, req.body)` patterns found.
`routes/addresses.js:79-86` similar — fixed `map` of allowed fields.
No explicit mass-assignment vulnerabilities found.

### Other API findings

- **No CSRF protection** anywhere. `cors` allows `credentials: true` (`server.js:87`) but auth uses `Authorization: Bearer` headers, not cookies, so classic CSRF is mitigated by browser CORS. **However** Socket.IO is mounted with `cors: { origin: '*' }` (`sockets/index.js:16`) and authenticates on `socket.handshake.auth.token`. A malicious cross-origin page can construct a Socket.IO client with a stolen token from any source — though stealing the token is the harder step.
- **Body limit 2MB** (`server.js:93`) — DoS-resistant. The `signatureDataUrl/photoDataUrl` paths in `driver.js:60-65` consume the same limit.
- **`/me/change-password` (`users.js:206`) has no rate limit**, while login does. An attacker with a valid token (e.g. a stolen DRIVER token) can brute-force the old password to escalate. Token TTL is 8h (`JWT_EXPIRES_IN` default) for users / 7d for drivers, plenty of time.

---

## 4. External integrations

### SAP (SQL + Service Layer)

- **SQL credentials** at `env.SAP_SQL_USER` / `SAP_SQL_PASSWORD` are used by `services/sap/sqlReader.js:23` and `services/sapSampleData.js:18` to build connection pools. `encrypt=true` by default (`config/env.js:59`) but `trustServerCertificate=true` by default (line 60) — encrypted transport, no cert validation. MITM-feasible for an attacker on the SAP↔hub network.
- **Service Layer**: `services/sap/serviceLayer.js:19` uses `rejectUnauthorized: env.SAP_SL_SSL_REJECT_UNAUTHORIZED` (default `false`, `config/env.js:48`). Same MITM exposure for SL traffic. There's a startup warning in prod (`config/env.js:150`) — surface but not enforced.
- **Demo path** (`demo/sapBridge.js:30`) hardcodes `encrypt: false, trustServerCertificate: true`. Demo server isn't in the prod entry, but the file ships in the same image.
- **No outbound URL allowlist** anywhere. `SAP_SL_URL` is a free-form string (`config/env.js:43`). Anthropic SDK calls `https://api.anthropic.com` (no override). `nodemailer` will connect wherever `SMTP_HOST` says.

### SMTP

- `SMTP_PASSWORD` only in `.env`, not stored elsewhere. `SMTP_SECURE` defaults absent (line 82). If `SMTP_PORT=587` and `SMTP_SECURE` is unset, nodemailer falls back to plain TCP unless STARTTLS negotiates — a downgrade attack opportunity.
- `SMTP_FROM` envelope is user-controlled at the env level (acceptable) but consumed verbatim into outgoing mail headers; spoofing isn't a vulnerability per se, just verify SPF/DKIM at the DNS layer.

### SMS providers

`SMS_PROVIDER` enum allows `none|twilio|inforu|019` (`config/env.js:88`). No keys present in env schema for these — the actual implementation must be reading them via `process.env` directly without zod validation. Confirm in `services/notifications.js` if extending. Not reviewed here.

### Anthropic API

- `ANTHROPIC_API_KEY` read once into `Anthropic({ apiKey })` on first call (`agents/runtime.js:43`).
- **Prompt-injection / tool-execution risk** via the `runAgent` loop:
  - The CEO Brief agent is the only mounted user (`agents/ceoBrief.js`). Its tools wrap read-only SAP financial queries (`agents/tools/financialTools.js`). Each handler is a wrapper around `services/sap/financialReader.js` which uses parameterized SQL. So even a maximally-injected prompt cannot make the model write to SAP — the worst case is the model returning fabricated numbers in `executive_summary`.
  - However: tool inputs are passed as `use.input` directly into the handler (`agents/runtime.js:171`). If anyone adds a tool that does string concatenation into SQL or shell, the model becomes the SQL-injection vector.
  - `AGENT_MAX_TOOL_CALLS=8`, `AGENT_MAX_TOKENS_OUT=4096` (`config/env.js:97-98`) — bounded, OK.
  - **`aiCostGuard.js` is a no-op** (`lib/intelligence/aiCostGuard.js:31-36`). Phase 1 returns `phase1_no_enforcement`. Daily/hourly budgets exist as numbers in `featureFlags.js:69-70` but nothing reads them. A loop or runaway agent has no monetary brake.
  - LLM endpoints are gated by `requireRole('ADMIN')` (`routes/agents.js:36, 50, 60`), so externally driven prompt-injection requires an admin token first.

---

## 5. Webhook validation

- **No inbound webhooks are mounted.** The closest is `intelligenceEvents.js` (service-token guarded, schema-validated), but it isn't wired into `server.js`. SMS/SMTP providers are outbound only in this codebase — no callback handlers were found.
- **`/api/public/track/:token`** (`routes/trackPublic.js:33`) is the one place where unauthenticated traffic does real DB reads.
  - Token is a 32-hex (`crypto.randomBytes(16).toString('hex')`, `services/trackingTokens.js:9`) — 128-bit, unguessable.
  - Tokens are bound to `StopId`, expire after 48h (line 16), survive `+7 days` past expiry in DB (`cleanupExpiredTokens`, line 169) — a small window where an expired token still exists in `TrackingTokens` but is rejected by `WHERE ExpiresAt > SYSUTCDATETIME()` (line 62). Acceptable.
  - **What `getTrackingInfo` returns is generous**: customer street + building number + city + lat/lng, driver full name + vehicle plate, run number, run date, every other stop's position in the route via `runProgress`. Anyone who intercepts the SMS link (or it shows up in URL referrer logs of any HTTP page on the same browser) gets this for 48h. The driver's **live GPS coordinates** are returned while `RunStatus IN ('IN_TRANSIT','LOADED')` (line 117). Vehicle-tracking-grade data is exposed to whoever holds the URL.
  - Rate limit is 30/min/IP (`trackPublic.js:18`) and silently degrades to no-limit if the factory throws (line 23). On a single instance, fine. Behind a load balancer with shared state, the in-memory store is per-instance — effective limit multiplies by instance count.
  - No token revocation. Once minted, a token is valid until expiry no matter what.

---

## 6. Token handling

### JWT

- Single secret, no rotation: `JWT_SECRET` from `.env` (`config/env.js:28`). Min 16 chars enforced. No JWKS, no key versioning. Rotating the secret invalidates **every** active session and driver token at once.
- `JWT_AUDIENCE` and `JWT_ISSUER` are signed in (`middleware/auth.js:42-45`) but `JWT_STRICT_VERIFY=false` by default (`config/env.js:35`). In lax mode, tokens **without** `aud`/`iss` claims are still accepted (`middleware/auth.js:71-73`) — this is the explicit migration path. Lax-mode mitigation: if claims are present they're checked (lines 79-80), so an attacker can't forge `aud=other-system` against the same `JWT_SECRET`. Acceptable as a transitional state, but the warning at startup (`config/env.js:153-155`) has been there a while — flip it.
- **No revocation list, no session table.** A leaked token is valid for the full TTL: 8h for users, **7 days for drivers** (`config/env.js:30`). Driver phones get lost; drivers get fired. No way to kick them out other than waiting or rotating the global secret.
- Driver token shape: `{ sub: 'driver-${driverId}', driverId, role: 'DRIVER', name }` (`middleware/auth.js:55-61`). Lacks any device binding.

### Tracking tokens (public)

Covered in §5. Summary: 128-bit random, 48h expiry, no revocation, not auth-bound.

### Service-bus token (intelligenceEvents — not mounted)

`INTEL_BUS_RECEIVER_TOKEN` compared against `Authorization: Bearer` (`routes/intelligenceEvents.js:36-39`). Constant-time compare: **no — it's `provided !== expected`**. If/when this router is mounted, swap to `crypto.timingSafeEqual` to avoid timing oracles.

### Socket.IO token

Same `JWT_SECRET`, verified on connect (`sockets/index.js:25`). Once connected, no re-validation — a token that expires mid-session continues to receive events until disconnect. Combined with the `cors: { origin: '*' }` (line 16), a malicious page can subscribe a stolen token to all `planner` and `warehouse` rooms.

---

## 7. Production hardening gaps

| # | Finding | Where | Impact |
|---|---|---|---|
| H1 | `LOGISTICS_SQL_TRUST_SERVER_CERT=true` default | `config/env.js:73` | encrypted transport, no cert validation; MITM-able |
| H2 | `SAP_SQL_TRUST_SERVER_CERT=true` default | `config/env.js:60` | same as H1 for SAP SQL |
| H3 | `SAP_SL_SSL_REJECT_UNAUTHORIZED=false` default | `config/env.js:48` | SL accepts any TLS cert; MITM-able |
| H4 | `JWT_STRICT_VERIFY=false` default | `config/env.js:35` | tokens with no aud/iss accepted (migration mode) |
| H5 | CORS allows null Origin | `server.js:81-86` (`if (!origin) cb(null, true)`) | server-to-server is fine, but `null` Origin also comes from sandboxed iframes, file:// pages, and some redirected requests; not an authentication bypass since auth is bearer-header but it widens the call surface |
| H6 | Helmet CSP allows `'unsafe-inline'` styles | `server.js:65` | XSS that lands in the SPA can inject inline styles (data exfil via `background-image: url(...)` techniques) |
| H7 | Socket.IO `cors: { origin: '*' }` | `sockets/index.js:16` | comment literally says "tighten for production" — never tightened. Stolen JWT works from any origin. |
| H8 | Cloudflare quick-tunnel was used, log committed | `cf-tunnel.log` (repo root), exposed `https://funk-aircraft-gains-gulf.trycloudflare.com` | dev box was world-reachable; quick-tunnels have no auth at the tunnel layer |
| H9 | Static `/uploads` served with no auth | `server.js:97-100` | anyone with a URL keeps access for 7 days (`maxAge` + `immutable`). UUIDs unguessable but URL leakage = permanent compromise |
| H10 | No rate limit on `/me/change-password` | `routes/users.js:206-228` | a stolen token can brute-force old password to escalate persistence |
| H11 | No rate limit on the 18 other `/api/*` routers | `server.js:111-129` | enumeration / scraping unconstrained for any authed user |
| H12 | `aiCostGuard` is a no-op | `lib/intelligence/aiCostGuard.js:31-36` | prompt-injected loop or runaway agent has no $ brake; daily token budgets defined but unenforced |
| H13 | `app.set('trust proxy', 1)` | `server.js:53` | trusts X-Forwarded-For from one hop. If anything other than your reverse proxy ever connects directly (firewall misconfig), `req.ip` becomes attacker-controlled and rate limits collapse |
| H14 | `backend/.env.bak.20260505` on disk with secrets | filesystem | gitignored but local-disclosure / backup-bundle risk |
| H15 | `helmet` CSP `connect-src: 'self'` only | `server.js:67` | fine for current behavior, breaks if frontend ever calls a separate API host without an update — minor |
| H16 | `errorHandler` exposes 4xx `err.message` | `middleware/errorHandler.js:36-37` | acceptable for Zod, dangerous if any service throws a 4xx with internal detail (e.g. SAP error text) |
| H17 | `server.log` (active log) and `data/` in repo | `backend/server.log`, `backend/data` | depending on contents; not reviewed line-by-line |
| H18 | Default admin password documented | `docs/PRODUCTION.md:45` (`admin / admin123`) | doc tells operator to change it, but install path doesn't enforce a change before first login |
| H19 | No HTTPS enforcement in app | `server.js` does not redirect HTTP→HTTPS | doc punts to nginx (`docs/PRODUCTION.md:271`); if you skip nginx, app is happy serving cleartext |
| H20 | `helmet` headers allow `crossOriginResourcePolicy: 'same-site'` | `server.js:73` | combined with `/uploads` static, sibling subdomains can embed delivery photos. Acceptable if all traffic is on one host. |
| H21 | Express body size 2MB | `server.js:93` | adequate, but driver photo data URLs can hit this (10MB cap inside `fileStorage.js:34` is dead code — request gets 413 from Express first) |

---

## 8. Specific findings — severity, file:line, fix

| # | Sev | File:Line | Issue | Fix |
|---|---|---|---|---|
| F1 | **P0** | `sockets/index.js:16` | Socket.IO `cors: { origin: '*' }` lets a stolen JWT subscribe from any origin | Set `cors: { origin: env.CORS_ORIGINS.split(',').map(s=>s.trim()) }` and reject the connection if `socket.handshake.headers.origin` isn't whitelisted. Comment line 17 ("tighten for production") has been there a while — close it. |
| F2 | **P0** | `routes/driver.js:58-110, 116-144, 149-169` | DRIVER token can mark any stop delivered / push any signature on any other driver's stop → fake SAP delivery notes. No ownership check between `req.user.driverId` and the run that contains `stopId` / `runOrderId`. | Add a check in each handler: load the run for the stop, confirm `run.DriverId === req.user.driverId` (or role=ADMIN). One helper, four call sites. |
| F3 | **P0** | `routes/tracking.js:42-58` | DRIVER token can read every other driver's live GPS + historical trail | Restrict `GET /drivers` and `GET /drivers/:id/trail` to `requireRole('ADMIN','PLANNER')`. Drivers don't need to see the fleet. |
| F4 | **P0** | `routes/customers.js:13` | Any DRIVER can search and read every customer in both SAP companies | Add `requireRole('ADMIN','PLANNER')` at router level. Drivers have no business calling `/api/customers/*`. |
| F5 | **P0** | `routes/davoMix.js:11` | Any DRIVER can read DAVO revenue, top buyers, attach rates, every CardCode breakdown | Add `requireRole('ADMIN','PLANNER')` at router level. |
| F6 | **P0** | `routes/analytics.js:25-51` | Any DRIVER can read every KPI dashboard; only `/summary` is gated. | Apply `requireRole('ADMIN','PLANNER')` at router level (line 8). The fact that `/summary` has an explicit gate (line 18) and others don't is inconsistent. |
| F7 | **P0** | `routes/drivers.js:12-25` | Any DRIVER can list every driver's contact info, plate, email | Add `requireRole('ADMIN','PLANNER')` to `GET /`. |
| F8 | **P0** | `routes/audit.js:10` | Any authed user can pull audit trail for any entity (incl. password-reset markers, role changes) | `requireRole('ADMIN')` on this router. |
| F9 | **P0** | `routes/reports.js:15-22, 30-38` | Any authed user can download any run's PDF manifest (full customer addresses, names, phone) and any wave's picking XLSX | `requireRole('ADMIN','PLANNER','WAREHOUSE')` minimum; better, an ownership check for DRIVER manifests. |
| F10 | **P0** | `cf-tunnel.log` (repo root) | Live URL of a Cloudflare quick-tunnel committed to the repo, exposing the dev box without auth at the tunnel layer | Delete the file. Confirm `cloudflared` process is down. Use a named tunnel + Cloudflare Access if remote access is needed. |
| F11 | **P1** | `config/env.js:60, 73` | `trustServerCertificate=true` defaults silently turn TLS into MITM-bait | Default to `false`; force operators to opt-in to skip verification. Issue CA-signed cert on the SQL Server (already noted in startup warnings). |
| F12 | **P1** | `config/env.js:48` | `SAP_SL_SSL_REJECT_UNAUTHORIZED=false` default | Default `true`. Same logic as F11. |
| F13 | **P1** | `middleware/auth.js:71-73` | `JWT_STRICT_VERIFY=false` default = legacy tokens with no aud/iss accepted | The migration window is open-ended. Flip to `true` once `_legacyAcceptedCount` (line 12) hits zero; rollout stats are already exposed via `getJwtRolloutStats`. |
| F14 | **P1** | `routes/users.js:206-228` | `/me/change-password` not rate-limited | Apply the same `loginLimiter` (export from `routes/auth.js`) or a similar one keyed on `req.user.sub`. |
| F15 | **P1** | `services/trackingTokens.js:44-134` | Public tracking endpoint exposes street + building + lat/lng + driver name + plate + live GPS to whoever holds the URL for 48h with no revocation | Reduce surface: drop driver full name (use first name or "הנהג"), drop vehicle plate, return only city-level location until run is `IN_TRANSIT`. Add a manual revoke endpoint (`POST /api/runs/stops/:stopId/tracking-link/revoke` for ADMIN). |
| F16 | **P1** | `middleware/auth.js:55-61` + login flow | No JWT revocation, 7-day driver TTL | Add a `Users.TokenVersion` / `Drivers.TokenVersion` int. Embed in token, check on every `requireAuth`. Bump on password reset / driver deactivation. |
| F17 | **P1** | `server.js:97-100` | `/uploads` static served forever with no auth, `immutable` cache | Move uploads behind an auth-gated handler that streams from disk after `requireAuth`. Or pre-sign URLs (HMAC of path + expiry). Don't serve them as durable bearer tokens. |
| F18 | **P1** | `routes/intelligenceEvents.js:36-39` (when mounted) | Token comparison via `!==` is non-constant-time | `crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(expected))`, both buffers same length. |
| F19 | **P1** | `server.js:81-86` | CORS callback allows any null origin unconditionally | Drop the `if (!origin)` short-circuit for browser-style methods. Server-to-server callers can be allowed by IP/auth elsewhere. |
| F20 | **P1** | `lib/intelligence/aiCostGuard.js:31-77` | Phase-1 stub means defined token / USD budgets aren't enforced. | Either move enforcement up (reject calls when daily budget is exceeded) or remove the budget envs from public docs until enforcement lands — current state is misleading. |
| F21 | **P1** | `backend/.env.bak.20260505` | Backup of `.env` with live secrets sits next to `.env` | Move all `.env.bak*` outside the project tree (or a sealed secrets store). At minimum `chmod 600` and rotate the secrets that were in it. |
| F22 | **P2** | `services/auditLog.js:67-88` (`auditMiddleware`) | Auto-logs the entire response body. Easy to misuse on an endpoint that returns a token. | Drop this middleware factory or document a hard rule: never wrap it around endpoints that return secrets. Better, accept a `pickFields: string[]` and require it. |
| F23 | **P2** | `demo/sapBridge.js:30, 141, 217, 295, 325` | Demo file uses `encrypt:false`, `trustServerCertificate:true`, `${limit}` interpolation, manual quote-doubling. Not currently mounted. | Mark file as deprecated, move out of `src/`, or harden it now. The longer it sits, the higher the chance someone wires demoServer back into prod. |
| F24 | **P2** | `routes/agents.js:42` | `createdBy` falls back to `user-${req.user?.sub}` — fine, but logs the numeric user id; consider `username` only | Cosmetic. |
| F25 | **P2** | `routes/sap.js:29, 41, 53` | No whitelist on `:company` param; relies on downstream throw | Validate against `['A','B']` before calling diagnostic helpers. |
| F26 | **P2** | `services/sapSampleData.js:33,42,49` | `SELECT TOP ${Number(sampleSize)}` with no clamp, but ADMIN/PLANNER-gated | Clamp to `Math.min(Math.max(Number(sampleSize)||10, 1), 50)`. |
| F27 | **P2** | `docs/PRODUCTION.md:45` | Default `admin / admin123` documented; install doesn't force a reset | Make `install.ps1` generate a random initial admin password and print it once. The doc currently relies on the operator remembering. |
| F28 | **P2** | `server.js:65` | Helmet CSP allows `'unsafe-inline'` for styles | Hash or nonce inline styles in the SPA build, drop `'unsafe-inline'`. |
| F29 | **P2** | `server.js:53` (`trust proxy: 1`) | If hub is ever exposed without a reverse proxy, `req.ip` becomes attacker-controlled (X-Forwarded-For spoof) | Tie to `NODE_ENV === 'production'` AND a documented `BEHIND_PROXY=true` env, default off. |
| F30 | **P2** | `services/fileStorage.js:34` | 10MB cap is dead code — Express body limit (2MB, `server.js:93`) trips first | Either raise body limit for the driver upload endpoints (with a separate `express.json({limit:'12mb'})` mounted only there) or drop the 10MB constant to match. |

---

## Quick prioritization

If you have one hour: F1 (Socket.IO CORS), F4–F9 (RBAC tightening — these are 6 lines each), F10 (delete cf-tunnel.log).

If you have one day: add the F2 ownership check helper (it's ~15 lines and closes the entire "DRIVER can spoof another DRIVER's deliveries" class), flip F11/F12/F13 defaults, add F14 rate limit, fix F17 uploads to be auth-gated.

If you have one week: F15 (public tracking surface reduction + revocation), F16 (token versioning), F20 (real cost guard), F22 (kill the auto-audit middleware), and walk through every `/:id` handler adding ownership/role-scoped checks.

The shape of the codebase is good — Zod is used widely, parameterized SQL is the norm, login is rate-limited, secrets are env-only. The systemic gap is that **`requireAuth` was treated as the authorization decision** in many places where role gating or ownership checking is what's actually needed, especially given that DRIVER tokens are wide-open 7-day bearers handed to phones in the field.
