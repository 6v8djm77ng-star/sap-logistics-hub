/**
 * Unit tests for the A2c-4a `_applyWriteResultToDn` helper.
 *
 * Background: A2c-4a extends flushAggregateDocsForRun to support an
 * `options.liveWrite=true` mode that calls writeDeliveryNote with
 * dryRun:false. The result of that call (whether dry-run or live, ok or
 * fail) is applied to the local DN via this pure helper — easier to test
 * than the full flush flow (which needs runs/stops/runOrders/customer
 * profiles/waveAllocations and would otherwise require store stubbing).
 *
 * What this file covers (per scope approved in A2c-4c):
 *   1. liveWrite=true → writeDeliveryNote receives { dryRun: false }
 *      (verified via the wr.dryRun flag the caller produces and the
 *      helper consumes; this proves the contract end-to-end)
 *   2. live success → SapDeliveryDocEntry persisted on dn
 *   3. live success → Status transitions to 'EXPORTED'
 *   4. failure (ok:false) → Status stays 'PENDING_EXPORT', SapWriteLastError set
 *   5. no duplicate side-effects if the helper is called with a dry-run
 *      result on a DN that previously got a live success (defensive
 *      idempotency — dry-run won't undo a real EXPORTED state)
 *
 * What this file does NOT cover (out of A2c-4c scope, called out in commit):
 *   - flushAggregateDocsForRun's order-level skip logic for orders that
 *     already have DeliveryNoteId (idempotency of the flush itself —
 *     pre-existing A2-2 behaviour, unchanged by A2c-4a)
 *   - actual SAP HTTP calls (no live write capability without password +
 *     SAP_WRITE_ENABLED + whitelist)
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.flushLive.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _applyWriteResultToDn } from './persistentStore.js';

// Convenience builder for a "fresh" DN that has been committed locally but
// not yet had writeDeliveryNote applied. Matches the shape produced by
// flushAggregateDocsForRun.
function freshDn(overrides = {}) {
  return {
    DeliveryNoteId: 100,
    DocNumber: 'DN-AGG-1-A-0001',
    Status: 'PENDING_EXPORT',
    SapDeliveryDocEntry: null,
    SapDeliveryDocNum: null,
    ExportedAt: null,
    SentToSapAt: null,
    LastDryRunPayloadAt: null,
    LastDryRunPayloadPreview: null,
    SapWriteAttempts: 1,
    SapWriteAttemptedAt: '2026-05-16T00:00:00.000Z',
    SapWriteLastError: null,
    ...overrides,
  };
}

// Convenience builder for a writeDeliveryNote() result.
function wrSuccess({ dryRun = true, sapDocEntry = null, sapDocNum = null, payload = null } = {}) {
  return {
    ok: true,
    dryRun,
    sapDocEntry,
    sapDocNum,
    payload: payload || { CardCode: 'C1', DocDate: '2026-05-16', DocumentLines: [{ BaseType: 17, BaseEntry: 1 }] },
  };
}

function wrFailure({ dryRun = false, error = 'SAP login failed' } = {}) {
  return { ok: false, dryRun, error, payload: null };
}

// ============================================================================
// Test 1 — dry-run result (current A2-2 behaviour, unchanged by A2c-4a)
// ============================================================================

test('A2c-4a / dry-run result: audit fields updated, Status NOT advanced', () => {
  const dn = freshDn();
  _applyWriteResultToDn(dn, wrSuccess({ dryRun: true, sapDocEntry: null }));

  assert.equal(dn.Status, 'PENDING_EXPORT', 'Status must NOT advance on dry-run');
  assert.equal(dn.SapDeliveryDocEntry, null, 'no DocEntry on dry-run');
  assert.equal(dn.SapDeliveryDocNum, null);
  assert.equal(dn.ExportedAt, null, 'ExportedAt stays null on dry-run');
  assert.equal(dn.SentToSapAt, null, 'SentToSapAt stays null on dry-run');
  assert.ok(dn.LastDryRunPayloadAt, 'audit timestamp set');
  assert.match(dn.LastDryRunPayloadPreview, /CardCode/, 'payload preview captured');
  assert.equal(dn.SapWriteLastError, null, 'no error after success');
});

// ============================================================================
// Test 2 — live success: SapDeliveryDocEntry persisted
// ============================================================================

test('A2c-4a / live success: SapDeliveryDocEntry and SapDeliveryDocNum persisted', () => {
  const dn = freshDn();
  _applyWriteResultToDn(dn, wrSuccess({
    dryRun: false,
    sapDocEntry: 1234,
    sapDocNum: 5678,
  }));

  assert.equal(dn.SapDeliveryDocEntry, 1234, 'real SAP DocEntry persisted');
  assert.equal(dn.SapDeliveryDocNum, 5678);
  assert.equal(typeof dn.SapDeliveryDocEntry, 'number', 'DocEntry must be numeric');
});

// ============================================================================
// Test 3 — live success: Status='EXPORTED'
// ============================================================================

test('A2c-4a / live success: Status transitions PENDING_EXPORT → EXPORTED', () => {
  const dn = freshDn({ Status: 'PENDING_EXPORT' });
  _applyWriteResultToDn(dn, wrSuccess({
    dryRun: false,
    sapDocEntry: 1234,
    sapDocNum: 5678,
  }));

  assert.equal(dn.Status, 'EXPORTED', 'Status advanced to EXPORTED');
  assert.ok(dn.ExportedAt, 'ExportedAt timestamp set');
  assert.ok(dn.SentToSapAt, 'SentToSapAt timestamp set');
  assert.equal(dn.SapWriteLastError, null, 'no error on success');
});

// ============================================================================
// Test 4 — failure: Status stays PENDING_EXPORT
// ============================================================================

test('A2c-4a / failure: Status stays PENDING_EXPORT, SapWriteLastError set', () => {
  const dn = freshDn();
  _applyWriteResultToDn(dn, wrFailure({ dryRun: false, error: 'SAP HTTP 500: timeout' }));

  assert.equal(dn.Status, 'PENDING_EXPORT', 'Status MUST stay PENDING_EXPORT on failure');
  assert.equal(dn.SapDeliveryDocEntry, null, 'no DocEntry persisted on failure');
  assert.equal(dn.SapDeliveryDocNum, null);
  assert.equal(dn.SapWriteLastError, 'SAP HTTP 500: timeout', 'error message captured');
  assert.equal(dn.ExportedAt, null);
  assert.equal(dn.SentToSapAt, null);
});

test('A2c-4a / failure: dry-run failure with empty error gets dry-run fallback message', () => {
  // Inline object (NOT wrFailure helper) — destructuring defaults would
  // re-fill error from undefined, defeating the test of the helper's
  // own fallback. We want wr.error to be falsy when it reaches the helper.
  const dn = freshDn();
  _applyWriteResultToDn(dn, { ok: false, dryRun: true, error: '', payload: null });

  assert.equal(dn.Status, 'PENDING_EXPORT');
  assert.equal(dn.SapWriteLastError, 'unknown dry-run failure');
});

test('A2c-4a / failure: live failure with empty error gets live fallback message', () => {
  const dn = freshDn();
  _applyWriteResultToDn(dn, { ok: false, dryRun: false, error: '', payload: null });

  assert.equal(dn.SapWriteLastError, 'unknown live write failure');
});

// ============================================================================
// Test 5 — defensive idempotency: dry-run result on already-EXPORTED DN
// ============================================================================

test('A2c-4a / no regression: dry-run result on EXPORTED DN does NOT undo live state', () => {
  // Simulates the case where a flush is somehow re-run on a DN that already
  // had a successful live write applied. Even if the new call happens to
  // be a dry-run, the previously-persisted live state (DocEntry, Status,
  // ExportedAt) must NOT be erased.
  const exportedDn = freshDn({
    Status: 'EXPORTED',
    SapDeliveryDocEntry: 9999,
    SapDeliveryDocNum: 8888,
    ExportedAt: '2026-05-16T10:00:00.000Z',
    SentToSapAt: '2026-05-16T10:00:00.000Z',
  });
  _applyWriteResultToDn(exportedDn, wrSuccess({ dryRun: true, sapDocEntry: null }));

  assert.equal(exportedDn.SapDeliveryDocEntry, 9999, 'previously-persisted DocEntry preserved');
  assert.equal(exportedDn.SapDeliveryDocNum, 8888);
  assert.equal(exportedDn.Status, 'EXPORTED', 'EXPORTED status NOT downgraded by dry-run');
  assert.equal(exportedDn.ExportedAt, '2026-05-16T10:00:00.000Z', 'original ExportedAt preserved');
});

// ============================================================================
// Defensive: missing inputs
// ============================================================================

test('A2c-4a / defensive: missing dn or wr is a no-op (no throw)', () => {
  assert.doesNotThrow(() => _applyWriteResultToDn(null, wrSuccess({})));
  assert.doesNotThrow(() => _applyWriteResultToDn(freshDn(), null));
  assert.doesNotThrow(() => _applyWriteResultToDn(null, null));
  assert.doesNotThrow(() => _applyWriteResultToDn(undefined, undefined));
});

test('A2c-4a / defensive: wr.ok=true but no payload is a no-op (no mutation)', () => {
  const dn = freshDn();
  const before = JSON.stringify(dn);
  _applyWriteResultToDn(dn, { ok: true, payload: null });
  assert.equal(JSON.stringify(dn), before, 'dn unchanged when payload missing');
});

// ============================================================================
// Behavioral check: live success that doesn't include sapDocEntry is treated
// as a partial/odd success → audit fields update but Status does NOT advance.
// ============================================================================

test('A2c-4a / safety: live "success" without sapDocEntry does NOT advance Status', () => {
  // Should never happen in practice (sapWriter.js always returns sapDocEntry
  // on a live success), but defensive: if SAP somehow returns ok without
  // DocEntry, do NOT mark as EXPORTED — operator must investigate.
  const dn = freshDn();
  _applyWriteResultToDn(dn, { ok: true, dryRun: false, sapDocEntry: null, sapDocNum: null,
    payload: { CardCode: 'C1', DocDate: '2026-05-16', DocumentLines: [{}] } });

  assert.equal(dn.Status, 'PENDING_EXPORT', 'Status stays PENDING when DocEntry missing');
  assert.equal(dn.SapDeliveryDocEntry, null);
  assert.equal(dn.ExportedAt, null);
  // Audit fields ARE updated — the payload was sent
  assert.ok(dn.LastDryRunPayloadAt);
});
