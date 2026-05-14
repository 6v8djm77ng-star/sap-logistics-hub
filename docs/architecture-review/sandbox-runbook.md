# Sandbox Runbook

**Audience:** the operator running the AI sandbox locally for experiments.
**Companion docs:** `ai-sandbox-plan.md` (design), `backend-sandbox/README.md` (quick start).

This runbook covers everything between "Claude built the skeleton" and "I have an experiment running".

---

## 1. What's already built (Claude — Task 3)

```
sap-logistics-hub/
└── backend-sandbox/
    ├── README.md                      # quick reference
    ├── package.json                   # deps: express, jwt, anthropic, zod
    ├── .env.sandbox.example           # template — copy to .env.sandbox
    ├── config.js                      # env loader + forbidden-flag checks
    ├── budget.js                      # in-memory cost ceiling
    ├── server.js                      # Express on 127.0.0.1:4101
    ├── agents/
    │   ├── runtime.js                 # tool-use loop with is_read_only enforcement
    │   ├── registry.js                # 4 agents: ceoBrief, anomalySummary, reportExplainer, salesInsights
    │   └── tools/
    │       ├── financialReadOnly.js   # get_daily_sales, get_top_customers, get_top_items, get_dead_stock
    │       └── analyticsReadOnly.js   # get_anomalies_summary, get_run_details, get_failure_breakdown
    └── mock-data/
        ├── daily-sales.json           # 8-day mock revenue series
        ├── top-customers.json         # 10 mock customers
        ├── top-items.json             # 7 mock items (DAVO + Tineco + Novo)
        ├── dead-stock.json            # 3 mock dead-stock items
        ├── anomalies.json             # 4 mock anomalies (4 types)
        ├── runs.json                  # 1 mock run with 3 stops
        └── failures.json              # 12 mock failures by reason code
```

All file paths relative to `sap-logistics-hub/`.

---

## 2. What's still manual (operator)

### 2.1 One-time setup

```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend-sandbox"

# A. Install dependencies (~30 seconds)
npm install
# Expect: 4 deps + transitive; no warnings about deprecated packages worth fixing

# B. Configure environment
Copy-Item .env.sandbox.example .env.sandbox

# C. Generate a sandbox-specific JWT secret (DIFFERENT from production)
$secret = node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
Write-Host "Generated secret: $secret"
# Edit .env.sandbox; replace the placeholder SANDBOX_JWT_SECRET with $secret

# D. Add Anthropic API key (optional but expected for real experiments)
# In .env.sandbox: ANTHROPIC_API_KEY=sk-ant-...
# RECOMMENDED: create a separate sub-key in the Anthropic console with a
# "sandbox" tag so spend is billed separately.
```

### 2.2 Per-session startup

```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend-sandbox"
node server.js
```

You'll see a banner like:
```
╔════════════════════════════════════════════════════════════╗
║  🧪 sap-logistics SANDBOX                                   ║
║  Bound to:        127.0.0.1:4101                            ║
║  Mode:            MOCK (cached JSON)                        ║
║  Model:           claude-haiku-4-5                          ║
║  Daily budget:    $5                                        ║
║  ⚠ NOT in PM2. Closes when this terminal exits.            ║
╚════════════════════════════════════════════════════════════╝
```

### 2.3 Stop

`Ctrl+C` in the terminal. Process exits cleanly within ~5 seconds. No state to clean up.

---

## 3. Smoke test (verify everything works)

In a separate PowerShell window (sandbox keeps running in the first):

```powershell
# A. /health — sanity
curl -s http://localhost:4101/health
# Expect: {"ok":true,"sandbox":true,"bind":"127.0.0.1","port":4101,"mock":true,...}

# B. List agents
curl -s http://localhost:4101/sandbox/list-agents
# Expect: 4 agents listed (ceoBrief, anomalySummary, reportExplainer, salesInsights)

# C. Budget status
curl -s http://localhost:4101/sandbox/cost-budget
# Expect: spent_today_usd=0, daily_ceiling_usd=5, runs_today=0

# D. Run an agent (mock mode — no Anthropic call)
# If ANTHROPIC_API_KEY is unset, you'll get a {_mock: true, ...} response
curl -s -X POST http://localhost:4101/sandbox/run/ceoBrief `
  -H "Content-Type: application/json" -d "{}"

# E. With ANTHROPIC_API_KEY set, the same call should produce a real Hebrew brief
# Expect: { "runId":"sb-...", "output": {...}, "tokensIn": ..., "costUsd": ... }

# F. Inspect run history
curl -s http://localhost:4101/sandbox/runs

