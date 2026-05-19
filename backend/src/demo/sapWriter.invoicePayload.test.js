/**
 * Unit tests for the A2d Invoice payload builder.
 *
 * Two modes that must work:
 *   1. Live mode — parent DN has a SapDeliveryDocEntry. Payload uses
 *      BaseType=15 (delivery note) references so SAP copies item/quantity
 *      from the source DN.
 *   2. Standalone mode — dry-run, or no DN at all. Payload lists ItemCode/
 *      Quantity directly so the operator can see exactly what would be sent.
 *
 * Scope rule covered:
 *   2. Invoice dry-run עובד גם כש-dn.SapDeliveryDocEntry=null
 *   3. Live mode עדיין משתמש ב-BaseType=15 כשיש SapDeliveryDocEntry
 *
 * Pure function — no env, no HTTP, no module state.
 *
 * Run:
 *   cd backend && node --test src/demo/sapWriter.invoicePayload.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _buildInvoicePayload } from './sapWriter.js';

function aggInv(overrides = {}) {
  return {
    InvoiceId: 200,
    DocNumber: 'INV-AGG-1-A-0001',
    SapCardCode: 'C-OIG-001',
    SapCardName: 'לקוח טסט',
    Lines: [
      { ItemCode: 'SKU-A', Picked: 3, Ordered: 3 },
      { ItemCode: 'SKU-B', Picked: 5, Ordered: 5 },
    ],
    ...overrides,
  };
}

function aggDn(overrides = {}) {
  return {
    DeliveryNoteId: 100,
    DocNumber: 'DN-AGG-1-A-0001',
    SapDeliveryDocEntry: null,
    Lines: [
      { ItemCode: 'SKU-A', Picked: 3, Ordered: 3 },
      { ItemCode: 'SKU-B', Picked: 5, Ordered: 5 },
    ],
    SourceOrders: [
      { SapDocEntry: 1001, lines: [{ LineNum: 0 }, { LineNum: 1 }] },
    ],
    ...overrides,
  };
}

// ============================================================================
// Live mode — DN has SapDeliveryDocEntry → BaseType=15 lines
// ============================================================================

test('A2d / live mode: BaseType=15 referencing the DN DocEntry', () => {
  const dn = aggDn({ SapDeliveryDocEntry: 7777 });
  const inv = aggInv();
  const p = _buildInvoicePayload(inv, dn);

  assert.equal(p.CardCode, 'C-OIG-001');
  assert.ok(p.DocDate, 'DocDate present');
  assert.ok(Array.isArray(p.DocumentLines));
  assert.equal(p.DocumentLines.length, 2, 'one line per SourceOrders[*].lines[*]');
  for (const ln of p.DocumentLines) {
    assert.equal(ln.BaseType, 15, 'BaseType=15 (delivery note)');
    assert.equal(ln.BaseEntry, 7777, 'BaseEntry points at the SAP-side DN');
    // No ItemCode/Quantity in live mode — SAP copies from base doc
    assert.equal(ln.ItemCode, undefined);
    assert.equal(ln.Quantity, undefined);
  }
});

// ============================================================================
// Standalone mode — dn.SapDeliveryDocEntry is null → ItemCode/Quantity lines
// ============================================================================

test('A2d / standalone mode (no DocEntry): ItemCode + Quantity from dn.Lines', () => {
  const dn = aggDn({ SapDeliveryDocEntry: null });
  const inv = aggInv();
  const p = _buildInvoicePayload(inv, dn);

  assert.equal(p.CardCode, 'C-OIG-001');
  assert.ok(Array.isArray(p.DocumentLines));
  assert.equal(p.DocumentLines.length, 2, 'one line per dn.Lines');
  assert.deepEqual(p.DocumentLines[0], { ItemCode: 'SKU-A', Quantity: 3 });
  assert.deepEqual(p.DocumentLines[1], { ItemCode: 'SKU-B', Quantity: 5 });
  // No BaseType in standalone mode
  for (const ln of p.DocumentLines) {
    assert.equal(ln.BaseType, undefined);
    assert.equal(ln.BaseEntry, undefined);
  }
});

// ============================================================================
// No DN at all (INV-without-DN flush branch) → uses invoice.Lines
// ============================================================================

test('A2d / no-DN mode: falls back to invoice.Lines', () => {
  const inv = aggInv({
    Lines: [
      { ItemCode: 'SKU-X', Picked: 7 },
      { ItemCode: 'SKU-Y', Picked: 2 },
    ],
  });
  const p = _buildInvoicePayload(inv, null);

  assert.equal(p.CardCode, 'C-OIG-001');
  assert.equal(p.DocumentLines.length, 2);
  assert.deepEqual(p.DocumentLines[0], { ItemCode: 'SKU-X', Quantity: 7 });
  assert.deepEqual(p.DocumentLines[1], { ItemCode: 'SKU-Y', Quantity: 2 });
});

// ============================================================================
// Fallback: line uses Quantity field when Picked is missing
// ============================================================================

test('A2d / standalone mode: Quantity fallback when ln.Picked is absent', () => {
  const dn = aggDn({
    SapDeliveryDocEntry: null,
    Lines: [{ ItemCode: 'SKU-Z', Quantity: 10 }],
  });
  const inv = aggInv();
  const p = _buildInvoicePayload(inv, dn);

  assert.equal(p.DocumentLines.length, 1);
  assert.deepEqual(p.DocumentLines[0], { ItemCode: 'SKU-Z', Quantity: 10 });
});

// ============================================================================
// Empty lines: standalone payload returns empty DocumentLines (caller will
// flag INVALID_PAYLOAD upstream). Helper itself does NOT throw.
// ============================================================================

test('A2d / defensive: empty lines yields empty DocumentLines (no throw)', () => {
  const dn = aggDn({ SapDeliveryDocEntry: null, Lines: [] });
  const inv = aggInv({ Lines: [] });
  const p = _buildInvoicePayload(inv, dn);
  assert.equal(p.DocumentLines.length, 0);
});

// ============================================================================
// Live-mode trumps Lines: when SapDeliveryDocEntry is set, ignore dn.Lines
// ============================================================================

test('A2d / precedence: SapDeliveryDocEntry truthy → BaseType lines win', () => {
  const dn = aggDn({ SapDeliveryDocEntry: 12345 });
  const inv = aggInv();
  const p = _buildInvoicePayload(inv, dn);

  for (const ln of p.DocumentLines) {
    assert.equal(ln.BaseType, 15);
    assert.equal(ln.ItemCode, undefined,
      'live mode must NOT include ItemCode (SAP copies from base doc)');
  }
});
