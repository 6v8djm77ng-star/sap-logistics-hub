# Immediate Exposure Reduction — Options Analysis

Read-only analysis of the demoServer routes flagged as P0 in `security-reaudit.md`. For each route: who uses it, what breaks if disabled, what's the safest mitigation, and whether auth can be added without a full rewrite.

**Scope rule:** all options must satisfy `freeze-policy.md §3` — reversible, with rollback notes. The default position is "no band-aid" unless an active exploit attempt is observed (per `security-reaudit.md §12.1`). This document gives the operator the data to make that yes/no call per route.

---

## 1. F31 — `GET /m/admin/:shortId` (anonymous credential vending)

### 1.1 What it does
- File: `backend/src/demo/demoServer.js:3289-3372`.
- Serves an HTML page that accepts an 8-char shortId, looks it up in the in-memory `mobileShortLinks` Map (line 158), extracts a previously-minted 30-day JWT, and writes it to `localStorage` via inline JS. The script also clears Service Workers and caches before injecting.
- Companion creator endpoint: `POST /api/auth/mobile-link` (line 168) — **DOES require a valid Bearer token** (line 170). It mints a 30-day JWT, stores it under a fresh shortId, and returns the QR/short URL.

### 1.2 Who uses it (frontend)
- `frontend/src/components/MobileLinkDialog.jsx:20` calls `POST /api/auth/mobile-link` (the auth-required creator).
- `frontend/src/pages/MobileShortLinkPage.jsx:23` is hit when an admin scans the QR / clicks the link on their phone — it's the consumer side that the URL `/m/admin/:shortId` redirects through.

### 1.3 Threat model
- **Creation requires auth** (good) — only a logged-in admin can mint a shortId.
- **Consumption is anonymous** (bad) — anyone who possesses the shortId (because the admin sent it via SMS/WhatsApp, because it was forwarded, because someone shoulder-surfed) gets a working 30-day prod-signed JWT. No revocation.
- **Keyspace:** 32^8 ≈ 1e12. Brute-force at 200 req/min would take ~9.5 million years.
- **Realistic threats:**
  - Admin posts shortId to a chat group → group member who shouldn't have admin keeps the JWT for 30 days.
  - Browser tab is shared / device is shared.
  - Malicious browser extension on the admin's phone harvests the URL from clipboard.

### 1.4 Operational impact of disabling

| Disable approach | Operational impact |
|---|---|
| Comment out line 3289-3372 (return 410/disabled) | Admins clicking shortId link on phone see error page. They fall back to manual login at `/login` with username/password. Acceptable. |
| Disable both endpoints (creator + consumer) | "Send link to my phone" button in admin UI breaks (`MobileLinkDialog.jsx:20`). Admins lose convenient phone onboarding. Functionally, they can still type the URL + login normally. |

### 1.5 Temporary mitigation options (least invasive first)

**Option A — leave it alone.** Justification: shortIds expire on process restart (in-memory only); creation is auth-gated. Real risk is admin OPSEC (sharing the URL). Document the OPSEC rule, don't change code.

**Option B — disable the consumer route.** Comment out lines 3289-3372, return 410:
```js
app.get('/m/admin/:shortId', (req, res) => {
  res.status(410).type('text').send('Mobile auto-login disabled during freeze. Login at /login.');
});
```
- Reversible: remove the 4 lines.
- Rollback notes: `git revert <sha>; pm2 restart sap-logistics`.
- Operational impact: existing shortIds become useless; admins must use manual login.

**Option C — disable the creator route too.** Comment out lines 168-243. The frontend's MobileLinkDialog will get 410 on submit; UX-wise it errors visibly which is preferable to a working flow that vends durable tokens.

**Option D — shorten the TTL.** Change `expiresIn: '30d'` (line 181) to `'1h'`. Reduces blast radius from a leaked URL to one hour.
- Code change is one line.
- Reversible (one-line revert).
- Doesn't break the flow — admin clicks link within minutes of receiving it.

### 1.6 Can auth be added safely without full rewrite?
**Not in the meaningful sense.** The whole point of `/m/admin/:shortId` is to bootstrap auth on a device that doesn't yet have a token. Requiring auth defeats the feature.

