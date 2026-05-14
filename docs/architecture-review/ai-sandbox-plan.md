# AI Sandbox Plan — Read-Only Design

**Status:** DESIGN ONLY. No code created by this document.
**Goal:** define a safe, isolated runtime where AI/LLM experiments can run without touching production.
**Why now:** the freeze policy + Wave A observation window forbid putting new agents/workers into production. But the team will want to experiment with LLM features (CEO Brief variants, anomaly summarization, sales insights) — they need a sanctioned playground that doesn't risk operational stability.

This document is a design spec. Build is operator-scoped, post-Phase-0.

---

## 1. Core principles

| Principle | Why |
|---|---|
| **Isolated process** | Lives on a different port (4101 / 4201). Cannot be reached from cf-tunnel. Cannot accidentally serve production traffic. |
| **Read-only against SAP** | No write tools exposed to the model. No `services/sap/serviceLayer.js POST` paths. SAP_WRITE_ENABLED stays UNSET. |
| **Mock adapters where possible** | Cached SAP-query responses, mock store.json, mock SMTP/SMS. The sandbox should NOT need a live external dependency. |
| **No autonomous scheduling** | No node-cron, no setInterval. Every run is manually triggered (HTTP POST or CLI). Removes "runaway agent" risk. |
| **No production coupling** | Sandbox does not write to `backend/data/store.json`. Does not share Logistics SQL pool. Does not share JWT_SECRET (uses its own). |
| **Bounded cost** | Hardcoded daily $ ceiling enforced at runtime. Aborts agent loops above ceiling. (Real `aiCostGuard` is Phase-1 stub per `security-reaudit.md` F12 — sandbox version is a SIMPLE counter, not the production guard.) |
| **Reversibility** | Stop the sandbox process → no residue. No persistent state in production locations. |

---

## 2. Runtime topology

```
                                                  ┌──────────────────────┐
                                                  │  AI Sandbox Process  │
                                                  │  PORT=4101           │
                                                  │  cwd: backend-sandbox│
                                                  │  (separate dir)      │
                                                  ├──────────────────────┤
                  read-only HTTP                  │  Express app         │
   ┌─────────────────────────────────────────────►│  (sandbox routes:    │
   │                                              │   POST /sandbox/run/ │
   │                                              │     <agent-name>)    │
   │                                              ├──────────────────────┤
   │  Operator desktop                            │  agents/ (port from  │
   │  (browser, curl, Postman)                    │   prod backend/src/  │
   │                                              │   agents/)           │
   │                                              ├──────────────────────┤
   │  /sandbox/list-agents                        │  tools/ (READ-ONLY   │
   │  /sandbox/run/ceoBrief                       │   subset of prod     │
   │  /sandbox/run/anomalySummary                 │   financialTools.js) │
   │  /sandbox/run/reportExplainer                ├──────────────────────┤
   │  /sandbox/run/salesInsights                  │  Anthropic SDK       │
   │                                              │  (separate API key)  │
   │                                              └──────┬───────────────┘
   │                                                     │
   │                                                     ▼
   │                                          ┌────────────────────────┐
   │                                          │  Mock SAP adapter      │
   │                                          │  (returns cached JSON  │
   │                                          │   from disk OR live    │
   │                                          │   read-only mssql to   │
   │                                          │   SAP — operator       │
   │                                          │   choice per launch)   │
   │                                          └────────────────────────┘
   │
   │  Production sap-logistics on port 4000 — UNTOUCHED.
   │  Cloudflare tunnel — UNTOUCHED.
   │  store.json — UNTOUCHED.
   ▼
```

**Key isolation guarantees:**
- Different port (4101 / 4201) — cf-tunnel routes to 4000 only
- Different cwd (e.g., `backend-sandbox/` parallel to `backend/`)
- Different env file (`.env.sandbox` with sandbox-only `JWT_SECRET`, `ANTHROPIC_API_KEY` if separate, no SAP_SQL credentials initially)
- No PM2 entry — manual `node` invocation; dies when operator closes terminal
- No `cron`, no `setInterval` schedulers wired up

---

## 3. Sandbox routes

A small Express app exposing 3-4 endpoints. The model never reaches production routes.

### 3.1 `GET /sandbox/list-agents`
Returns a list of available sandbox agents and their last-run metadata.

