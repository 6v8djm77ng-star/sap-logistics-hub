/**
 * Unit tests for the per-zone-picker-assignment changes in
 * createWaveFromLines (2026-05-21).
 *
 * Covers:
 *   1. legacy 2-arg call still works (AssignedPicker* = null on the new wave)
 *   2. 3-arg call with options writes AssignedPickerId/Name/By/At
 *   3. WAVE_IN_PROGRESS thrown when an active wave (IN_PROGRESS / PENDING_QC)
 *      already exists on the run — and the thrown error carries activeWaveId
 *   4. PENDING wave is still silently cancelled (no throw) — preserves
 *      pre-feature behaviour for stale/never-started waves
 *
 * The createWaveFromLines function mutates the module-level cache produced
 * by persistentStore.load(). We test by snapshotting the relevant arrays
 * (runs / waves / waveLines / pickAllocations / users) before each case,
 * seeding the test fixture into the live cache, calling the function, and
 * restoring the snapshot at the end. The test never calls save() — the
 * disk store.json is never written.
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.createWave.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  load,
  createWaveFromLines,
  getPickableUsers,
  isPickableUser,
} from './persistentStore.js';

// ── Snapshot / restore helpers ──────────────────────────────────────────
// The cache mutations of this test must be local to the test. We capture
// the arrays we touch before each test, seed test fixtures, and restore on
// finish — even if the test throws.
function snapshot() {
  const s = load();
  return {
    runs:            structuredClone(s.runs || []),
    waves:           structuredClone(s.waves || []),
    waveLines:       structuredClone(s.waveLines || []),
    pickAllocations: structuredClone(s.pickAllocations || []),
    users:           structuredClone(s.users || []),
    stops:           structuredClone(s.stops || []),
    runOrders:       structuredClone(s.runOrders || []),
    nextWaveId:      s.nextWaveId,
    nextWaveLineId:  s.nextWaveLineId,
    nextAllocId:     s.nextAllocId,
  };
}

function restore(snap) {
  const s = load();
  s.runs            = snap.runs;
  s.waves           = snap.waves;
  s.waveLines       = snap.waveLines;
  s.pickAllocations = snap.pickAllocations;
  s.users           = snap.users;
  s.stops           = snap.stops;
  s.runOrders       = snap.runOrders;
  s.nextWaveId      = snap.nextWaveId;
  s.nextWaveLineId  = snap.nextWaveLineId;
  s.nextAllocId     = snap.nextAllocId;
}

// Minimal "real" SAP-line shape required by the byItem aggregation loop.
// Tied to one run/stop/runOrder so the docToCustomer map lookups succeed.
function seedRunAndLines({ runId = 90000, stopId = 90001, runOrderId = 90002 }) {
  const s = load();
  // Push a test run (avoid colliding with real ids by using >=90000).
  s.runs = [...(s.runs || []), {
    RunId: runId,
    RunNumber: `TEST-RUN-${runId}`,
    RunDate: '2026-05-21',
    ZoneId: 1, ZoneCode: 'TEST', ZoneName: 'בדיקה', ZoneColor: '#000',
    DriverId: null, DriverName: '', DriverPhone: '', VehiclePlate: '',
    Status: 'OPEN',
    PalletMode: 'SINGLE',
    CreatedAt: new Date().toISOString(),
  }];
  s.stops = [...(s.stops || []), {
    StopId: stopId, RunId: runId, StopOrder: 1,
    City: 'בדיקה', BranchName: 'לקוח טסט', Street: '',
  }];
  s.runOrders = [...(s.runOrders || []), {
    RunOrderId: runOrderId,
    StopId: stopId,
    CompanyCode: 'A',
    SapDocEntry: 70001,
    SapDocNum: 5000,
    SapCardCode: 'C001', SapCardName: 'לקוח טסט',
    Status: 'OPEN',
  }];
  const orderLines = [{
    CompanyCode: 'A', DocEntry: 70001, DocNum: 5000, LineNum: 0,
    ItemCode: 'ITEM-A', ItemName: 'פריט A',
    OpenQty: 5, Quantity: 5,
    WarehouseCode: '01', UomCode: 'EA', Barcode: null,
    CardName: 'לקוח טסט',
  }];
  return orderLines;
}

// ── Tests ────────────────────────────────────────────────────────────────

test('createWaveFromLines: legacy 2-arg call still works (AssignedPicker* = null)', () => {
  const snap = snapshot();
  try {
    const lines = seedRunAndLines({ runId: 90100, stopId: 90101, runOrderId: 90102 });
    const wave = createWaveFromLines(90100, lines);
    assert.ok(wave, 'wave should be created');
    assert.equal(wave.AssignedPickerId,   null);
    assert.equal(wave.AssignedPickerName, null);
    assert.equal(wave.AssignedBy,         null);
    assert.equal(wave.AssignedAt,         null);
    assert.equal(wave.Status,             'PENDING');
    assert.equal(wave.PickedBy,           null, 'PickedBy untouched by assignment');
    assert.equal(wave.PickedByName,       null);
  } finally {
    restore(snap);
  }
});

test('createWaveFromLines: 3-arg call writes AssignedPickerId/Name/By/At', () => {
  const snap = snapshot();
  try {
    const lines = seedRunAndLines({ runId: 90200, stopId: 90201, runOrderId: 90202 });
    const before = Date.now();
    const wave = createWaveFromLines(90200, lines, {
      assignedPickerId:   7,
      assignedPickerName: 'מלקט טסט',
      assignedBy:         2,
    });
    const after = Date.now();
    assert.ok(wave);
    assert.equal(wave.AssignedPickerId,   7);
    assert.equal(wave.AssignedPickerName, 'מלקט טסט');
    assert.equal(wave.AssignedBy,         2);
    assert.ok(wave.AssignedAt, 'AssignedAt should be set when picker assigned');
    const stampedAt = Date.parse(wave.AssignedAt);
    assert.ok(stampedAt >= before && stampedAt <= after, 'AssignedAt close to now');
    // PickedBy semantics preserved
    assert.equal(wave.PickedBy,     null);
    assert.equal(wave.PickedByName, null);
  } finally {
    restore(snap);
  }
});

test('createWaveFromLines: WAVE_IN_PROGRESS thrown when existing wave is IN_PROGRESS', () => {
  const snap = snapshot();
  try {
    const lines = seedRunAndLines({ runId: 90300, stopId: 90301, runOrderId: 90302 });
    const s = load();
    // Seed a pre-existing IN_PROGRESS wave on the same run.
    s.waves = [...(s.waves || []), {
      WaveId: 99001, WaveNumber: 'WAVE-EXISTING-01',
      RunId: 90300, RunNumber: 'TEST-RUN-90300', RunDate: '2026-05-21',
      Status: 'IN_PROGRESS',
      PickedBy: null, PickedByName: null,
      StartedAt: new Date().toISOString(),
      CreatedAt: new Date().toISOString(),
      TotalLines: 0, CompletedLines: 0,
    }];
    assert.throws(
      () => createWaveFromLines(90300, lines),
      (err) => {
        assert.equal(err.code,              'WAVE_IN_PROGRESS');
        assert.equal(err.activeWaveId,      99001);
        assert.equal(err.activeWaveStatus,  'IN_PROGRESS');
        return true;
      }
    );
    // The IN_PROGRESS wave was NOT cancelled by the failed attempt.
    const after = s.waves.find((w) => w.WaveId === 99001);
    assert.equal(after.Status, 'IN_PROGRESS', 'existing wave preserved on failed reuse');
  } finally {
    restore(snap);
  }
});

test('createWaveFromLines: WAVE_IN_PROGRESS thrown when existing wave is PENDING_QC', () => {
  const snap = snapshot();
  try {
    const lines = seedRunAndLines({ runId: 90400, stopId: 90401, runOrderId: 90402 });
    const s = load();
    s.waves = [...(s.waves || []), {
      WaveId: 99002, WaveNumber: 'WAVE-PQC-01',
      RunId: 90400, RunNumber: 'TEST-RUN-90400', RunDate: '2026-05-21',
      Status: 'PENDING_QC',
      PickedBy: null, PickedByName: null,
      CreatedAt: new Date().toISOString(),
      TotalLines: 0, CompletedLines: 0,
    }];
    assert.throws(
      () => createWaveFromLines(90400, lines),
      (err) => {
        assert.equal(err.code,             'WAVE_IN_PROGRESS');
        assert.equal(err.activeWaveStatus, 'PENDING_QC');
        return true;
      }
    );
  } finally {
    restore(snap);
  }
});

test('createWaveFromLines: PENDING wave is silently cancelled (pre-feature behaviour)', () => {
  const snap = snapshot();
  try {
    const lines = seedRunAndLines({ runId: 90500, stopId: 90501, runOrderId: 90502 });
    const s = load();
    s.waves = [...(s.waves || []), {
      WaveId: 99003, WaveNumber: 'WAVE-PENDING-01',
      RunId: 90500, RunNumber: 'TEST-RUN-90500', RunDate: '2026-05-21',
      Status: 'PENDING',
      PickedBy: null, PickedByName: null,
      CreatedAt: new Date().toISOString(),
      TotalLines: 0, CompletedLines: 0,
    }];
    const wave = createWaveFromLines(90500, lines);
    assert.ok(wave, 'new wave created');
    // Old PENDING wave was cancelled in place.
    const oldWave = s.waves.find((w) => w.WaveId === 99003);
    assert.equal(oldWave.Status, 'CANCELLED');
    // New wave is the one returned.
    assert.equal(wave.Status, 'PENDING');
    assert.notEqual(wave.WaveId, 99003);
  } finally {
    restore(snap);
  }
});

// ── getPickableUsers / isPickableUser ────────────────────────────────────
// Mirrors the runtime gate at /api/pickable-users + the body validator at
// POST /api/runs/:id/wave. The user list is whatever's in store.json today
// — these tests assert the FILTER logic, not the specific identities.

test('getPickableUsers: includes ADMIN, PLANNER, WAREHOUSE; excludes DRIVER + inactive', () => {
  const snap = snapshot();
  try {
    const s = load();
    s.users = [
      { UserId: 101, Username: 'a', FullName: 'A admin',     Role: 'ADMIN',     IsActive: true },
      { UserId: 102, Username: 'b', FullName: 'B planner',   Role: 'PLANNER',   IsActive: true },
      { UserId: 103, Username: 'c', FullName: 'C warehouse', Role: 'WAREHOUSE', IsActive: true },
      { UserId: 104, Username: 'd', FullName: 'D driver',    Role: 'DRIVER',    IsActive: true },
      { UserId: 105, Username: 'e', FullName: 'E inactive',  Role: 'PLANNER',   IsActive: false },
    ];
    const pickers = getPickableUsers();
    const ids = pickers.map((p) => p.userId).sort((a, b) => a - b);
    assert.deepEqual(ids, [101, 102, 103], 'only active ADMIN/PLANNER/WAREHOUSE');
    // Shape contract
    for (const p of pickers) {
      assert.ok(typeof p.userId === 'number');
      assert.ok(typeof p.fullName === 'string');
      assert.ok(['ADMIN', 'PLANNER', 'WAREHOUSE'].includes(p.role));
    }
    // isPickableUser mirrors the gate
    assert.equal(isPickableUser(101), true);
    assert.equal(isPickableUser(104), false, 'DRIVER excluded');
    assert.equal(isPickableUser(105), false, 'inactive PLANNER excluded');
    assert.equal(isPickableUser(999), false, 'missing user excluded');
  } finally {
    restore(snap);
  }
});
