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
  save,
  createWaveFromLines,
  getPickableUsers,
  isPickableUser,
} from './persistentStore.js';

// ── Snapshot / restore helpers ──────────────────────────────────────────
// The cache mutations of this test must be local to the test. We capture
// the arrays we touch before each test, seed test fixtures, and restore on
// finish — even if the test throws.
// Pre-purge fixtures that previous broken runs of this suite leaked into
// store.json on disk. Without this, every test repeats the seed but the
// snapshot/restore couldn't undo the pre-existing fixture rows (Run 90500,
// Wave 99003, ...) — they accumulated, ~one duplicate per full suite run.
// Test-pollution fix (2026-05-23): run once at first snapshot() call,
// flush cleaned cache to disk via save() so this file (and the next test
// file) inherit a clean baseline. The IDs we own here all live at
// >=80000 (run/stop/runOrder) and >=99000 (wave) per seedFixture/
// seedRunAndLines below.
let _purgedOnce = false;
function purgeTestFixtures() {
  if (_purgedOnce) return;
  _purgedOnce = true;
  const s = load();
  const before = {
    runs: (s.runs||[]).length, waves: (s.waves||[]).length,
    stops: (s.stops||[]).length, runOrders: (s.runOrders||[]).length,
  };
  s.runs      = (s.runs      || []).filter((r)  => r.RunId      < 80000);
  s.waves     = (s.waves     || []).filter((w)  => w.WaveId     < 80000);
  s.stops     = (s.stops     || []).filter((st) => st.StopId    < 80000);
  s.runOrders = (s.runOrders || []).filter((o)  => o.RunOrderId < 80000);
  const after = {
    runs: s.runs.length, waves: s.waves.length,
    stops: s.stops.length, runOrders: s.runOrders.length,
  };
  if (before.runs !== after.runs || before.waves !== after.waves ||
      before.stops !== after.stops || before.runOrders !== after.runOrders) {
    save();
  }
}

function snapshot() {
  purgeTestFixtures();
  const s = load();
  return {
    runs:            structuredClone(s.runs || []),
    waves:           structuredClone(s.waves || []),
    waveLines:       structuredClone(s.waveLines || []),
    pickAllocations: structuredClone(s.pickAllocations || []),
    users:           structuredClone(s.users || []),
    // Per-zone-picker-assignment source-correction (2026-05-22):
    // pickable-users now reads from store.pickers, so the fixture
    // has to live (and roll back) on this slice too.
    pickers:         structuredClone(s.pickers || []),
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
  s.pickers         = snap.pickers;
  s.stops           = snap.stops;
  s.runOrders       = snap.runOrders;
  s.nextWaveId      = snap.nextWaveId;
  s.nextWaveLineId  = snap.nextWaveLineId;
  s.nextAllocId     = snap.nextAllocId;
  // Test-pollution fix (2026-05-23): createWaveFromLines calls save()
  // mid-test, so the on-disk store.json picks up the fixture inserts
  // (Run 90100/90200/..., Wave 99001/..., etc). Reverting the in-memory
  // cache alone leaves those rows orphaned on disk forever; rerunning
  // the suite multiplies them. Calling save() here flushes the restored
  // cache so disk and memory match.
  save();
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
// POST /api/runs/:id/wave.
//
// Source-correction (2026-05-22): the data source is now store.pickers
// (the warehouse-handheld entity, same one PickersPage uses), not
// store.users. The response shape is intentionally preserved — userId
// carries PickerId, and role is hard-coded 'WAREHOUSE' — so the frontend
// dropdown didn't need to change.
test('getPickableUsers: returns active pickers as { userId, fullName, role:WAREHOUSE }', () => {
  const snap = snapshot();
  try {
    const s = load();
    // Seed only the slice the function reads — the fixture deliberately
    // excludes inactive and proves users with a "pickable role" are NOT
    // surfaced anymore (the bug the source-correction fixes).
    s.pickers = [
      { PickerId: 201, Code: 'P-A', FullName: 'הראל טסט',  Phone: '050-1', IsActive: true },
      { PickerId: 202, Code: 'P-B', FullName: 'לורנזו טסט', Phone: '050-2', IsActive: true },
      { PickerId: 203, Code: 'P-C', FullName: 'מלקט מושבת', Phone: '050-3', IsActive: false },
    ];
    s.users = [
      // These three would have been picked up under the OLD source
      // (users.role ∈ {ADMIN,PLANNER,WAREHOUSE}); now they must NOT
      // appear in getPickableUsers. The test fails if the source
      // regresses back to users.
      { UserId: 901, Username: 'a', FullName: 'איציק טסט', Role: 'ADMIN',     IsActive: true },
      { UserId: 902, Username: 'b', FullName: 'מוטי טסט',  Role: 'PLANNER',   IsActive: true },
      { UserId: 903, Username: 'c', FullName: 'מחסנאי טסט', Role: 'WAREHOUSE', IsActive: true },
    ];

    const pickers = getPickableUsers();
    const ids = pickers.map((p) => p.userId).sort((a, b) => a - b);
    assert.deepEqual(ids, [201, 202], 'only active pickers; inactive excluded');
    // Shape contract — kept stable so frontend doesn't change
    for (const p of pickers) {
      assert.ok(typeof p.userId === 'number');
      assert.ok(typeof p.fullName === 'string');
      assert.equal(p.role, 'WAREHOUSE', 'role hard-coded for pickers');
    }
    // No user-table identities should leak in (regression guard)
    assert.ok(!ids.includes(901));
    assert.ok(!ids.includes(902));
    assert.ok(!ids.includes(903));
  } finally {
    restore(snap);
  }
});

test('isPickableUser: validates against store.pickers (active only)', () => {
  const snap = snapshot();
  try {
    const s = load();
    s.pickers = [
      { PickerId: 301, Code: 'P-X', FullName: 'מלקט פעיל',  Phone: '050', IsActive: true },
      { PickerId: 302, Code: 'P-Y', FullName: 'מלקט מושבת', Phone: '050', IsActive: false },
    ];
    // A user with a "pickable role" must NOT pass the validator — the
    // source-correction means user-table membership is irrelevant.
    s.users = [
      { UserId: 901, Username: 'admin', FullName: 'אדמין', Role: 'ADMIN', IsActive: true },
    ];

    assert.equal(isPickableUser(301), true,  'active picker accepted');
    assert.equal(isPickableUser(302), false, 'inactive picker rejected');
    assert.equal(isPickableUser(999), false, 'missing picker rejected');
    assert.equal(isPickableUser(901), false, 'user-table identity NOT accepted as picker');
    assert.equal(isPickableUser('301'), true, 'string id is coerced');
    assert.equal(isPickableUser(null), false);
    assert.equal(isPickableUser(undefined), false);
  } finally {
    restore(snap);
  }
});
