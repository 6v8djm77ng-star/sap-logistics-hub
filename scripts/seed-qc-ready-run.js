#!/usr/bin/env node
/**
 * scripts/seed-qc-ready-run.js
 *
 * Creates a minimal, QC-ready test Run for validating Phase A2 SAP dry-run
 * write end-to-end, WITHOUT touching any real customer data or hitting SAP.
 *
 * Why this exists:
 *   Phase A2 (dry-run SAP DN write inside flush-aggregate-docs) is code-
 *   complete but blocked from e2e validation because no real RunOrder in
 *   the store currently has a non-empty fulfillment (Bug A was just fixed,
 *   Bug B re. recordPick→allocations propagation is still pending). To
 *   exercise the A2 happy path we need ONE run where:
 *     - A QC-ready order exists
 *     - That order's customer has a valid DocPolicy (aggregateDN=yes)
 *     - The wave is active (not CANCELLED) and has waveAllocations with
 *       PickedQuantity > 0, so _computeOrderFulfillment returns non-empty
 *
 * Safety model:
 *   - All seeded entities are tagged { IsTest: true } so cleanup is a
 *     pure tag filter. No real customer/run/order is touched.
 *   - SapDocEntry uses a high reserved range (9_900_000+) that does not
 *     collide with real SAP numbers (real ones are 4-5 digits).
 *   - CardCode is the synthetic 'TEST-SEED-A1' — no real CardCode ever
 *     matches that. The matching test customer profile is also IsTest=true.
 *   - SAP_WRITE_ENABLED is NOT touched. The A2 flush will run in dry-run
 *     mode regardless.
 *   - The script stops sap-logistics before mutating store.json (so the
 *     server's in-memory state doesn't overwrite our edits on graceful
 *     shutdown), takes a timestamped backup, then starts the server and
 *     waits for HTTP liveness.
 *
 * Usage:
 *   node scripts/seed-qc-ready-run.js                # preview only (no changes)
 *   node scripts/seed-qc-ready-run.js --apply        # actually create the seed
 *   node scripts/seed-qc-ready-run.js --cleanup      # remove ALL IsTest=true entries
 *
 * Exit codes:
 *   0  success
 *   1  store.json not found
 *   2  store.json below minimum size (refused — likely truncated)
 *   3  pm2 stop / start failed
 *   4  HTTP liveness check failed after start
 *
 * After --apply, run the A2 e2e check manually (or wire a follow-up script):
 *   curl -X POST http://localhost:4000/api/orders/<runOrderId>/qc-approve
 *   curl -X POST http://localhost:4000/api/runs/<runId>/flush-aggregate-docs
 *   → expect: dryRunPayloads array populated, SapDeliveryDocEntry stays null,
 *             dn.Status stays PENDING_EXPORT.
 *
 * Created 2026-05-16 for Phase A2 dry-run validation. Delete this file +
 * run `--cleanup` when A2 is fully validated and the seed is no longer
 * needed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

// ---------------------------------------------------------------------------
// Config — keep these in one place for grep-ability when cleaning up later.
// ---------------------------------------------------------------------------
const STORE_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'store.json');
const MIN_STORE_SIZE_BYTES = 100_000; // safety floor; real store is ~2.5 MB
const PM2_APP = 'sap-logistics';
const LIVENESS_URL = 'http://localhost:4000/api/auth/me'; // 401 is fine — proves up
const LIVENESS_RETRIES = 20;
const LIVENESS_DELAY_MS = 500;

// Identification constants — every seeded entity carries IsTest:true PLUS
// one of these stable markers so cleanup can also catch entries that lost
// their IsTest flag somehow (defense in depth).
const TEST_CARDCODE = 'TEST-SEED-A1';
const TEST_CARDNAME = 'טסט - לקוח לבדיקת A2 dry-run';
const TEST_COMPANY_CODE = 'A';  // OIG
const TEST_COMPANY_ID = 1;
const TEST_COMPANY_NAME = 'OIG';
const TEST_RUN_PREFIX = 'SEED-TEST-';     // RunNumber begins with this
const TEST_SAPDOCENTRY_BASE = 9_900_000;  // reserved high range, no collision

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function log(msg) { console.log('[seed-qc-ready-run] ' + msg); }
function err(msg) { console.error('[seed-qc-ready-run] ERROR: ' + msg); }

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) { err('store.json not found: ' + STORE_PATH); process.exit(1); }
  const stat = fs.statSync(STORE_PATH);
  if (stat.size < MIN_STORE_SIZE_BYTES) {
    err(`store.json too small (${stat.size} bytes < ${MIN_STORE_SIZE_BYTES} floor) — refusing`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}
function saveStore(s) { fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2)); }

function backupStore(tag) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', 'T').split('Z')[0];
  const dst = path.resolve(path.dirname(STORE_PATH), `store.PRE-${tag}-${ts}.json`);
  fs.copyFileSync(STORE_PATH, dst);
  log('backup: ' + path.basename(dst));
  return dst;
}

function pm2Stop() {
  try { execSync(`pm2 stop ${PM2_APP}`, { stdio: 'pipe' }); log('pm2 stop ok'); }
  catch (e) { err('pm2 stop failed: ' + e.message); process.exit(3); }
}
function pm2Start() {
  try { execSync(`pm2 start ${PM2_APP}`, { stdio: 'pipe' }); log('pm2 start ok'); }
  catch (e) { err('pm2 start failed: ' + e.message); process.exit(3); }
}

async function waitLiveness() {
  for (let i = 0; i < LIVENESS_RETRIES; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get(LIVENESS_URL, (res) => { resolve(res.statusCode === 401 || res.statusCode === 200); res.resume(); });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => { req.destroy(); resolve(false); });
    });
    if (ok) { log(`liveness ok after ${i + 1} attempts`); return; }
    await new Promise((r) => setTimeout(r, LIVENESS_DELAY_MS));
  }
  err('server did not respond on ' + LIVENESS_URL);
  process.exit(4);
}

// ---------------------------------------------------------------------------
// Seed plan — what we add. Documented so reviewers see the full footprint.
// ---------------------------------------------------------------------------
function buildSeedPlan(s) {
  const now = new Date().toISOString();
  const runTag = TEST_RUN_PREFIX + Date.now();

  // Counters: bump from current store. Do NOT decrement on cleanup — these
  // are monotonic and small wasted-id gaps are harmless.
  const nextRunId = s.nextRunId || 1;
  const nextStopId = s.nextStopId || 1;
  const nextRunOrderId = s.nextRunOrderId || 1;
  const nextWaveId = s.nextWaveId || 1;
  const nextWaveLineId = s.nextWaveLineId || 1;
  const nextWaveAllocationId = s.nextWaveAllocationId || 1;

  // 1 Run — minimal fields only; mirrors the shape of real runs.
  const run = {
    RunId: nextRunId,
    RunNumber: runTag,
    RunDate: now.split('T')[0],
    ZoneId: 1, ZoneCode: 'TEST', ZoneName: 'בדיקה', ZoneColor: '#888888',
    DriverId: null, DriverName: '', DriverPhone: '', VehiclePlate: '',
    Status: 'OPEN', PlannedStartTime: null, ActualStartTime: null, ActualEndTime: null,
    Notes: 'TEST SEED — auto-created for Phase A2 dry-run validation. Safe to delete via --cleanup.',
    CreatedAt: now,
    StopCount: 2, OrderCount: 2, PalletMode: 'SINGLE',
    IsTest: true,
  };

  // 2 Stops (each holds 1 RunOrder). Test addresses; no real geolocation.
  const stops = [
    { StopId: nextStopId,     RunId: run.RunId, AddressId: null, StopOrder: 1, Status: 'PENDING',
      ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: 'TEST',
      Street: 'בדיקה 1', BuildingNumber: '', City: 'תל אביב', BranchName: TEST_CARDNAME + ' #1',
      Latitude: null, Longitude: null, DeliveryWindowStart: null, DeliveryWindowEnd: null,
      DeliveryDays: null, ContactPhone: null, ContactName: null, DeliveryNotes: null,
      SuggestedZoneId: 1, SuggestedZoneName: 'בדיקה', IsTest: true },
    { StopId: nextStopId + 1, RunId: run.RunId, AddressId: null, StopOrder: 2, Status: 'PENDING',
      ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: 'TEST',
      Street: 'בדיקה 2', BuildingNumber: '', City: 'תל אביב', BranchName: TEST_CARDNAME + ' #2',
      Latitude: null, Longitude: null, DeliveryWindowStart: null, DeliveryWindowEnd: null,
      DeliveryDays: null, ContactPhone: null, ContactName: null, DeliveryNotes: null,
      SuggestedZoneId: 1, SuggestedZoneName: 'בדיקה', IsTest: true },
  ];

  // 2 RunOrders, both for the SAME synthetic customer so aggregateDN flow
  // groups them. SapDocEntry in reserved high range (no real collision).
  const runOrders = [
    { RunOrderId: nextRunOrderId,     StopId: stops[0].StopId, CompanyId: TEST_COMPANY_ID,
      CompanyCode: TEST_COMPANY_CODE, CompanyName: TEST_COMPANY_NAME,
      SapDocEntry: TEST_SAPDOCENTRY_BASE + 1, SapDocNum: TEST_SAPDOCENTRY_BASE + 1,
      SapCardCode: TEST_CARDCODE, SapCardName: TEST_CARDNAME,
      OrderTotal: 100, LinesCount: 2, Status: 'PENDING', SapDeliveryDocEntry: null,
      IsTest: true },
    { RunOrderId: nextRunOrderId + 1, StopId: stops[1].StopId, CompanyId: TEST_COMPANY_ID,
      CompanyCode: TEST_COMPANY_CODE, CompanyName: TEST_COMPANY_NAME,
      SapDocEntry: TEST_SAPDOCENTRY_BASE + 2, SapDocNum: TEST_SAPDOCENTRY_BASE + 2,
      SapCardCode: TEST_CARDCODE, SapCardName: TEST_CARDNAME,
      OrderTotal: 60, LinesCount: 1, Status: 'PENDING', SapDeliveryDocEntry: null,
      IsTest: true },
  ];

  // 1 Wave (COMPLETED — so _selectActiveWaveForRun picks it).
  const wave = {
    WaveId: nextWaveId,
    WaveNumber: 'WAVE-' + runTag,
    RunId: run.RunId, RunNumber: run.RunNumber, RunDate: run.RunDate,
    Status: 'COMPLETED',
    PickedBy: 1, PickedByName: 'TEST SEED',
    StartedAt: now, CompletedAt: now, CreatedAt: now,
    TotalLines: 2, CompletedLines: 2,
    QcApprovedAt: null, QcApprovedBy: null,
    IsTest: true,
  };

  // 2 WaveLines (1 per item). Quantities sum to what's allocated below.
  const waveLines = [
    { WaveLineId: nextWaveLineId,     WaveId: wave.WaveId,
      SapItemCode: 'TEST-ITEM-01', SapItemName: 'פריט בדיקה 1', Barcode: 'TEST001',
      UomCode: 'יח', BinLocation: 'TEST',
      TotalQuantity: 3, PickedQuantity: 3, Status: 'COMPLETED', AllocationCount: 2, Notes: null,
      IsTest: true },
    { WaveLineId: nextWaveLineId + 1, WaveId: wave.WaveId,
      SapItemCode: 'TEST-ITEM-02', SapItemName: 'פריט בדיקה 2', Barcode: 'TEST002',
      UomCode: 'יח', BinLocation: 'TEST',
      TotalQuantity: 2, PickedQuantity: 2, Status: 'COMPLETED', AllocationCount: 1, Notes: null,
      IsTest: true },
  ];

  // 3 WaveAllocations — each with PickedQuantity > 0. Linkage:
  //   line 1 (3 units) → split: order1=2, order2=1
  //   line 2 (2 units) → all to order1
  const waveAllocations = [
    { AllocationId: nextWaveAllocationId,     WaveLineId: waveLines[0].WaveLineId,
      CompanyCode: TEST_COMPANY_CODE, SapDocEntry: runOrders[0].SapDocEntry,
      SapDocNum: runOrders[0].SapDocNum, SapOrderLineNum: 1,
      SapCardName: TEST_CARDNAME, City: 'תל אביב', BranchName: TEST_CARDNAME + ' #1',
      Quantity: 2, PickedQuantity: 2, Status: 'COMPLETED', IsTest: true },
    { AllocationId: nextWaveAllocationId + 1, WaveLineId: waveLines[0].WaveLineId,
      CompanyCode: TEST_COMPANY_CODE, SapDocEntry: runOrders[1].SapDocEntry,
      SapDocNum: runOrders[1].SapDocNum, SapOrderLineNum: 1,
      SapCardName: TEST_CARDNAME, City: 'תל אביב', BranchName: TEST_CARDNAME + ' #2',
      Quantity: 1, PickedQuantity: 1, Status: 'COMPLETED', IsTest: true },
    { AllocationId: nextWaveAllocationId + 2, WaveLineId: waveLines[1].WaveLineId,
      CompanyCode: TEST_COMPANY_CODE, SapDocEntry: runOrders[0].SapDocEntry,
      SapDocNum: runOrders[0].SapDocNum, SapOrderLineNum: 2,
      SapCardName: TEST_CARDNAME, City: 'תל אביב', BranchName: TEST_CARDNAME + ' #1',
      Quantity: 2, PickedQuantity: 2, Status: 'COMPLETED', IsTest: true },
  ];

  // 1 synthetic customer DeliveryProfile — aggregateDN=yes so the A2
  // flush-aggregate-docs path is exercised. Per-order DN/INV stay 'no'
  // to keep the flow narrow (one DN per customer, no invoice).
  const customerProfile = {
    CardCode: TEST_CARDCODE,
    Company: TEST_COMPANY_NAME,
    Name: TEST_CARDNAME,
    City: 'תל אביב', Street: 'בדיקה 1', Zone: 'TEST', SubZone: '',
    ZoneNameRaw: 'בדיקה', DeliveryDays: [], Issue: '',
    DocPolicy: {
      perOrderDeliveryNote: 'no',
      perOrderInvoice: 'no',
      aggregateDeliveryNote: 'yes',
      aggregateInvoice: 'no',
      notes: 'TEST SEED — for Phase A2 dry-run validation only. Delete with --cleanup.',
      updatedAt: now,
    },
    IsTest: true,
  };

  return { run, stops, runOrders, wave, waveLines, waveAllocations, customerProfile,
           counters: {
             nextRunId: nextRunId + 1,
             nextStopId: nextStopId + 2,
             nextRunOrderId: nextRunOrderId + 2,
             nextWaveId: nextWaveId + 1,
             nextWaveLineId: nextWaveLineId + 2,
             nextWaveAllocationId: nextWaveAllocationId + 3,
           } };
}

function applySeed(s, plan) {
  // Idempotency: if a profile with our CardCode already exists, abort.
  if ((s.customerDeliveryProfiles || []).some((p) => p.CardCode === TEST_CARDCODE)) {
    err(`A profile with CardCode=${TEST_CARDCODE} already exists. Run --cleanup first.`);
    process.exit(5);
  }
  (s.runs ||= []).push(plan.run);
  (s.stops ||= []).push(...plan.stops);
  (s.runOrders ||= []).push(...plan.runOrders);
  (s.waves ||= []).push(plan.wave);
  (s.waveLines ||= []).push(...plan.waveLines);
  (s.waveAllocations ||= []).push(...plan.waveAllocations);
  (s.customerDeliveryProfiles ||= []).push(plan.customerProfile);
  Object.assign(s, plan.counters);
}

function applyCleanup(s) {
  const removed = {};

  // Step 1 — collect IDs from the seed BEFORE we remove anything, so DNs
  // and invoices (which don't carry IsTest themselves — they're created
  // later by flush/QC-approve from the seeded orders) can still be matched
  // by their RunId / RunOrderId / SourceOrders[].RunOrderId references.
  const seedRunIds = new Set((s.runs || []).filter((r) => r && r.IsTest === true).map((r) => r.RunId));
  const seedRunOrderIds = new Set((s.runOrders || []).filter((o) => o && o.IsTest === true).map((o) => o.RunOrderId));

  const filterOut = (key) => {
    const before = (s[key] || []).length;
    s[key] = (s[key] || []).filter((x) => !x || x.IsTest !== true);
    removed[key] = before - s[key].length;
  };
  // Order matters for human readability; functionally any order works.
  filterOut('waveAllocations');
  filterOut('waveLines');
  filterOut('waves');
  filterOut('runOrders');
  filterOut('stops');
  filterOut('runs');
  filterOut('customerDeliveryProfiles');

  // Step 2 — DNs/invoices generated by the e2e (flush, QC-approve) inherit
  // the seed's identity through SapCardCode + RunId + SourceOrders[].
  // Match on ANY of these so a partial e2e (only QC-approve, only flush,
  // both, etc.) still leaves the store clean.
  const matchesSeed = (doc) => {
    if (!doc) return true; // drop nulls regardless
    if (doc.IsTest === true) return true;
    if (typeof doc.SapCardCode === 'string' && doc.SapCardCode === TEST_CARDCODE) return true;
    if (typeof doc.CardCode === 'string' && doc.CardCode === TEST_CARDCODE) return true;
    if (doc.RunId != null && seedRunIds.has(doc.RunId)) return true;
    if (doc.RunOrderId != null && seedRunOrderIds.has(doc.RunOrderId)) return true;
    if (Array.isArray(doc.SourceOrders) &&
        doc.SourceOrders.some((src) => src && seedRunOrderIds.has(src.RunOrderId))) return true;
    if (typeof doc.DocNumber === 'string' && doc.DocNumber.includes(TEST_RUN_PREFIX)) return true;
    return false;
  };

  const before_dn = (s.deliveryNotes || []).length;
  s.deliveryNotes = (s.deliveryNotes || []).filter((d) => !matchesSeed(d));
  removed.deliveryNotes = before_dn - s.deliveryNotes.length;

  const before_inv = (s.invoices || []).length;
  s.invoices = (s.invoices || []).filter((i) => !matchesSeed(i));
  removed.invoices = before_inv - s.invoices.length;

  return removed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const isCleanup = args.includes('--cleanup');

(async () => {
  if (isApply && isCleanup) { err('--apply and --cleanup are mutually exclusive'); process.exit(1); }

  // Dry-run preview path: no server touch, no mutation.
  if (!isApply && !isCleanup) {
    const s = loadStore();
    const plan = buildSeedPlan(s);
    log('=== PREVIEW (no changes) ===');
    log(`Would add 1 run (RunId=${plan.run.RunId}, ${plan.run.RunNumber})`);
    log(`Would add 2 stops (StopId ${plan.stops[0].StopId}..${plan.stops[1].StopId})`);
    log(`Would add 2 runOrders (RunOrderId ${plan.runOrders[0].RunOrderId}..${plan.runOrders[1].RunOrderId})`);
    log(`Would add 1 wave (WaveId=${plan.wave.WaveId}, Status=${plan.wave.Status})`);
    log(`Would add 2 waveLines (WaveLineId ${plan.waveLines[0].WaveLineId}..${plan.waveLines[1].WaveLineId})`);
    log(`Would add 3 waveAllocations (AllocationId ${plan.waveAllocations[0].AllocationId}..${plan.waveAllocations[2].AllocationId})`);
    log(`Would add 1 customer profile (CardCode=${TEST_CARDCODE}, DocPolicy.aggregateDN=yes)`);
    log('Run with --apply to actually seed, --cleanup to remove all IsTest=true entries.');
    process.exit(0);
  }

  pm2Stop();
  backupStore(isApply ? 'SEED-APPLY' : 'SEED-CLEANUP');
  const s = loadStore();

  if (isApply) {
    const plan = buildSeedPlan(s);
    applySeed(s, plan);
    saveStore(s);
    log(`seeded: run=${plan.run.RunId} orders=[${plan.runOrders.map((o) => o.RunOrderId).join(',')}] wave=${plan.wave.WaveId}`);
    pm2Start();
    await waitLiveness();
    log('=== APPLY DONE ===');
    log(`RunId=${plan.run.RunId}  RunNumber=${plan.run.RunNumber}`);
    log(`RunOrderIds=${plan.runOrders.map((o) => o.RunOrderId).join(',')}`);
    log(`Next steps (manual, dry-run only):`);
    log(`  curl -X POST http://localhost:4000/api/orders/${plan.runOrders[0].RunOrderId}/qc-approve`);
    log(`  curl -X POST http://localhost:4000/api/orders/${plan.runOrders[1].RunOrderId}/qc-approve`);
    log(`  curl -X POST http://localhost:4000/api/runs/${plan.run.RunId}/flush-aggregate-docs`);
    log(`Cleanup when done: node scripts/seed-qc-ready-run.js --cleanup`);
  } else {
    const removed = applyCleanup(s);
    saveStore(s);
    log('removed: ' + JSON.stringify(removed));
    pm2Start();
    await waitLiveness();
    log('=== CLEANUP DONE ===');
  }
})();
