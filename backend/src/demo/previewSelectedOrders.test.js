// Unit tests for previewSelectedOrders — proves the helper:
//   1. Returns the expected response shapes for each guard
//   2. Returns a correct summary on the happy path
//   3. NEVER mutates the inputs (store snapshot before == after)
//   4. Never produces a "created" run/stop/wave/runOrder (the helper has
//      no I/O, so this is by construction; we also assert no fields
//      named *Created appear in the body to catch regressions).
//
// Run:
//   cd backend && node --test src/demo/previewSelectedOrders.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewSelectedOrders } from './previewSelectedOrders.js';

// ──────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────
const ZONE_NORTH = { ZoneId: 1, Code: 'NORTH', Name: 'צפון' };
const ZONE_CENTER = { ZoneId: 2, Code: 'CENTER', Name: 'מרכז' };

const zoneByCity = {
  'חיפה': ZONE_NORTH,
  'נהריה': ZONE_NORTH,
  'תל אביב': ZONE_CENTER,
  'רמת גן': ZONE_CENTER,
};
const suggestZoneForCity = (city) => zoneByCity[city] || null;

function makeOrder({ company = 'A', docEntry, docNum, cardCode, cardName, street, city, total = 1000, lines = 3 } = {}) {
  return {
    CompanyCode: company,
    DocEntry: docEntry,
    DocNum: docNum,
    CardCode: cardCode,
    CardName: cardName,
    ShipToAddress: street ? `${street}\n${city}` : city,
    CustCity: city,
    DocTotal: total,
    LinesCount: lines,
    CustPhone: '050-1111111',
  };
}

function emptyStore() {
  return { runs: [], stops: [], runOrders: [] };
}

// Deep clone via JSON so we can compare before/after without aliasing.
function snapshot(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ──────────────────────────────────────────────────────────────────────
// Guards
// ──────────────────────────────────────────────────────────────────────

test('NO_ORDERS: empty array → 400', () => {
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [],
    sapOpenOrders: [],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_ORDERS');
});

test('NO_ORDERS: non-array orderRefs → 400', () => {
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: null,
    sapOpenOrders: [],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_ORDERS');
});

test('TOO_MANY: 501 orderRefs → 400', () => {
  const refs = Array.from({ length: 501 }, (_, i) => ({ companyCode: 'A', docEntry: i + 1 }));
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: refs,
    sapOpenOrders: [],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'TOO_MANY');
});

test('BAD_REF: missing docEntry → 400', () => {
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A' /* no docEntry */ }],
    sapOpenOrders: [],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BAD_REF');
});

test('BAD_REF: missing companyCode → 400', () => {
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ docEntry: 42 }],
    sapOpenOrders: [],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BAD_REF');
});

test('ORDERS_MISSING: requested order not in SAP snapshot → 400 with missing list', () => {
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 999 }],
    sapOpenOrders: [makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', city: 'חיפה' })],
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'ORDERS_MISSING');
  assert.equal(Array.isArray(r.body.missing), true);
  assert.equal(r.body.missing.length, 1);
  assert.equal(r.body.missing[0].docEntry, 999);
});

test('ALREADY_ASSIGNED: order already on an existing run → 409 with conflicts', () => {
  const order = makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', city: 'חיפה' });
  const storeWithExistingAssignment = {
    runs: [{ RunId: 5, RunDate: '2026-05-18', ZoneId: 1, Status: 'OPEN', RunNumber: 'RUN-2026-05-18-01' }],
    stops: [{ StopId: 10, RunId: 5 }],
    runOrders: [{ StopId: 10, CompanyCode: 'A', SapDocEntry: 100 }],
  };
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: [order],
    storeSnapshot: storeWithExistingAssignment,
    suggestZoneForCity,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'ALREADY_ASSIGNED');
  assert.equal(r.body.conflicts.length, 1);
  assert.equal(r.body.conflicts[0].companyCode, 'A');
  assert.equal(r.body.conflicts[0].docNum, 10);
});