```json
{
  "agents": [
    {
      "name": "ceoBrief",
      "description": "Daily CEO summary from cached SAP data",
      "tools": ["get_daily_sales", "get_top_customers", "get_dead_stock"],
      "estimated_cost_per_run_usd": 0.05,
      "last_run_at": "2026-05-15T10:00:00Z"
    },
    { "name": "anomalySummary", ... },
    { "name": "reportExplainer", ... },
    { "name": "salesInsights", ... }
  ]
}
```

### 3.2 `POST /sandbox/run/<agent-name>`
Triggers an agent. Synchronous — blocks until complete.

Request body:
```json
{
  "input": "<free-form context the agent uses>",
  "max_tool_calls": 5,
  "max_tokens_out": 2000,
  "model": "claude-sonnet-4-5"
}
```

Response body:
```json
{
  "run_id": "sb-2026-05-15-001",
  "status": "completed",
  "output": { "executive_summary": "...", "metrics": [...] },
  "tool_calls": [
    { "name": "get_daily_sales", "input": {...}, "output": {...}, "duration_ms": 423 }
  ],
  "tokens_in": 1200,
  "tokens_out": 850,
  "cost_usd": 0.0145,
  "duration_ms": 5400
}
```

### 3.3 `GET /sandbox/runs`
Returns recent sandbox-run history (in-memory, last 50 runs). Operator can review what the model did.

### 3.4 `GET /sandbox/cost-budget`
Returns current sandbox spend vs daily ceiling.
```json
{ "spent_today_usd": 1.23, "ceiling_usd": 5.00, "runs_today": 18 }
```

---

## 4. Read-only tools only

The sandbox's tool registry is a strict subset of `backend/src/agents/tools/financialTools.js`:

### 4.1 Allowed (read-only)
- `get_daily_sales(date_from, date_to)` — wraps mock or live SAP read
- `get_top_customers(days, limit)`
- `get_top_items(days, limit)`
- `get_margin_by_item(days, limit)`
- `get_dead_stock(days_threshold)`
- `get_open_orders_count()`
- `get_stop_completion_rate(days)`
- (Future) `get_anomalies_summary(days)` — wrap demoServer's `/api/analytics/anomalies` data
- (Future) `get_failure_breakdown(days)`

### 4.2 Forbidden in sandbox (NEVER expose to model)
- Any `services/sap/serviceLayer.js` POST/PATCH/DELETE method
- `services/deliveryNotes.js`, `services/returnRequests.js` (write paths)
- `db/logisticsDb.js` write helpers (`execute`, `transaction`)
- `services/notifications.js` send methods (would email/SMS real recipients)
- `services/customerComms.js` send methods
- File-system writes outside sandbox's own log directory

### 4.3 Tool definition pattern
Each sandbox tool has:
```js
{
  name: 'get_daily_sales',
  description: 'Returns sales totals for the date range. Read-only.',
  input_schema: { /* JSON Schema */ },
  handler: async (input) => {
    // 1. Validate input (zod)
    // 2. Call mock or live read function — NO writes
    // 3. Return JSON-serializable result
    // 4. Errors propagate as { is_error: true, error: "..." }
  },
  // Sandbox-specific guard:
  is_read_only: true   // explicit; refuse to load tools without this flag
}
```

A loader-time check refuses any tool registration without `is_read_only: true`. Defense-in-depth against accidentally exposing a write method.

---

## 5. Mock adapters

### 5.1 Why mock first
Real SAP reads cost connection slots and may surprise the SAP server with unusual query patterns from experimental prompts. Initial sandbox runs should use cached data.

### 5.2 Mock SAP data
Snapshot real SAP query responses once, save to `backend-sandbox/mock-data/`:
- `mock-data/daily-sales.json`
- `mock-data/top-customers-90d.json`
- `mock-data/top-items-90d.json`
- `mock-data/dead-stock.json`
- `mock-data/anomalies.json`

Tool handlers check `process.env.SANDBOX_USE_MOCK === 'true'` and return mock JSON if set.

### 5.3 Mode toggle
| Mode | When | How |
|---|---|---|
| **mock** (default) | Most experiments; UI testing; prompt iteration | `SANDBOX_USE_MOCK=true` |
| **live read-only** | When operator wants real-data validation, with budget awareness | `SANDBOX_USE_MOCK=false` and connection params present |

---

## 6. Cost ceiling

