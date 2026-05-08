/**
 * CEO Daily Brief Agent.
 *
 * Reasoning-driven (not rule-based): the LLM is given access to SAP data via tools,
 * decides which periods to compare, finds anomalies / risks / opportunities,
 * and returns a single structured JSON via the `submit_brief` tool.
 *
 * The output schema is enforced by Anthropic's tool input_schema (JSON Schema)
 * and re-validated with Zod after the run.
 */
import { z } from 'zod';
import { format, subDays } from 'date-fns';
import { runAgent } from './runtime.js';
import { financialTools } from './tools/financialTools.js';

const SYSTEM_PROMPT = `You are the CEO Daily Brief Agent for an Israeli distributor running SAP Business One across two companies (A and B).

Your job: produce a short, evidence-based morning brief for the CEO based on what the SAP data is telling you today.

How you work:
1. Use the available tools to pull data. You decide which queries are needed and which periods to compare.
   The user message gives you the relevant date anchors (today, yesterday, week, prior week, MTD, prior MTD).
2. Always compare against at least one prior period before claiming a change is meaningful. Single-day spikes mean little without context.
3. Distinguish data-quality issues (cost = 0 in OITM, missing addresses, weekends) from real signals. Flag suspected data issues separately, do not dress them up as risks.
4. Be specific: name the customer, the item, the company (A or B), the percentage. Vague observations are worthless.
5. If a finding has no supporting numbers, do not include it.
6. Keep the brief tight: at most 5 key changes, 5 anomalies, 5 risks, 5 opportunities, 5 actions. Quality over quantity.
7. Write executive_summary in Hebrew (2-4 sentences). Everything else: structured fields with Hebrew strings where natural, but keep numeric / code fields untouched.
8. When you are done analyzing, call the \`submit_brief\` tool. Do not write a final text message — the brief must come through the tool.

Hard rules:
- Every number you report MUST come from a tool result. Never invent figures.
- Do not produce a brief without making at least one tool call.
- Israeli currency is NIS (₪). Format large numbers with thousands separators in user-facing strings.
- Israeli weekends are Friday-Saturday. Mondays compare against the prior business day appropriately.
`;

// JSON schema for the forced final tool. The model must call this — that's how we
// get a structured output instead of free text.
const SUBMIT_TOOL = {
  name: 'submit_brief',
  description: 'Submit the final CEO Daily Brief. Call this exactly once when your analysis is complete.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      executive_summary: {
        type: 'string',
        description: 'Hebrew, 2-4 sentences. The headline of the day.',
        minLength: 20,
        maxLength: 800,
      },
      period: {
        type: 'object',
        additionalProperties: false,
        properties: {
          anchor_date: { type: 'string', description: 'YYYY-MM-DD, the day the brief is for.' },
          comparisons_used: {
            type: 'array',
            items: { type: 'string', enum: ['daily', 'weekly', 'mtd'] },
            description: 'Which prior-period comparisons informed this brief.',
          },
        },
        required: ['anchor_date', 'comparisons_used'],
      },
      key_changes: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            metric:    { type: 'string', description: 'e.g. "Daily revenue", "Margin % company A".' },
            value:     { type: 'string', description: 'Current value as a string with units.' },
            delta_pct: { type: 'number', description: 'Percent change vs comparison period. Negative for down.' },
            direction: { type: 'string', enum: ['up', 'down', 'flat'] },
            note:      { type: 'string' },
          },
          required: ['metric', 'value', 'direction', 'note'],
        },
      },
      anomalies: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            area:     { type: 'string', enum: ['sales', 'inventory', 'margin', 'customers', 'data_quality'] },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            finding:  { type: 'string' },
            evidence: { type: 'object', description: 'Numeric evidence: counts, totals, ItemCodes, CardCodes, etc.' },
          },
          required: ['area', 'severity', 'finding', 'evidence'],
        },
      },
      top_risks: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            risk:       { type: 'string' },
            impact:     { type: 'string', description: 'What happens if this is not addressed.' },
            likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
            evidence:   { type: 'object' },
          },
          required: ['risk', 'impact', 'likelihood', 'evidence'],
        },
      },
      opportunities: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            opportunity:        { type: 'string' },
            potential_value_ils: { type: 'number', description: 'Order-of-magnitude estimate; null if unknown.' },
            evidence:           { type: 'object' },
          },
          required: ['opportunity', 'evidence'],
        },
      },
      recommended_actions: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action:           { type: 'string' },
            owner:            { type: 'string', enum: ['ceo', 'sales', 'ops', 'finance', 'inventory'] },
            priority:         { type: 'string', enum: ['p0', 'p1', 'p2'] },
            expected_outcome: { type: 'string' },
          },
          required: ['action', 'owner', 'priority', 'expected_outcome'],
        },
      },
      data_sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool names used, e.g. ["get_daily_sales", "get_margin_by_item"].',
      },
    },
    required: [
      'executive_summary',
      'period',
      'key_changes',
      'anomalies',
      'top_risks',
      'opportunities',
      'recommended_actions',
      'data_sources',
    ],
  },
};

