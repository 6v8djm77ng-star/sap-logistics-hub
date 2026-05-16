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
 *   node scripts/seed-qc-ready-run.js                                       # preview only (no changes)
 *   node scripts/seed-qc-ready-run.js --apply                               # actually create the seed (synthetic)
 *   node scripts/seed-qc-ready-run.js --apply --use-real-sap-orders=<json>  # seed from real SAP orders (A2c-3)
 *   node scripts/seed-qc-ready-run.js --cleanup                             # remove ALL IsTest=true entries
 *
 * A2c-3 flag (--use-real-sap-orders=<path>):
 *   Reads the JSON output of scripts/discover-test-sap-orders.js --json
 *   (an object with `orders[]`, each having DocEntry, CardCode, DocumentLines)
 *   and creates the test RunOrders pointing at real SAP DocEntries instead
 *   of the synthetic 9_900_000+ range. Picks up to 2 orders for the seed.
 *
 *   When this flag is set:
 *     - RunOrders use real SapDocEntry / SapDocNum / SapCardCode / SapCardName
 *     - WaveLines + WaveAllocations are built from the real DocumentLines
 *     - Quantities come from OpenQuantity (fallback Quantity)
 *     - If the real CardCode already has a customerDeliveryProfile, we
 *       reuse it (the real customer's DocPolicy applies). Otherwise we
 *       create a tagged-IsTest profile with aggregateDeliveryNote=yes.
 *   When the flag is NOT set:
 *     - Synthetic behaviour (CardCode=TEST-SEED-A1, SapDocEntry=9_900_001+)
 *       — unchanged from the original A2c-2 seed.
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
//
// A2c-3 (2026-05-16): accepts an optional `realOrders` array (from
// scripts/discover-test-sap-orders.js --json). When provided, the seed
// uses real SAP DocEntries / CardCodes / DocumentLines instead of the
// synthetic 9_900_000+ range. When null, behaviour is unchanged from
// the original A2c-2 synthetic seed.
// ---------------------------------------------------------------------------
function buildSeedPlan(s, realOrders = null) {
  const now = new Date().toISOString();
  const runTag = TEST_RUN_PREFIX + Date.now();
  const useReal = Array.isArray(realOrders) && realOrders.length >= 1;

  // Pick up to 2 real orders (mirror the synthetic seed shape — 2 orders, 1
  // customer profile, 1 wave). If fewer than 2 supplied, work with what we have.
  const selectedOrders = useReal ? realOrders.slice(0, 2) : null;
  const orderCount = useReal ? selectedOrders.length : 2;

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
    Notes: useReal
      ? 'TEST SEED (A2c-3 real SAP orders) — Safe to delete via --cleanup.'
      : 'TEST SEED — auto-created for Phase A2 dry-run validation. Safe to delete via --cleanup.',
    CreatedAt: now,
    StopCount: orderCount, OrderCount: orderCount, PalletMode: 'SINGLE',
    IsTest: true,
  };

  // Stops — one per RunOrder. In real mode, BranchName comes from CardName.
  const stops = [];
  for (let i = 0; i < orderCount; i++) {
    const cardName = useReal
      ? (selectedOrders[i].CardName || selectedOrders[i].CardCode)
      : (TEST_CARDNAME + ' #' + (i + 1));
    stops.push({
      StopId: nextStopId + i, RunId: run.RunId, AddressId: null,
      StopOrder: i + 1, Status: 'PENDING',
      ArrivedAt: null, CompletedAt: null, SignatureUrl: null, PhotoUrl: null, Notes: 'TEST',
      Street: useReal ? '' : `בדיקה ${i + 1}`, BuildingNumber: '',
      City: useReal ? '' : 'תל אביב',
      BranchName: cardName,
      Latitude: null, Longitude: null, DeliveryWindowStart: null, DeliveryWindowEnd: null,
      DeliveryDays: null, ContactPhone: null, ContactName: null, DeliveryNotes: null,
      SuggestedZoneId: 1, SuggestedZoneName: 'בדיקה', IsTest: true,
    });
  }

  // RunOrders — real or synthetic.
  let runOrders;
  if (useReal) {
    runOrders = selectedOrders.map((src, i) => ({
      RunOrderId: nextRunOrderId + i,
      StopId: stops[i].StopId,
      CompanyId: TEST_COMPANY_ID,
      CompanyCode: TEST_COMPANY_CODE,
      CompanyName: TEST_COMPANY_NAME,
      SapDocEntry: Number(src.DocEntry),
      SapDocNum: Number(src.DocNum != null ? src.DocNum : src.DocEntry),
      SapCardCode: src.CardCode,
      SapCardName: src.CardName || src.CardCode,
      OrderTotal: Number(src.DocTotal || 0),
      LinesCount: (src.DocumentLines || []).length,
      Status: 'PENDING',
      SapDeliveryDocEntry: null,
      IsTest: true,
    }));
  } else {
    // Synthetic: 2 RunOrders for the same fake customer, SapDocEntry in
    // reserved high range (no real collision).
    runOrders = [
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
  }

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

  // WaveLines + WaveAllocations
  let waveLines, waveAllocations;
  if (useReal) {
    // Real mode: each unique ItemCode across selectedOrders → one WaveLine.
    // Each (line × order) pair with qty > 0 → one Allocation.
    const lineMap = new Map(); // ItemCode → wlObj
    for (const src of selectedOrders) {
      for (const ln of (src.DocumentLines || [])) {
        const itemKey = ln.ItemCode;
        if (!itemKey) continue;
        const qty = Number(ln.OpenQuantity != null ? ln.OpenQuantity : ln.Quantity || 0);
        if (qty <= 0) continue;
        if (!lineMap.has(itemKey)) {
          lineMap.set(itemKey, {
            WaveLineId: nextWaveLineId + lineMap.size,
            SapItemCode: ln.ItemCode,
            SapItemName: ln.ItemDescription || ln.ItemCode,
            Barcode: ln.Barcode || '',
            TotalQuantity: 0,
            PickedQuantity: 0,
            allocs: [],
          });
        }
        const wl = lineMap.get(itemKey);
        wl.TotalQuantity += qty;
        wl.PickedQuantity += qty;
        wl.allocs.push({
          CompanyCode: TEST_COMPANY_CODE,
          SapDocEntry: Number(src.DocEntry),
          SapDocNum: Number(src.DocNum != null ? src.DocNum : src.DocEntry),
          SapOrderLineNum: ln.LineNum != null ? Number(ln.LineNum) : 0,
          SapCardName: src.CardName || src.CardCode,
          City: '',
          BranchName: src.CardName || src.CardCode,
          Quantity: qty,
          PickedQuantity: qty,
        });
      }
    }
    waveLines = [];
    waveAllocations = [];
    let allocSeq = 0;
    for (const wl of lineMap.values()) {
      waveLines.push({
        WaveLineId: wl.WaveLineId, WaveId: wave.WaveId,
        SapItemCode: wl.SapItemCode, SapItemName: wl.SapItemName, Barcode: wl.Barcode,
        UomCode: 'יח', BinLocation: 'TEST',
        TotalQuantity: wl.TotalQuantity, PickedQuantity: wl.PickedQuantity,
        Status: 'COMPLETED', AllocationCount: wl.allocs.length, Notes: null, IsTest: true,
      });
      for (const a of wl.allocs) {
        waveAllocations.push({
          AllocationId: nextWaveAllocationId + allocSeq++,
          WaveLineId: wl.WaveLineId,
          ...a,
          Status: 'COMPLETED', IsTest: true,
        });
      }
    }
  } else {
    // Synthetic — 2 WaveLines + 3 WaveAllocations as before.
    waveLines = [
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
    waveAllocations = [
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
  }

  // Customer DeliveryProfile.
  //   - Real mode: if a profile already exists for the real CardCode, reuse it
  //     (the real customer's DocPolicy applies). Otherwise create a tagged-
  //     IsTest profile with aggregateDeliveryNote='yes' so the flush flow has
  //     somewhere to land.
  //   - Synthetic mode: always create the TEST-SEED-A1 profile.
  let customerProfile = null;
  if (useReal) {
    const realCardCode = selectedOrders[0].CardCode;
    const existing = (s.customerDeliveryProfiles || []).find((p) => p && p.CardCode === realCardCode);
    if (!existing) {
      customerProfile = {
        CardCode: realCardCode,
        Company: TEST_COMPANY_NAME,
        Name: selectedOrders[0].CardName || realCardCode,
        City: '', Street: '', Zone: 'TEST', SubZone: '',
        ZoneNameRaw: '', DeliveryDays: [], Issue: '',
        DocPolicy: {
          perOrderDeliveryNote: 'no',
          perOrderInvoice: 'no',
          aggregateDeliveryNote: 'yes',
          aggregateInvoice: 'no',
          notes: 'TEST SEED (A2c-3 real-orders) — Delete with --cleanup.',
          updatedAt: now,
        },
        IsTest: true,
      };
    }
    // If existing profile, customerProfile stays null → applySeed skips it
    // → real customer's existing DocPolicy applies.
  } else {
    customerProfile = {
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
  }

  return {
    run, stops, runOrders, wave, waveLines, waveAllocations, customerProfile,
    counters: {
      nextRunId: nextRunId + 1,
      nextStopId: nextStopId + stops.length,
      nextRunOrderId: nextRunOrderId + runOrders.length,
      nextWaveId: nextWaveId + 1,
      nextWaveLineId: nextWaveLineId + waveLines.length,
      nextWaveAllocationId: nextWaveAllocationId + waveAllocations.length,
    },
  };
}

function applySeed(s, plan) {
  // Idempotency: refuse if a seed run with the SEED-TEST- prefix is already
  // in the store. Covers both synthetic and real-orders modes — the run
  // prefix is the stable identifier (CardCode differs between modes).
  const existingSeed = (s.runs || []).find(
    (r) => r && r.IsTest === true && typeof r.RunNumber === 'string' && r.RunNumber.startsWith(TEST_RUN_PREFIX)
  );
  if (existingSeed) {
    err(`A test seed run already exists (RunId=${existingSeed.RunId}, ${existingSeed.RunNumber}). Run --cleanup first.`);
    process.exit(5);
  }
  (s.runs ||= []).push(plan.run);
  (s.stops ||= []).push(...plan.stops);
  (s.runOrders ||= []).push(...plan.runOrders);
  (s.waves ||= []).push(plan.wave);
  (s.waveLines ||= []).push(...plan.waveLines);
  (s.waveAllocations ||= []).push(...plan.waveAllocations);
  // customerProfile is null in real-orders mode when an existing profile is
  // being reused — don't push null into the array.
  if (plan.customerProfile) {
    (s.customerDeliveryProfiles ||= []).push(plan.customerProfile);
  }
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
// A2c-3 helper: load real SAP orders from discovery JSON output
// ---------------------------------------------------------------------------
function loadRealSapOrders(filePath) {
  if (!fs.existsSync(filePath)) {
    err(`--use-real-sap-orders: file not found: ${filePath}`);
    process.exit(6);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    err(`--use-real-sap-orders: failed to parse JSON: ${e.message}`);
    process.exit(6);
  }
  // Accept either the discover-test-sap-orders --json shape ({ orders: [...] })
  // or a bare array of orders. Be forgiving.
  const orders = Array.isArray(parsed) ? parsed
               : Array.isArray(parsed.orders) ? parsed.orders
               : null;
  if (!orders || orders.length === 0) {
    err(`--use-real-sap-orders: no orders found in file (expected {orders:[...]} or bare array)`);
    process.exit(6);
  }
  // Sanity-check each order has the fields buildSeedPlan needs.
  for (const o of orders) {
    if (o.DocEntry == null || !o.CardCode) {
      err(`--use-real-sap-orders: order missing DocEntry or CardCode: ${JSON.stringify(o).slice(0, 200)}`);
      process.exit(6);
    }
  }
  log(`loaded ${orders.length} real SAP orders from ${path.basename(filePath)}`);
  return orders;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isApply = args.includes('--apply');
const isCleanup = args.includes('--cleanup');
const realFlagArg = args.find((a) => a.startsWith('--use-real-sap-orders='));
const REAL_ORDERS_PATH = realFlagArg ? realFlagArg.split('=').slice(1).join('=') : null;

(async () => {
  if (isApply && isCleanup) { err('--apply and --cleanup are mutually exclusive'); process.exit(1); }
  if (REAL_ORDERS_PATH && isCleanup) {
    err('--use-real-sap-orders is for --apply only (cleanup matches by IsTest tag, no SAP data needed)');
    process.exit(1);
  }

  // A2c-3: load real orders BEFORE any server touch — fail-fast on bad input.
  const realOrders = REAL_ORDERS_PATH ? loadRealSapOrders(REAL_ORDERS_PATH) : null;

  // Dry-run preview path: no server touch, no mutation.
  if (!isApply && !isCleanup) {
    const s = loadStore();
    const plan = buildSeedPlan(s, realOrders);
    log(`=== PREVIEW (no changes${realOrders ? ', real SAP orders mode' : ', synthetic mode'}) ===`);
    log(`Would add 1 run (RunId=${plan.run.RunId}, ${plan.run.RunNumber})`);
    log(`Would add ${plan.stops.length} stops (StopId ${plan.stops[0].StopId}..${plan.stops[plan.stops.length - 1].StopId})`);
    log(`Would add ${plan.runOrders.length} runOrders (RunOrderId ${plan.runOrders[0].RunOrderId}..${plan.runOrders[plan.runOrders.length - 1].RunOrderId})`);
    for (const ro of plan.runOrders) {
      log(`  RunOrder: SapDocEntry=${ro.SapDocEntry} CardCode=${ro.SapCardCode} '${(ro.SapCardName || '').slice(0, 40)}'`);
    }
    log(`Would add 1 wave (WaveId=${plan.wave.WaveId}, Status=${plan.wave.Status})`);
    log(`Would add ${plan.waveLines.length} waveLines`);
    log(`Would add ${plan.waveAllocations.length} waveAllocations`);
    if (plan.customerProfile) {
      log(`Would add 1 customer profile (CardCode=${plan.customerProfile.CardCode}, DocPolicy.aggregateDN=${plan.customerProfile.DocPolicy.aggregateDeliveryNote})`);
    } else {
      log(`Reusing existing customer profile (no new profile created)`);
    }
    log('Run with --apply to actually seed, --cleanup to remove all IsTest=true entries.');
    process.exit(0);
  }

  pm2Stop();
  backupStore(isApply ? 'SEED-APPLY' : 'SEED-CLEANUP');
  const s = loadStore();

  if (isApply) {
    const plan = buildSeedPlan(s, realOrders);
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