### 6.1 Hardcoded budget
```js
const SANDBOX_DAILY_BUDGET_USD = 5.00;
const SANDBOX_PER_RUN_BUDGET_USD = 0.50;
let spentToday = 0;
let lastResetDate = new Date().toDateString();

function checkBudget(estimatedCost) {
  const today = new Date().toDateString();
  if (today !== lastResetDate) { spentToday = 0; lastResetDate = today; }
  if (spentToday + estimatedCost > SANDBOX_DAILY_BUDGET_USD) {
    throw new Error(`Sandbox daily budget exceeded ($${spentToday.toFixed(2)} of $${SANDBOX_DAILY_BUDGET_USD})`);
  }
  if (estimatedCost > SANDBOX_PER_RUN_BUDGET_USD) {
    throw new Error(`Single-run budget exceeded ($${estimatedCost.toFixed(2)} > $${SANDBOX_PER_RUN_BUDGET_USD})`);
  }
}
```

### 6.2 Pre-run cost estimation
Before each tool-loop iteration, estimate cost from token usage so far + projected remaining (max_tokens_out × output price). If estimate > budget, abort.

### 6.3 Monitoring
- `GET /sandbox/cost-budget` returns current state
- Daily reset at process restart OR on date change

### 6.4 Why not use the production `aiCostGuard`?
Per `security-reaudit.md` F12, production `aiCostGuard` is a Phase-1 no-op stub. The sandbox should not import that stub (avoid coupling). Sandbox uses a simple counter — appropriate for a single experimental process.

---

## 7. Suggested first experiments

In order of safety/value:

### 7.1 CEO Brief summarizer (port of existing agent)
**Goal:** validate the existing `agents/ceoBrief.js` code path runs cleanly in sandbox.
**Tools used:** get_daily_sales, get_top_customers, get_top_items, get_margin_by_item.
**Risk:** very low. This agent already exists in production; sandbox is just running it under different env.
**Success metric:** output JSON matches schema; cost <$0.10/run.

### 7.2 Anomaly summarizer
**Goal:** take the raw `/api/analytics/anomalies` payload (~42 KB JSON in demoServer) and produce a 5-bullet executive narrative.
**Tools used:** get_anomalies_summary (mock returns cached anomalies blob).
**Risk:** low. Pure summarization; no decisions, no writes.
**Success metric:** narrative cites at least 3 anomalies by name; no fabricated metrics.

### 7.3 Report explainer
**Goal:** take a generated PDF manifest's underlying JSON data + ask the model to explain anomalies in plain Hebrew.
**Tools used:** get_run_details (mock), get_failure_breakdown.
**Risk:** low. Read-only; output goes to operator.
**Success metric:** explanation matches data; no hallucinations.

### 7.4 Sales insights assistant
**Goal:** "what changed week-over-week in DAVO mix?" — model uses get_top_items + get_margin_by_item to produce a comparison.
**Tools used:** read-only DAVO mix tools.
**Risk:** medium. The model may invent trends if data is sparse. Watch for hallucination.
**Success metric:** insights cite specific data points; no metrics absent from the input.

### 7.5 Future (NOT in first pass)
- Driver-leaderboard narrative
- Customer churn predictor (requires more data plumbing)
- Anything that requires writing back to the system — explicitly OUT OF SCOPE for sandbox

---

## 8. What sandbox is NOT

| Not | Why |
|---|---|
| A path to production AI features | Production AI deployment requires `aiCostGuard` enforcement + ownership review + rollout plan |
| A way to bypass the freeze | Sandbox runs only on operator's manual trigger; doesn't deploy anywhere |
| A debugging tool for production agents | Production agents have their own runs/logs; sandbox is for new agent design |
| Authoritative data | Sandbox uses mock data unless explicitly switched to live; outputs are experimental, not for decision-making |
| A monitoring system | Doesn't observe production; doesn't ingest live events |

---

## 9. Setup steps (for the operator, when ready)

NOT NOW — this is post-Phase-0 work. Listed for completeness.

