/**
 * Weekly DAVO Mix report scheduler. Off by default — enable via:
 *   DAVO_MIX_REPORT_ENABLED=true
 *   DAVO_MIX_REPORT_CRON=0 8 * * 0      (Sunday 08:00 Asia/Jerusalem)
 *   DAVO_MIX_REPORT_RECIPIENTS=ceo@oig.co.il,sales@oig.co.il
 */
import cron from 'node-cron';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';
import { runWeeklyReport } from '../services/davoMixWeeklyReport.js';

let task = null;

export function startDavoMixReportScheduler() {
  if (task) return;
  if (!env.DAVO_MIX_REPORT_ENABLED) {
    apiLogger.info('[davoMixReportScheduler] disabled (DAVO_MIX_REPORT_ENABLED=false)');
    return;
  }
  if (!cron.validate(env.DAVO_MIX_REPORT_CRON)) {
    apiLogger.error(`[davoMixReportScheduler] invalid cron: ${env.DAVO_MIX_REPORT_CRON}`);
    return;
  }

  task = cron.schedule(env.DAVO_MIX_REPORT_CRON, async () => {
    try {
      apiLogger.info('[davoMixReportScheduler] firing scheduled weekly report');
      await runWeeklyReport({ triggerType: 'scheduled' });
    } catch (err) {
      apiLogger.error('[davoMixReportScheduler] failed', { error: err.message });
    }
  }, { timezone: 'Asia/Jerusalem' });

  apiLogger.info(`[davoMixReportScheduler] started — cron='${env.DAVO_MIX_REPORT_CRON}' tz=Asia/Jerusalem`);
}

export function stopDavoMixReportScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}