// ──────────────────────────────────────────────────────────────────────
// Happy path
// ──────────────────────────────────────────────────────────────────────

test('happy path: 2 orders → 2 zones → 2 runs preview', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'הרצל 1', city: 'חיפה' }),
    makeOrder({ docEntry: 200, docNum: 20, cardCode: 'C2', cardName: 'Beta',  street: 'דיזנגוף 5', city: 'תל אביב' }),
  ];
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }, { companyCode: 'A', docEntry: 200 }],
    sapOpenOrders: orders,
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.preview, true);
  assert.equal(r.body.selectedCount, 2);
  assert.equal(r.body.runsPreview.length, 2);
  const zones = r.body.runsPreview.map((p) => p.zoneCode).sort();
  assert.deepEqual(zones, ['CENTER', 'NORTH']);
  // Each zone: 1 stop, 1 order
  for (const p of r.body.runsPreview) {
    assert.equal(p.stopCount, 1);
    assert.equal(p.orderCount, 1);
    assert.equal(p.wouldReuseExistingRunId, null);
    assert.equal(p.wouldReuseExistingRunNumber, null);
  }
  assert.equal(r.body.summary.ordersRequested, 2);
  assert.equal(r.body.summary.ordersAssigned, 2);
  assert.equal(r.body.summary.ordersUnassigned, 0);
  assert.equal(r.body.summary.runsToCreate, 2);
  assert.equal(r.body.summary.runsToReuse, 0);
  assert.equal(r.body.unassigned, null);
});

test('happy path: two orders to same address → 1 stop, 2 orders', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'הרצל 1', city: 'חיפה' }),
    makeOrder({ docEntry: 101, docNum: 11, cardCode: 'C1', cardName: 'Alpha', street: 'הרצל 1', city: 'חיפה' }),
  ];
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }, { companyCode: 'A', docEntry: 101 }],
    sapOpenOrders: orders,
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.runsPreview.length, 1);
  assert.equal(r.body.runsPreview[0].stopCount, 1);
  assert.equal(r.body.runsPreview[0].orderCount, 2);
});

test('unassigned: order with unrecognized city → listed in unassigned, not in runsPreview', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'אילת' }),
    makeOrder({ docEntry: 200, docNum: 20, cardCode: 'C2', cardName: 'Beta',  street: 'Y', city: 'חיפה' }),
  ];
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }, { companyCode: 'A', docEntry: 200 }],
    sapOpenOrders: orders,
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.runsPreview.length, 1);
  assert.equal(r.body.runsPreview[0].zoneCode, 'NORTH');
  assert.equal(r.body.unassigned.length, 1);
  assert.equal(r.body.unassigned[0].docNum, 10);
  assert.equal(r.body.unassigned[0].city, 'אילת');
  assert.equal(r.body.summary.ordersAssigned, 1);
  assert.equal(r.body.summary.ordersUnassigned, 1);
});

test('reuse: zone with existing OPEN run on same runDate → wouldReuseExistingRunId set', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'חיפה' }),
  ];
  const storeWithOpenRun = {
    runs: [{ RunId: 7, RunDate: '2026-05-18', ZoneId: 1, Status: 'OPEN', RunNumber: 'RUN-2026-05-18-07' }],
    stops: [],
    runOrders: [],
  };
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: orders,
    storeSnapshot: storeWithOpenRun,
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.runsPreview[0].wouldReuseExistingRunId, 7);
  assert.equal(r.body.runsPreview[0].wouldReuseExistingRunNumber, 'RUN-2026-05-18-07');
  assert.equal(r.body.summary.runsToCreate, 0);
  assert.equal(r.body.summary.runsToReuse, 1);
});

test('reuse: existing run is for a different date → not reused', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'חיפה' }),
  ];
  const storeWithOldRun = {
    runs: [{ RunId: 7, RunDate: '2026-05-17', ZoneId: 1, Status: 'OPEN', RunNumber: 'RUN-2026-05-17-07' }],
    stops: [],
    runOrders: [],
  };
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: orders,
    storeSnapshot: storeWithOldRun,
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.runsPreview[0].wouldReuseExistingRunId, null);
  assert.equal(r.body.summary.runsToCreate, 1);
  assert.equal(r.body.summary.runsToReuse, 0);
});

