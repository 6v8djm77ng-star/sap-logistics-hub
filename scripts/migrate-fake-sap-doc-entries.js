/**
 * One-time migration: scrub the fake `SapDeliveryDocEntry` values that the
 * stop-completion handler used to inject (`9000000 + RunOrderId`). After A1
 * the handler no longer creates these, but historical store.json may still
 * carry them — they masquerade as a real SAP DocEntry and would confuse the
 * upcoming SAP write path.
 *
 * What it touches
 *  - runOrders[i].SapDeliveryDocEntry  → null  (if value is in the fake range)
 *  - deliveryNotes[i].SapDeliveryDocEntry → null
 *  - deliveryNotes[i].SentToSapAt → null  (also fake, set by the same code)
 *
 * Safety rules
 *  - Fake = numeric AND in [9_000_000 .. 9_999_999]
 *  - Refuses to touch a DN with Status === 'SAP_CONFIRMED' — that's a real
 *    SAP write, even if (theoretically) its DocEntry collided with the fake
 *    range. The SAP_CONFIRMED guard is the canonical "this came from SAP"
 *    signal.
 *  - Refuses to touch a value that is a string (the one real DocEntry in the
 *    current store is a string "1" — leave it alone).
 *  - Backup: written ALONGSIDE the rewrite. Caller is also expected to take
 *    its own backup via `restart-safe.ps1` pre-flight; this script keeps a
 *    second one for paranoia.
 *
 * Usage
 *  node scripts/migrate-fake-sap-doc-entries.js             # dry-run (default)
 *  node scripts/migrate-fake-sap-doc-entries.js --apply     # actually write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const STORE = path.join(REPO, 'backend', 'data', 'store.json');

const FAKE_MIN = 9_000_000;
const FAKE_MAX = 9_999_999;

const apply = process.argv.includes('--apply');

function isFake(v) {
  return typeof v === 'number' && v >= FAKE_MIN && v <= FAKE_MAX;
}

function main() {
  if (!fs.existsSync(STORE)) {
    console.error(`store.json not found at ${STORE}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(STORE, 'utf8');
  const store = JSON.parse(raw);

  const orders = store.runOrders || [];
  const dns = store.deliveryNotes || [];

  const orderTouches = [];
  const dnTouches = [];
  const dnSkipped = [];

  // RunOrders: simple — any fake numeric SapDeliveryDocEntry → null
  for (const o of orders) {
    if (isFake(o.SapDeliveryDocEntry)) {
      orderTouches.push({
        RunOrderId: o.RunOrderId,
        oldValue: o.SapDeliveryDocEntry,
        SapDocNum: o.SapDocNum,
        SapCardName: o.SapCardName,
      });
    }
  }

  // DNs: never touch SAP_CONFIRMED, never touch a string value.
  for (const d of dns) {
    if (!isFake(d.SapDeliveryDocEntry)) continue;
    if (d.Status === 'SAP_CONFIRMED') {
      dnSkipped.push({
        DeliveryNoteId: d.DeliveryNoteId,
        reason: 'Status=SAP_CONFIRMED (real SAP write)',
        SapDeliveryDocEntry: d.SapDeliveryDocEntry,
      });
      continue;
    }
    dnTouches.push({
      DeliveryNoteId: d.DeliveryNoteId,
      DocNumber: d.DocNumber,
      oldDocEntry: d.SapDeliveryDocEntry,
      oldSentToSapAt: d.SentToSapAt,
      Status: d.Status,
      SapCardName: d.SapCardName,
    });
  }

  console.log('===== migration plan =====');
  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN (re-run with --apply to write)'}`);
  console.log(`store: ${STORE}`);
  console.log('');
  console.log(`RunOrders to clean: ${orderTouches.length}`);
  for (const t of orderTouches.slice(0, 5)) {
    console.log(`  - RunOrderId=${t.RunOrderId} (${t.SapCardName || '?'}): ${t.oldValue} → null`);
  }
  if (orderTouches.length > 5) console.log(`  ... and ${orderTouches.length - 5} more`);
  console.log('');
  console.log(`DeliveryNotes to clean: ${dnTouches.length}`);
  for (const t of dnTouches) {
    console.log(`  - DN ${t.DeliveryNoteId} (${t.DocNumber}, ${t.SapCardName || '?'}): DocEntry ${t.oldDocEntry} → null, SentToSapAt ${t.oldSentToSapAt} → null`);
  }
  console.log('');
  console.log(`DeliveryNotes SKIPPED (SAP_CONFIRMED, intentionally preserved): ${dnSkipped.length}`);
  for (const s of dnSkipped) {
    console.log(`  - DN ${s.DeliveryNoteId}: ${s.reason}, kept DocEntry=${s.SapDeliveryDocEntry}`);
  }

  if (!apply) {
    console.log('');
    console.log('DRY-RUN complete. No changes written.');
    return;
  }

  // Side-backup, separate from any caller-side backup.
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
  const sideBackup = path.join(REPO, 'backend', 'data', `store.PRE-MIGRATE-FAKE-DOCS-${stamp}.json`);
  fs.writeFileSync(sideBackup, raw, 'utf8');
  console.log(`side-backup: ${path.basename(sideBackup)}`);

  // Apply changes in-place.
  for (const o of orders) {
    if (isFake(o.SapDeliveryDocEntry)) {
      o.SapDeliveryDocEntry = null;
    }
  }
  for (const d of dns) {
    if (!isFake(d.SapDeliveryDocEntry)) continue;
    if (d.Status === 'SAP_CONFIRMED') continue;
    d.SapDeliveryDocEntry = null;
    d.SentToSapAt = null;
  }

  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), 'utf8');
  console.log('');
  console.log(`✓ wrote ${STORE}`);
  console.log(`  cleaned: ${orderTouches.length} RunOrders, ${dnTouches.length} DNs`);
  console.log(`  preserved: ${dnSkipped.length} SAP_CONFIRMED DNs`);
}

main();
