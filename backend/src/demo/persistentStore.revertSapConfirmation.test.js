/**
 * Unit tests — revertSapConfirmation (DEV.13).
 *
 * Why this exists:
 *   DEV.10/11 prevent NEW fake SAP confirmations from being created. But
 *   the store already holds 3 SAP_CONFIRMED Delivery Notes with
 *   SapDeliveryDocEntry=1 (DN-40, DN-83, DN-84). This module gives the
 *   admin a controlled way to undo those — resetting Status back to
 *   PENDING_EXPORT — WITHOUT touching SAP itself.
 *
 * What we test here:
 *   - The pure guard `canRevertConfirmation` (every branch, hand-built
 *     fixtures — zero store access).
 *   - The store wrapper `revertSapConfirmation` for non-mutating paths
 *     (docId=-1 → null, etc.). We do NOT exercise the success path here
 *     because it would mutate the real store; canRevertConfirmation
 *     coverage is enough to prove the logic.
 *
 * Pure unit tests — no PM2, no SAP, no HTTP, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canRevertConfirmation,
  revertSapConfirmation,
  CONFIRM_SAP_MIN_DOCENTRY,
} from './persistentStore.js';

const NON_EXISTENT_ID = -1;

// -----------------------------------------------------------------------------
// canRevertConfirmation — pure guard
// -----------------------------------------------------------------------------

test('canRevertConfirmation: success on SAP_CONFIRMED DN with SapDocEntry=1', () => {
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: 1 };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.deepEqual(r, { ok: true });
});

test('canRevertConfirmation: success on SAP_CONFIRMED DN with SapDocEntry="1" (string from old data)', () => {
  // The 3 real fakes (DN-40, DN-83, DN-84) store SapDocEntry as string "1"
  // — they predate DEV.10's Number() coercion. Guard must accept that too.
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: '1' };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.deepEqual(r, { ok: true });
});

test('canRevertConfirmation: success on suspicious INV with SapInvoiceDocEntry=42 (just under floor)', () => {
  const inv = { Status: 'SAP_CONFIRMED', SapInvoiceDocEntry: CONFIRM_SAP_MIN_DOCENTRY - 1 };
  const r = canRevertConfirmation(inv, 'SapInvoiceDocEntry');
  assert.deepEqual(r, { ok: true });
});

test('canRevertConfirmation: rejects PENDING_EXPORT (wrong status)', () => {
  const dn = { Status: 'PENDING_EXPORT', SapDeliveryDocEntry: null };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SAP_CONFIRMED');
  assert.equal(r.current, 'PENDING_EXPORT');
});

test('canRevertConfirmation: rejects EXPORTED (wrong status)', () => {
  const dn = { Status: 'EXPORTED', SapDeliveryDocEntry: null };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SAP_CONFIRMED');
});

test('canRevertConfirmation: rejects real SAP_CONFIRMED with SapDocEntry=42211 (above floor)', () => {
  // This is the critical safety property: the endpoint must NEVER revert
  // a real confirmation. 42211 is the DocEntry from LIVE.4 (real TEST_OIG
  // write); attempting to revert it must fail.
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: 42211 };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SUSPICIOUS');
  assert.equal(r.currentDocEntry, 42211);
  assert.equal(r.floor, CONFIRM_SAP_MIN_DOCENTRY);
});

test('canRevertConfirmation: rejects SAP_CONFIRMED at the exact floor (CONFIRM_SAP_MIN_DOCENTRY)', () => {
  // The boundary is `< floor` — anything == floor is considered real.
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: CONFIRM_SAP_MIN_DOCENTRY };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SUSPICIOUS');
});

test('canRevertConfirmation: rejects SAP_CONFIRMED with null SapDocEntry', () => {
  // Null/missing DocEntry can't be characterized as "suspicious vs real"
  // — Number(null)=0 fails the >= 1 check. We refuse rather than guess.
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: null };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SUSPICIOUS');
});

test('canRevertConfirmation: rejects SAP_CONFIRMED with non-numeric SapDocEntry', () => {
  const dn = { Status: 'SAP_CONFIRMED', SapDeliveryDocEntry: 'abc' };
  const r = canRevertConfirmation(dn, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'NOT_SUSPICIOUS');
});

test('canRevertConfirmation: rejects null doc', () => {
  const r = canRevertConfirmation(null, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'DOC_NOT_FOUND');
});

test('canRevertConfirmation: rejects undefined doc', () => {
  const r = canRevertConfirmation(undefined, 'SapDeliveryDocEntry');
  assert.equal(r.error, 'DOC_NOT_FOUND');
});

// -----------------------------------------------------------------------------
// revertSapConfirmation — store wrapper, non-mutating paths only
// -----------------------------------------------------------------------------

test('revertSapConfirmation: returns null for non-existent deliveryNote id', () => {
  const r = revertSapConfirmation('deliveryNote', NON_EXISTENT_ID);
  assert.equal(r, null);
});

test('revertSapConfirmation: returns null for non-existent invoice id (future-proof)', () => {
  const r = revertSapConfirmation('invoice', NON_EXISTENT_ID);
  assert.equal(r, null);
});

test('revertSapConfirmation: handles numeric-string docId (HTTP body)', () => {
  // The endpoint passes req.params.id which is always a string. The store
  // function must coerce via Number(); use a guaranteed-missing id.
  const r = revertSapConfirmation('deliveryNote', String(NON_EXISTENT_ID));
  assert.equal(r, null);
});
