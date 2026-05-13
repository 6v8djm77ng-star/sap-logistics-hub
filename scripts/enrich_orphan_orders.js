/**
 * Mirrors logistics-rfp's `enrichMissingCustomers()` for the older
 * sap-logistics-hub project: for every open SAP order whose CardCode has
 * no row in customerDeliveryProfiles, create a placeholder profile so the
 * order surfaces in zone/day filtering, instead of being silently dropped.
 *
 * Placeholder fields:
 *   - Zone='' unless the customer name says 'אילת' → EILAT
 *   - DocPolicy is set by the same chain/private classifier we used for
 *     the 1,489 non-Eilat customers, so the picker isn't blocked at QA.
 *   - Issue='no_master_record' marks it for a master-data fix in SAP.
 */
const http = require('http');
const fs = require('fs');
const STORE = './backend/data/store.json';

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

function looksLikeEilat(name) {
  return /אילת/.test(name || '');
}

function call(path, method, tok, body) {
  return new Promise((resolve) => {
    const h = {};
    if (tok) h['Authorization'] = 'Bearer ' + tok;
    if (body) h['Content-Type'] = 'application/json';
    const q = http.request({ host: 'localhost', port: 4000, path, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    if (body) q.write(body);
    q.end();
  });
}

(async () => {
  // 1. Login
  const al = await call('/api/auth/login', 'POST', null, JSON.stringify({ username: 'admin', password: '24RX3N*^uXxze3Dx' }));
  const tok = JSON.parse(al.body).token;
  if (!tok) { console.error('login failed'); process.exit(1); }

  // 2. Pull open orders + filter orphans
  const j = JSON.parse((await call('/api/orders/open?limit=500', 'GET', tok)).body);
  const orphanOrders = j.orders.filter((o) => o.profileIssue === 'no_profile');
  console.log('open orders total:', j.count, ' orphans:', orphanOrders.length);

  // 3. De-dup by (Company, CardCode)
  const byKey = new Map();
  for (const o of orphanOrders) {
    const company = o.CompanyCode === 'A' ? 'OIG' : o.CompanyCode === 'B' ? 'UNICO' : '';
    const cardCode = String(o.CardCode || '').trim();
    if (!cardCode) continue;
    const key = company + '|' + cardCode;
    if (byKey.has(key)) continue;
    byKey.set(key, { Company: company, CardCode: cardCode, Name: o.CardName || '' });
  }
  console.log('unique orphan customers:', byKey.size);

  // 4. Read store, prepare placeholders
  const s = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const profiles = s.customerDeliveryProfiles || (s.customerDeliveryProfiles = []);
  const now = new Date().toISOString();
  const summary = { chain: 0, private: 0, eilat: 0 };
  let added = 0, skipped = 0;

  for (const ph of byKey.values()) {
    const dup = profiles.find((p) => String(p.CardCode) === ph.CardCode && p.Company === ph.Company);
    if (dup) { skipped++; continue; }

    const isEilat = looksLikeEilat(ph.Name);
    const c = classifyName(ph.Name);

    let docPolicy;
    if (isEilat) {
      summary.eilat++;
      docPolicy = {
        perOrderDeliveryNote: 'no',
        perOrderInvoice: 'yes',
        aggregateDeliveryNote: 'no',
        aggregateInvoice: 'no',
        notes: 'אזור סחר חופשי — חשבונית מס חובה (כלל אזורי) — placeholder',
        updatedAt: now,
        classifiedBy: 'auto_v1_orphan',
      };
    } else if (c.kind === 'chain') {
      summary.chain++;
      docPolicy = {
        perOrderDeliveryNote: 'yes',
        perOrderInvoice: 'no',
        aggregateDeliveryNote: 'no',
        aggregateInvoice: 'no',
        notes: 'רשת שיווק (' + c.chain + ') — תעודת משלוח לכל הזמנה — placeholder',
        updatedAt: now,
        classifiedBy: 'auto_v1_orphan',
      };
    } else {
      summary.private++;
      docPolicy = {
        perOrderDeliveryNote: 'no',
        perOrderInvoice: 'yes',
        aggregateDeliveryNote: 'no',
        aggregateInvoice: 'no',
        notes: 'לקוח פרטי — חשבונית לכל הזמנה — placeholder',
        updatedAt: now,
        classifiedBy: 'auto_v1_orphan',
      };
    }

    profiles.push({
      CardCode: ph.CardCode,
      Company: ph.Company,
      Name: ph.Name,
      City: '',
      Street: '',
      Zone: isEilat ? 'EILAT' : '',
      SubZone: '',
      ZoneNameRaw: '',
      DeliveryDays: [],
      Issue: 'no_master_record',
      DocPolicy: docPolicy,
    });
    added++;
  }

  fs.writeFileSync(STORE, JSON.stringify(s, null, 2));

  console.log();
  console.log('=== RESULT ===');
  console.log('  added placeholders:', added);
  console.log('  duplicates skipped:', skipped);
  console.log('  summary by kind:', summary);
})();
