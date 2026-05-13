/**
 * Auto-classify non-Eilat customers and write the doc policy directly to
 * store.json. Mirrors the per-customer logic the logistics-rfp project uses
 * (DocumentTypePref), but writes it on top of the 4-column DocPolicy that
 * already exists here.
 *
 * Run with the server stopped — we mutate store.json directly.
 *
 * Classification rule (per the user's spec):
 *   - Customer name matches a retail-chain pattern  → תעודת משלוח לכל הזמנה
 *   - Otherwise (private business)                   → חשבונית מס לכל הזמנה
 *   - Eilat is skipped (already handled with its own rule)
 *   - Profiles that already have a non-empty perOrderInvoice/perOrderDeliveryNote
 *     are skipped so re-running is idempotent and doesn't overwrite manual edits.
 */
const fs = require('fs');
const path = './backend/data/store.json';

const CHAIN_PATTERNS = [
  { re: /אלקטרה/i,                       label: 'אלקטרה' },
  { re: /מחסני\s*חשמל/i,                  label: 'מחסני חשמל' },
  { re: /א\.ל\.מ|\bאלמ\b/i,                label: 'א.ל.מ' },
  { re: /טרקלין/i,                        label: 'טרקלין' },
  { re: /שקם.*אלקטריק|שקם\s*אלק/i,        label: 'שקם אלקטריק' },
  { re: /אייס(\s*מול)?/i,                 label: 'אייס' },
  { re: /\bמגה\b/i,                       label: 'מגה' },
];

function classifyName(name) {
  for (const p of CHAIN_PATTERNS) if (p.re.test(name || '')) return { kind: 'chain', chain: p.label };
  return { kind: 'private' };
}

const s = JSON.parse(fs.readFileSync(path, 'utf8'));
const profiles = s.customerDeliveryProfiles || [];
console.log('total profiles in store:', profiles.length);

let touched = 0;
let chainCount = 0;
let privateCount = 0;
let skippedEilat = 0;
let skippedExisting = 0;
let skippedIssue = 0;
const chainBreakdown = {};
const now = new Date().toISOString();

for (const p of profiles) {
  if (p.Issue) { skippedIssue++; continue; }
  if (p.Zone === 'EILAT') { skippedEilat++; continue; }
  const dp = p.DocPolicy || {};
  if (dp.perOrderInvoice || dp.perOrderDeliveryNote) { skippedExisting++; continue; }

  const c = classifyName(p.Name);
  p.DocPolicy = {
    perOrderDeliveryNote:  c.kind === 'chain'   ? 'yes' : 'no',
    perOrderInvoice:       c.kind === 'private' ? 'yes' : 'no',
    aggregateDeliveryNote: 'no',
    aggregateInvoice:      'no',
    notes: c.kind === 'chain'
      ? 'רשת שיווק (' + c.chain + ') — תעודת משלוח לכל הזמנה'
      : 'לקוח פרטי — חשבונית לכל הזמנה',
    updatedAt: now,
    classifiedBy: 'auto_v1',
  };
  if (c.kind === 'chain') {
    chainCount++;
    chainBreakdown[c.chain] = (chainBreakdown[c.chain] || 0) + 1;
  } else {
    privateCount++;
  }
  touched++;
}

fs.writeFileSync(path, JSON.stringify(s, null, 2));

console.log();
console.log('=== RESULT ===');
console.log('  touched:           ', touched);
console.log('  chain (תעודה):     ', chainCount);
console.log('  private (חשבונית):', privateCount);
console.log('  skipped (Eilat):   ', skippedEilat);
console.log('  skipped (issue):   ', skippedIssue);
console.log('  skipped (existing):', skippedExisting);
console.log('  chain breakdown:   ', chainBreakdown);

// Quick re-read verification
const v = JSON.parse(fs.readFileSync(path, 'utf8'));
const counts = { 'תעודה': 0, 'חשבונית': 0, 'אילת חשבונית מס': 0, 'ללא': 0, 'issue': 0 };
for (const p of v.customerDeliveryProfiles) {
  if (p.Issue) counts.issue++;
  else if (p.Zone === 'EILAT' && p.DocPolicy?.perOrderInvoice === 'yes') counts['אילת חשבונית מס']++;
  else if (p.DocPolicy?.perOrderDeliveryNote === 'yes') counts['תעודה']++;
  else if (p.DocPolicy?.perOrderInvoice === 'yes') counts['חשבונית']++;
  else counts['ללא']++;
}
console.log();
console.log('=== Coverage after classify ===');
console.log(counts);
