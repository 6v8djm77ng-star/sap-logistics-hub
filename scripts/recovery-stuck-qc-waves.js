#!/usr/bin/env node
/**
 * scripts/recovery-stuck-qc-waves.js
 *
 * One-shot recovery for waves that hit the pre-Bug-fix pickAllocation
 * auto-complete path: wave.Status='COMPLETED', QcApprovedAt=null, run.Status=
 * 'LOADED', and zero Delivery Notes generated. Those waves can't be
 * QC-approved through approveWaveQc (which requires wave.Status==='PENDING_QC')
 * and therefore can't produce DNs through the normal flow.
 *
 * This script identifies a hard-coded set of recent stuck waves (by RunId)
 * and rewinds them to a state the operator can manually QC-approve:
 *
 *     wave.Status:     'COMPLETED'  → 'PENDING_QC'
 *     run.Status:      'LOADED'     → 'OPEN'
 *     QcApprovedAt:    null (unchanged)
 *     CompletedAt:     unchanged (it correctly records when picking finished)
 *
 * Scope (per operator decision 2026-05-16):
 *   ONLY Run 75, 76, 77 — the three runs that landed in the stuck state
 *   today via the buggy pickAllocation path that was fixed in the
 *   companion commit `fix(picking): require QC after allocation-level
 *   picking`.
 *
 * NOT touched (intentionally):
 *   - Run 25 (2026-04-27) — older, deferred for manual review
 *   - Any wave with Status != COMPLETED, or with QcApprovedAt set, or
 *     with any DNs for its run
 *   - SAP, .env, SAP_WRITE_ENABLED, A2c artifacts, frontend
 *
 * Safety model (same pattern as scripts/seed-qc-ready-run.js):
 *   1. Refuses to run if backend/data/store.json is below a minimum size
 *      (truncation guard)
 *   2. Refuses --apply unless EVERY target wave matches the stuck profile
 *      exactly (Status=COMPLETED, QcApprovedAt=null, 0 DNs). If even one
 *      mismatches, aborts with non-zero exit so the operator can re-audit.
 *   3. --apply stops PM2, takes a timestamped backup, mutates, saves,
 *      restarts PM2, and waits for HTTP liveness. NEVER auto-DELETEs.
 *
 * Usage:
 *   node scripts/recovery-stuck-qc-waves.js              # preview (default)
 *   node scripts/recovery-stuck-qc-waves.js --list       # same as default
 *   node scripts/recovery-stuck-qc-waves.js --apply      # actually mutate
 *
 * Exit codes:
 *   0  preview ok / apply succeeded
 *   1  store.json missing
 *   2  store.json below minimum size
 *   3  pm2 stop/start failed
 *   4  HTTP liveness check failed after start
 *   5  one or more target runs/waves don't match the stuck profile
 *
 * Created 2026-05-16. Delete after the four stuck runs have been resolved.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const STORE_PATH = path.resolve(__dirname, '..', 'backend', 'data', 'store.json');
const MIN_STORE_SIZE_BYTES = 100_000;
const PM2_APP = 'sap-logistics';
const LIVENESS_URL = 'http://localhost:4000/api/auth/me';
const LIVENESS_RETRIES = 20;
const LIVENESS_DELAY_MS = 500;

// Operator-approved allow-list of RunIds to recover. Run 25 (older) is
// intentionally EXCLUDED for separate manual review.
const ALLOWED_RUN_IDS = new Set([75, 76, 77]);

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function log(msg) { console.log('[recovery-stuck-qc-waves] ' + msg); }
function err(msg) { console.error('[recovery-stuck-qc-waves] ERROR: ' + msg); }

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) { err('store.json not found: ' + STORE_PATH); process.exit(1); }
  const sz = fs.statSync(STORE_PATH).size;
  if (sz < MIN_STORE_SIZE_BYTES) {
    err(`store.json too small (${sz} bytes < ${MIN_STORE_SIZE_BYTES} floor) — refusing`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}
function saveStore(s) { fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2)); }

function backupStore(tag) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').split('Z')[0];
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
// Identify stuck targets that match the operator-approved allow-list AND
// the exact stuck profile.
// ---------------------------------------------------------------------------
function findStuckTargets(s) {
  const dns = s.deliveryNotes || [];
  const runs = s.runs || [];
  const stops = s.stops || [];
  const runOrders = s.runOrders || [];
  const targets = [];
  for (const w of (s.waves || [])) {
    if (!w || !ALLOWED_RUN_IDS.has(w.RunId)) continue;
    const run = runs.find((r) => r && r.RunId === w.RunId);
    const stopCount = stops.filter((st) => st && st.RunId === w.RunId).length;
    const orderCount = runOrders.filter((o) => o && stops.some((st) => st && st.RunId === w.RunId && st.StopId === o.StopId)).length;
    const dnCount = dns.filter((d) => d && d.RunId === w.RunId).length;
    targets.push({
      WaveId: w.WaveId, RunId: w.RunId,
      RunNumber: run?.RunNumber || '?',
      waveStatus: w.Status,
      qcApprovedAt: w.QcApprovedAt || null,
      runStatus: run?.Status || '?',
      stopCount, orderCount, dnCount,
    });
  }
  return targets;
}

function isStuckProfile(t) {
  return t.waveStatus === 'COMPLETED'
      && (t.qcApprovedAt == null)
      && t.dnCount === 0
      && t.runStatus === 'LOADED';
}

// ---------------------------------------------------------------------------
// Apply the rewind to a single matching target.
// ---------------------------------------------------------------------------
function applyOne(s, target) {
  const w = (s.waves || []).find((x) => x && x.WaveId === target.WaveId);
  const r = (s.runs  || []).find((x) => x && x.RunId  === target.RunId);
  if (!w || !r) return false;
  w.Status = 'PENDING_QC';
  // QcApprovedAt stays null. CompletedAt stays as is.
  r.Status = 'OPEN';
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isApply = args.includes('--apply');

(async () => {
  const s = loadStore();
  const targets = findStuckTargets(s);

  log('=========================================================');
  log(`Operator allow-list: RunIds [${[...ALLOWED_RUN_IDS].join(', ')}]`);
  log(`Targets found in store: ${targets.length}`);
  log('=========================================================');
  for (const t of targets) {
    const profileOk = isStuckProfile(t);
    log(`  Wave ${t.WaveId} | Run ${t.RunId} (${t.RunNumber})`);
    log(`    waveStatus=${t.waveStatus}  qcApprovedAt=${t.qcApprovedAt || 'null'}  runStatus=${t.runStatus}`);
    log(`    stops=${t.stopCount}  orders=${t.orderCount}  dns=${t.dnCount}`);
    log(`    matches stuck profile: ${profileOk ? 'YES' : 'NO — will be skipped on --apply'}`);
  }
  log('=========================================================');

  // Refuse --apply if ANY allow-listed target fails the profile check.
  // The operator approved Run 75/76/77 *believing* they were all stuck
  // in the same way. If one of them isn't, abort and surface why.
  const mismatches = targets.filter((t) => !isStuckProfile(t));
  if (isApply && mismatches.length) {
    err(`refusing --apply: ${mismatches.length} target(s) do not match the stuck profile.`);
    err('  Either they were already resolved manually, or the data shifted since approval.');
    err('  Re-audit, then either drop them from ALLOWED_RUN_IDS or pursue manual recovery.');
    process.exit(5);
  }

  if (!isApply) {
    log('PREVIEW mode — no changes. Re-run with --apply to mutate the store.');
    log('Expected mutations on --apply:');
    for (const t of targets.filter(isStuckProfile)) {
      log(`  Wave ${t.WaveId}: Status COMPLETED → PENDING_QC`);
      log(`  Run  ${t.RunId}: Status LOADED   → OPEN`);
    }
    log('Run 25 (2026-04-27) is INTENTIONALLY excluded from this script (operator decision).');
    return;
  }

  // --apply path
  if (targets.length === 0) {
    log('nothing to do — no targets match the allow-list. exiting.');
    return;
  }

  pm2Stop();
  backupStore('RECOVERY-STUCK-QC');
  // Re-read AFTER backup, so the mutate operates on a fresh deserialized copy.
  const s2 = loadStore();
  const applied = [];
  for (const t of targets) {
    if (!isStuckProfile(t)) continue; // already filtered above, defensive
    if (applyOne(s2, t)) {
      applied.push({ WaveId: t.WaveId, RunId: t.RunId });
      log(`  applied: Wave ${t.WaveId} → PENDING_QC, Run ${t.RunId} → OPEN`);
    }
  }
  saveStore(s2);
  pm2Start();
  await waitLiveness();

  log('=========================================================');
  log('=== RECOVERY APPLIED ===');
  log(`Mutated ${applied.length} wave/run pair(s):`);
  for (const a of applied) log(`  Wave ${a.WaveId} | Run ${a.RunId}`);
  log('');
  log('Next steps (manual, by operator):');
  log('  1. Frontend: open the picking screen for each affected run.');
  log('  2. Click "QC approve" — approveWaveQc will fire and generate DNs.');
  log('  3. DNs will appear on the documents page.');
  log('');
  log('If something looks wrong, the pre-recovery snapshot is at:');
  log('  ' + path.basename(backupStore.lastPath || 'store.PRE-RECOVERY-STUCK-QC-*.json'));
})();
