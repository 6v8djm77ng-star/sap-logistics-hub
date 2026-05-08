/**
 * Content & Copy Agent — DB-free LLM runtime.
 *
 * One Anthropic call per request. No tools, no DB, no scheduler, no persistence.
 * Inputs and outputs are validated by Zod. The LLM is asked to return JSON only;
 * if the first attempt fails to parse, we run ONE repair attempt that strictly
 * demands JSON. After two failures we surface a structured error.
 *
 * Errors thrown by this module attach `code` and `statusHint` so the route can
 * map them to HTTP status codes without leaking internals.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { apiLogger } from '../../utils/logger.js';
import { inputSchema, outputSchema } from './schema.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';

let _client = null;
function client() {
  if (!_client) {
    if (!env.ANTHROPIC_API_KEY) {
      const err = new Error('agent_not_configured');
      err.code = 'agent_not_configured';
      err.statusHint = 503;
      throw err;
    }
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function extractText(response) {
  return (response.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function tryParseJson(text) {
  let s = (text || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // If the model wrapped JSON in extra prose, attempt to isolate the outermost {...}.
  if (!s.startsWith('{')) {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

function makeError(code, statusHint, details) {
  const err = new Error(code);
  err.code = code;
  err.statusHint = statusHint;
  if (details) err.details = details;
  return err;
}

export async function runContentCopyAgent(rawInput) {
  const inputResult = inputSchema.safeParse(rawInput);
  if (!inputResult.success) {
    throw makeError('invalid_input', 400, inputResult.error.flatten());
  }
  const input = inputResult.data;

  if (!env.ANTHROPIC_API_KEY) {
    throw makeError('agent_not_configured', 503);
  }

  const t0 = Date.now();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  let response;
  try {
    response = await client().messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: env.AGENT_MAX_TOKENS_OUT,
      temperature: 0.4,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (e) {
    // Sanitize: Anthropic errors expose status/type/message but never the API key.
    // We propagate these via .cause so callers can debug without modifying agent.
    const sanitized = {
      status: e?.status ?? null,
      type: e?.error?.type ?? e?.name ?? null,
      message: typeof e?.message === 'string' ? e.message.slice(0, 500) : null,
    };
    apiLogger.error('[content-copy] llm_error', {
      brand: input.brand,
      content_type: input.content_type,
      language: input.language,
      sdk_status: sanitized.status,
      sdk_type: sanitized.type,
    });
    const wrapped = makeError('llm_error', 502);
    wrapped.cause = sanitized;
    throw wrapped;
  }

  const tokensIn = response.usage?.input_tokens || 0;
  const tokensOut = response.usage?.output_tokens || 0;

  const text = extractText(response);
  let parsed;
  try {
    parsed = tryParseJson(text);
  } catch {
    let repair;
    try {
      repair = await client().messages.create({
        model: env.ANTHROPIC_MODEL,
        max_tokens: env.AGENT_MAX_TOKENS_OUT,
        temperature: 0,
        system:
          'Return ONLY a single valid JSON object matching the schema previously specified. ' +
          'No markdown, no code fences, no commentary, no preamble. JSON only.',
        messages: [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: text || '(empty reply)' },
          { role: 'user', content: 'Your previous reply could not be parsed as JSON. Return ONLY the JSON object now.' },
        ],
      });
    } catch {
      throw makeError('invalid_llm_json', 502);
    }
    try {
      parsed = tryParseJson(extractText(repair));
    } catch {
      throw makeError('invalid_llm_json', 502);
    }
  }

  const outputResult = outputSchema.safeParse(parsed);
  if (!outputResult.success) {
    apiLogger.error('[content-copy] invalid_output_schema', {
      brand: input.brand,
      content_type: input.content_type,
    });
    throw makeError('invalid_output_schema', 502);
  }

  const durationMs = Date.now() - t0;
  apiLogger.info('[content-copy] ok', {
    brand: input.brand,
    content_type: input.content_type,
    language: input.language,
    durationMs,
    tokensIn,
    tokensOut,
  });

  return outputResult.data;
}
