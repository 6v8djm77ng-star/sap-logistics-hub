/**
 * Unit tests — canExportInvoiceToSap (DEV.14).
 *
 * Why this exists:
 *   The new admin endpoint POST /api/admin/sap-write/invoices/:id/export-test
 *   pushes a single PENDING_EXPORT invoice to SAP TEST. To do that safely we
 *   need a hard guard that rejects malformed / already-exported / wrong-status
 *   invoices BEFORE the network call. canExportInvoiceToSap is that guard.
 *
 *   Same pattern as DEV.13's canRevertConfirmation: pure function, no
 *   store access, no env, no I/O. Tests drive every branch with hand-built
 *   fixtures so we can cover edge cases without touching the real store.
 *
 * Pure unit tests — no PM2, no SAP, no HTTP, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canExportInvoiceToSap } from './persistentStore.js';

// -----------------------------------------------------------------------------
// Reject cases
// -----------------------------------------------------------------------------

test('rejects null invoice', () => {
  const r = canExportInvoiceToSap(null);
  assert.equal(r.error, 'INVOICE_NOT_FOUND');
});

test('rejects undefined invoice', () => {
  const r = canExportInvoiceToSap(undefined);
  assert.equal(r.error, 'INVOICE_NOT_FOUND');
});

test('rejects non-object invoice (string)', () => {
  const r = canExportInvoiceToSap('INV-3');
  assert.equal(r.error, 'INVOICE_NOT_FOUND');
});

test('rejects invoice with Status=SAP_CONFIRMED', () => {
  const inv = {
    Status: 'SAP_CONFIRMED',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NOT_PENDING_EXPORT');
  assert.equal(r.current, 'SAP_CONFIRMED');
});

test('rejects invoice with Status=CANCELLED', () => {
  const inv = {
    Status: 'CANCELLED',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NOT_PENDING_EXPORT');
});

test('rejects invoice with Status=EXPORTED (already in motion)', () => {
  const inv = {
    Status: 'EXPORTED',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NOT_PENDING_EXPORT');
});

test('rejects invoice that already has SapInvoiceDocEntry (real number)', () => {
  // The critical anti-double-write check. 42211 is a real SAP DocEntry
  // from LIVE.4. Trying to re-export it must fail to prevent a duplicate
  // invoice in SAP.
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: 42211,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'ALREADY_EXPORTED');
  assert.equal(r.existingDocEntry, 42211);
});

test('rejects invoice with placeholder SapInvoiceDocEntry="1" (legacy bad data)', () => {
  // Mirrors DN-40/83/84 pattern that motivated DEV.10/13. We still treat
  // it as "something is there, refuse" — the operator should revert via
  // DEV.13 (revertSapConfirmation) before re-exporting.
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: '1',
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'ALREADY_EXPORTED');
});

test('rejects invoice with missing SapCardCode', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'MISSING_CARD_CODE');
});

test('rejects invoice with empty-string SapCardCode', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'MISSING_CARD_CODE');
});

test('rejects invoice with missing CompanyCode', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'MISSING_COMPANY_CODE');
});

test('rejects invoice with empty Lines array', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NO_LINES');
});

test('rejects invoice with missing Lines field', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NO_LINES');
});

test('rejects invoice with Lines that is not an array', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: 'not-an-array',
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.error, 'NO_LINES');
});

// -----------------------------------------------------------------------------
// Accept cases
// -----------------------------------------------------------------------------

test('accepts a fully valid invoice (mirrors INV-3 shape)', () => {
  const inv = {
    InvoiceId: 3,
    DocNumber: 'INV-16-A-0004',
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapInvoiceDocNum: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: '20304', Picked: 1, Ordered: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.deepEqual(r, { ok: true });
});

test('accepts invoice with SapInvoiceDocEntry=null (the canonical "not exported" state)', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.ok, true);
});

test('accepts invoice with SapInvoiceDocEntry=0 (falsy, treated as not exported)', () => {
  // 0 is a placeholder we would never produce ourselves (CONFIRM_SAP_MIN_DOCENTRY
  // forbids it via DEV.10) but defensively: 0 is falsy, so the "already exported"
  // check does not fire. Letting it through is fine because the downstream
  // payload builder treats it as no-DocEntry anyway.
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: 0,
    SapCardCode: '2501556',
    CompanyCode: 'A',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.ok, true);
});

test('accepts invoice for company B (Test_Unico path) — future-proof', () => {
  const inv = {
    Status: 'PENDING_EXPORT',
    SapInvoiceDocEntry: null,
    SapCardCode: '5000001',
    CompanyCode: 'B',
    Lines: [{ ItemCode: 'X', Picked: 1 }],
  };
  const r = canExportInvoiceToSap(inv);
  assert.equal(r.ok, true);
});
