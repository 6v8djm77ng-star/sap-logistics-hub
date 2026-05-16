/**
 * Unit tests for the wave-selection helper used by _computeOrderFulfillment.
 *
 * Background — Bug A (2026-05-16):
 *   A run can accumulate multiple waves over its lifetime (created →
 *   CANCELLED → fresh wave created and picked). The old `.find()` on RunId
 *   alone could lock onto the FIRST wave returned, which was often a stale
 *   CANCELLED one whose allocations were all PickedQuantity=0. That made
 *   QC-approve raise NOTHING_PICKED ("nothing was picked") even when the
 *   order had actually been picked in the active wave.
 *
 * Coverage:
 *   1. cancelled + completed run → returns the completed wave
 *   2. run with only cancelled waves → returns null (no crash) — caller
 *      surfaces { reason: 'NO_ACTIVE_WAVE' }
 *   3. multiple active waves with different CreatedAt → returns the latest
 *   4. multiple active waves with identical CreatedAt → tiebreak by WaveId
 *   5. unknown RunId → returns null
 *
 * Run with:
 *   cd backend && npm test
 *   (or: node --test src/demo/persistentStore.computeOrderFulfillment.test.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _selectActiveWaveForRun } from './persistentStore.js';

test('Bug A: cancelled + completed run picks the completed wave (not the first cancelled one)', () => {
  // Mirrors the real RunId=64 shape from the production store on 2026-05-15.
  const waves = [
    { WaveId: 24, RunId: 64, Status: 'CANCELLED', CreatedAt: '2026-05-15T03:55:42.769Z' },
    { WaveId: 25, RunId: 64, Status: 'CANCELLED', CreatedAt: '2026-05-15T04:13:24.901Z' },
    { WaveId: 27, RunId: 64, Status: 'CANCELLED', CreatedAt: '2026-05-15T14:46:43.471Z' },
    { WaveId: 29, RunId: 64, Status: 'COMPLETED', CreatedAt: '2026-05-15T14:49:22.205Z' },
  ];
  const pick = _selectActiveWaveForRun(waves, 64);
  assert.equal(pick?.WaveId, 29, 'must pick the COMPLETED wave 29, not any of the CANCELLED ones');
  assert.equal(pick?.Status, 'COMPLETED');
});

test('Bug A: run with ONLY cancelled waves → returns null (no crash, caller emits NO_ACTIVE_WAVE)', () => {
  const waves = [
    { WaveId: 1, RunId: 99, Status: 'CANCELLED', CreatedAt: '2026-05-15T03:00:00.000Z' },
    { WaveId: 2, RunId: 99, Status: 'CANCELLED', CreatedAt: '2026-05-15T04:00:00.000Z' },
  ];
  const pick = _selectActiveWaveForRun(waves, 99);
  assert.equal(pick, null, 'must return null so the caller returns reason: NO_ACTIVE_WAVE');
});

test('Bug A: multiple active waves → returns the latest by CreatedAt', () => {
  const waves = [
    { WaveId: 10, RunId: 50, Status: 'IN_PROGRESS', CreatedAt: '2026-05-10T08:00:00.000Z' },
    { WaveId: 11, RunId: 50, Status: 'COMPLETED',   CreatedAt: '2026-05-12T09:00:00.000Z' },
    { WaveId: 12, RunId: 50, Status: 'IN_PROGRESS', CreatedAt: '2026-05-11T10:00:00.000Z' },
  ];
  const pick = _selectActiveWaveForRun(waves, 50);
  assert.equal(pick?.WaveId, 11, 'must pick the wave with the latest CreatedAt');
});

test('Bug A: ties on CreatedAt → tiebreak by higher WaveId', () => {
  const sameTs = '2026-05-15T12:00:00.000Z';
  const waves = [
    { WaveId: 30, RunId: 70, Status: 'IN_PROGRESS', CreatedAt: sameTs },
    { WaveId: 31, RunId: 70, Status: 'IN_PROGRESS', CreatedAt: sameTs },
    { WaveId: 32, RunId: 70, Status: 'IN_PROGRESS', CreatedAt: sameTs },
  ];
  const pick = _selectActiveWaveForRun(waves, 70);
  assert.equal(pick?.WaveId, 32, 'with identical timestamps, the highest WaveId wins');
});

test('Bug A: unknown RunId → returns null', () => {
  const waves = [
    { WaveId: 1, RunId: 1, Status: 'COMPLETED', CreatedAt: '2026-05-15T08:00:00.000Z' },
  ];
  assert.equal(_selectActiveWaveForRun(waves, 999), null);
});

test('Bug A: empty / missing waves input → returns null (defensive)', () => {
  assert.equal(_selectActiveWaveForRun([], 1), null);
  assert.equal(_selectActiveWaveForRun(null, 1), null);
  assert.equal(_selectActiveWaveForRun(undefined, 1), null);
});

test('Bug A: RunId coerces strings → number (real callers pass `Number(runId)`)', () => {
  const waves = [
    { WaveId: 5, RunId: 42, Status: 'COMPLETED', CreatedAt: '2026-05-15T08:00:00.000Z' },
  ];
  // The helper does `Number(runId)` internally — string '42' must match.
  assert.equal(_selectActiveWaveForRun(waves, '42')?.WaveId, 5);
});
