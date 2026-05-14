// =====================================================================
// server.js — sandbox HTTP entrypoint
// Express app on 127.0.0.1:<SANDBOX_PORT>. NEVER 0.0.0.0.
// =====================================================================
import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { runAgent, runAgentDef, getRunLog } from './agents/runtime.js';
import { allAgents, listAgents } from './agents/registry.js';
import { getBudgetStatus } from './budget.js';

const app = express();
app.use(express.json({ limit: '128kb' }));

// Per-request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path}`);
  next();
});

// Optional bearer-token gate
function maybeAuth(req, res, next) {
  if (!config.ACCESS_TOKEN) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${config.ACCESS_TOKEN}`) return next();
  return res.status(401).json({ error: 'Sandbox access token required' });
}

// =====================================================================
// Routes
// =====================================================================

// Liveness — no auth required
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sandbox: true,
    bind: '127.0.0.1',
    port: config.PORT,
    mock: config.USE_MOCK,
    model: config.ANTHROPIC_MODEL,
    anthropic_configured: !!config.ANTHROPIC_API_KEY,
  });
});

// List agents
app.get('/sandbox/list-agents', maybeAuth, (_req, res) => {
  res.json({ agents: listAgents() });
});

// Run an agent
// Uses the high-level runAgentDef orchestrator which supports both
// legacy (tools-only) and verified-metrics (preCompute → LLM → postProcess) flows.
app.post('/sandbox/run/:agentName', maybeAuth, async (req, res) => {
  const agent = allAgents[req.params.agentName];
  if (!agent) return res.status(404).json({ error: `Unknown agent: ${req.params.agentName}` });
  try {
    const result = await runAgentDef(agent, req.body || {}, { model: req.body?.model });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Recent runs
app.get('/sandbox/runs', maybeAuth, (_req, res) => {
  res.json({ runs: getRunLog() });
});

// Budget status
app.get('/sandbox/cost-budget', maybeAuth, (_req, res) => {
  res.json(getBudgetStatus());
});

// =====================================================================
// Bind to localhost only
// =====================================================================
const server = app.listen(config.PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  🧪 sap-logistics SANDBOX                                   ║');
  console.log('║                                                              ║');
  console.log(`║  Bound to:        127.0.0.1:${String(config.PORT).padEnd(33)}║`);
  console.log(`║  Mode:            ${(config.USE_MOCK ? 'MOCK (cached JSON)' : 'LIVE (read-only SAP)').padEnd(43)}║`);
  console.log(`║  Model:           ${config.ANTHROPIC_MODEL.padEnd(43)}║`);
  console.log(`║  Access gate:     ${(config.ACCESS_TOKEN ? 'Bearer token required' : 'open on localhost').padEnd(43)}║`);
  console.log(`║  Daily budget:    $${String(config.DAILY_BUDGET_USD).padEnd(43)}║`);
  console.log(`║  Per-run budget:  $${String(config.PER_RUN_BUDGET_USD).padEnd(43)}║`);
  console.log('║                                                              ║');
  console.log('║  Endpoints:                                                  ║');
  console.log('║    GET  /health                                              ║');
  console.log('║    GET  /sandbox/list-agents                                 ║');
  console.log('║    POST /sandbox/run/<agentName>                             ║');
  console.log('║    GET  /sandbox/runs                                        ║');
  console.log('║    GET  /sandbox/cost-budget                                 ║');
  console.log('║                                                              ║');
  console.log('║  ⚠ NOT in PM2. Closes when this terminal exits.             ║');
  console.log('║  ⚠ Read-only. Refuses any tool without is_read_only:true.   ║');
  console.log('║  ⚠ Localhost-only. Cloudflare tunnel cannot reach this.     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
function shutdown(sig) {
  console.log(`\n[${sig}] shutting down sandbox...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
