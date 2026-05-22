# Runbook — SAP LIVE Test-Flush

> **Audience:** operator running a single, controlled live SAP write against
> `TEST_OIG` via `POST /api/admin/sap-write/test-flush/:runId`.
> **Scope:** test DBs only. Never `SAP_OIG` / `SAP_Unico` / `SAP_Unico_Eilat`.

This is an operator-grade checklist. It assumes the safety infrastructure
in HEAD (whitelist gate, IsTest gate, adminOnly middleware, restart-safe
guard, DRY-RUN default) is already wired and verified.

---

## 0. Hard prerequisites (must be true before opening any terminal)

| # | Pre-req | How to verify |
|---|---|---|
| P1 | `SAP_SL_USERNAME=איציק`, `SAP_SL_PASSWORD=<set>`, `SAP_SL_COMPANY_DB_A=TEST_OIG` (uppercase, case-sensitive), `SAP_SL_COMPANY_DB_B=Test_Unico`, `SAP_LIVE_WRITE_DB_WHITELIST=TEST_OIG,Test_Unico` in `backend/.env` | `grep ^SAP_ backend/.env` |
| P2 | `SAP_WRITE_ENABLED` is **absent** | `grep -c ^SAP_WRITE_ENABLED= backend/.env` returns `0` |
| P3 | ADMIN credentials known to operator (real password, not `admin123`) | personal — never store in repo |
| P4 | At least one customer in `customerDeliveryProfiles` has `DocPolicy.aggregateDeliveryNote='yes'` | check `backend/data/store.json` |
| P5 | A real SAP DocEntry from `TEST_OIG` available (via `discover-test-sap-orders.js --json` or direct SQL) | inspect `discovery-*.json` |
| P6 | PM2 `sap-logistics` online + responding HTTP 401 on `/api/auth/me` | `pm2 list` + `curl localhost:4000/api/auth/me` |
| P7 | Working tree clean (`git status --short` shows nothing relevant) | `git status` |

**Do not proceed past 0 if any P-row fails.**

---

## 1. Auth Preflight (mandatory before arming)

**Goal:** verify the ADMIN password works against the running server **before**
flipping any gate. A wrong password mid-live-window means a partially-armed
system sitting open longer than necessary.

```text
1.  Create empty C:\Users\izik\admin-password.tmp
2.  Operator types ONLY the password into the file, saves
3.  POST /api/auth/login { username: admin, password: <from file> }
4.  Delete admin-password.tmp regardless of outcome
5.  Verify response.user.role === 'ADMIN'
6.  Do NOT print full token — only token.length
7.  If 401 → STOP. Wrong password. Fix it; do NOT continue to arming.
8.  Discard token. We will re-login inside the armed window.
```

**Hard rule:** if Auth Preflight fails, you do NOT proceed to step 2.
A working-tree-clean baseline costs nothing; an armed system with a wrong
password is needless exposure.

---

## 2. Snapshot phase

```text
- backend/.env                        → backup as .env.backup.PRE-LIVE-FLUSH-<ts>
- DocPolicy for target CardCode      → JSON snapshot file with all 4 fields
                                       + IsTest + Name
- backend/data/store.json            → handled automatically by seed script
                                       (store.PRE-SEED-APPLY-<ts>.json)
```

Snapshots live next to the originals; they exist only so the cleanup phase
can restore the canonical pre-test state.

---

## 3. Arm phase (every step opens blast radius — do them quickly)

### 3.1 DocPolicy override (one customer only)

If the target customer's `DocPolicy.aggregateDeliveryNote` is not already
`'yes'`, set it temporarily. Pattern:

```text
pm2 stop sap-logistics
edit data/store.json  (only the one CardCode's DocPolicy)
pm2 start sap-logistics
```

(Plain `pm2 start` here is fine because no env vars changed yet.)

### 3.2 Enable live write

Add **one** line to `backend/.env`:

```env
SAP_WRITE_ENABLED=true
```

Do **not** edit any other env value. Do **not** touch
`SAP_LIVE_WRITE_DB_WHITELIST` — it must already contain `TEST_OIG`.

