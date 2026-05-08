/**
 * AI Cost Guard — daily / hourly token budgets, automatic downgrade,
 * queue backpressure.
 *
 * Phase 1: SKELETON. Returns "no enforcement" results.
 * Real enforcement requires migration 012 (AiSpendBudget table).
 *
 * Future capabilities (Phase 4+):
 *   - Track tokens-in/out + USD cost per (PeriodKey, AgentName, Model)
 *   - Compare against INTEL_AI_DAILY_TOKEN_BUDGET / INTEL_AI_HOURLY_USD_LIMIT
 *   - Switch from PRIMARY to FALLBACK model when nearing limits
 *   - Set BackpressureActive=1 when budget exhausted; agents pause
 *   - Daily reset job clears bucket
 *
 * Public interface in Phase 1 mirrors what the real implementation will use,
 * so swapping in real logic later requires no caller changes.
 */
import { intelligenceFlags } from '../featureFlags.js';

/**
 * Decide which model to use for an upcoming agent call.
 * @param {string} agentName
 * @param {object} [opts]
 * @param {string} [opts.preferred] — caller hint (overrides primary)
 * @returns {Promise<{model: string, downgraded: boolean, reason: string}>}
 */
export async function selectModel(agentName, opts = {}) {
  const f = intelligenceFlags;
  const requested = opts.preferred ?? f.INTEL_AI_PRIMARY_MODEL;

  // Phase 1: no enforcement — always return what's requested
  return {
    model: requested,
    downgraded: false,
    reason: 'phase1_no_enforcement',
  };

  // ─── Future Phase 4+ logic ───
  //
  // const today = new Date().toISOString().slice(0, 10);          // 2026-05-08
  // const thisHour = new Date().toISOString().slice(0, 13);       // 2026-05-08T14
  //
  // const dailySpend = await getBudgetBucket('daily', today, agentName);
  // const hourlySpend = await getBudgetBucket('hourly', thisHour, agentName);
  //
  // if (hourlySpend.usdCost >= f.INTEL_AI_HOURLY_USD_LIMIT) {
  //   return { model: f.INTEL_AI_FALLBACK_MODEL, downgraded: true, reason: 'hourly_usd_exceeded' };
  // }
  // if (dailySpend.tokensTotal >= f.INTEL_AI_DAILY_TOKEN_BUDGET) {
  //   return { model: f.INTEL_AI_FALLBACK_MODEL, downgraded: true, reason: 'daily_tokens_exceeded' };
  // }
  // return { model: requested, downgraded: false, reason: 'within_budget' };
}

/**
 * Record token usage from a completed agent call.
 * @param {object} usage
 * @param {string} usage.agentName
 * @param {string} usage.model
 * @param {number} usage.tokensIn
 * @param {number} usage.tokensOut
 * @param {number} usage.usdCost
 * @returns {Promise<{recorded: boolean, reason?: string}>}
 */
export async function recordUsage(usage) {
  if (intelligenceFlags.INTEL_DEBUG_LOG_EVENTS) {
    // eslint-disable-next-line no-console
    console.log('[aiCostGuard] usage:', usage);
  }

  // Phase 1: no DB write
  return { recorded: false, reason: 'phase1_table_not_present' };

  // ─── Future ───
  // await upsertBudgetBucket('daily', today, usage);
  // await upsertBudgetBucket('hourly', thisHour, usage);
  // return { recorded: true };
}

/**
 * Check whether agents should pause because budget is exhausted.
 * @returns {Promise<{paused: boolean, reason?: string, resumeAt?: string}>}
 */
export async function checkBackpressure() {
  // Phase 1: never paused
  return { paused: false };
}

/**
 * Compute a human-readable budget summary — useful for /health.
 */
export async function getBudgetSummary() {
  return {
    phase: 1,
    enforcing: false,
    primaryModel: intelligenceFlags.INTEL_AI_PRIMARY_MODEL,
    fallbackModel: intelligenceFlags.INTEL_AI_FALLBACK_MODEL,
    dailyTokenBudget: intelligenceFlags.INTEL_AI_DAILY_TOKEN_BUDGET,
    hourlyUsdLimit: intelligenceFlags.INTEL_AI_HOURLY_USD_LIMIT,
    note: 'Phase 1: budget tracking deferred until migration 012 applied.',
  };
}
