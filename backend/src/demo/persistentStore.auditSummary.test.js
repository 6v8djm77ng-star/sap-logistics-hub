/**
 * Unit tests for A2e _computeAuditSummary — the pure aggregate over the
 * A2-1 (DN) + A2d (Invoice) audit fields surfaced through
 * /api/documents/stats so the operator can see at a glance:
 *
 *   - how many DNs / INVs are stuck with a SapWriteLastError
 *   - cumulative SapWriteAttempts (writer activity)
 *   - most recent LastDryRunPayloadAt across BOTH doc types
 *
 * Pure function — no env, no store, no HTTP.
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.auditSummary.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _computeAuditSummary } from './persistentStore.js';

function dn(overrides = {}) {
  return {
    DeliveryNoteId: 100,
    SapWriteAttempts: 0,
    LastDryRunPayloadAt: null,
    SapWriteLastError: null,
    ...overrides,
  };
}

function inv(overrides = {}) {
  return {
    InvoiceId: 200,
    SapWriteAttempts: 0,
    LastDryRunPayloadAt: null,
    SapWriteLastError: null,
    ...overrides,
  };
}

// ============================================================================
// Empty / defensive inputs
// ============================================================================

test('A2e / empty inputs return zeros and null timestamp', () => {
  const r = _computeAuditSummary([], []);
  assert.deepEqual(r, {
    deliveryNotes: { withErrors: 0, totalAttempts: 0 },
    invoices:      { withErrors: 0, totalAttempts: 0 },
    lastWriteAttemptAt: null,
    combinedErrorsCount: 0,
  });
});

test('A2e / non-array inputs are treated as empty (no throw)', () => {
  assert.doesNotThrow(() => _computeAuditSummary(null, undefined));
  const r = _computeAuditSummary(null, undefined);
  assert.equal(r.deliveryNotes.withErrors, 0);
  assert.equal(r.invoices.withErrors, 0);
  assert.equal(r.lastWriteAttemptAt, null);
});

test('A2e / null/undefined entries inside arrays are skipped (no throw)', () => {
  const r = _computeAuditSummary([null, undefined, dn()], [undefined, inv()]);
  assert.equal(r.deliveryNotes.withErrors, 0);
  assert.equal(r.invoices.withErrors, 0);
});

// ============================================================================
// withErrors counter — based on SapWriteLastError
// ============================================================================

test('A2e / withErrors counts only docs with a non-null SapWriteLastError', () => {
  const dns = [
    dn({ SapWriteLastError: 'SAP HTTP 500' }),
    dn({ SapWriteLastError: 'timeout' }),
    dn({ SapWriteLastError: null }),
    dn({ SapWriteLastError: '' }),       // falsy → not counted
  ];
  const invs = [
    inv({ SapWriteLastError: 'invalid payload' }),
    inv({ SapWriteLastError: null }),
  ];
  const r = _computeAuditSummary(dns, invs);
  assert.equal(r.deliveryNotes.withErrors, 2);
  assert.equal(r.invoices.withErrors, 1);
  assert.equal(r.combinedErrorsCount, 3);
});

// ============================================================================
// totalAttempts — sum across docs
// ============================================================================

test('A2e / totalAttempts sums SapWriteAttempts across all docs of a type', () => {
  const dns = [
    dn({ SapWriteAttempts: 3 }),
    dn({ SapWriteAttempts: 1 }),
    dn({ SapWriteAttempts: 0 }),
  ];
  const invs = [
    inv({ SapWriteAttempts: 2 }),
    inv({ SapWriteAttempts: 5 }),
  ];
  const r = _computeAuditSummary(dns, invs);
  assert.equal(r.deliveryNotes.totalAttempts, 4);
  assert.equal(r.invoices.totalAttempts, 7);
});

test('A2e / totalAttempts handles missing / non-numeric values gracefully', () => {
  const dns = [
    dn({ SapWriteAttempts: undefined }),
    dn({ SapWriteAttempts: null }),
    dn({ SapWriteAttempts: 'not-a-number' }),
    dn({ SapWriteAttempts: 4 }),
  ];
  const r = _computeAuditSummary(dns, []);
  assert.equal(r.deliveryNotes.totalAttempts, 4);
});

// ============================================================================
// lastWriteAttemptAt — chronological max across BOTH types
// ============================================================================

test('A2e / lastWriteAttemptAt picks chronological max across DN and INV', () => {
  const dns = [
    dn({ LastDryRunPayloadAt: '2026-05-15T08:00:00.000Z' }),
    dn({ LastDryRunPayloadAt: '2026-05-16T09:00:00.000Z' }),
  ];
  const invs = [
    inv({ LastDryRunPayloadAt: '2026-05-19T22:50:00.000Z' }),
    inv({ LastDryRunPayloadAt: '2026-05-17T10:00:00.000Z' }),
  ];
  const r = _computeAuditSummary(dns, invs);
  assert.equal(r.lastWriteAttemptAt, '2026-05-19T22:50:00.000Z');
});

test('A2e / lastWriteAttemptAt: DN-only when invoices have no timestamps', () => {
  const dns = [dn({ LastDryRunPayloadAt: '2026-05-19T00:00:00.000Z' })];
  const r = _computeAuditSummary(dns, [inv()]);
  assert.equal(r.lastWriteAttemptAt, '2026-05-19T00:00:00.000Z');
});

test('A2e / lastWriteAttemptAt: INV wins if it is later than the latest DN', () => {
  const dns = [dn({ LastDryRunPayloadAt: '2026-05-10T00:00:00.000Z' })];
  const invs = [inv({ LastDryRunPayloadAt: '2026-05-20T00:00:00.000Z' })];
  const r = _computeAuditSummary(dns, invs);
  assert.equal(r.lastWriteAttemptAt, '2026-05-20T00:00:00.000Z');
});

test('A2e / lastWriteAttemptAt: null when no doc has a timestamp', () => {
  const r = _computeAuditSummary([dn(), dn()], [inv()]);
  assert.equal(r.lastWriteAttemptAt, null);
});

// ============================================================================
// Realistic post-A2d scenario — one aggregate flush that did dry-run DN+INV,
// followed by another that failed mid-INV (writeInvoice 422 / SAP HTTP error)
// ============================================================================

test('A2e / realistic mixed scenario: DN+INV dry-run plus one INV failure', () => {
  const dns = [
    dn({
      DeliveryNoteId: 1,
      SapWriteAttempts: 1,
      LastDryRunPayloadAt: '2026-05-20T00:10:00.000Z',
      SapWriteLastError: null,
    }),
    dn({
      DeliveryNoteId: 2,
      SapWriteAttempts: 1,
      LastDryRunPayloadAt: '2026-05-20T00:12:00.000Z',
      SapWriteLastError: null,
    }),
  ];
  const invs = [
    inv({
      InvoiceId: 1,
      SapWriteAttempts: 1,
      LastDryRunPayloadAt: '2026-05-20T00:10:01.000Z',
      SapWriteLastError: null,
    }),
    inv({
      InvoiceId: 2,
      SapWriteAttempts: 2,
      LastDryRunPayloadAt: '2026-05-20T00:12:30.000Z',
      SapWriteLastError: 'SAP HTTP 500: timeout',
    }),
  ];
  const r = _computeAuditSummary(dns, invs);
  assert.deepEqual(r, {
    deliveryNotes: { withErrors: 0, totalAttempts: 2 },
    invoices:      { withErrors: 1, totalAttempts: 3 },
    lastWriteAttemptAt: '2026-05-20T00:12:30.000Z',
    combinedErrorsCount: 1,
  });
});