### 3.3 PM2 ecosystem reload — **must** go through restart-safe.ps1

```powershell
powershell -ExecutionPolicy Bypass -File scripts/restart-safe.ps1
```

**Do not** use any of these alternatives:

| ❌ Do not use | Why |
|---|---|
| `pm2 restart sap-logistics --update-env` | 2026-05-14 incident: silently truncated `store.json` (~2.5 MB → 3 KB, 69 runs → 0). `restart-safe.ps1` wraps this command with pre-backup + post-verify + auto-recovery |
| `pm2 restart sap-logistics` (plain) | Does **not** re-read `ecosystem.config.cjs` → new `SAP_WRITE_ENABLED=true` is **not** loaded into process env. Looks armed; isn't |
| `pm2 delete sap-logistics && pm2 start ecosystem.config.cjs` | Works in theory, but skips the store-integrity preflight + backup that `restart-safe.ps1` provides |

After the script reports `Safe restart COMPLETE` and HTTP 401 liveness, the
running PM2 process now has `SAP_WRITE_ENABLED=true` in its env.

### 3.4 Verify writer status

```http
GET /api/sap/writer/status     (with ADMIN Bearer)
```

Required values in response:

```json
{
  "writeEnabled": true,
  "canWrite": true,
  "mode": "LIVE",
  "whitelist": ["TEST_OIG", "Test_Unico"],
  "whitelistConfigured": true,
  "serviceLayerConfigured": true
}
```

Any deviation → STOP, run cleanup phase.

---

## 4. Seed phase

Use a discovery file with **one** real SAP order (smaller blast radius).

```bash
node scripts/seed-qc-ready-run.js \
     --use-real-sap-orders=discovery-test-oig-aggdn-one.json \
     --apply
```

Take note of:

* `RunId=<N>` — required for QC + flush
* `RunOrderIds=<a>[,<b>...]` — required for QC approve

The seed script does its own PM2 stop/start cycle with `store.json` backup.

---

## 5. QC + DRY-RUN sanity (mandatory before LIVE write)

Even though SAP_WRITE_ENABLED is on, run a **dry-run** flush first and
inspect the payload that would be sent to SL. This catches:

* synthetic values leaking through (`TEST-SEED-A1`, `9_900_001+` ranges)
* wrong CompanyDB in the payload
* missing `BaseEntry` / `CardCode`

```http
POST /api/orders/<RunOrderId>/qc-approve     (per RunOrder)
POST /api/runs/<N>/flush-aggregate-docs      (DRY-RUN — no body needed)
```

Inspect `response.dryRunPayloads[0].preview` — verify:

* `BaseEntry` is the real SAP DocEntry (not `9_900_xxx`)
* `CardCode` is the real CardCode (not `TEST-SEED-A1`)
* Lines look reasonable (correct ItemCode + quantity)

If any value looks wrong → STOP, run cleanup. Do not proceed to LIVE.

---

## 6. LIVE test-flush — one call, one run, one DN

```http
POST /api/admin/sap-write/test-flush/<RunId>
Headers: Authorization: Bearer <admin-token>
Body:    { "confirm": "I-UNDERSTAND-THIS-WRITES-TO-SAP" }
```

Wrap this call in **try / finally**. The `finally` block performs DISARM
**regardless** of HTTP outcome (success, 4xx, 5xx, network error, timeout).

### Expected success

```json
{
  "ok": true,
  "source": "test-flush",
  "runId": <N>,
  "result": {
    "deliveryNotes": [{ "DeliveryNoteId": <local>, "DocNumber": "DN-AGG-...",
                        "SapDeliveryDocEntry": <real-from-SAP>,
                        "SapDeliveryDocNum": <real-from-SAP> }],
    "invoicesCreated": [],     // empty when DocPolicy.aggregateInvoice='no'
    "ordersTouched": 1
  }
}
```

### Known failure modes

