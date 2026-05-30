/**
 * DEV.18: auto-DISARM safety net for SAP_WRITE_ENABLED.
 *
 * Why this exists:
 *   The LIVE.5/LIVE.6 runbook arms SAP_WRITE_ENABLED via restart-safe.ps1,
 *   does one write, and DISARMs in a try/finally. That works when the script
 *   runs to completion. But:
 *     - if the script process crashes between arm and DISARM
 *     - if an operator manually edits .env to true and forgets
 *     - if a parallel agent armed and didn't disarm
 *   ...then SAP_WRITE_ENABLED stays on indefinitely. Without this safety net,
 *   any subsequent admin call to the LIVE write endpoints would silently
 *   succeed against SAP TEST without explicit operator intent.
 *
 * Design:
 *   - Pure module, no I/O at import time.
 *   - `startAutoDisarmWatcher(opts)` sets up an interval that checks the env
 *     var. Tracks when it was FIRST seen as 'true' since the watcher started.
 *     Once elapsed time > maxMinutes, deletes `process.env.SAP_WRITE_ENABLED`
 *     so subsequent writeInvoice/writeDeliveryNote calls fall back to dry-run.
 *   - .env file is NOT touched — only the in-memory env var. This avoids
 *     interfering with restart-safe.ps1, OneDrive sync, or any other process
 *     that might be reading/writing the file.
 *   - Logs every state transition so the operator has a clear timeline.
 *
 * Limits:
 *   - If PM2 restarts (--update-env), env is re-loaded from .env and the
 *     timer resets. That's by design — restart counts as a fresh authorize.
 *   - Doesn't protect against an operator who keeps re-running an arm/write
 *     cycle every < maxMinutes. That's a process problem, not a code one.
 */

const DEFAULT_MAX_MINUTES = 5;
const DEFAULT_INTERVAL_MS = 60_000; // 1 minute

// Module-level state — created once per process. Tests can use
// _resetForTests() to clear between cases.
let _firstSeenAtMs = null;
let _intervalHandle = null;

/**
 * Check the current SAP_WRITE_ENABLED env and return one of:
 *   'inactive'  — env is not 'true' (clean state)
 *   'active'    — env is 'true' and within budget
 *   'expired'   — env is 'true' and elapsed > maxMinutes (caller should disarm)
 * Pure function aside from reading `process.env` and the module-level
 * `_firstSeenAtMs`.
 */
export function evaluateAutoDisarm(opts = {}) {
  const { maxMinutes = DEFAULT_MAX_MINUTES, nowMs = Date.now() } = opts;
  const isOn = process.env.SAP_WRITE_ENABLED === 'true';
  if (!isOn) {
    // Clean state: reset the timer.
    if (_firstSeenAtMs !== null) _firstSeenAtMs = null;
    return { state: 'inactive', elapsedMinutes: 0, maxMinutes };
  }
  // First time we observe it on this run? Stamp it.
  if (_firstSeenAtMs === null) _firstSeenAtMs = nowMs;
  const elapsedMs = nowMs - _firstSeenAtMs;
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes > maxMinutes) {
    return { state: 'expired', elapsedMinutes, maxMinutes };
  }
  return { state: 'active', elapsedMinutes, maxMinutes };
}

/**
 * Apply the disarm: remove the env var so writes drop back to dry-run.
 * .env file is NOT modified — only the in-process variable. Logs via the
 * provided logger.
 */
export function applyDisarm(reason, logger = console) {
  delete process.env.SAP_WRITE_ENABLED;
  _firstSeenAtMs = null;
  logger.warn?.(`[sap-write-auto-disarm] SAP_WRITE_ENABLED cleared from process.env: ${reason}. (.env file unchanged — clean up manually if needed.)`);
}

/**
 * Start the polling watcher. Returns a handle that can be cleared via
 * stopAutoDisarmWatcher() in tests / shutdown.
 */
export function startAutoDisarmWatcher(opts = {}) {
  const {
    maxMinutes = DEFAULT_MAX_MINUTES,
    intervalMs = DEFAULT_INTERVAL_MS,
    logger = console,
  } = opts;
  if (_intervalHandle) return _intervalHandle; // idempotent
  _intervalHandle = setInterval(() => {
    const verdict = evaluateAutoDisarm({ maxMinutes });
    if (verdict.state === 'expired') {
      applyDisarm(
        `exceeded ${maxMinutes}-minute budget (elapsed ${verdict.elapsedMinutes.toFixed(1)} min)`,
        logger,
      );
    }
  }, intervalMs);
  if (_intervalHandle.unref) _intervalHandle.unref(); // don't block process exit
  return _intervalHandle;
}

export function stopAutoDisarmWatcher() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

// Test hook — resets module state between cases.
export function _resetForTests() {
  _firstSeenAtMs = null;
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = null;
}
