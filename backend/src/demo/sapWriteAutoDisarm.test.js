/**
 * Unit tests — sapWriteAutoDisarm (DEV.18).
 *
 * Pure unit tests — no PM2, no SAP, no HTTP, no network.
 * Manipulates process.env.SAP_WRITE_ENABLED directly + clears state
 * between tests so each case starts clean.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAutoDisarm,
  applyDisarm,
  _resetForTests,
} from './sapWriteAutoDisarm.js';

let originalEnv;

beforeEach(() => {
  originalEnv = process.env.SAP_WRITE_ENABLED;
  _resetForTests();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.SAP_WRITE_ENABLED;
  else process.env.SAP_WRITE_ENABLED = originalEnv;
  _resetForTests();
});

test('inactive when SAP_WRITE_ENABLED is undefined', () => {
  delete process.env.SAP_WRITE_ENABLED;
  const r = evaluateAutoDisarm();
  assert.equal(r.state, 'inactive');
});

test('inactive when SAP_WRITE_ENABLED is "false"', () => {
  process.env.SAP_WRITE_ENABLED = 'false';
  const r = evaluateAutoDisarm();
  assert.equal(r.state, 'inactive');
});

test('inactive when SAP_WRITE_ENABLED is empty string', () => {
  process.env.SAP_WRITE_ENABLED = '';
  const r = evaluateAutoDisarm();
  assert.equal(r.state, 'inactive');
});

test('active when SAP_WRITE_ENABLED=true and just observed', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  const t0 = 1_000_000;
  const r = evaluateAutoDisarm({ nowMs: t0, maxMinutes: 5 });
  assert.equal(r.state, 'active');
  assert.equal(r.elapsedMinutes, 0);
});

test('still active 1 minute later (within 5-minute budget)', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  const t0 = 1_000_000;
  evaluateAutoDisarm({ nowMs: t0, maxMinutes: 5 });
  const r = evaluateAutoDisarm({ nowMs: t0 + 60_000, maxMinutes: 5 });
  assert.equal(r.state, 'active');
  assert.equal(r.elapsedMinutes, 1);
});

test('expired after 6 minutes (exceeds 5-minute budget)', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  const t0 = 1_000_000;
  evaluateAutoDisarm({ nowMs: t0, maxMinutes: 5 });
  const r = evaluateAutoDisarm({ nowMs: t0 + 6 * 60_000, maxMinutes: 5 });
  assert.equal(r.state, 'expired');
  assert.equal(r.elapsedMinutes, 6);
});

test('boundary: exactly at maxMinutes is still active (strict >)', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  const t0 = 1_000_000;
  evaluateAutoDisarm({ nowMs: t0, maxMinutes: 5 });
  const r = evaluateAutoDisarm({ nowMs: t0 + 5 * 60_000, maxMinutes: 5 });
  assert.equal(r.state, 'active');
});

test('timer resets when env transitions to inactive then back', () => {
  // Arm
  process.env.SAP_WRITE_ENABLED = 'true';
  const t0 = 1_000_000;
  evaluateAutoDisarm({ nowMs: t0, maxMinutes: 5 });
  // Manual disarm
  delete process.env.SAP_WRITE_ENABLED;
  evaluateAutoDisarm({ nowMs: t0 + 2 * 60_000, maxMinutes: 5 }); // inactive, resets
  // Re-arm 10 minutes later (would be "expired" if timer didn't reset)
  process.env.SAP_WRITE_ENABLED = 'true';
  const r = evaluateAutoDisarm({ nowMs: t0 + 10 * 60_000, maxMinutes: 5 });
  assert.equal(r.state, 'active', 'after re-arm, timer should restart from 0');
});

test('applyDisarm removes env var and logs warn', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  let warned = null;
  const logger = { warn: (msg) => { warned = msg; } };
  applyDisarm('test reason', logger);
  assert.equal(process.env.SAP_WRITE_ENABLED, undefined);
  assert.match(warned, /SAP_WRITE_ENABLED cleared/);
  assert.match(warned, /test reason/);
});

test('applyDisarm without logger does not throw', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  assert.doesNotThrow(() => applyDisarm('no-logger', {}));
  assert.equal(process.env.SAP_WRITE_ENABLED, undefined);
});

test('evaluate after applyDisarm shows inactive', () => {
  process.env.SAP_WRITE_ENABLED = 'true';
  evaluateAutoDisarm({ nowMs: 1_000_000, maxMinutes: 5 });
  applyDisarm('cleanup');
  const r = evaluateAutoDisarm({ nowMs: 2_000_000, maxMinutes: 5 });
  assert.equal(r.state, 'inactive');
});

test('case-sensitivity: "TRUE" (caps) is not treated as on', () => {
  // process.env.SAP_WRITE_ENABLED === 'true' is the canonical check
  process.env.SAP_WRITE_ENABLED = 'TRUE';
  const r = evaluateAutoDisarm();
  assert.equal(r.state, 'inactive');
});
