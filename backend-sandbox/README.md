# sap-logistics — AI Sandbox

Isolated runtime for AI/LLM experiments. **Never reaches production.**

## Quick start

```powershell
cd "C:\Users\izik\OneDrive - OIG\שולחן העבודה\cowork\sap-logistics-hub\backend-sandbox"

# 1. Install deps (one-time)
npm install

# 2. Configure
copy .env.sandbox.example .env.sandbox
# Edit .env.sandbox: set SANDBOX_JWT_SECRET (64-char random) and ANTHROPIC_API_KEY

# 3. Run
node server.js
# Banner appears; sandbox is on http://localhost:4101
```

## Smoke test

```powershell
curl http://localhost:4101/health
curl http://localhost:4101/sandbox/list-agents
curl -X POST http://localhost:4101/sandbox/run/ceoBrief -H "Content-Type: application/json" -d "{}"
curl http://localhost:4101/sandbox/cost-budget
```

## Stop

`Ctrl+C` in the terminal. Process exits cleanly. No state to clean up.

## Full operator runbook

See `docs/architecture-review/sandbox-runbook.md`.

## Isolation guarantees

- Bound to `127.0.0.1` (NOT `0.0.0.0`) — Cloudflare tunnel cannot reach.
- Different `JWT_SECRET` from production — tokens never interchangeable.
- Tool loader refuses any tool without `is_read_only: true`.
- No imports from `backend/src/` — no SAP write paths.
- No PM2 entry — exits when the terminal closes.
- Hardcoded budget ceiling: $5/day, $0.50/run.

## NEVER do

- Add a write tool here. The loader will refuse, but don't try.
- Set `SAP_WRITE_ENABLED=true` in `.env.sandbox`. The config loader will refuse to start.
- Add to PM2.
- Bind to `0.0.0.0`.
- Reuse production `JWT_SECRET` or production `.env`.
- Connect to the Cloudflare tunnel.

See `docs/architecture-review/ai-sandbox-plan.md` for the design rationale.