What CAN be added without rewrite:
- TTL shortening (Option D above) — 1 line.
- Per-IP rate limit at the route level (already covered by global `apiLimiter` 200 req/min, but `/m/admin/:shortId` is on the non-`/api/*` path so it's not rate-limited at all today). Adding `apiLimiter` to this route is 1 line.
- One-time-use: check `entry.usedAt`, reject if already redeemed. Adds 3 lines.

### 1.7 Recommendation
**Apply Option D (TTL → 1h) + one-time-use (`usedAt` check).** 4 lines of change, fully reversible, preserves the feature, dramatically reduces blast radius. Document in `INCIDENTS.md` as "F31 mitigated 2026-05-XX; TTL reduced from 30d to 1h, single-use enforced." Schedule full removal at cutover.

If the operator prefers the no-touch default per freeze policy, document the OPSEC rule: "shortIds must NOT be shared via group chats; never forward; if device changes hands, request a fresh shortId."

---

## 2. F34 — Anonymous user CRUD

### 2.1 What it does
- Endpoints: `POST /api/users` (`demoServer.js:1137`), `PATCH /api/users/:id` (1146), `POST /api/users/:id/reset-password` (1156), `DELETE /api/users/:id` (1166), `GET /api/users` (1135).
- All inline in demoServer.js. No `requireAuth` middleware applied.
- Backed by `persistentStore.js` `addUser`, `updateUser`, `setUserPassword`, `deleteUser` — bcrypt-hashes passwords and writes to `store.json`.

### 2.2 Who uses it (frontend)
- `frontend/src/pages/UsersPage.jsx:27-31` — admin user-management page.
- The same page IS gated client-side: `App.jsx` wraps `UsersPage` in `RequireAuth` requiring an authenticated session. So the UI doesn't expose this to non-admins. **The exposure is at the API layer** — anyone can directly hit `POST /api/users` from curl/Postman.

### 2.3 Threat model
- **Severity: P0.** Account takeover trivially possible:
  1. Attacker (no account) hits `POST /api/users {"username":"hacker","password":"x","role":"ADMIN"}` → 200, user created in store.json.
  2. Attacker hits `POST /api/auth/login {"username":"hacker","password":"x"}` → returns a real prod-signed JWT.
  3. Attacker now has full admin.
  - OR even simpler: `POST /api/users/:adminId/reset-password {"newPassword":"x"}` → real admin's password is now "x".

- **Active exploit risk:** depends on whether the URL is reachable from the public internet. With `cf-tunnel.log` deleted (F10) and no quick-tunnel running, the system should only be on the office LAN. **Operator must confirm.**

### 2.4 Operational impact of disabling

| Disable approach | Operational impact |
|---|---|
| Add `requireAuth` middleware (4-line band-aid) | Admin UI continues to work (it sends Bearer tokens). Curl-from-internet attacks blocked. **No user-visible impact.** |
| Disable `POST/PATCH/DELETE` entirely | Admins can't create/edit/delete users from UI. Can still manage via direct DB edit. Disruptive. |
| Add role check `requireRole('ADMIN')` | Same as #1 plus blocks non-ADMIN authed users. Best-in-class. |

### 2.5 Temporary mitigation options

**Option A — leave it alone.** Justification: only office-LAN reachable. Acceptable IF that's confirmed and the operator commits to weekly verification.

**Option B — add inline auth check (band-aid).** Insert a small middleware ABOVE the user routes (e.g. before line 1135):
```js
function adminOnly(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
// Apply to user CRUD routes only
app.use('/api/users', adminOnly);  // before the route definitions
```
- ~10 lines.
- Reversible: revert commit.
- Rollback: `git revert <sha>; pm2 restart sap-logistics`.
- **Risk:** the `app.use('/api/users', adminOnly)` would also apply to `/api/users/me/change-password` (line 263) which is currently auth-gated. Both compatible — no breaking change.
- **Risk:** `/api/users/me/subscriptions` (lines 1184, 1188) become ADMIN-only. They're currently no-op stubs; impact zero.

**Option C — surgically gate just the dangerous endpoints.** Add the middleware only to `POST/PATCH/DELETE /api/users` and the reset-password route, not the GET. ~6 lines.

### 2.6 Can auth be added safely without full rewrite?
**Yes.** Option B above is 10 lines, applies to a clearly-bounded surface (user CRUD), uses the same JWT_SECRET demoServer already uses, and has no behavioral side effects beyond closing the auth bypass. **Lowest-friction band-aid in the F-list.**

### 2.7 Recommendation
**Apply Option B as the FIRST band-aid if the operator approves any band-aid at all.** It's the highest-impact / lowest-risk mitigation in this document. Document in `INCIDENTS.md` with rollback notes.

---

## 3. F35 — Anonymous run management

### 3.1 What it does
- Endpoints: `POST /api/runs` (`demoServer.js:1206`), `PATCH /api/runs/:id` (1220), `DELETE /api/runs/:id` (1235), `POST /api/runs/auto-plan` (1308), `POST /api/runs/:id/optimize` (519).
- Plus all the run-mutation routes in `route-matrix.md` §B (force-include, duplicate, split, loading-plan, departure-approval, generate-invoices).
- All anonymous in demoServer.

### 3.2 Who uses it (frontend)
- `pages/RunsPage.jsx:23` — `POST /api/runs` (create).
- `pages/RunsPage.jsx:120,129` — DELETE / duplicate.
- `pages/RunDetailsPage.jsx` — most mutations.
- `pages/PlannerPage.jsx:22` — auto-plan / force-include.
- `components/AssignDriverDialog.jsx:15` — `PATCH /api/runs/:id` (assign driver).
- `components/DepartureApprovalDialog.jsx:31` — approve-departure.

### 3.3 Threat model
- **Severity: P0** for operational disruption (NOT data exfiltration).
- An attacker can:
  - Cancel today's runs by hitting `DELETE /api/runs/:id` for IDs 1-100.
  - Reroute deliveries via `POST /api/runs/auto-plan` (recomputes the plan from scratch).
  - Add bogus stops via `POST /api/runs/:runId/stops`.
- No SAP write impact (run data lives in store.json + Logistics SQL only).
- No PII exfil (the GET endpoints are also anonymous but covered separately).

### 3.4 Operational impact of disabling

| Disable approach | Operational impact |
|---|---|
| Add Bearer-token check (matches the F34 pattern) | UI continues to work. Curl-from-internet attacks blocked. |
| Add role gate `requireRole('ADMIN','PLANNER')` | UI works (planners have PLANNER role). Drivers can't accidentally hit these endpoints (they shouldn't be able to anyway — UI doesn't expose them). |

### 3.5 Temporary mitigation options

**Option A — leave it alone.** Same argument as F34: depends on network reachability.

**Option B — apply the same `adminOnly`/`adminOrPlanner` middleware** to `app.use('/api/runs', plannerOrAdmin)`. ~10 lines, including the planner-or-admin variant. Critical: this middleware must be inserted BEFORE the route definitions (around line 1190) and AFTER the auth/login routes.

- **Risk:** picker-login may need to read `/api/runs` for assigned waves — verify with frontend. If it does, gate accordingly.
- **Risk:** the `/api/runs` GET is also gated by Option B; that's actually fine because all reads should require auth too.

### 3.6 Can auth be added safely without full rewrite?
**Yes.** Same pattern as F34. ~10 lines.

### 3.7 Recommendation
**Apply alongside F34's Option B.** Single PR, two middleware functions (`adminOnly` + `plannerOrAdmin`), three `app.use(...)` lines. ~25 lines total, single commit, clean rollback.

---

## 4. F36 — Anonymous picker management + 30-day picker tokens

### 4.1 What it does
- `POST /api/auth/picker-login` (`demoServer.js:109`) — issues a 30-day JWT for any picker code present in store.json.
- `GET/POST/PATCH/DELETE /api/pickers` (`demoServer.js:134-153`) — picker CRUD, anonymous.

### 4.2 Who uses it (frontend)
- `pages/PickerAutoLoginPage.jsx:25` — picker scans their code, gets the 30d token.
- `pages/PickersPage.jsx:14-17` — admin picker-management page.

### 4.3 Threat model
- **Picker-login behavior:** input is just a picker code string. If the codes are predictable (e.g., "P001", "P002"), enumeration is trivial. Auth-by-knowledge-of-a-string with no shared secret.
- **Picker CRUD anonymous:** anyone can create a fake picker, then login with it.
- **Token TTL: 30 days.** No revocation.

### 4.4 Operational impact of disabling

| Disable approach | Operational impact |
|---|---|
| Gate picker CRUD with adminOnly | Admin picker-management UI still works. Internet attackers can't create fake pickers. |
| Don't touch `/api/auth/picker-login` | Drinking from the firehose (anonymous-input login) continues but is the only path the warehouse handheld can use. |
| Tighten picker codes (out of scope) | Requires coordination with warehouse. Defer. |

### 4.5 Temporary mitigation options

**Option A — gate just the CRUD.** Apply `adminOnly` to `app.use('/api/pickers', adminOnly)`. ~3 lines (reuses F34's middleware).
- Picker-login (`/api/auth/picker-login`) continues to work for warehouse handhelds.
- Picker CRUD requires admin token.

**Option B — also reduce picker token TTL.** Change line 116 (`expiresIn: '30d'`) to `'12h'`. Pickers re-scan their code at start of each shift — operational cost is one extra scan per day per picker. Reduces leaked-token blast radius from 30d to 12h.

**Option C — combine A + B.** Most defensible.

### 4.6 Can auth be added safely without full rewrite?
**CRUD: yes.** Picker-login: only by adding a shared secret (pre-shared key in handheld config), which is a real change requiring coordination. Out of scope for Phase 0.

### 4.7 Recommendation
**Apply Option C if a band-aid window is opened.** ~5 lines total. CRUD gated; TTL reduced to 12h. Picker-login URL itself remains the same.

---

## 5. F37 — `cf-tunnel-error.log` mining

### 5.1 What it does
- `demoServer.js:200-208` reads `backend/logs/cf-tunnel-error.log`, regex-extracts trycloudflare URLs, and exposes them via the auth-required `POST /api/auth/mobile-link` response.

### 5.2 Threat model
- **Severity: P1 (low immediate risk).** The endpoint requires auth; only an admin can extract a tunnel URL from this log.
- **Latent risk:** if a band-aid is added later that loosens this endpoint, the log becomes a sensitive-URL exfil channel.

### 5.3 Operational impact of disabling
- If the log mining is removed, `/api/auth/mobile-link` falls back to LAN IP / request-host detection. Admin convenience lost (they may need to manually paste the cf-tunnel URL).

### 5.4 Recommendation
**Leave it alone.** Auth-gated; no immediate exposure. Document for cutover (the entire mobile-link feature goes away then anyway).

If the operator wants extreme tidiness:
- Empty the log: `Clear-Content backend\logs\cf-tunnel-error.log`. The endpoint then has nothing to extract.
- Reversible (the log refills naturally if cloudflared runs).

---

## 6. F32 / F33 — Anonymous SAP write endpoints (env-gated)

### 6.1 What they do
- `POST /api/sap/write/delivery-note/:id` (`demoServer.js:412`).
- `POST /api/sap/write/invoice/:id` (`demoServer.js:434`).
- Both anonymous; both env-gated by `SAP_WRITE_ENABLED && SAP_SERVICE_LAYER_URL`.

### 6.2 Threat model
- **Today:** safe. `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` are both UNSET in `.env`. Calls return synthetic doc entries.
- **The day either env is set:** anonymous SAP write vector. P0 immediately.

### 6.3 Operational impact of disabling
- Used by Documents Hub UI ("send to SAP" button) — `pages/DocumentsPage.jsx`.
- If gated: button still works (UI sends Bearer token).
- If removed: button errors.

### 6.4 Recommendation
**Two-layer:**
1. **Operational gate (CRITICAL):** `SAP_WRITE_ENABLED` stays UNSET through cutover. This is already enforced by the freeze policy.
2. **Optional band-aid:** if the operator approves any band-aid set, include these in the same `app.use('/api/sap/write', adminOnly)` line. ~1 line. Adds belt-and-suspenders.

---

## 7. F4 / F6 / F7 / F8 — Anonymous reads (customers, analytics, drivers, audit)

These are the original P0 fixes (F4 customers, F6 analytics, F7 drivers, F8 audit) that are inert in production because demoServer doesn't import the patched route files.

### 7.1 demoServer's anonymous data exposure today

| Endpoint | demoServer.js | What's returned |
|---|---|---|
| `GET /api/customers/search?q=...` | line 3255 | Real SAP customer rows (CardCode, name, phone, city). Verified live during P0 verification: `{"source":"sap"}`. |
| `GET /api/analytics/summary`, `/anomalies`, `/customer-profitability`, `/driver-performance`, `/stock-prediction` | 1797, 667, 794, 1017, 571 | KPI dashboards with revenue/customer/run data. |
| `GET /api/drivers` | 1100 | Full driver PII (name, phone, plate, zones). |
| `GET /api/audit/...` | 3240 | Stub `{trail:[]}` — empty. No real exposure (audit log isn't actually populated by demoServer). |

### 7.2 Threat model
- **PII exfiltration risk** without auth. Whoever can reach the URL gets customer phones + driver phones.
- **Severity:** depends on network reachability. Office LAN only = lower; public-tunnel reachable = P0.

### 7.3 Recommendation
**Apply the same `adminOnly`/`plannerOrAdmin` middleware in a single PR** alongside F34/F35/F36 if the band-aid window is opened:

```js
// All routes that should require any valid Bearer token
app.use('/api/customers', requireAuthBasic);
app.use('/api/analytics', requireAuthBasic);
app.use('/api/drivers', requireAuthBasic);
app.use('/api/audit', requireAuthBasic);
app.use('/api/orders', requireAuthBasic);
app.use('/api/returns', requireAuthBasic);
app.use('/api/zones', requireAuthBasic);
app.use('/api/failures', requireAuthBasic);
app.use('/api/runs', plannerOrAdmin);
app.use('/api/users', adminOnly);
app.use('/api/pickers', adminOnly);
app.use('/api/sap', adminOnly);
app.use('/api/cod', requireAuthBasic);
app.use('/api/picking', requireAuthBasic);
app.use('/api/delivery-notes', requireAuthBasic);
app.use('/api/invoices', requireAuthBasic);
app.use('/api/documents', requireAuthBasic);
app.use('/api/reports', requireAuthBasic);
app.use('/api/tracking', requireAuthBasic);
app.use('/api/addresses', requireAuthBasic);
app.use('/api/settings', adminOnly);
app.use('/api/notify', requireAuthBasic);
// EXCEPT (must remain anonymous):
//   /api/auth/login, /api/auth/driver-login, /api/auth/picker-login (login endpoints)
//   /api/public/track/:token (tokenized public tracking)
//   /api/auth/mobile-link/:shortId   (anonymous-by-design, see F31)
//   /m/admin/:shortId                (anonymous-by-design, see F31)
//   /health
```

Caveat: the `/api/auth/me` (line 252) is auth-gated already; the `app.use('/api/auth', ...)` cannot be a blanket adminOnly without breaking login. Hence the per-prefix gating above.

---

## 8. Mitigation packaging

If the operator approves a band-aid, here's the proposed atomic patch (single commit):

### 8.1 Single PR scope
- Add three middleware functions to demoServer.js around line 84 (just after the request logger):
  - `requireAuthBasic(req, res, next)` — verifies Bearer JWT, attaches `req.user`. Returns 401 without.
  - `plannerOrAdmin(req, res, next)` — same plus role check (`PLANNER` or `ADMIN`).
  - `adminOnly(req, res, next)` — same plus role check (`ADMIN`).
- Add `app.use(...)` lines for each path prefix per §7.3.
- Reduce `expiresIn: '30d'` to `'12h'` for picker (line 116) and to `'1h'` for mobile-link (line 181).
- Total diff: ~50 lines added, 2 lines modified.

### 8.2 Pre-deployment validation
- Apply the patch to a local copy.
- Start demoServer locally on a free port.
- Run a curl matrix:
  - Without Authorization → expect 401 on every gated endpoint.
  - With a valid ADMIN token → expect 200 on adminOnly endpoints.
  - With a valid PLANNER token → expect 200 on plannerOrAdmin, 403 on adminOnly.
  - With a valid DRIVER token → expect 401 on plannerOrAdmin (no PLANNER role).
- Smoke-test the frontend's UsersPage, RunsPage, etc. with an ADMIN session.

### 8.3 Deployment plan
- Per `pm2-stabilization.md`, restarting sap-logistics today is at risk of orphan-on-port-4000. **DO NOT deploy this band-aid unless the PM2 maintenance has happened first.**
- Sequence: PM2 maintenance window → verify daemon healthy → THEN deploy the band-aid in a separate window.

### 8.4 Rollback notes (sample)
```
Rollback:
  git revert <sha>
  pm2 restart sap-logistics --update-env

If pm2 restart hangs (orphan-on-port-4000):
  (Stop-Process -Force on the orphan first per pm2-maintenance-runbook.md D.1)
  pm2 restart sap-logistics

State preserved: store.json untouched by the band-aid.
```

---

## 9. Decision matrix

For each of F31, F34, F35, F36, F32/33, F4/F6/F7/F8: the operator chooses ONE.

| Finding | Severity | Default (no-touch) | Recommended band-aid | Lines | Reversible? |
|---|---|---|---|---|---|
| F31 | P0 | OK if OPSEC enforced | Option D (TTL 1h + single-use) | 4 | yes |
| F34 (user CRUD) | P0 | NOT OK without LAN-only confirmation | Option B (`adminOnly`) | ~10 | yes |
| F35 (run management) | P0 | OK on office-only LAN | `plannerOrAdmin` middleware | ~10 | yes |
| F36 (picker mgmt + token) | P0 | OK on office-only LAN | Option C (CRUD gate + 12h TTL) | ~5 | yes |
| F32/F33 (SAP write) | P0 latent | Already OK (env-unset) | Optional `adminOnly` belt-and-suspenders | 1 | yes |
| F4/F6/F7/F8 | P0 (PII) | NOT OK if internet-reachable | `requireAuthBasic` middleware | ~15 | yes |

**Total band-aid scope if all approved:** ~50 lines in a single PR. Restart required (gated by PM2 maintenance).

**Total band-aid scope if only F34 + F4 family (the highest-impact):** ~25 lines.

---

## 10. Network reachability — the deciding factor

Many recommendations above hinge on whether `localhost:4000` is reachable from outside the office LAN. The operator must confirm:

```text
[ ] cf-tunnel quick-tunnel: STOPPED (cf-tunnel.log was deleted; verify cloudflared.exe is not running)
[ ] PM2 'cloudflare-tunnel' app status (per dump.pm2 it's 'online'): if online, what URL does it expose?
[ ] PM2 'sap-bi-tunnel' app: same question, different project but same host
[ ] PM2 'sap-bi-ngrok' app: ngrok exposes port 4000?
[ ] Firewall rules: is port 4000 reachable from outside the LAN?
[ ] If a public URL exists, who has it? (sales? customers? drivers via SMS?)
```

Until these are confirmed, **assume the worst-case (publicly reachable) and prioritize F34 + F4-family band-aids.** The PM2 dump shows three tunnel-style apps running — at least one of them likely exposes `sap-logistics` to the internet.

### 10.1 If publicly reachable
**Recommend the full band-aid bundle (§8.1).** ~50 lines. Single PR. Deploy after PM2 stabilization.

### 10.2 If office LAN only
**Recommend F34 only** as defense-in-depth (a future internal compromise becomes much less catastrophic). F31 OPSEC documentation in the runbook. Other findings can wait for cutover.

---

## 11. What does NOT make sense to band-aid

Some routes are unsafe to gate retroactively because doing so breaks more than it fixes.

| Route | Why not band-aid |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/driver-login`, `POST /api/auth/picker-login` | These ARE the auth endpoints. Can't gate them with auth. They're rate-limited (`loginLimiter` 20/15min/IP) which is the right pattern. |
| `GET /api/public/track/:token` | Token-based; designed for unauthed customer SMS. Mitigation is reducing the data returned (F15 in `security-analysis.md`), not adding auth. |
| `GET /m/admin/:shortId` | Anonymous-by-design (it's the bootstrap auth flow). Recommended approach is TTL/single-use, not blanket auth. |
| `GET /health` | Public health endpoint; intentional. |
| Worker-internal routes (none mounted today) | n/a |

---

## 12. Final recommendation matrix

For the operator. Pick one row (top to bottom = least to most invasive):

| Tier | Action | Effort | Restart needed? | Approval needed? |
|---|---|---|---|---|
| 0 | Document OPSEC rules (no code change). Confirm network reachability §10. | 30 min | no | no |
| 1 | Empty `cf-tunnel-error.log` (F37 mitigation). Reduce attack surface by 1 read. | 1 min | no | no |
| 2 | Apply F31 Option D (TTL → 1h, single-use). Lowest blast-radius for the credential vending feature. | 1 hour code + restart | yes (after PM2 mx) | yes |
| 3 | Apply F34 band-aid only (anonymous user CRUD). Highest-impact / lowest-risk single change. | 1 hour | yes (after PM2 mx) | yes |
| 4 | Apply F34 + F35 + F36 + F4-family (full bundle from §8.1). | 2 hours | yes (after PM2 mx) | yes |

**Strong recommendation: Tier 0 immediately + Tier 1 immediately + Tier 3 after PM2 maintenance + Tier 4 if internet-reachable.** This sequence avoids the riskiest moves until PM2 is stable and gives the operator clear stop points.

---

## 13. Document references

- `security-reaudit.md` — original F-list including the new F31-F37 findings
- `security-analysis.md` — original F1-F30 findings (most inert under demoServer)
- `freeze-policy.md` §3, §4 — band-aid policy
- `pm2-maintenance-runbook.md` — must run before any band-aid deploy
- `route-matrix.md` — full endpoint list with frontend callers
- `backup-inventory.md` — pre-deploy backups
- `cowork/INCIDENTS.md` — where the band-aid gets logged

End of exposure-reduction analysis.