test('reuse: COMPLETED/CANCELLED runs are NOT reused', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'חיפה' }),
  ];
  const storeWithClosedRuns = {
    runs: [
      { RunId: 1, RunDate: '2026-05-18', ZoneId: 1, Status: 'COMPLETED', RunNumber: 'RUN-A' },
      { RunId: 2, RunDate: '2026-05-18', ZoneId: 1, Status: 'CANCELLED', RunNumber: 'RUN-B' },
    ],
    stops: [],
    runOrders: [],
  };
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: orders,
    storeSnapshot: storeWithClosedRuns,
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.runsPreview[0].wouldReuseExistingRunId, null);
});

// ──────────────────────────────────────────────────────────────────────
// Immutability — proves the helper does not mutate anything
// ──────────────────────────────────────────────────────────────────────

test('immutability: store snapshot is byte-identical before/after a 200 response', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'חיפה' }),
    makeOrder({ docEntry: 200, docNum: 20, cardCode: 'C2', cardName: 'Beta',  street: 'Y', city: 'תל אביב' }),
  ];
  const storeSnapshot = {
    runs: [{ RunId: 9, RunDate: '2026-05-18', ZoneId: 1, Status: 'OPEN', RunNumber: 'RUN-9' }],
    stops: [{ StopId: 50, RunId: 9, City: 'נהריה' }],
    runOrders: [{ StopId: 50, CompanyCode: 'B', SapDocEntry: 9999 }],
  };
  const before = snapshot(storeSnapshot);
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }, { companyCode: 'A', docEntry: 200 }],
    sapOpenOrders: orders,
    storeSnapshot,
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  // Same data, same shape, same length, same nested values
  assert.deepEqual(storeSnapshot, before, 'storeSnapshot must not mutate');
  // sapOpenOrders inputs must also not mutate
  assert.equal(orders.length, 2);
  assert.equal(orders[0].DocEntry, 100);
});

test('immutability: store snapshot unchanged when a guard fires (4xx path)', () => {
  const storeSnapshot = {
    runs: [{ RunId: 1, RunDate: '2026-05-18', ZoneId: 1, Status: 'OPEN', RunNumber: 'RUN-1' }],
    stops: [{ StopId: 10, RunId: 1 }],
    runOrders: [{ StopId: 10, CompanyCode: 'A', SapDocEntry: 100 }],
  };
  const before = snapshot(storeSnapshot);
  // Trigger ALREADY_ASSIGNED
  const order = makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', city: 'חיפה' });
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: [order],
    storeSnapshot,
    suggestZoneForCity,
  });
  assert.equal(r.status, 409);
  assert.deepEqual(storeSnapshot, before, 'storeSnapshot must not mutate even on guard path');
});

test('immutability: response body never contains *Created fields (preview = no creation)', () => {
  const orders = [
    makeOrder({ docEntry: 100, docNum: 10, cardCode: 'C1', cardName: 'Alpha', street: 'X', city: 'חיפה' }),
  ];
  const r = previewSelectedOrders({
    runDate: '2026-05-18',
    orderRefs: [{ companyCode: 'A', docEntry: 100 }],
    sapOpenOrders: orders,
    storeSnapshot: emptyStore(),
    suggestZoneForCity,
  });
  assert.equal(r.status, 200);
  const json = JSON.stringify(r.body);
  // Guards against future regressions if someone copies the live endpoint
  // shape (runsCreated / runsReused) into preview by accident. Preview must
  // use the *Preview / runsToCreate language.
  assert.equal(json.includes('"runsCreated"'), false, 'preview must not surface runsCreated');
  assert.equal(json.includes('"reusedExisting"'), false, 'preview must not surface reusedExisting');
});
