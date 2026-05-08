/**
 * Smoke tests for the unified Intelligence Event schema.
 * Run with: npm test (uses node:test built-in)
 *
 * No DB, no network, no external services.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IntelligenceEventSchema,
  validateEvent,
  safeValidateEvent,
  SCHEMA_VERSION,
} from '../eventSchema.js';
import { computeAlertKey, shouldFireAlert } from '../alertGuard.js';
import { selectModel, getBudgetSummary } from '../aiCostGuard.js';
import { getEventBus, resetEventBusCache } from '../eventBusFactory.js';

const VALID_EVENT = {
  eventId: '550e8400-e29b-41d4-a716-446655440000',
  eventType: 'mention.created',
  source: 'fb-agent',
  timestamp: '2026-05-08T12:00:00.000Z',
  schemaVersion: 1,
  entityType: 'SocialItem',
  entityId: 'ck123abc',
  severity: 'medium',
  payload: { url: 'https://facebook.com/post/1', content: 'test' },
};

describe('IntelligenceEventSchema', () => {
  it('accepts canonical valid event', () => {
    assert.doesNotThrow(() => validateEvent(VALID_EVENT));
  });

  it('rejects missing eventId', () => {
    const { eventId: _, ...rest } = VALID_EVENT;
    assert.equal(safeValidateEvent(rest).ok, false);
  });

  it('rejects non-uuid eventId', () => {
    const r = safeValidateEvent({ ...VALID_EVENT, eventId: 'not-a-uuid' });
    assert.equal(r.ok, false);
  });

  it('rejects unknown eventType', () => {
    const r = safeValidateEvent({ ...VALID_EVENT, eventType: 'unknown.event' });
    assert.equal(r.ok, false);
  });

  it('rejects unknown source', () => {
    const r = safeValidateEvent({ ...VALID_EVENT, source: 'random-system' });
    assert.equal(r.ok, false);
  });

  it('rejects schemaVersion != 1', () => {
    assert.equal(safeValidateEvent({ ...VALID_EVENT, schemaVersion: 0 }).ok, false);
    assert.equal(safeValidateEvent({ ...VALID_EVENT, schemaVersion: 2 }).ok, false);
  });

  it('rejects invalid timestamp', () => {
    const r = safeValidateEvent({ ...VALID_EVENT, timestamp: 'yesterday' });
    assert.equal(r.ok, false);
  });

  it('rejects severity outside enum', () => {
    const r = safeValidateEvent({ ...VALID_EVENT, severity: 'extreme' });
    assert.equal(r.ok, false);
  });

  it('rejects confidence out of [0,1]', () => {
    assert.equal(safeValidateEvent({ ...VALID_EVENT, confidence: 1.01 }).ok, false);
    assert.equal(safeValidateEvent({ ...VALID_EVENT, confidence: -0.1 }).ok, false);
  });

  it('accepts all optional fields filled', () => {
    const full = {
      ...VALID_EVENT,
      entityName: 'Tineco S9 mention',
      brand: 'Tineco',
      competitor: 'Roborock',
      sentiment: 'negative',
      intent: 'complaint',
      confidence: 0.85,
    };
    assert.doesNotThrow(() => validateEvent(full));
  });

  it('SCHEMA_VERSION is 1', () => {
    assert.equal(SCHEMA_VERSION, 1);
  });
});

describe('Event bus factory', () => {
  beforeEach(() => {
    resetEventBusCache();
    delete process.env.ENABLE_EVENT_BUS;
    delete process.env.EVENT_BUS_DRIVER;
    delete process.env.INTEL_BUS_URL;
  });

  it('returns noop bus when ENABLE_EVENT_BUS unset', async () => {
    const bus = getEventBus();
    assert.equal(bus.driver, 'noop');
    const result = await bus.publish(VALID_EVENT);
    assert.equal(result.ok, true);
    assert.equal(result.suppressed, true);
  });

  it('falls back to noop when http driver has no URL', () => {
    process.env.ENABLE_EVENT_BUS = 'true';
    process.env.EVENT_BUS_DRIVER = 'http';
    process.env.INTEL_BUS_URL = '';
    resetEventBusCache();
    assert.equal(getEventBus().driver, 'noop');
  });

  it('returns http bus when properly configured', () => {
    process.env.ENABLE_EVENT_BUS = 'true';
    process.env.EVENT_BUS_DRIVER = 'http';
    process.env.INTEL_BUS_URL = 'http://localhost:4000/api/intelligence/events';
    resetEventBusCache();
    assert.equal(getEventBus().driver, 'http');
  });

  it('falls back to noop for unimplemented drivers', () => {
    process.env.ENABLE_EVENT_BUS = 'true';
    process.env.EVENT_BUS_DRIVER = 'redis-streams';
    resetEventBusCache();
    assert.equal(getEventBus().driver, 'noop');
  });
});

describe('alertGuard', () => {
  it('computes stable alert key', () => {
    const key = computeAlertKey({
      eventType: 'price.dropped',
      brand: 'DAVO',
      competitor: 'Roborock',
      severity: 'high',
    });
    assert.equal(key, 'price.dropped:davo:roborock:high');
  });

  it('handles missing brand and competitor', () => {
    const key = computeAlertKey({
      eventType: 'mention.created',
      severity: 'low',
    });
    assert.equal(key, 'mention.created:no-brand:no-competitor:low');
  });

  it('returns shouldFire=false when ENABLE_INTEL_ALERTS unset', async () => {
    delete process.env.ENABLE_INTEL_ALERTS;
    const result = await shouldFireAlert(VALID_EVENT);
    assert.equal(result.shouldFire, false);
    assert.equal(result.reason, 'alerts_disabled');
  });
});

describe('aiCostGuard', () => {
  it('returns primary model in Phase 1 (no enforcement)', async () => {
    const r = await selectModel('test-agent');
    assert.equal(r.downgraded, false);
    assert.equal(r.reason, 'phase1_no_enforcement');
  });

  it('budget summary shows phase 1 status', async () => {
    const summary = await getBudgetSummary();
    assert.equal(summary.phase, 1);
    assert.equal(summary.enforcing, false);
  });
});
