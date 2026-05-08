/**
 * Feature flags reader for the Israeli Commerce Intelligence layer.
 *
 * Mirrors fb-agent/src/lib/feature-flags.ts (TypeScript). Same flag names,
 * same defaults — keeps the two systems aligned without a shared package.
 *
 * Strict additive: this module is opt-in only. The existing config/env.js
 * envSchema is NOT modified by Phase 1. These flags read straight from
 * process.env so the sap-hub bootstrap continues to work unchanged.
 *
 * Phase mapping:
 *   Phase 1: ENABLE_EVENT_BUS + EVENT_BUS_DRIVER + INTEL_BUS_URL
 *   Phase 4: INTEL_AGENT_HOURLY_ENABLED, INTEL_AI_*_BUDGET, INTEL_AI_*_MODEL
 *   Phase 7: ENABLE_INTEL_ALERTS, INTEL_ALERT_*
 *   Phase 4: ENABLE_EXECUTIVE_DIGEST, INTEL_DIGEST_*
 *
 * All flags default to safe values (false / no-op).
 */

function readBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function readString(name, defaultValue = '') {
  return process.env[name] ?? defaultValue;
}

function readInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? defaultValue : n;
}

function readFloat(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

/**
 * Read every flag from process.env into a fresh plain object.
 * Module-level binding `intelligenceFlags` keeps the same reference across
 * imports; in production it's evaluated once at startup. Tests use
 * `_reloadIntelligenceFlagsForTesting()` to refresh without re-importing.
 */
function readAllFlags() {
  return {
    // ── Master switches ──
    ENABLE_EVENT_BUS: readBool('ENABLE_EVENT_BUS'),
    ENABLE_SOCIAL_INTELLIGENCE: readBool('ENABLE_SOCIAL_INTELLIGENCE'),
    ENABLE_HEBREW_CLASSIFIER: readBool('ENABLE_HEBREW_CLASSIFIER'),
    ENABLE_META_CONNECTORS: readBool('ENABLE_META_CONNECTORS'),
    ENABLE_INTEL_ALERTS: readBool('ENABLE_INTEL_ALERTS'),
    ENABLE_EXECUTIVE_DIGEST: readBool('ENABLE_EXECUTIVE_DIGEST'),

    // ── Event bus ──
    EVENT_BUS_DRIVER: readString('EVENT_BUS_DRIVER', 'noop'),
    INTEL_BUS_URL: readString('INTEL_BUS_URL'),
    INTEL_BUS_RECEIVER_TOKEN: readString('INTEL_BUS_RECEIVER_TOKEN'),

    // ── Debug ──
    INTEL_DEBUG_LOG_EVENTS: readBool('INTEL_DEBUG_LOG_EVENTS'),

    // ── AI cost protection (Phase 4+; structures wired in Phase 1) ──
    INTEL_AI_DAILY_TOKEN_BUDGET: readInt('INTEL_AI_DAILY_TOKEN_BUDGET', 1_000_000),
    INTEL_AI_HOURLY_USD_LIMIT: readFloat('INTEL_AI_HOURLY_USD_LIMIT', 5.0),
    INTEL_AI_PRIMARY_MODEL: readString('INTEL_AI_PRIMARY_MODEL', 'claude-sonnet-4-5'),
    INTEL_AI_FALLBACK_MODEL: readString('INTEL_AI_FALLBACK_MODEL', 'claude-haiku-4-5'),

    // ── Alerts (Phase 7+) ──
    INTEL_ALERT_DEDUP_WINDOW_MIN: readInt('INTEL_ALERT_DEDUP_WINDOW_MIN', 60),
    INTEL_ALERT_THROTTLE_PER_HOUR: readInt('INTEL_ALERT_THROTTLE_PER_HOUR', 20),
    INTEL_ALERT_COOLDOWN_MIN: readInt('INTEL_ALERT_COOLDOWN_MIN', 30),

    // ── Schedulers (Phase 4+) ──
    INTEL_AGENT_HOURLY_ENABLED: readBool('INTEL_AGENT_HOURLY_ENABLED'),
    INTEL_DIGEST_RECIPIENTS: readString('INTEL_DIGEST_RECIPIENTS'),
    INTEL_DIGEST_CRON: readString('INTEL_DIGEST_CRON', '0 7 * * *'),

    // ── Retention (used by archive/cleanup workers in later phases) ──
    INTEL_EVENT_RETENTION_DAYS: readInt('INTEL_EVENT_RETENTION_DAYS', 90),
    INTEL_INSIGHT_RETENTION_DAYS: readInt('INTEL_INSIGHT_RETENTION_DAYS', 365),
  };
}

/**
 * Single shared flag object. Same reference across all importers, so any
 * mutation here is visible to every module that reads `intelligenceFlags.X`.
 * In production this object is populated once at startup and never mutated.
 */
export const intelligenceFlags = readAllFlags();

/**
 * Test-only: re-reads every flag from current `process.env` and copies
 * the values into the live `intelligenceFlags` object. Production code
 * never calls this; it exists because feature flags are normally cached
 * at import time and tests need to simulate different env configurations
 * without re-importing the module graph.
 *
 * Naming convention (`_*ForTesting`) marks this as a test-only escape hatch.
 */
export function _reloadIntelligenceFlagsForTesting() {
  Object.assign(intelligenceFlags, readAllFlags());
}

/**
 * Compute readiness — quick health summary callers can render in /health.
 */
export function intelligenceReadiness() {
  const f = intelligenceFlags;
  return {
    eventBus: {
      enabled: f.ENABLE_EVENT_BUS,
      driver: f.EVENT_BUS_DRIVER,
      receiverConfigured: !!f.INTEL_BUS_RECEIVER_TOKEN,
    },
    classifier: { enabled: f.ENABLE_HEBREW_CLASSIFIER },
    connectors: { enabled: f.ENABLE_META_CONNECTORS },
    alerts: { enabled: f.ENABLE_INTEL_ALERTS },
    digest: { enabled: f.ENABLE_EXECUTIVE_DIGEST, recipients: !!f.INTEL_DIGEST_RECIPIENTS },
    aiBudget: {
      dailyTokenBudget: f.INTEL_AI_DAILY_TOKEN_BUDGET,
      hourlyUsdLimit: f.INTEL_AI_HOURLY_USD_LIMIT,
      primaryModel: f.INTEL_AI_PRIMARY_MODEL,
      fallbackModel: f.INTEL_AI_FALLBACK_MODEL,
    },
  };
}
