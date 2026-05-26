/**
 * Unit tests — QC Control P3 (2026-05-26).
 *
 * Covers the two new pure-ish persistentStore functions:
 *   - listQcPendingOrders(filters) — query
 *   - rejectOrderQc(runOrderId, opts) — mutation
 *
 * Pattern: snapshot the relevant arrays before each test, mutate via
 * fixture rows we own (RunOrderId in the >= 80000 test-fixture range so
 * purgeTestFixtures cleans up), then restore in t.after().
 *
 * No SAP, no HTTP. The success-path approval (generateDocsForRunOrder)
 * is covered by other test files already; we don't re-test it here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listQcPendingOrders,
  rejectOrderQc,
  load,
  save,
} from './persistentStore.js';

// ----- snapshot/restore helpers -----
function snapshot() {
  const s = load();
  return {
    runs:      structuredClone(s.runs || []),
    stops:     structuredClone(s.stops || []),
    runOrders: structuredClone(s.runOrders || []),
    waves:     structuredClone(s.waves || []),
  };
}
function restore(snap) {
  const s = load();
  s.runs      = snap.runs;
  s.stops     = snap.stops;
  s.runOrders = snap.runOrders;
  s.waves     = snap.waves;
  save();
}

// Test IDs all in the 80000+ range so they're easy to spot and a cleanup
// pass can remove them automatically.
const T_RUN_ID   = 80100;
const T_STOP_ID  = 80101;
const T_WAVE_ID  = 80102;
const T_ORDER_ID = 80103;
const T_ORDER_ID_2 = 80104;

function seedPendingQcFixture() {
  const s = load();
  s.runs = (s.runs || []).filter((r) => r.RunId !== T_RUN_ID);
  s.stops = (s.stops || []).filter((st) => st.StopId !== T_STOP_ID);
  s.waves = (s.waves || []).filter((w) => w.WaveId !== T_WAVE_ID);
  s.runOrders = (s.runOrders || [])
    .filter((o) => o.RunOrderId !== T_ORDER_ID && o.RunOrderId !== T_ORDER_ID_2);

  s.runs.push({
    RunId: T_RUN_ID,
    RunNumber: 'RUN-QC-TEST-01',
    RunDate: '2026-05-26',
    ZoneCode: 'TEST_ZONE',
    ZoneName: 'אזור בדיקה',
    Status: 'PICKING',
    DriverName: 'נהג בדיקה',
  });
  s.stops.push({
    StopId: T_STOP_ID,
    RunId: T_RUN_ID,
    Sequence: 1,
    Address: 'כתובת בדיקה 1',
  });
  s.waves.push({
    WaveId: T_WAVE_ID,
    WaveNumber: 'WAVE-QC-TEST-01',
    RunId: T_RUN_ID,
    Status: 'PENDING_QC',
    AssignedPickerId: 9999,
    AssignedPickerName: 'מלקט בדיקה',
    PickedByName: 'מלקט בדיקה',
    CompletedAt: '2026-05-26T10:00:00.000Z',
  });
  s.runOrders.push({
    RunOrderId: T_ORDER_ID,
    StopId: T_STOP_ID,
    SapCardCode: 'TEST-CUST-1',
    SapCardName: 'לקוח בדיקה 1',
    SapDocNum: 99001,
    SapDocEntry: 99001,
    OrderTotal: 1000,
    LinesCount: 2,
    // No DeliveryNoteId / InvoiceId yet → pending QC.
  });
  s.runOrders.push({
    RunOrderId: T_ORDER_ID_2,
    StopId: T_STOP_ID,
    SapCardCode: 'TEST-CUST-2',
    SapCardName: 'לקוח בדיקה 2',
    SapDocNum: 99002,
    SapDocEntry: 99002,
    OrderTotal: 2000,
    LinesCount: 1,
  });
  save();
}

// ============================================================
// listQcPendingOrders
// ============================================================
test('listQcPendingOrders surfaces orders in PENDING_QC waves', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const rows = listQcPendingOrders();
  const ours = rows.filter((r) => r.RunOrderId === T_ORDER_ID || r.RunOrderId === T_ORDER_ID_2);
  assert.equal(ours.length, 2, 'both fixture orders should appear');

  const first = ours.find((r) => r.RunOrderId === T_ORDER_ID);
  assert.equal(first.SapCardCode, 'TEST-CUST-1');
  assert.equal(first.WaveStatus, 'PENDING_QC');
  assert.equal(first.RunNumber, 'RUN-QC-TEST-01');
  assert.equal(first.AssignedPickerName, 'מלקט בדיקה');
});

test('listQcPendingOrders filters by runDate', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const matches = listQcPendingOrders({ runDate: '2026-05-26' });
  const ours = matches.filter((r) => r.RunOrderId === T_ORDER_ID);
  assert.equal(ours.length, 1, 'should match on the fixture run date');

  const misses = listQcPendingOrders({ runDate: '2026-01-01' });
  const oursMisses = misses.filter((r) => r.RunOrderId === T_ORDER_ID);
  assert.equal(oursMisses.length, 0, 'should not match a different run date');
});

test('listQcPendingOrders filters by zoneCode', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const matches = listQcPendingOrders({ zoneCode: 'TEST_ZONE' });
  const ours = matches.filter((r) => r.RunOrderId === T_ORDER_ID);
  assert.equal(ours.length, 1);

  const misses = listQcPendingOrders({ zoneCode: 'OTHER_ZONE' });
  assert.equal(misses.filter((r) => r.RunOrderId === T_ORDER_ID).length, 0);
});

test('listQcPendingOrders filters by pickerId', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const matches = listQcPendingOrders({ pickerId: 9999 });
  assert.ok(matches.find((r) => r.RunOrderId === T_ORDER_ID));

  const misses = listQcPendingOrders({ pickerId: 12345 });
  assert.equal(misses.filter((r) => r.RunOrderId === T_ORDER_ID).length, 0);
});

test('listQcPendingOrders skips orders that already have a DN', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  // Simulate the order being approved.
  const s = load();
  const order = s.runOrders.find((o) => o.RunOrderId === T_ORDER_ID);
  order.DeliveryNoteId = 555;
  save();

  const rows = listQcPendingOrders();
  const approved = rows.find((r) => r.RunOrderId === T_ORDER_ID);
  const stillPending = rows.find((r) => r.RunOrderId === T_ORDER_ID_2);
  assert.equal(approved, undefined, 'approved order must not appear');
  assert.ok(stillPending, 'the other order in the same wave should still appear');
});

test('listQcPendingOrders skips QcRejected orders', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const s = load();
  s.runOrders.find((o) => o.RunOrderId === T_ORDER_ID).QcRejected = true;
  save();

  const rows = listQcPendingOrders();
  assert.equal(rows.filter((r) => r.RunOrderId === T_ORDER_ID).length, 0);
});

test('listQcPendingOrders skips waves not in PENDING_QC by default', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const s = load();
  s.waves.find((w) => w.WaveId === T_WAVE_ID).Status = 'ACTIVE';
  save();

  const rows = listQcPendingOrders();
  assert.equal(rows.filter((r) => r.RunOrderId === T_ORDER_ID).length, 0);

  const rowsWithStatus = listQcPendingOrders({ status: 'ACTIVE' });
  assert.ok(rowsWithStatus.find((r) => r.RunOrderId === T_ORDER_ID));
});

// ============================================================
// rejectOrderQc
// ============================================================
test('rejectOrderQc marks order as QcRejected with reason', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const res = rejectOrderQc(T_ORDER_ID, {
    reason: 'פגום באריזה',
    rejectedBy: 'בקר בדיקה',
  });
  assert.equal(res.ok, true);
  assert.equal(res.order.QcRejected, true);
  assert.equal(res.order.QcRejectionReason, 'פגום באריזה');
  assert.equal(res.order.QcRejectedBy, 'בקר בדיקה');
  assert.ok(res.order.QcRejectedAt, 'timestamp should be set');
});

test('rejectOrderQc returns ORDER_NOT_FOUND for unknown id', () => {
  const res = rejectOrderQc(999999, { reason: 'test' });
  assert.equal(res.error, 'ORDER_NOT_FOUND');
});

test('rejectOrderQc refuses to reject an order that already has a DN', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  const s = load();
  s.runOrders.find((o) => o.RunOrderId === T_ORDER_ID).DeliveryNoteId = 777;
  save();

  const res = rejectOrderQc(T_ORDER_ID, { reason: 'too late' });
  assert.equal(res.error, 'ALREADY_APPROVED');
});

test('rejectOrderQc refuses double-reject', (t) => {
  const snap = snapshot();
  t.after(() => restore(snap));
  seedPendingQcFixture();

  rejectOrderQc(T_ORDER_ID, { reason: 'first time' });
  const res = rejectOrderQc(T_ORDER_ID, { reason: 'second time' });
  assert.equal(res.error, 'ALREADY_REJECTED');
  assert.equal(res.current.reason, 'first time');
});
