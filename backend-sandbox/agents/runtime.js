// =====================================================================
// runtime.js — sandbox agent runtime
// Synchronous tool-use loop. No autonomous scheduling, no background
// execution, no production coupling.
//
// Adapted from backend/src/agents/runtime.js but with these differences:
//   - No DB persistence of agent runs (in-memory log instead)
//   - Hard cost ceiling per request (budget.js)
//   - Tool-loader rejects tools without is_read_only:true
//   - Refuses to start if Anthropic key missing AND USE_MOCK=false
// =====================================================================
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { checkBudgetForRun, recordSpend } from '../budget.js';

// Pricing per million tokens (USD). Same numbers as backend/src/agents/runtime.js.
const PRICING = {
  'claude-sonnet-4-5':   { in: 3.00,  out: 15.00 },
  'claude-opus-4-5':     { in: 15.00, out: 75.00 },
  'claude-haiku-4-5':    { in: 1.00,  out: 5.00 },
  default:               { in: 3.00,  out: 15.00 },
};

function priceFor(model) {
  for (const key of Object.keys(PRICING)) {
    if (key !== 'default' && model.startsWith(key)) return PRICING[key];
  }
  return PRICING.default;
}

let _client = null;
function client() {
  if (!_client) {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set in .env.sandbox');
    }
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

// In-memory run log (last N runs); reset on process restart
const _runLog = [];
const RUN_LOG_MAX = 50;

function addRun(record) {
  _runLog.unshift(record);
  if (_runLog.length > RUN_LOG_MAX) _runLog.length = RUN_LOG_MAX;
}

export function getRunLog() {
  return _runLog;
}

// =====================================================================
// Tool-loader guard — refuses tools without is_read_only:true
// =====================================================================
function validateTools(tools) {
  for (const t of tools) {
    if (!t.name || !t.description || !t.input_schema || typeof t.handler !== 'function') {
      throw new Error(`Tool registration invalid: ${JSON.stringify(t)}`);
    }
    if (t.is_read_only !== true) {
      throw new Error(
        `SANDBOX REFUSED tool "${t.name}": is_read_only must be explicitly true. ` +
        `If you genuinely need a write tool, you're in the wrong runtime.`
      );
    }
  }
}

// =====================================================================
// runAgentDef — high-level orchestrator (preCompute → LLM → postProcess)
//
// Use this entry point instead of runAgent() directly. It supports both:
//   - Legacy agents (no preCompute): tools-only flow, same as Experiment 1
//   - Verified-metrics agents (with preCompute): deterministic numbers
//     are computed BEFORE the LLM is called; LLM only narrates.
//
// See docs/architecture-review/verified-metrics-architecture.md
// =====================================================================
export async function runAgentDef(agent, input, options = {}) {
  // ---------------------------------------------------------------
  // 1. Deterministic pre-computation (if agent supports it)
  // ---------------------------------------------------------------
  let verified = null;
  if (typeof agent.preCompute === 'function') {
    try {
      verified = await agent.preCompute(input);
    } catch (err) {
      return {
        status: 'precompute_error',
        error: err.message,
        output: null,
      };
    }
    // Fail closed on validation errors
    if (verified && Array.isArray(verified.errors) && verified.errors.length > 0) {
      return {
        status: 'validation_error',
        errors: verified.errors,
        warnings: verified.warnings || [],
        meta: verified.meta || null,
        output: null,
      };
    }
  }

  // ---------------------------------------------------------------
  // 2. Build user message (agent-specific, may consume `verified`)
  // ---------------------------------------------------------------
  const userMessage = (typeof agent.buildUserMessage === 'function')
    ? agent.buildUserMessage(input || {}, verified)
    : (input?.userMessage || '');

  // ---------------------------------------------------------------
  // 3. Call LLM via the existing low-level runAgent
  // ---------------------------------------------------------------
  const llmResult = await runAgent({
    agentName: agent.name,
    systemPrompt: agent.systemPrompt,
    userMessage,
    tools: agent.tools || [],
    submitTool: agent.submitTool || undefined,
    model: options.model || input?.model,
    // Per-agent override of MAX_TOKENS_OUT (Experiment 3 F1 — reportExplainer
    // hit the 2000-token ceiling consistently in the prior live validation).
    // Falls back to config.MAX_TOKENS_OUT when unset.
    maxTokensOut: agent.maxTokensOut,
  });

  // ---------------------------------------------------------------
  // 4. Post-process (agent-specific; can inject verified, validate refs)
  // ---------------------------------------------------------------
  let finalOutput = llmResult.output;
  if (typeof agent.postProcess === 'function' && llmResult.status !== 'mock_mode') {
    try {
      finalOutput = agent.postProcess(llmResult.output, verified);
    } catch (err) {
      return {
        ...llmResult,
        status: 'postprocess_error',
        error: err.message,
        output: llmResult.output,  // expose raw LLM output for debugging
      };
    }
  } else if (llmResult.status === 'mock_mode' && verified) {
    // In mock mode, surface the verified metrics so the operator can
    // inspect the deterministic layer even without an Anthropic key.
    finalOutput = {
      _mock: true,
      message: llmResult.output?.message || 'no LLM call',
      verified_metrics: verified.metrics,
      verified_anomalies: verified.anomalies,
      verified_warnings: verified.warnings,
      verified_meta: verified.meta,
    };
  }

  return {
    ...llmResult,
    output: finalOutput,
  };
}

// =====================================================================
// runAgent — low-level Anthropic tool-use loop (used by runAgentDef)
// =====================================================================
/**
 * @param {object} opts
 * @param {string} opts.agentName
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {Array}  opts.tools           — each MUST have is_read_only:true
 * @param {object} [opts.submitTool]    — optional forced final tool
 * @param {string} [opts.model]         — overrides config.ANTHROPIC_MODEL
 * @param {number} [opts.maxTokensOut]  — overrides config.MAX_TOKENS_OUT (per-agent)
 * @returns {Promise<object>}            — { runId, output, tokensIn, tokensOut, costUsd, ... }
 */
export async function runAgent({
  agentName,
  systemPrompt,
  userMessage,
  tools,
  submitTool,
  model,
  maxTokensOut,
}) {
  validateTools(tools);

  const useModel = model || config.ANTHROPIC_MODEL;
  const price = priceFor(useModel);
  // Resolve effective max_tokens: per-agent override wins, else env config.
  // Hard ceiling of 8192 (well within any current Anthropic model limit) to
  // prevent accidental run-away from a malformed agent definition.
  const effectiveMaxTokens = Math.min(
    Number.isFinite(maxTokensOut) && maxTokensOut > 0 ? maxTokensOut : config.MAX_TOKENS_OUT,
    8192
  );

  // Pre-flight: estimate worst case (max tokens out × price) and check budget
  const worstCaseUsd = (effectiveMaxTokens / 1_000_000) * price.out
                     + (10000 / 1_000_000) * price.in;  // rough input ceiling
  checkBudgetForRun(worstCaseUsd);

  if (!config.ANTHROPIC_API_KEY) {
    return {
      runId: `sb-mock-${Date.now()}`,
      status: 'mock_mode',
      output: { _mock: true, message: 'ANTHROPIC_API_KEY not set; would have called the model' },
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      toolCallCount: 0,
      durationMs: 0,
    };
  }

  const t0 = Date.now();
  const runId = `sb-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Build Anthropic tool definitions
  const anthropicTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  if (submitTool) {
    anthropicTools.push({
      name: submitTool.name,
      description: submitTool.description,
      input_schema: submitTool.input_schema,
    });
  }

  const messages = [{ role: 'user', content: userMessage }];
  let totalIn = 0, totalOut = 0, toolCalls = 0;
  let finalOutput = null;

  // Tool-use loop
  while (toolCalls < config.MAX_TOOL_CALLS) {
    const force = (submitTool && toolCalls >= 1)
      ? { tool_choice: { type: 'tool', name: submitTool.name } }
      : {};

    const resp = await client().messages.create({
      model: useModel,
      max_tokens: effectiveMaxTokens,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
      ...force,
    });

    totalIn  += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;

    // Hard budget check after each round-trip
    const costSoFar = (totalIn / 1_000_000) * price.in + (totalOut / 1_000_000) * price.out;
    if (costSoFar > config.PER_RUN_BUDGET_USD) {
      throw new Error(`Per-run budget exceeded mid-loop: $${costSoFar.toFixed(4)} > $${config.PER_RUN_BUDGET_USD}`);
    }

    if (resp.stop_reason === 'end_turn' && !resp.content.some((b) => b.type === 'tool_use')) {
      finalOutput = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      break;
    }

    // Execute tool calls
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      finalOutput = resp.content.map((b) => b.type === 'text' ? b.text : '').join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: resp.content });

    const toolResults = [];
    for (const use of toolUses) {
      toolCalls += 1;
      if (toolCalls > config.MAX_TOOL_CALLS) {
        throw new Error(`Tool-call cap reached (${config.MAX_TOOL_CALLS})`);
      }
      // submitTool: capture input as final output
      if (submitTool && use.name === submitTool.name) {
        finalOutput = use.input;
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'submitted' });
        continue;
      }
      const tool = tools.find((t) => t.name === use.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Unknown tool: ${use.name}`,
          is_error: true,
        });
        continue;
      }
      try {
        const result = await tool.handler(use.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(result).slice(0, 50000),  // bound payload
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    if (finalOutput) break;

    messages.push({ role: 'user', content: toolResults });
  }

  const costUsd = (totalIn / 1_000_000) * price.in + (totalOut / 1_000_000) * price.out;
  recordSpend(costUsd);

  const record = {
    runId,
    agentName,
    model: useModel,
    output: finalOutput,
    tokensIn: totalIn,
    tokensOut: totalOut,
    costUsd: Number(costUsd.toFixed(6)),
    toolCallCount: toolCalls,
    durationMs: Date.now() - t0,
    timestamp: new Date().toISOString(),
  };
  addRun(record);
  return record;
}
