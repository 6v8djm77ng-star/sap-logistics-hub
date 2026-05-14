// =====================================================================
// budget.js — sandbox cost ceiling enforcement
// In-memory counter; resets at process restart OR on date change.
// Hard ceiling enforced before each agent loop iteration.
//
// This is the SANDBOX equivalent of the production aiCostGuard
// (which is a Phase-1 stub per security-reaudit.md F12). The sandbox
// version is intentionally simpler — single process, no DB persistence,
// just a counter.
// =====================================================================
import { config } from './config.js';

let spentToday = 0;
let runsToday = 0;
let lastResetDate = new Date().toDateString();

function maybeResetForNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    spentToday = 0;
    runsToday = 0;
    lastResetDate = today;
  }
}

export function checkBudgetForRun(estimatedCostUsd) {
  maybeResetForNewDay();
  if (estimatedCostUsd > config.PER_RUN_BUDGET_USD) {
    throw new Error(
      `Sandbox per-run budget exceeded: estimated $${estimatedCostUsd.toFixed(4)} > limit $${config.PER_RUN_BUDGET_USD}`
    );
  }
  if (spentToday + estimatedCostUsd > config.DAILY_BUDGET_USD) {
    throw new Error(
      `Sandbox daily budget exceeded: $${spentToday.toFixed(4)} spent today, +$${estimatedCostUsd.toFixed(4)} would exceed $${config.DAILY_BUDGET_USD} ceiling. Try again tomorrow OR raise SANDBOX_DAILY_BUDGET_USD.`
    );
  }
}

export function recordSpend(usd) {
  maybeResetForNewDay();
  spentToday += usd;
  runsToday += 1;
}

export function getBudgetStatus() {
  maybeResetForNewDay();
  return {
    date: lastResetDate,
    spent_today_usd: Number(spentToday.toFixed(6)),
    daily_ceiling_usd: config.DAILY_BUDGET_USD,
    per_run_ceiling_usd: config.PER_RUN_BUDGET_USD,
    runs_today: runsToday,
    remaining_today_usd: Number((config.DAILY_BUDGET_USD - spentToday).toFixed(6)),
  };
}