# G. Confirm budget is incrementing
curl -s http://localhost:4101/sandbox/cost-budget
# Expect: spent_today_usd > 0, runs_today > 0
```

**If the smoke test fails, see §6 troubleshooting.**

---

## 4. Setup checklist

```text
☐ Node.js 20+ installed (node --version)
☐ backend-sandbox/ directory exists with files per §1
☐ npm install ran successfully (node_modules/ exists, no errors)
☐ .env.sandbox copied from .env.sandbox.example
☐ SANDBOX_JWT_SECRET set to ≥32 chars random (NOT the placeholder)
☐ ANTHROPIC_API_KEY set (or knowingly left blank for mock-only mode)
☐ ANTHROPIC_MODEL is the cheap one (claude-haiku-4-5) for first experiments
☐ SANDBOX_USE_MOCK=true (default; never live SAP from sandbox initially)
☐ SANDBOX_DAILY_BUDGET_USD=5 (default; raise only after observing real costs)
☐ SAP_WRITE_ENABLED is NOT in .env.sandbox (config.js refuses to start otherwise)
☐ Server starts; banner displays
☐ /health returns 200
☐ /sandbox/list-agents returns 4 agents
☐ At least one agent run completes (mock or real)
☐ /sandbox/cost-budget reflects the spend
☐ Production sap-logistics on port 4000 still healthy
☐ pm2 list shows no new entries (sandbox is NOT in PM2)
☐ Public Cloudflare URL returns nothing on port 4101 (sandbox is localhost-only)
```

---

## 5. Mock data backfill (optional, when you want real outputs)

The skeleton ships with synthetic mock data. For more realistic experiments:

### 5.1 Get a real-looking sample (read-only against SAP)

Run a one-shot snapshot script (operator writes; not shipped):

```powershell
# Example pattern — adapt to your SAP credentials
$out = "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend-sandbox\mock-data"

# Daily sales for last 30 days
sqlcmd -S <SAP_SQL_HOST> -U <user> -P <pass> -d <SAP_SQL_DB_A> -Q `
  "SELECT CAST(DocDate AS DATE) AS date, SUM(DocTotal) AS revenue_ils, COUNT(*) AS orders_count
   FROM OINV WHERE DocDate >= DATEADD(day, -30, GETDATE())
   GROUP BY CAST(DocDate AS DATE) ORDER BY 1" -h -1 -W -s "," |
  ConvertTo-Json | Set-Content "$out\daily-sales.real.json"

# Then update the tool loader to prefer *.real.json if present, OR just
# rename daily-sales.real.json → daily-sales.json after sanity check.
```

`*.real.json` is gitignored (per the .gitignore update Claude added) so live customer data never reaches git.

### 5.2 Switch to live SAP (advanced — only for validation)

After mock-mode experiments work end-to-end, optionally test against live SAP:

```powershell
# In .env.sandbox:
SANDBOX_USE_MOCK=false
SAP_SQL_HOST=...
SAP_SQL_USER=...
SAP_SQL_PASSWORD=...
SAP_SQL_DB_A=...
SAP_SQL_DB_B=...
SAP_SQL_ENCRYPT=true
SAP_SQL_TRUST_SERVER_CERT=true
```

The skeleton's tool handlers throw `'Live SAP read not implemented'` when `USE_MOCK=false` — **operator must add the mssql query code** before this works. Intentional: forces explicit awareness of the credentials being used.

---

## 6. Troubleshooting

### 6.1 `FATAL: .env.sandbox not found`
You skipped step 2.1.B. Run `Copy-Item .env.sandbox.example .env.sandbox` and edit.