| HTTP / code | Meaning |
|---|---|
| `401` | Bad token (Auth Preflight should have caught this) |
| `403 NOT_TEST_RUN` | `run.IsTest !== true` — seed didn't tag it or wrong RunId |
| `403 LIVE_WRITE_DISABLED` | `SAP_WRITE_ENABLED !== 'true'` in **process env** (PM2 didn't reload) |
| `400 INVALID_RUN_ID` | URL parameter not a positive integer |
| `400` (no code) | Body confirm string not exact |
| `404 RUN_NOT_FOUND` | RunId not in store |
| `422 UNAPPROVED_ORDERS` | QC step skipped or failed |
| `422 DOC_POLICY_MISSING` | Target customer has no usable DocPolicy |
| `500` with SAP error code | SL rejected (BP not found, base order closed, etc.) |

---

## 7. DISARM phase — **mandatory**, runs in `finally`

Even if step 6 returned success, you DISARM. Even if it threw, you DISARM.

```text
- Remove SAP_WRITE_ENABLED line from backend/.env
- restart-safe.ps1 (so process env drops the var)
- Verify GET /api/sap/writer/status → writeEnabled=false, mode=DRY-RUN
```

**This is not optional.** Leaving `SAP_WRITE_ENABLED=true` between flushes
means any future request that satisfies the other gates (IsTest, whitelist,
adminOnly) could write to SAP.

---

## 8. Cleanup phase

```bash
node scripts/seed-qc-ready-run.js --cleanup
```

Cleanup removes:

* Run + Stops + RunOrders + Waves + WaveLines + WaveAllocations tagged `IsTest=true`
* DeliveryNotes / Invoices linked to seedRunIds or seed CardCode

Cleanup does **not** touch SAP. The LIVE DN written in step 6 persists in
`TEST_OIG` SAP Business One; cancel it manually in B1 Client if you don't
want it to remain.

Restore DocPolicy from the JSON snapshot taken in step 2.

---

## 9. Final verification

```text
- backend/.env: SAP_WRITE_ENABLED absent
- backend/data/store.json: IsTest=true count == 0 across all 9 collections
- DocPolicy for target CardCode restored to pre-arm snapshot
- backend/logs/sap-writes.log: one new entry with mode=LIVE
- PM2 sap-logistics: online, HTTP 401 on /api/auth/me
- SAP B1 Client (manual): the new DN appears in TEST_OIG with the DocEntry
  returned in step 6
```

---

## 10. Hard rules — never violate

1. ❌ **Never** point any DB env var at `SAP_OIG`, `SAP_Unico`, or `SAP_Unico_Eilat`
2. ❌ **Never** add those to `SAP_LIVE_WRITE_DB_WHITELIST`
3. ❌ **Never** guess SAP passwords (account lockout risk)
4. ❌ **Never** use synthetic seed (`TEST-SEED-A1`, `9_900_xxx`) for LIVE write — SAP will reject
5. ❌ **Never** skip Auth Preflight before arming
6. ❌ **Never** skip DISARM
7. ❌ **Never** edit DocPolicy permanently for the test customer — always restore from snapshot
8. ❌ **Never** use plain `pm2 restart` for env changes — always `restart-safe.ps1`

---

## Appendix — file locations

| Path | Role |
|---|---|
| `backend/.env` | env source of truth (single line `SAP_WRITE_ENABLED=true` toggles arm) |
| `scripts/restart-safe.ps1` | the only sanctioned env-reload restart |
| `scripts/seed-qc-ready-run.js` | seed `--apply` / `--cleanup` / `--use-real-sap-orders=<json>` |
| `scripts/discover-test-sap-orders.js` | SL-side read-only discovery (tiered `$expand` fallback) |
| `backend/src/services/sap/writeWhitelist.js` | the gate that protects production DBs |
| `backend/src/demo/sapWriter.js` | `writeDeliveryNote` / `writeInvoice` / dry-run default |
| `backend/src/demo/demoServer.js:3826` | `POST /api/admin/sap-write/test-flush/:runId` endpoint |
| `backend/src/demo/persistentStore.js:3038` | `flushAggregateDocsForRun` — QcApproved + DocPolicy gates |
| `backend/logs/sap-writes.log` | append-only audit of every SL POST attempt |

---

*Last updated: 2026-05-22. See `project_sap_logistics_write_status.md`
in user memory for the history of why each rule exists.*
