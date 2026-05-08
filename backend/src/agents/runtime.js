/**
 * Generic Anthropic tool-use runtime.
 *
 * Given a system prompt, a user message, a set of tools (with handlers), and an
 * optional `submitTool` (a forced final tool that produces structured JSON output),
 * this runtime drives the LLM tool-use loop, persists every step to the DB,
 * and returns the final structured output.
 *
 * Safety rails:
 *   - max tool-call count (env.AGENT_MAX_TOOL_CALLS)
 *   - max output tokens (env.AGENT_MAX_TOKENS_OUT)
 *   - per-step timing
 *   - tool errors are reported back to the model as `is_error: true`, not thrown
 *   - cost computed from token usage (Sonnet 4.5 pricing baked in; override per call)
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';
import * as store from './store.js';

// Pricing per million tokens (USD). Update when models / prices change.
const PRICING = {
  'claude-sonnet-4-5':   { in: 3.00, out: 15.00 },
  'claude-opus-4-5':     { in: 15.00, out: 75.00 },
  'claude-haiku-4-5':    { in: 1.00, out: 5.00 },
  // fallback
  default:               { in: 3.00, out: 15.00 },
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
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set — agents are disabled.');
    }
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Run an agent loop.
 *
 * @param {object} opts
 * @param {string} opts.agentName       — for persistence (e.g. 'ceo_brief')
 * @param {string} opts.triggerType     — 'manual' | 'scheduled'
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {Array}  opts.tools           — [{ name, description, input_schema, handler }]
 * @param {object} [opts.submitTool]    — optional forced final tool: { name, description, input_schema }
 *                                         When set, runtime uses tool_choice to force this tool
 *                                         once the model is ready, and returns its input as `output`.
 * @param {string} [opts.createdBy]     — userId or 'cron'
 * @param {string} [opts.model]         — overrides env.ANTHROPIC_MODEL
 * @returns {Promise<{runId, output, tokensIn, tokensOut, costUsd, toolCallCount, durationMs}>}
 */
export async function runAgent({
  agentName,
  triggerType = 'manual',
  systemPrompt,
  userMessage,
  tools,
  submitTool,
  createdBy,
  model,
}) {
  const useModel = model || env.ANTHROPIC_MODEL;
  const t0 = Date.now();

  const runId = await store.createRun({
    agentName,
    triggerType,
    model: useModel,
    createdBy,
  });

  const allTools = [
    ...tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    ...(submitTool ? [{ name: submitTool.name, description: submitTool.description, input_schema: submitTool.input_schema }] : []),
  ];
  const handlers = new Map(tools.map((t) => [t.name, t.handler]));

  const messages = [{ role: 'user', content: userMessage }];

  let totalIn = 0;
  let totalOut = 0;
  let toolCallCount = 0;
  let finalOutput = null;

  try {
    for (let step = 0; step < env.AGENT_MAX_TOOL_CALLS + 2; step++) {
      // After we've used some tool calls, force the model to commit by requiring submitTool.
      const forceSubmit = !!submitTool && toolCallCount >= 1 && step >= env.AGENT_MAX_TOOL_CALLS;

      const response = await client().messages.create({
        model: useModel,
        max_tokens: env.AGENT_MAX_TOKENS_OUT,
        system: systemPrompt,
        tools: allTools,
        ...(forceSubmit
          ? { tool_choice: { type: 'tool', name: submitTool.name } }
          : { tool_choice: { type: 'auto' } }),
        temperature: 0.2,
        messages,
      });

      totalIn += response.usage?.input_tokens || 0;
      totalOut += response.usage?.output_tokens || 0;

      messages.push({ role: 'assistant', content: response.content });

      // Find tool_use blocks
      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        // No more tool calls — model returned a text response without finalizing.
        // If we required a submit tool, this is a failure mode — surface it.
        if (submitTool) {
          throw new Error('Model stopped without invoking submit tool');
        }
        break;
      }

      // Check if model invoked the submit tool — that's our terminal signal.
      const submitInvocation = submitTool ? toolUses.find((u) => u.name === submitTool.name) : null;
      if (submitInvocation) {
        finalOutput = submitInvocation.input;
        // Acknowledge the submit tool result back so the conversation is well-formed (for logs).
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: submitInvocation.id, content: 'ok' }],
        });
        break;
      }

      // Execute non-submit tool calls and feed results back.
      const toolResults = [];
      for (const use of toolUses) {
        toolCallCount++;
        if (toolCallCount > env.AGENT_MAX_TOOL_CALLS) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Tool call budget exceeded (${env.AGENT_MAX_TOOL_CALLS}). Submit your final answer now.`,
          });
          continue;
        }

        const handler = handlers.get(use.name);
        const tStart = Date.now();
        if (!handler) {
          await store.recordToolCall(runId, toolCallCount, use.name, use.input, { error: 'unknown tool' }, true, Date.now() - tStart);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Unknown tool: ${use.name}`,
          });
          continue;
        }

        try {
          const result = await handler(use.input || {});
          const durationMs = Date.now() - tStart;
          await store.recordToolCall(runId, toolCallCount, use.name, use.input, result, false, durationMs);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const durationMs = Date.now() - tStart;
          await store.recordToolCall(runId, toolCallCount, use.name, use.input, { error: err.message }, true, durationMs);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Tool error: ${err.message}`,
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    if (submitTool && finalOutput == null) {
      throw new Error('Agent exhausted steps without producing a final output');
    }

    const px = priceFor(useModel);
    const costUsd = (totalIn / 1_000_000) * px.in + (totalOut / 1_000_000) * px.out;
    const durationMs = Date.now() - t0;

    await store.completeRun(runId, {
      tokensIn: totalIn,
      tokensOut: totalOut,
      costUsd: Number(costUsd.toFixed(6)),
      toolCallCount,
      output: finalOutput,
      messages,
      durationMs,
    });

    apiLogger.info(`[agent:${agentName}] run ${runId} ok`, {
      durationMs, tokensIn: totalIn, tokensOut: totalOut, toolCallCount,
      costUsd: Number(costUsd.toFixed(4)),
    });

    return {
      runId,
      output: finalOutput,
      tokensIn: totalIn,
      tokensOut: totalOut,
      costUsd: Number(costUsd.toFixed(6)),
      toolCallCount,
      durationMs,
    };
  } catch (err) {
    const px = priceFor(useModel);
    const costUsd = (totalIn / 1_000_000) * px.in + (totalOut / 1_000_000) * px.out;
    const durationMs = Date.now() - t0;
    await store.failRun(runId, err.message, {
      tokensIn: totalIn,
      tokensOut: totalOut,
      costUsd: Number(costUsd.toFixed(6)),
      toolCallCount,
      messages,
      durationMs,
    });
    apiLogger.error(`[agent:${agentName}] run ${runId} failed`, { error: err.message });
    throw err;
  }
}
