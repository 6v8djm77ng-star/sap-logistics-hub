/**
 * Unit tests — confirmSapDocument validation (2026-05-24 safeguard).
 *
 * Why this exists:
 *   The store currently holds 3 SAP_CONFIRMED Delivery Notes with
 *   SapDeliveryDocEntry=1 (DN-40, DN-83, DN-84). These are placeholder
 *   values an operator typed into the manual-confirm UI — they do NOT
 *   correspond to any real SAP DocEntry. Real TEST_OIG DocEntries are
 *   4-5 digits (e.g. DN 42211, INV 86011). The validation added in
 *   persistentStore.js floors sapDocEntry at CONFIRM_SAP_MIN_DOCENTRY
 *   to catch typos / placeholders / "I'll fix it later" before they
 *   create another fake confirmation.
 *
 * These tests do NOT mutate the real store: they pass docId=-1 to the
 * "valid input" cases, so even if validation passes the find() call
 * returns undefined and the function exits with null (no save()).
 *
 * Pure unit tests — no PM2, no SAP, no HTTP, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmSapDocument, CONFIRM_SAP_MIN_DOCENTRY } from './persistentStore.js';

// Use docId=-1 throughout: no record has a negative DeliveryNoteId/InvoiceId,
// so find() returns undefined and the function exits without save().
const NON_EXISTENT_ID = -1;

test('CONFIRM_SAP_MIN_DOCENTRY is exported and >= 2 (sane floor)', () => {
  assert.equal(typeof CONFIRM_SAP_MIN_DOCENTRY, 'number');
  assert.ok(CONFIRM_SAP_MIN_DOCENTRY >= 2,
    'floor must be at least 2 to catch the SapDE=1 placeholders we already have');
});

test('rejects sapDocEntry=1 (the exact placeholder in DN-40, DN-83, DN-84)', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', 1, 1);
  assert.equal(r.error, 'INVALID_SAP_DOC_ENTRY');
  assert.equal(r.floor, CONFIRM_SAP_MIN_DOCENTRY);
  assert.deepEqual(r.provided, { sapDocEntry: 1, sapDocNum: 1 });
});

test('rejects sapDocEntry=0', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', 0, 1);
  assert.equal(r.error, 'INVALID_SAP_DOC_ENTRY');
});

test('rejects sapDocEntry=99 (just below floor)', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', CONFIRM_SAP_MIN_DOCENTRY - 1, 1);
  assert.equal(r.error, 'INVALID_SAP_DOC_ENTRY');
});

test('rejects negative sapDocEntry', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', -42211, 42211);
  assert.equal(r.error, 'INVALID_SAP_DOC_ENTRY');
});

test('rejects non-integer sapDocEntry (string, null, undefined, float)', () => {
  for (const bad of [null, undefined, 'abc', '', 42211.5, NaN, true, {}, []]) {
    const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', bad, 42211);
    assert.equal(r?.error, 'INVALID_SAP_DOC_ENTRY',
      `value=${JSON.stringify(bad)} (typeof=${typeof bad}) should be rejected`);
  }
});

test('accepts string "42211" because Number("42211")===42211 (intentional ergonomics)', () => {
  // We use Number() in the check, so numeric strings still parse. This is by
  // design: the HTTP body often arrives with stringified numbers. Document
  // the contract here so a future refactor doesn't silently tighten it.
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', '42211', '42211');
  // Validation passes → null because docId=-1 doesn't exist
  assert.equal(r, null,
    'valid numeric string should pass validation; null = doc not found, not validation error');
});

test('rejects sapDocNum invalid even when sapDocEntry is valid', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', 42211, 0);
  assert.equal(r.error, 'INVALID_SAP_DOC_NUM');
});

test('rejects negative sapDocNum', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', 42211, -1);
  assert.equal(r.error, 'INVALID_SAP_DOC_NUM');
});

test('passes validation with realistic LIVE.4 values (42211, 42211); null because doc not found', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote', 42211, 42211);
  assert.equal(r, null);
});

test('passes at the exact floor — CONFIRM_SAP_MIN_DOCENTRY', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'deliveryNote',
    CONFIRM_SAP_MIN_DOCENTRY, CONFIRM_SAP_MIN_DOCENTRY);
  assert.equal(r, null,
    'value at the floor should pass validation; null = doc not found');
});

test('same validation applies to invoice type, not just deliveryNote', () => {
  const r = confirmSapDocument(NON_EXISTENT_ID, 'invoice', 1, 1);
  assert.equal(r.error, 'INVALID_SAP_DOC_ENTRY',
    'invoice type must also reject placeholder DocEntry');
});