### 6.2 `FATAL: SANDBOX_JWT_SECRET must be at least 32 characters`
You left the placeholder. Generate a real secret:
```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

### 6.3 `FATAL: env var SAP_WRITE_ENABLED is set in sandbox env`
Someone copy-pasted production env into sandbox. **Remove `SAP_WRITE_ENABLED` and `SAP_SERVICE_LAYER_URL` from `.env.sandbox` immediately.** This guard exists exactly to prevent sandbox from accidentally writing to SAP.

### 6.4 `SANDBOX REFUSED tool "..." : is_read_only must be explicitly true`
Someone tried to register a write tool. **Don't.** Sandbox is read-only by design. If your experiment genuinely needs writes, it doesn't belong in sandbox — design a Wave-style production patch instead.

### 6.5 `Sandbox per-run budget exceeded`
Your prompt + tools generated more output than the $0.50 per-run cap. Either:
- Raise `SANDBOX_PER_RUN_BUDGET_USD` in `.env.sandbox`
- Reduce `SANDBOX_MAX_TOKENS_OUT`
- Switch to `claude-haiku-4-5` (cheapest)
- Trim the system prompt

### 6.6 `Sandbox daily budget exceeded`
You've spent $5+ today. Either wait until tomorrow OR raise `SANDBOX_DAILY_BUDGET_USD` (recommended ceiling: $20/day during active experimentation).

### 6.7 Agent returns `{_mock: true, message: "ANTHROPIC_API_KEY not set..."}`
You haven't set the API key. Add to `.env.sandbox`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
Restart the sandbox.

### 6.8 Tool returns `{_mock_missing: true, file: "...", hint: "..."}`
The mock JSON file doesn't exist. Either create it OR pick a different agent that doesn't need that file.

### 6.9 Port 4101 already in use
Either another process is using it, OR you have a stuck sandbox instance. `Get-NetTCPConnection -LocalPort 4101` to find the pid; `Stop-Process -Id <pid>` to kill.

---

## 7. Risk notes

### 7.1 What the sandbox CAN'T do
- Read or write production database
- Send SMS / email
- POST to SAP Service Layer
- Be reached from the internet (bound to 127.0.0.1)
- Persist state outside `backend-sandbox/`
- Auto-trigger on a schedule
- Affect PM2 daemon health

### 7.2 What the sandbox CAN do (within its boundary)
- Spend Anthropic API credit (capped by daily/per-run budget)
- Read mock JSON
- Read live SAP (read-only) IF `SANDBOX_USE_MOCK=false` AND operator wires the live query code
- Write to its own log (none configured by default; output is stdout)

### 7.3 Things to watch
- **Anthropic API key in .env.sandbox** — if leaked, attacker can spend your Anthropic credit. Same risk as production. Treat .env.sandbox like any other secret.
- **`mock-data/*.real.json` (when operator backfills)** — may contain real customer PII. Gitignored but exists on disk; back up/delete responsibly.
- **Sandbox process running for hours** — it consumes RAM (~50 MB) but no CPU when idle. Safe to leave running during experimentation.
- **Anthropic rate limits** — separate from cost. Heavy testing may hit Anthropic's per-key per-minute limits. Slow down, don't bypass.

---

## 8. Rollback / removal procedure

### 8.1 Pause sandbox temporarily
`Ctrl+C` in the sandbox terminal. Done. Nothing else needed.

### 8.2 Remove sandbox entirely
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"

# Confirm sandbox not in PM2
pm2 list   # should NOT show backend-sandbox; confirms isolation

# Confirm production sap-logistics still healthy (sanity)
curl -s http://localhost:4000/health

# Stop sandbox process if running
$sandbox_pid = (Get-NetTCPConnection -LocalPort 4101 -State Listen -EA SilentlyContinue).OwningProcess
if ($sandbox_pid) { Stop-Process -Id $sandbox_pid -Force }

# Remove the directory
Remove-Item -Recurse -Force backend-sandbox

# Update .gitignore — remove the backend-sandbox/* lines (optional cleanup)

# Commit removal
git add -A
git commit -m "Remove AI sandbox skeleton"
```

**Production sap-logistics is unaffected by sandbox removal.** Sandbox has no production coupling.

### 8.3 If sandbox somehow contaminated production
This shouldn't happen given the isolation guarantees, but if it does:
- The Wave A rollback path applies (`git revert ae18787; pm2 restart sap-logistics`)
- See `wave-a-observation-window.md` §5.2

---

## 9. Before any future production AI rollout

The sandbox is for experimentation, NOT for production deployment. To graduate an experiment to production:

```text
☐ ≥10 successful sandbox runs of the experiment over ≥7 days
☐ Output validated by domain expert (CEO / sales / operations)
☐ Per-run cost <$1 even with full live data
☐ Tool surface review (no writes, no PII leakage in outputs)
☐ aiCostGuard real implementation lands in production (currently Phase-1 stub per security-reaudit.md F12)
☐ Production ownership defined (who responds when the agent misbehaves at 3 AM?)
☐ Rollout plan: gradual (e.g., daily summary email to one person → small group → full team)
☐ Stakeholder sign-off in cowork/INCIDENTS.md
☐ NEVER as a Phase-0 change. Production AI is a post-cutover decision.
```

If any of these is missing, the experiment stays in sandbox.

---

## 10. Document references

- `ai-sandbox-plan.md` — design rationale + boundary definitions
- `freeze-policy.md` §1.2 — production AI is forbidden during freeze
- `deploy-discipline.md` — applies to sandbox file changes if they ever reach git
- `security-reaudit.md` F12 — production aiCostGuard status
- `recommendations.md` Tier 0 D5 — production AI cost-cap roadmap
- `backend-sandbox/README.md` — quick reference

End of sandbox runbook.
