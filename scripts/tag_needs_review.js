/**
 * Finish P0-A: every customer profile gets an explicit Status field so the
 * planner can tell at a glance which ones are usable vs which ones still
 * need master-data work in SAP.
 *
 *   ACTIVE        — profile has zone + city + a DocPolicy decision.
 *                   Safe to use in automated document creation later.
 *   NEEDS_REVIEW  — profile has an Issue (missing_city, missing_zone,
 *                   no_master_record). DocPolicy may still be filled in
 *                   as a best-effort default so picking isn't blocked,
 *                   but it must be reviewed in SAP.
 *
 * Also classifies the 174 customers that have an Issue but no DocPolicy
 * yet (because their zone is missing in the source xlsx) — using the
 * same chain-name rule we used for the other 1,489. This way the
 * MOST a picker will lose is the address (which is missing anyway), not
 * the document type.
 *
 * Idempotent — re-running will not overwrite hand-edited Status or
 * hand-edited DocPolicy.
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

function looksLikeEilat(p) {
  if (p.Zone === 'EILAT') return true;
  if (/אילת/.test(p.Name || '')) return true;
  if (/אילת/.test(p.City || '')) return true;
  return false;
}

const s = JSON.parse(fs.readFileSync(path, 'utf8'));
const profiles = s.customerDeliveryProfiles || [];
const now = new Date().toISOString();

let active = 0;
let needsReview = 0;
let classifiedForReview = 0;

for (const p of profiles) {
  // Don't trample manual edits to Status.
  if (p.Status && (p.Status === 'ACTIVE' || p.Status === 'NEEDS_REVIEW')) {
    if (p.Status === 'ACTIVE') active++; else needsReview++;
    continue;
  }

  const isIssue = !!p.Issue;
  const hasPolicy = p.DocPolicy && (p.DocPolicy.perOrderDeliveryNote || p.DocPolicy.perOrderInvoice);

  if (isIssue) {
    p.Status = 'NEEDS_REVIEW';
    p.StatusReason = p.Issue;
    p.StatusAt = now;
    needsReview++;

    // If no DocPolicy yet → assign a sensible default so picking can proceed.
    if (!hasPolicy) {
      const isEilat = looksLikeEilat(p);
      const c = classifyName(p.Name);
      if (isEilat) {
        p.Zone = p.Zone || 'EILAT';
        p.DocPolicy = {
          perOrderDeliveryNote: 'no',
          perOrderInvoice: 'yes',
          aggregateDeliveryNote: 'no',
          aggregateInvoice: 'no',
          notes: 'אזור סחר חופשי (אילת) — חשבונית מס. NEEDS_REVIEW: ' + p.Issue,
          updatedAt: now,
          classifiedBy: 'auto_v1_needs_review',
        };
      } else if (c.kind === 'chain') {
        p.DocPolicy = {
          perOrderDeliveryNote: 'yes',
          perOrderInvoice: 'no',
          aggregateDeliveryNote: 'no',
          aggregateInvoice: 'no',
          notes: 'רשת שיווק (' + c.chain + ') — תעודת משלוח. NEEDS_REVIEW: ' + p.Issue,
          updatedAt: now,
          classifiedBy: 'auto_v1_needs_review',
        };
      } else {
        p.DocPolicy = {
          perOrderDeliveryNote: 'no',
          perOrderInvoice: 'yes',
          aggregateDeliveryNote: 'no',
          aggregateInvoice: 'no',
          notes: 'לקוח פרטי — חשבונית. NEEDS_REVIEW: ' + p.Issue,
          updatedAt: now,
          classifiedBy: 'auto_v1_needs_review',
        };
      }
      classifiedForReview++;
    }
  } else {
    p.Status = 'ACTIVE';
    p.StatusReason = '';
    p.StatusAt = now;
    active++;
  }
}

fs.writeFileSync(path, JSON.stringify(s, null, 2));

console.log('=== Status assignment ===');
console.log('  ACTIVE        :', active);
console.log('  NEEDS_REVIEW  :', needsReview, '(of which', classifiedForReview, 'got a default DocPolicy in this run)');
console.log('  TOTAL         :', active + needsReview);

// Re-read for confirmation
const v = JSON.parse(fs.readFileSync(path, 'utf8'));
const breakdown = { ACTIVE: 0, NEEDS_REVIEW: 0 };
const byReason = {};
for (const p of v.customerDeliveryProfiles) {
  breakdown[p.Status] = (breakdown[p.Status] || 0) + 1;
  if (p.Status === 'NEEDS_REVIEW') {
    byReason[p.StatusReason] = (byReason[p.StatusReason] || 0) + 1;
  }
}
console.log();
console.log('=== Verify ===');
console.log('  on disk:', breakdown);
console.log('  NEEDS_REVIEW by reason:', byReason);
