/**
 * Unit tests for the A2d `_applyWriteResultToInv` helper — the Invoice
 * counterpart to A2c-4a's `_applyWriteResultToDn`.
 *
 * Why this file exists separately: the helper is pure and easier to test in
 * isolation than the full flushAggregateDocsForRun pipeline (which needs
 * runs/stops/runOrders/customer profiles/waveAllocations). This mirrors the
 * approach in persistentStore.flushLive.test.js for DNs.
 *
 * Scope (matches A2d approved scope):
 *   1. dry-run result → audit fields updated, Status NOT advanced
 *   2. live success   → SapInvoiceDocEntry persisted + Status='EXPORTED'
 *   3. failure        → Status stays PENDING_EXPORT, SapWriteLastError set
 *   4. fallback error messages for empty wr.error
 *   5. defensive idempotency — dry-run on already-EXPORTED inv does NOT undo
 *   6. defensive: missing inputs are no-ops
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.flushLiveInv.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _applyWriteResultToInv } from './persistentStore.js';

function freshInv(overrides = {}) {
  return {
    InvoiceId: 200,
    DocNumber: 'INV-AGG-1-A-0001',
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapInvoiceDocNum: null,
    ExportedAt: null,
    SentToSapAt: null,
    LastDryRunPayloadAt: null,
    LastDryRunPayloadPreview: null,
    SapWriteAttempts: 1,
    SapWriteAttemptedAt: '2026-05-19T00:00:00.000Z',
    SapWriteLastError: null,
    ...overrides,
  };
}

function wrSuccess({ dryRun = true, sapDocEntry = null, sapDocNum = null, payload = null } = {}) {
  return {
    ok: true,
    dryRun,
    sapDocEntry,
    sapDocNum,
    payload: payload || {
      CardCode: 'C1',
      DocDate: '2026-05-19',
      DocumentLines: [{ ItemCode: 'SKU-A', Quantity: 3 }],
    },
  };
}

function wrFailure({ dryRun = false, error = 'SAP login failed' } = {}) {
  return { ok: false, dryRun, error, payload: null };
}

// ============================================================================
// 1. dry-run result → audit only
// ============================================================================

test('A2d / dry-run result: audit fields updated, Status NOT advanced', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, wrSuccess({ dryRun: true }));

  assert.equal(inv.Status, 'PENDING_EXPORT', 'Status must NOT advance on dry-run');
  assert.equal(inv.SapInvoiceDocEntry, null);
  assert.equal(inv.SapInvoiceDocNum, null);
  assert.equal(inv.ExportedAt, null);
  assert.equal(inv.SentToSapAt, null);
  assert.ok(inv.LastDryRunPayloadAt, 'audit timestamp set');
  assert.match(inv.LastDryRunPayloadPreview, /CardCode/);
  assert.equal(inv.SapWriteLastError, null);
});

// ============================================================================
// 2. live success → SapInvoiceDocEntry persisted + Status='EXPORTED'
// ============================================================================

test('A2d / live success: SapInvoiceDocEntry persisted, Status=EXPORTED', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, wrSuccess({ dryRun: false, sapDocEntry: 4321, sapDocNum: 8765 }));

  assert.equal(inv.SapInvoiceDocEntry, 4321);
  assert.equal(inv.SapInvoiceDocNum, 8765);
  assert.equal(inv.Status, 'EXPORTED');
  assert.ok(inv.ExportedAt);
  assert.ok(inv.SentToSapAt);
  assert.equal(inv.SapWriteLastError, null);
});

// ============================================================================
// 3. failure → Status stays + SapWriteLastError captured
// ============================================================================

test('A2d / failure: Status stays PENDING_EXPORT, error captured', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, wrFailure({ error: 'SAP HTTP 500: timeout' }));

  assert.equal(inv.Status, 'PENDING_EXPORT');
  assert.equal(inv.SapInvoiceDocEntry, null);
  assert.equal(inv.SapInvoiceDocNum, null);
  assert.equal(inv.SapWriteLastError, 'SAP HTTP 500: timeout');
  assert.equal(inv.ExportedAt, null);
  assert.equal(inv.SentToSapAt, null);
});

// ============================================================================
// 4. empty-error fallback messages
// ============================================================================

test('A2d / failure: dry-run empty error gets dry-run fallback', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, { ok: false, dryRun: true, error: '', payload: null });
  assert.equal(inv.Status, 'PENDING_EXPORT');
  assert.equal(inv.SapWriteLastError, 'unknown dry-run failure');
});

test('A2d / failure: live empty error gets live fallback', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, { ok: false, dryRun: false, error: '', payload: null });
  assert.equal(inv.SapWriteLastError, 'unknown live write failure');
});

// ============================================================================
// 5. defensive idempotency — dry-run on EXPORTED inv preserves live state
// ============================================================================

test('A2d / no regression: dry-run on EXPORTED inv does NOT undo live state', () => {
  const exported = freshInv({
    Status: 'EXPORTED',
    SapInvoiceDocEntry: 9999,
    SapInvoiceDocNum: 7777,
    ExportedAt: '2026-05-19T10:00:00.000Z',
    SentToSapAt: '2026-05-19T10:00:00.000Z',
  });
  _applyWriteResultToInv(exported, wrSuccess({ dryRun: true }));

  assert.equal(exported.SapInvoiceDocEntry, 9999);
  assert.equal(exported.SapInvoiceDocNum, 7777);
  assert.equal(exported.Status, 'EXPORTED');
  assert.equal(exported.ExportedAt, '2026-05-19T10:00:00.000Z');
});

// ============================================================================
// 6. defensive: missing inputs
// ============================================================================

test('A2d / defensive: missing inv or wr is a no-op (no throw)', () => {
  assert.doesNotThrow(() => _applyWriteResultToInv(null, wrSuccess({})));
  assert.doesNotThrow(() => _applyWriteResultToInv(freshInv(), null));
  assert.doesNotThrow(() => _applyWriteResultToInv(null, null));
  assert.doesNotThrow(() => _applyWriteResultToInv(undefined, undefined));
});

test('A2d / defensive: wr.ok=true but no payload is a no-op (no mutation)', () => {
  const inv = freshInv();
  const before = JSON.stringify(inv);
  _applyWriteResultToInv(inv, { ok: true, payload: null });
  assert.equal(JSON.stringify(inv), before);
});

test('A2d / safety: live success without sapDocEntry does NOT advance Status', () => {
  const inv = freshInv();
  _applyWriteResultToInv(inv, {
    ok: true, dryRun: false, sapDocEntry: null, sapDocNum: null,
    payload: { CardCode: 'C1', DocDate: '2026-05-19', DocumentLines: [{ ItemCode: 'X', Quantity: 1 }] },
  });
  assert.equal(inv.Status, 'PENDING_EXPORT');
  assert.equal(inv.SapInvoiceDocEntry, null);
  assert.equal(inv.ExportedAt, null);
  // Audit fields ARE updated — the payload was sent
  assert.ok(inv.LastDryRunPayloadAt);
});