// Zod mirror of the schema — second line of defense in case the model bends the JSON.
const briefSchema = z.object({
  executive_summary: z.string().min(20).max(800),
  period: z.object({
    anchor_date: z.string(),
    comparisons_used: z.array(z.enum(['daily', 'weekly', 'mtd'])),
  }),
  key_changes: z.array(z.object({
    metric:    z.string(),
    value:     z.string(),
    delta_pct: z.number().optional(),
    direction: z.enum(['up', 'down', 'flat']),
    note:      z.string(),
  })).max(5),
  anomalies: z.array(z.object({
    area:     z.enum(['sales', 'inventory', 'margin', 'customers', 'data_quality']),
    severity: z.enum(['high', 'medium', 'low']),
    finding:  z.string(),
    evidence: z.record(z.any()),
  })).max(5),
  top_risks: z.array(z.object({
    risk:       z.string(),
    impact:     z.string(),
    likelihood: z.enum(['high', 'medium', 'low']),
    evidence:   z.record(z.any()),
  })).max(5),
  opportunities: z.array(z.object({
    opportunity:         z.string(),
    potential_value_ils: z.number().nullable().optional(),
    evidence:            z.record(z.any()),
  })).max(5),
  recommended_actions: z.array(z.object({
    action:           z.string(),
    owner:            z.enum(['ceo', 'sales', 'ops', 'finance', 'inventory']),
    priority:         z.enum(['p0', 'p1', 'p2']),
    expected_outcome: z.string(),
  })).max(5),
  data_sources: z.array(z.string()),
});

function buildUserMessage(anchorDate) {
  const anchor = anchorDate ? new Date(anchorDate) : new Date();
  const fmt = (d) => format(d, 'yyyy-MM-dd');

  const today        = fmt(anchor);
  const yesterday    = fmt(subDays(anchor, 1));
  const dayBefore    = fmt(subDays(anchor, 2));

  const last7End     = fmt(subDays(anchor, 1));
  const last7Start   = fmt(subDays(anchor, 7));
  const prior7End    = fmt(subDays(anchor, 8));
  const prior7Start  = fmt(subDays(anchor, 14));

  const mtdStart = fmt(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const mtdEnd   = fmt(anchor);
  const priorMtdStart = fmt(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
  const priorMtdEndDay = Math.min(
    anchor.getDate(),
    new Date(anchor.getFullYear(), anchor.getMonth(), 0).getDate()
  );
  const priorMtdEnd = fmt(new Date(anchor.getFullYear(), anchor.getMonth() - 1, priorMtdEndDay));

  return `Produce the CEO Daily Brief for ${today}.

Suggested comparison anchors (use the ones that make sense — you do not have to use all):
- Daily:    yesterday=${yesterday} vs day-before=${dayBefore}
- Weekly:   last_7d=${last7Start}..${last7End} vs prior_7d=${prior7Start}..${prior7End}
- MTD:      mtd=${mtdStart}..${mtdEnd} vs prior_mtd=${priorMtdStart}..${priorMtdEnd}

Pull what you need via tools, reason about it, then call submit_brief with your findings.`;
}

/**
 * Run the CEO Brief agent.
 *
 * @param {object} opts
 * @param {string} [opts.anchorDate]   YYYY-MM-DD. Defaults to today.
 * @param {string} [opts.triggerType]  'manual' | 'scheduled'
 * @param {string} [opts.createdBy]
 */
export async function runCeoBrief({ anchorDate, triggerType = 'manual', createdBy } = {}) {
  const result = await runAgent({
    agentName: 'ceo_brief',
    triggerType,
    createdBy,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(anchorDate),
    tools: financialTools,
    submitTool: SUBMIT_TOOL,
  });

  // Validate the LLM output against our Zod schema. If it fails, the run is still
  // persisted (so the caller can debug), but we surface the validation error.
  const parsed = briefSchema.safeParse(result.output);
  if (!parsed.success) {
    const err = new Error(`Brief schema validation failed: ${parsed.error.message}`);
    err.runId = result.runId;
    err.rawOutput = result.output;
    throw err;
  }

  return { ...result, output: parsed.data };
}
