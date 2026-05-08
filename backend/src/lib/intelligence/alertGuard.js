/**
 * Alert Guard — deduplication, throttling, aggregation windows, cooldown.
 *
 * Phase 1: SKELETON. Real enforcement requires migration 011 (Alerts table).
 *
 * Future capabilities (Phase 7+):
 *   - Compute canonical AlertKey from event attributes
 *   - Deduplicate within INTEL_ALERT_DEDUP_WINDOW_MIN
 *   - Throttle to INTEL_ALERT_THROTTLE_PER_HOUR per key
 *   - Apply cooldown of INTEL_ALERT_COOLDOWN_MIN after firing
 *   - Aggregate within configurable windows (5m / 1h / 1d)
 *
 * Public interface stable in Phase 1 so callers wire once.
 */
import { intelligenceFlags } from '../featureFlags.js';

/**
 * Compute a canonical alert key for an event.
 * Used as the dedup primary key.
 * @param {object} event
 * @returns {string}
 */
export function computeAlertKey(event) {
  const parts = [
    event.eventType,
    event.brand || 'no-brand',
    event.competitor || 'no-competitor',
    event.severity,
  ];
  return parts.join(':').toLowerCase();
}

/**
 * Decide whether an alert should fire for a given event.
 *
 * Phase 1: returns shouldFire=true iff ENABLE_INTEL_ALERTS=true.
 * Future: queries Alerts table for prior occurrences within dedup window,
 *         throttle counts, cooldown state.
 *
 * @param {object} event
 * @returns {Promise<{shouldFire: boolean, reason: string, alertKey: string}>}
 */
export async function shouldFireAlert(event) {
  const alertKey = computeAlertKey(event);

  if (!intelligenceFlags.ENABLE_INTEL_ALERTS) {
    return { shouldFire: false, reason: 'alerts_disabled', alertKey };
  }

  // Phase 1: no Alerts table → no enforcement → fire-through
  return { shouldFire: true, reason: 'phase1_no_enforcement', alertKey };

  // ─── Future Phase 7+ ───
  //
  // const dedupWindowMin = intelligenceFlags.INTEL_ALERT_DEDUP_WINDOW_MIN;
  // const throttlePerHour = intelligenceFlags.INTEL_ALERT_THROTTLE_PER_HOUR;
  // const cooldownMin = intelligenceFlags.INTEL_ALERT_COOLDOWN_MIN;
  //
  // const recent = await db.queryRow(`
  //   SELECT TOP 1 AlertId, OccurrenceCount, LastSeenAt, SuppressedUntil
  //   FROM dbo.Alerts
  //   WHERE AlertKey = @key
  //     AND LastSeenAt > DATEADD(minute, -@window, SYSUTCDATETIME())
  // `, { key: alertKey, window: dedupWindowMin });
  //
  // if (recent && recent.SuppressedUntil > new Date()) {
  //   return { shouldFire: false, reason: 'cooldown', alertKey };
  // }
  // if (recent && recent.OccurrenceCount >= throttlePerHour) {
  //   return { shouldFire: false, reason: 'throttled', alertKey };
  // }
  // return { shouldFire: true, reason: 'within_limits', alertKey };
}

/**
 * Record that an alert was processed (whether fired or suppressed).
 * Phase 1: no-op.
 * @param {object} event
 * @param {string} alertKey
 * @param {{ fired: boolean, channel?: string }} outcome
 */
export async function recordAlert(_event, _alertKey, _outcome = {}) {
  if (intelligenceFlags.INTEL_DEBUG_LOG_EVENTS) {
    // eslint-disable-next-line no-console
    console.log('[alertGuard] would record alert:', _alertKey, _outcome);
  }
  return { recorded: false, reason: 'phase1_table_not_present' };
}
