/**
 * Unit tests for Bug B fix — recordPick FIFO distribution into allocations.
 *
 * Strategy:
 *   The two pure helpers (_compareAllocationsFifo + _distributePickedQtyByFifo)
 *   cover the entire FIFO+cap logic. recordPick itself is a thin wrapper
 *   that loads store state, sorts via the comparator, distributes via the
 *   distributor, and applies the deltas. Testing the helpers exercises the
 *   substantive logic without needing to fake/mock the persistent store.
 *
 *   The state-mutating bits (allocation Status/LastPickedAt updates,
 *   line.PickedQuantity recompute, wave→PENDING_QC transition, resetWaveLine
 *   syncing allocations) are validated by the smoke run against the test
 *   seed — see scripts/seed-qc-ready-run.js + the smoke commands in the
 *   commit message.
 *
 * Run:
 *   cd backend && npm test
 *   (or: node --test src/demo/persistentStore.recordPick.test.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _compareAllocationsFifo,
  _distributePickedQtyByFifo,
  recordPick,
} from './persistentStore.js';

// Convenience: build an alloc object with the fields the helpers read.
function alloc({ AllocationId, SapDocEntry, CompanyCode = 'A', Quantity, PickedQuantity = 0 }) {
  return { AllocationId, SapDocEntry, CompanyCode, Quantity, PickedQuantity, WaveLineId: 1 };
}

// ============================================================================
// _compareAllocationsFifo — FIFO ordering by SapDocEntry → RunOrderId → AllocationId
// ============================================================================

test('Bug B / FIFO sort: primary key is SapDocEntry ASC', () => {
  const a = alloc({ AllocationId: 99, SapDocEntry: 200, Quantity: 1 });
  const b = alloc({ AllocationId: 1,  SapDocEntry: 100, Quantity: 1 });
  const sorted = [a, b].sort((x, y) => _compareAllocationsFifo(x, y));
  assert.equal(sorted[0].SapDocEntry, 100, 'lower SapDocEntry wins regardless of AllocationId');
  assert.equal(sorted[1].SapDocEntry, 200);
});

test('Bug B / FIFO sort: secondary key is RunOrderId when SapDocEntry ties', () => {
  // Same SapDocEntry but different CompanyCode → different RunOrders
  const a = alloc({ AllocationId: 99, SapDocEntry: 100, CompanyCode: 'A', Quantity: 1 });
  const b = alloc({ AllocationId: 1,  SapDocEntry: 100, CompanyCode: 'B', Quantity: 1 });
  const orderByKey = (x) => x.CompanyCode === 'A' ? { RunOrderId: 50 } : { RunOrderId: 10 };
  const sorted = [a, b].sort((x, y) => _compareAllocationsFifo(x, y, orderByKey));
  assert.equal(sorted[0].CompanyCode, 'B', 'B wins (RunOrderId 10 < 50) despite higher AllocationId');
});

test('Bug B / FIFO sort: tiebreak is AllocationId ASC', () => {
  const a = alloc({ AllocationId: 50, SapDocEntry: 100, Quantity: 1 });
  const b = alloc({ AllocationId: 10, SapDocEntry: 100, Quantity: 1 });
  // No orderByKey → both RunOrderIds resolve to 0, fall through to AllocationId
  const sorted = [a, b].sort((x, y) => _compareAllocationsFifo(x, y));
  assert.equal(sorted[0].AllocationId, 10);
  assert.equal(sorted[1].AllocationId, 50);
});

test('Bug B / FIFO sort: orderByKey missing returns RunOrderId=0 → tiebreak by AllocationId', () => {
  const a = alloc({ AllocationId: 5,  SapDocEntry: 100, Quantity: 1 });
  const b = alloc({ AllocationId: 99, SapDocEntry: 100, Quantity: 1 });
  // Default orderByKey is () => undefined → RunOrderId reads as 0 for both
  const sorted = [a, b].sort((x, y) => _compareAllocationsFifo(x, y));
  assert.equal(sorted[0].AllocationId, 5);
});

// ============================================================================
// _distributePickedQtyByFifo — distribute by FIFO, respect caps
// ============================================================================

test('Bug B / distribute: single allocation gets the full pick (trivial FIFO)', () => {
  const allocs = [alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 5 })];
  const deltas = _distributePickedQtyByFifo(3, allocs, 5);
  assert.deepEqual(deltas, [{ AllocationId: 1, take: 3 }]);
});

test('Bug B / distribute: two-alloc split, partial fill only the first FIFO alloc', () => {
  // Already sorted FIFO. Line=5 (3+2). Pick 2 → goes entirely to alloc1.
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3 }), // oldest SAP order
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2 }),
  ];
  const deltas = _distributePickedQtyByFifo(2, allocs, 5);
  assert.deepEqual(deltas, [{ AllocationId: 1, take: 2 }], 'pick 2 → only alloc1 gets it');
});

test('Bug B / distribute: pick exactly fills the first alloc, second untouched', () => {
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3 }),
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2 }),
  ];
  const deltas = _distributePickedQtyByFifo(3, allocs, 5);
  assert.deepEqual(deltas, [{ AllocationId: 1, take: 3 }]);
});

test('Bug B / distribute: pick overflows first alloc into second by FIFO', () => {
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3 }),
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2 }),
  ];
  const deltas = _distributePickedQtyByFifo(4, allocs, 5);
  assert.deepEqual(deltas, [
    { AllocationId: 1, take: 3 }, // first alloc filled
    { AllocationId: 2, take: 1 }, // remainder goes to second
  ]);
});

test('Bug B / distribute: pick fills both allocs completely', () => {
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3 }),
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2 }),
  ];
  const deltas = _distributePickedQtyByFifo(5, allocs, 5);
  assert.deepEqual(deltas, [
    { AllocationId: 1, take: 3 },
    { AllocationId: 2, take: 2 },
  ]);
});

test('Bug B / distribute: pick cap — over-pick is silently clipped at line total', () => {
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3 }),
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2 }),
  ];
  const deltas = _distributePickedQtyByFifo(100, allocs, 5);
  const sum = deltas.reduce((s, d) => s + d.take, 0);
  assert.equal(sum, 5, 'cannot exceed line.TotalQuantity = 5');
});

test('Bug B / distribute: cumulative — second call respects prior picks', () => {
  // alloc1 already has 2 of its 3 picked. Pick 2 more → 1 fills alloc1, 1 spills to alloc2.
  const allocs = [
    alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 3, PickedQuantity: 2 }),
    alloc({ AllocationId: 2, SapDocEntry: 200, Quantity: 2, PickedQuantity: 0 }),
  ];
  const deltas = _distributePickedQtyByFifo(2, allocs, 5);
  assert.deepEqual(deltas, [
    { AllocationId: 1, take: 1 },
    { AllocationId: 2, take: 1 },
  ]);
});

test('Bug B / distribute: empty allocs → no deltas (defensive)', () => {
  assert.deepEqual(_distributePickedQtyByFifo(5, [], 5), []);
  assert.deepEqual(_distributePickedQtyByFifo(5, null, 5), []);
  assert.deepEqual(_distributePickedQtyByFifo(5, undefined, 5), []);
});

test('Bug B / distribute: negative qty defensively treated as 0 (recordPick rejects upstream)', () => {
  const allocs = [alloc({ AllocationId: 1, SapDocEntry: 100, Quantity: 5 })];
  assert.deepEqual(_distributePickedQtyByFifo(-3, allocs, 5), []);
});

// ============================================================================
// recordPick (the wrapper) — rejects negative qty upstream
// ============================================================================

test('Bug B / recordPick: rejects negative qty with HTTP 400 error', () => {
  assert.throws(
    () => recordPick(999999, -1),  // non-existent line is fine — error fires first
    (err) => err.status === 400 && /negative qty not supported/i.test(err.message),
    'must throw before touching state'
  );
});
