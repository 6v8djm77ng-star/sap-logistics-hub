/**
 * Cleanup Worker - daily housekeeping.
 *
 * Runs once a day at 03:00 AM (low traffic) and prunes:
 *   - Expired tracking tokens (> 7 days past expiry)
 *   - Old notification logs (> 90 days)
 *   - Old driver location history (> 30 days)
 *   - Old audit logs (> 365 days)
 *   - SAP retry queue entries that succeeded long ago
 *
 * Keeps the DB lean and fast.
 */
import * as db from '../db/logisticsDb.js';
import { apiLogger } from '../utils/logger.js';

let timer = null;
let lastRunDate = null;

/**
 * Delete expired tracking tokens (7 days past expiry).
 */
async function cleanupExpiredTokens() {
  const result = await db.execute(
    `DELETE FROM dbo.TrackingTokens
     WHERE ExpiresAt < DATEADD(DAY, -7, SYSUTCDATETIME())`
  );
  return { table: 'TrackingTokens', deleted: result.rowsAffected };
}

/**
 * Delete old notification logs (> 90 days).
 */
async function cleanupNotifications() {
  const result = await db.execute(
    `DELETE FROM dbo.NotificationLog
     WHERE CreatedAt < DATEADD(DAY, -90, SYSUTCDATETIME())`
  );
  return { table: 'NotificationLog', deleted: result.rowsAffected };
}

/**
 * Delete old driver location history (> 30 days).
 * Current positions in DriverLocations are NOT affected (1 row per driver).
 */
async function cleanupLocationHistory() {
  const result = await db.execute(
    `DELETE FROM dbo.DriverLocationHistory
     WHERE RecordedAt < DATEADD(DAY, -30, SYSUTCDATETIME())`
  );
  return { table: 'DriverLocationHistory', deleted: result.rowsAffected };
}

/**
 * Delete old audit logs (> 365 days).
 * Users can adjust retention via env AUDIT_RETENTION_DAYS.
 */
async function cleanupAuditLog() {
  const days = Number(process.env.AUDIT_RETENTION_DAYS) || 365;
  const result = await db.execute(
    `DELETE FROM dbo.AuditLog
     WHERE CreatedAt < DATEADD(DAY, -@days, SYSUTCDATETIME())`,
    { days }
  );
  return { table: 'AuditLog', deleted: result.rowsAffected, retentionDays: days };
}

/**
 * Delete completed retry queue entries (> 7 days since SUCCESS).
 */
async function cleanupRetryQueue() {
  const result = await db.execute(
    `DELETE FROM dbo.SapRetryQueue
     WHERE Status = 'SUCCESS'
       AND LastAttemptAt < DATEADD(DAY, -7, SYSUTCDATETIME())`
  );
  return { table: 'SapRetryQueue', deleted: result.rowsAffected };
}

/**
 * Run all cleanups.
 */
export async function runCleanup() {
  const start = Date.now();
  apiLogger.info('[cleanup] Starting daily cleanup');

  const results = [];
  for (const fn of [
    cleanupExpiredTokens,
    cleanupNotifications,
    cleanupLocationHistory,
    cleanupAuditLog,
    cleanupRetryQueue,
  ]) {
    try {
      const result = await fn();
      results.push(result);
      if (result.deleted > 0) {
        apiLogger.info(`[cleanup] ${result.table}: deleted ${result.deleted} rows`);
      }
    } catch (err) {
      apiLogger.error(`[cleanup] ${fn.name} failed`, { error: err.message });
      results.push({ fn: fn.name, error: err.message });
    }
  }

  const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
  apiLogger.info(`[cleanup] Done in ${Date.now() - start}ms, deleted ${totalDeleted} rows total`);
  return results;
}

/**
 * Schedule next run at 03:00.
 */
function scheduleNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (now.getHours() >= 3) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function startCleanupWorker() {
  if (timer) return;
  apiLogger.info('[cleanup] Cleanup worker started');

  const schedule = () => {
    const ms = scheduleNextRun();
    apiLogger.info(`[cleanup] Next cleanup in ${Math.round(ms / 3600000)}h`);
    timer = setTimeout(async () => {
      const today = new Date().toISOString().slice(0, 10);
      if (lastRunDate !== today) {
        lastRunDate = today;
        await runCleanup();
      }
      schedule();
    }, ms);
  };
  schedule();
}

export function stopCleanupWorker() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
