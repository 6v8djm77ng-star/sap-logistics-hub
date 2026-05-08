/**
 * Schedules the CEO Daily Brief agent to run on a cron schedule.
 *
 * Off by default. Enable by setting in .env:
 *   CEO_BRIEF_SCHEDULE_ENABLED=true
 *   CEO_BRIEF_CRON=0 7 * * *           (default: 07:00 every day)
 *
 * Requires ANTHROPIC_API_KEY to be set, otherwise the scheduler stays idle.
 *
 * No email / Slack delivery — results are persisted to dbo.AgentRuns and read via
 * GET /api/agents/runs. Email integration can be added later.
 */
import cron from 'node-cron';
import { env, agentsConfigured } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';
import { runCeoBrief } from '../agents/ceoBrief.js';

let task = null;

export function startCeoBriefScheduler() {
  if (task) return;
  if (!env.CEO_BRIEF_SCHEDULE_ENABLED) {
    apiLogger.info('[ceoBriefScheduler] disabled (CEO_BRIEF_SCHEDULE_ENABLED=false)');
    return;
  }
  if (!agentsConfigured) {
    apiLogger.warn('[ceoBriefScheduler] cannot start — ANTHROPIC_API_KEY is missing');
    return;
  }
  if (!cron.validate(env.CEO_BRIEF_CRON)) {
    apiLogger.error(`[ceoBriefScheduler] invalid cron expression: ${env.CEO_BRIEF_CRON}`);
    return;
  }

  task = cron.schedule(env.CEO_BRIEF_CRON, async () => {
    try {
      apiLogger.info('[ceoBriefScheduler] firing scheduled CEO brief');
      const result = await runCeoBrief({ triggerType: 'scheduled', createdBy: 'cron' });
      apiLogger.info(`[ceoBriefScheduler] run ${result.runId} ok`, {
        durationMs: result.durationMs,
        costUsd: result.costUsd,
        toolCallCount: result.toolCallCount,
      });
    } catch (err) {
      apiLogger.error('[ceoBriefScheduler] run failed', { error: err.message });
    }
  }, { timezone: 'Asia/Jerusalem' });

  apiLogger.info(`[ceoBriefScheduler] started — cron='${env.CEO_BRIEF_CRON}' tz=Asia/Jerusalem`);
}

export function stopCeoBriefScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}
