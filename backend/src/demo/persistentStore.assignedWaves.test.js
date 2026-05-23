/**
 * Unit tests for listAssignedWavesForPicker — Picker Task Inbox (2026-05-22).
 *
 * Covers the helper that backs GET /api/pickers/:pickerId/assigned-waves:
 *   1. picker with 2 assigned waves gets exactly those 2
 *   2. a different picker sees nothing from picker #1
 *   3. CANCELLED / COMPLETED waves are excluded
 *   4. waves on a CANCELLED run are excluded (even if active themselves)
 *   5. invalid pickerId (NaN, missing) → null (HTTP layer maps to 4xx)
 *   6. inactive picker → null
 *   7. orderCount / lineCount / completedLineCount / shortageCount math
 *
 * Same snapshot/restore pattern as persistentStore.createWave.test.js — we
 * seed the live cache, run, and roll back so subsequent tests / files are
 * not affected. The disk store.json is never written.
 *
 * Run:
 *   cd backend && node --test src/demo/persistentStore.assignedWaves.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, save, listAssignedWavesForPicker } from './persistentStore.js';

// Test-pollution fix (2026-05-23): purge fixtures that leaked into
// store.json from previous broken runs (Run/Stop/RunOrder >=80000,
// Wave >=80000, Picker >=8000) before the first snapshot. Restore()
// below already calls save() to prevent new leaks, but pre-existing
// rows would otherwise persist forever.
let _purgedOnce = false;
function purgeTestFixtures() {
  if (_purgedOnce) return;
  _purgedOnce = true;
  const s = load();
  const before = {
    runs: (s.runs||[]).length, waves: (s.waves||[]).length,
    stops: (s.stops||[]).length, runOrders: (s.runOrders||[]).length,
    pickers: (s.pickers||[]).length,
  };
  s.runs      = (s.runs      || []).filter((r)  => r.RunId      < 80000);
  s.waves     = (s.waves     || []).filter((w)  => w.WaveId     < 80000);
  s.stops     = (s.stops     || []).filter((st) => st.StopId    < 80000);
  s.runOrders = (s.runOrders || []).filter((o)  => o.RunOrderId < 80000);
  s.pickers   = (s.pickers   || []).filter((p)  => p.PickerId   < 8000);
  s.waveLines = (s.waveLines || []).filter((wl) => wl.WaveLineId < 99000);
  const after = {
    runs: s.runs.length, waves: s.waves.length,
    stops: s.stops.length, runOrders: s.runOrders.length,
    pickers: s.pickers.length,
  };
  if (before.runs      !== after.runs   ||
      before.waves     !== after.waves  ||
      before.stops     !== after.stops  ||
      before.runOrders !== after.runOrders ||
      before.pickers   !== after.pickers) {
    save();
  }
}

function snapshot() {
  purgeTestFixtures();
  const s = load();
  return {
    runs:        structuredClone(s.runs || []),
    waves:       structuredClone(s.waves || []),
    waveLines:   structuredClone(s.waveLines || []),
    stops:       structuredClone(s.stops || []),
    runOrders:   structuredClone(s.runOrders || []),
    pickers:     structuredClone(s.pickers || []),
  };
}
function restore(snap) {
  const s = load();
  s.runs      = snap.runs;
  s.waves     = snap.waves;
  s.waveLines = snap.waveLines;
  s.stops     = snap.stops;
  s.runOrders = snap.runOrders;
  s.pickers   = snap.pickers;
  // Test-pollution fix (2026-05-23): mid-test save() calls inside
  // persistentStore mutators leak fixtures (Pickers 800x, Runs 80100..,
  // Waves 80501..) onto store.json on disk. Reverting the in-memory
  // cache alone leaves those rows orphaned; flushing the restored
  // cache here keeps disk and memory in sync.
  save();
}

// Seed minimal fixture: 2 pickers, 1 inactive; 4 waves across 3 runs.
// Run 80100 active, Run 80200 CANCELLED. Picker 8001 owns waves on both.
function seedFixture() {
  const s = load();
  s.pickers = [
    { PickerId: 8001, Code: 'TEST-1', FullName: 'מלקט טסט 1', Phone: '050', IsActive: true },
    { PickerId: 8002, Code: 'TEST-2', FullName: 'מלקט טסט 2', Phone: '050', IsActive: true },
    { PickerId: 8003, Code: 'TEST-3', FullName: 'מלקט מושבת', Phone: '050', IsActive: false },
  ];
  s.runs = [
    { RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', ZoneId: 1, ZoneCode: 'SHARON',    ZoneName: 'שרון',  ZoneColor: '#0891b2', Status: 'PICKING',   CreatedAt: new Date().toISOString() },
    { RunId: 80200, RunNumber: 'TEST-RUN-200', RunDate: '2026-05-22', ZoneId: 2, ZoneCode: 'TEL_AVIV',  ZoneName: 'ת"א',   ZoneColor: '#000',    Status: 'CANCELLED', CreatedAt: new Date().toISOString() },
    { RunId: 80300, RunNumber: 'TEST-RUN-300', RunDate: '2026-05-22', ZoneId: 3, ZoneCode: 'CENTER_FAR',ZoneName: 'מרכז',  ZoneColor: '#888',    Status: 'OPEN',      CreatedAt: new Date().toISOString() },
  ];
  // 2 stops on Run 80100 with orders, 0 stops elsewhere (keep it minimal)
  s.stops = [
    { StopId: 80101, RunId: 80100, StopOrder: 1, City: 'הרצליה',  BranchName: 'A' },
    { StopId: 80102, RunId: 80100, StopOrder: 2, City: 'רעננה',   BranchName: 'B' },
  ];
  s.runOrders = [
    { RunOrderId: 80111, StopId: 80101, CompanyCode: 'A', SapDocEntry: 1, Status: 'OPEN' },
    { RunOrderId: 80112, StopId: 80101, CompanyCode: 'A', SapDocEntry: 2, Status: 'OPEN' },
    { RunOrderId: 80113, StopId: 80102, CompanyCode: 'A', SapDocEntry: 3, Status: 'OPEN' },
    { RunOrderId: 80114, StopId: 80102, CompanyCode: 'A', SapDocEntry: 4, Status: 'CANCELLED' }, // not counted
  ];
  // 4 waves: P/I/PQ assigned to picker 8001 on Run 80100; C/COMP on 80100 also assigned to 8001
  // 1 active wave assigned to 8001 on CANCELLED Run 80200 (must be filtered out)
  // 1 active wave on Run 80300 assigned to 8002 (must not leak to 8001)
  s.waves = [
    { WaveId: 80501, WaveNumber: 'W-501', RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', Status: 'PENDING',     AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T10:00:00Z', CreatedAt: '2026-05-22T10:00:00Z', StartedAt: null,                       TotalLines: 3, CompletedLines: 0 },
    { WaveId: 80502, WaveNumber: 'W-502', RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', Status: 'IN_PROGRESS', AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T11:00:00Z', CreatedAt: '2026-05-22T11:00:00Z', StartedAt: '2026-05-22T11:30:00Z',     TotalLines: 4, CompletedLines: 1 },
    { WaveId: 80503, WaveNumber: 'W-503', RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', Status: 'PENDING_QC',  AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T12:00:00Z', CreatedAt: '2026-05-22T12:00:00Z', StartedAt: null,                       TotalLines: 2, CompletedLines: 2 },
    { WaveId: 80504, WaveNumber: 'W-504', RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', Status: 'CANCELLED',   AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T13:00:00Z', CreatedAt: '2026-05-22T13:00:00Z', StartedAt: null,                       TotalLines: 1, CompletedLines: 0 },
    { WaveId: 80505, WaveNumber: 'W-505', RunId: 80100, RunNumber: 'TEST-RUN-100', RunDate: '2026-05-22', Status: 'COMPLETED',   AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T14:00:00Z', CreatedAt: '2026-05-22T14:00:00Z', StartedAt: '2026-05-22T14:30:00Z',     TotalLines: 5, CompletedLines: 5 },
    { WaveId: 80506, WaveNumber: 'W-506', RunId: 80200, RunNumber: 'TEST-RUN-200', RunDate: '2026-05-22', Status: 'PENDING',     AssignedPickerId: 8001, AssignedPickerName: 'מלקט טסט 1', AssignedAt: '2026-05-22T15:00:00Z', CreatedAt: '2026-05-22T15:00:00Z', StartedAt: null,                       TotalLines: 1, CompletedLines: 0 },
    { WaveId: 80507, WaveNumber: 'W-507', RunId: 80300, RunNumber: 'TEST-RUN-300', RunDate: '2026-05-22', Status: 'PENDING',     AssignedPickerId: 8002, AssignedPickerName: 'מלקט טסט 2', AssignedAt: '2026-05-22T16:00:00Z', CreatedAt: '2026-05-22T16:00:00Z', StartedAt: null,                       TotalLines: 1, CompletedLines: 0 },
  ];
  // Wave lines for the counter test (Wave 80502: 4 lines = 1 COMPLETED + 1 SHORTAGE + 2 PENDING)
  s.waveLines = [
    { WaveLineId: 1, WaveId: 80502, Status: 'COMPLETED' },
    { WaveLineId: 2, WaveId: 80502, Status: 'SHORTAGE'  },
    { WaveLineId: 3, WaveId: 80502, Status: 'PENDING'   },
    { WaveLineId: 4, WaveId: 80502, Status: 'PENDING'   },
    // Wave 80501 — no wave lines yet (lineCount=0, all aggregates=0)
    // Wave 80503 — 2 completed lines
    { WaveLineId: 5, WaveId: 80503, Status: 'COMPLETED' },
    { WaveLineId: 6, WaveId: 80503, Status: 'COMPLETED' },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────

test('listAssignedWavesForPicker: returns the 3 active waves for picker 8001 (P/IP/PQ)', () => {
  const snap = snapshot();
  try {
    seedFixture();
    const rows = listAssignedWavesForPicker(8001);
    assert.ok(Array.isArray(rows), 'returns array for valid picker');
    const ids = rows.map((r) => r.waveId).sort((a, b) => a - b);
    assert.deepEqual(ids, [80501, 80502, 80503], 'only P/IP/PQ assigned to picker 8001 on a non-cancelled run');
    // Sort priority: IN_PROGRESS first, then PENDING_QC, then PENDING
    assert.deepEqual(rows.map((r) => r.status), ['IN_PROGRESS', 'PENDING_QC', 'PENDING']);
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: picker 8002 sees only their own waves (no leak from 8001)', () => {
  const snap = snapshot();
  try {
    seedFixture();
    const rows = listAssignedWavesForPicker(8002);
    assert.ok(Array.isArray(rows));
    const ids = rows.map((r) => r.waveId);
    assert.deepEqual(ids, [80507], 'only the wave assigned to 8002');
    // Cross-check: no waves from picker 8001 leaked
    assert.ok(!ids.includes(80501));
    assert.ok(!ids.includes(80502));
    assert.ok(!ids.includes(80503));
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: CANCELLED and COMPLETED waves are excluded', () => {
  const snap = snapshot();
  try {
    seedFixture();
    const rows = listAssignedWavesForPicker(8001);
    const ids = rows.map((r) => r.waveId);
    assert.ok(!ids.includes(80504), 'CANCELLED wave excluded');
    assert.ok(!ids.includes(80505), 'COMPLETED wave excluded');
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: waves on a CANCELLED run are excluded', () => {
  const snap = snapshot();
  try {
    seedFixture();
    const rows = listAssignedWavesForPicker(8001);
    const ids = rows.map((r) => r.waveId);
    assert.ok(!ids.includes(80506), 'Wave 80506 is PENDING but its run (80200) is CANCELLED — must NOT appear');
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: invalid / missing pickerId returns null', () => {
  const snap = snapshot();
  try {
    seedFixture();
    assert.equal(listAssignedWavesForPicker(NaN), null, 'NaN');
    assert.equal(listAssignedWavesForPicker(null), null, 'null');
    assert.equal(listAssignedWavesForPicker(undefined), null, 'undefined');
    assert.equal(listAssignedWavesForPicker('abc'), null, 'non-numeric string');
    assert.equal(listAssignedWavesForPicker(99999), null, 'pickerId that does not exist');
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: inactive picker returns null', () => {
  const snap = snapshot();
  try {
    seedFixture();
    assert.equal(listAssignedWavesForPicker(8003), null, 'IsActive=false picker rejected');
  } finally {
    restore(snap);
  }
});

test('listAssignedWavesForPicker: counts (orderCount/lineCount/completedLineCount/shortageCount) are correct', () => {
  const snap = snapshot();
  try {
    seedFixture();
    const rows = listAssignedWavesForPicker(8001);
    const w501 = rows.find((r) => r.waveId === 80501);
    const w502 = rows.find((r) => r.waveId === 80502);
    const w503 = rows.find((r) => r.waveId === 80503);

    // Run 80100 has 4 runOrders but 1 is CANCELLED → orderCount = 3 (shared across all waves on this run)
    assert.equal(w501.orderCount, 3, 'orderCount counts non-cancelled runOrders on the run');
    assert.equal(w502.orderCount, 3);
    assert.equal(w503.orderCount, 3);

    // Wave 80501 — no wave lines seeded → all counts 0
    assert.equal(w501.lineCount,          0);
    assert.equal(w501.completedLineCount, 0);
    assert.equal(w501.shortageCount,      0);

    // Wave 80502 — 4 lines: 1 COMPLETED, 1 SHORTAGE, 2 PENDING
    assert.equal(w502.lineCount,          4);
    assert.equal(w502.completedLineCount, 1);
    assert.equal(w502.shortageCount,      1);

    // Wave 80503 — 2 lines, both COMPLETED
    assert.equal(w503.lineCount,          2);
    assert.equal(w503.completedLineCount, 2);
    assert.equal(w503.shortageCount,      0);

    // Denormalised Run fields appear on every row
    for (const r of rows) {
      assert.equal(r.zoneCode,  'SHARON');
      assert.equal(r.zoneName,  'שרון');
      assert.equal(r.zoneColor, '#0891b2');
      assert.equal(r.runNumber, 'TEST-RUN-100');
      assert.equal(r.assignedPickerId,   8001);
      assert.equal(r.assignedPickerName, 'מלקט טסט 1');
      assert.ok(typeof r.assignedAt === 'string' && r.assignedAt.length > 0);
      assert.ok(typeof r.createdAt  === 'string' && r.createdAt.length  > 0);
    }
  } finally {
    restore(snap);
  }
});