### 9.1 Directory layout
```
sap-logistics-hub/
├── backend/                    # PRODUCTION — untouched
└── backend-sandbox/            # NEW — parallel to backend/
    ├── package.json            # minimal deps: express, jwt, anthropic
    ├── .env.sandbox            # SANDBOX_DAILY_BUDGET_USD, SANDBOX_USE_MOCK,
    │                           # ANTHROPIC_API_KEY (separate from prod)
    ├── server.js               # sandbox Express app
    ├── agents/
    │   ├── runtime.js          # adapted from prod runtime, with budget gate
    │   ├── ceoBrief.js         # ported (read-only tools)
    │   ├── anomalySummary.js   # new
    │   └── tools/
    │       ├── financialReadOnly.js
    │       └── analyticsReadOnly.js
    └── mock-data/
        ├── daily-sales.json
        └── ...
```

### 9.2 Setup commands
```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub"

mkdir backend-sandbox
cd backend-sandbox
npm init -y
npm install express @anthropic-ai/sdk jsonwebtoken zod

# Copy + adapt agents/ from backend/src/agents/
# Create mock-data/ from production SAP query snapshots

# Create .env.sandbox (NOT in git):
# SANDBOX_DAILY_BUDGET_USD=5.00
# SANDBOX_PER_RUN_BUDGET_USD=0.50
# SANDBOX_USE_MOCK=true
# JWT_SECRET=<a-fresh-secret-for-sandbox-only>
# ANTHROPIC_API_KEY=<sandbox-key, ideally separate billing tag>
# DEMO_PORT=4101

# Add to .gitignore:
echo "backend-sandbox/.env.sandbox" >> .gitignore
echo "backend-sandbox/mock-data/" >> .gitignore  # if mocks contain PII
```

### 9.3 Run + test
```powershell
cd backend-sandbox
node server.js
# Browser: http://localhost:4101/sandbox/list-agents
# curl: POST http://localhost:4101/sandbox/run/ceoBrief
```

### 9.4 Stop
```powershell
# Ctrl+C in terminal. Process exits cleanly.
# No state to clean up; mock data + .env.sandbox stay on disk.
```

---

## 10. Security boundary

### 10.1 Network boundary
- PORT 4101 (or 4201) bound to 127.0.0.1 only — NOT 0.0.0.0
- Cannot be reached from LAN unless explicitly enabled
- cf-tunnel only routes to port 4000 — sandbox never exposed

### 10.2 Authentication
- Sandbox routes can be wide-open on localhost (single-operator host) OR gated by sandbox-specific bearer token (set via `.env.sandbox SANDBOX_TOKEN`)
- Sandbox JWT_SECRET is DIFFERENT from production — sandbox tokens cannot be used against production routes

### 10.3 Tool boundary
- Tool loader refuses tools without `is_read_only: true`
- Tools never call `db/logisticsDb.js write helpers` (`execute`, `transaction`) — separate `dbReadOnly.js` wrapper that only exposes `query`/`queryOne`
- No filesystem write paths exposed to model

### 10.4 Cost boundary
- Hardcoded $5/day ceiling
- Single-run $0.50 ceiling
- Each tool-loop iteration checks budget before proceeding

### 10.5 Process boundary
- Not in PM2 → not auto-restarted on crash
- Operator-supervised → if it misbehaves, Ctrl+C
- No persistent state outside `backend-sandbox/` directory

---

## 11. When sandbox graduates to production

A sandbox experiment becomes a production candidate when:
- ≥10 successful sandbox runs over ≥7 days
- Output validated by domain expert (CEO / sales / operations)
- Cost ceiling per-run < $1 even with full live data
- Tool surface review (no writes, no PII leakage)
- `aiCostGuard` real implementation lands in production (Phase 6+)
- Stakeholder sign-off in `INCIDENTS.md`

Until ALL of those are true, the experiment stays in sandbox.

---

## 12. Out of scope

- Real-time inference / streaming responses
- Multi-tenant sandbox (one operator, one process)
- GUI / web dashboard for sandbox runs (curl + JSON is fine for experiments)
- Agent-to-agent orchestration (single agent per run)
- Long-running background agents (synchronous request/response only)

---

## 13. Document references

- `freeze-policy.md` §1.2 — confirms no AI/forecasting work in production during freeze; this sandbox plan is the explicitly-allowed alternative
- `deploy-discipline.md` §11 — anti-patterns sandbox helps avoid
- `production-monitoring-plan.md` — monitoring doesn't extend to sandbox (separate concern)
- `recommendations.md` Tier 0 D5 — `aiCostGuard` real implementation deferred; sandbox uses simple counter
- `security-reaudit.md` F12 — `aiCostGuard` Phase-1 stub status

End of AI sandbox plan.
