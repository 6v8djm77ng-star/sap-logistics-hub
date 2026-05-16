/**
 * Unit tests for the pickAllocation auto-complete bug fix (2026-05-16).
 *
 * Background: pickAllocation used to auto-advance wave.Status to
 * 'COMPLETED' and run.Status to 'LOADED' as soon as all lines were
 * picked. That skipped QC entirely, so approveWaveQc (the SOLE producer
 * of Delivery Notes) could never run on those waves — leaving them
 * stuck in LOADED with 0 DNs and invisible on the documents screen.
 * Four real runs (25, 75, 76, 77) ended up in this state.
 *
 * Fix: when all picking is done, pickAllocation now moves wave.Status
 * to 'PENDING_QC' (matching recordPick) and does NOT touch run.Status.
 * approveWaveQc remains the only place that advances run to LOADED.
 *
 * What this file tests (pure, no store stubbing):
 *   - _nextWaveStatusOnPickingDone: IN_PROGRESS → PENDING_QC
 *   - _nextWaveStatusOnPickingDone: PENDING → PENDING_QC
 *   - _nextWaveStatusOnPickingDone: PENDING_QC → PENDING_QC (idempotent)
 *   - _nextWaveStatusOnPickingDone: COMPLETED → COMPLETED (no downgrade)
 *   - _nextWaveStatusOnPickingDone: unknown status → PENDING_QC (defensive)
 *
 * Not covered here (called out for awareness):
 *   - pickAllocation's run.Status NON-mutation — verified by reading
 *     persistentStore.js around line 2044 (no run.Status assignment in
 *     the allDone branch after this fix).
 *   - recordPick → PENDING_QC: already tested in
 *     persistentStore.recordPick.test.js (Bug B test suite).
 *   - approveWaveQc behaviour after the fix: unchanged, already
 *     exercised by the existing flushAggregateDocsForRun smoke from
 *     A2c-2 / Bug B.
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.pickAllocation.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _nextWaveStatusOnPickingDone } from './persistentStore.js';

test('pickAllocation fix: IN_PROGRESS wave → PENDING_QC (the main bug-fix case)', () => {
  // This is the path the four stuck runs (25/75/76/77) hit: wave was
  // IN_PROGRESS (set on first pick), all lines completed, used to
  // auto-COMPLETE → must now go to PENDING_QC and wait for approveWaveQc.
  assert.equal(_nextWaveStatusOnPickingDone('IN_PROGRESS'), 'PENDING_QC');
});

test('pickAllocation fix: PENDING wave → PENDING_QC (edge case)', () => {
  // Possible if a single allocation completes the whole wave in one call
  // before wave.Status was ever flipped to IN_PROGRESS. Should still
  // require QC.
  assert.equal(_nextWaveStatusOnPickingDone('PENDING'), 'PENDING_QC');
});

test('pickAllocation fix: PENDING_QC wave stays PENDING_QC (idempotent)', () => {
  // Defensive: re-applying the rule to a wave already at PENDING_QC
  // must not bounce it elsewhere.
  assert.equal(_nextWaveStatusOnPickingDone('PENDING_QC'), 'PENDING_QC');
});

test('pickAllocation fix: COMPLETED wave is NOT downgraded', () => {
  // Critical guard: if a wave was already QC-approved (Status=COMPLETED
  // with QcApprovedAt set), a stray late pickAllocation call must NOT
  // pull it back to PENDING_QC. Status stays COMPLETED.
  assert.equal(_nextWaveStatusOnPickingDone('COMPLETED'), 'COMPLETED');
});

test('pickAllocation fix: unknown / null / undefined Status → PENDING_QC (defensive)', () => {
  assert.equal(_nextWaveStatusOnPickingDone(undefined), 'PENDING_QC');
  assert.equal(_nextWaveStatusOnPickingDone(null), 'PENDING_QC');
  assert.equal(_nextWaveStatusOnPickingDone(''), 'PENDING_QC');
  assert.equal(_nextWaveStatusOnPickingDone('SOME_FUTURE_STATE'), 'PENDING_QC');
});

test('pickAllocation fix: function is pure — same input always gives same output', () => {
  // No hidden state, no Date.now() dependency, no env reads.
  const before = _nextWaveStatusOnPickingDone('IN_PROGRESS');
  const after  = _nextWaveStatusOnPickingDone('IN_PROGRESS');
  assert.equal(before, after);
  assert.equal(before, 'PENDING_QC');
});
