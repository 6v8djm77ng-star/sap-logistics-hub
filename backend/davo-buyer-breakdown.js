/**
 * Per-buyer DAVO mix breakdown — for the top retailers, what's their mixer/non-mixer split,
 * what attach pattern do they have, what's the upside for each one.
 * Read-only.
 */
import 'dotenv/config';
import sql from 'mssql';

const config = {
  user: process.env.SAP_SQL_USER,
  password: process.env.SAP_SQL_PASSWORD,
  server: process.env.SAP_SQL_HOST,
  port: Number(process.env.SAP_SQL_PORT) || 1433,
  database: process.env.SAP_SQL_DB_A,
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 8000,
  requestTimeout: 60000,
};

const TOP_BUYERS = [
  { code: '2502746', short: 'קימל' },
  { code: '68',      short: 'א.ל.מ אילת 16' },
  { code: '25017371', short: 'היי ביז' },
  { code: '96',      short: 'א.ל.מ ראש העין' },
  { code: '561',     short: 'אלקטרה ביג אילת' },
  { code: '171',     short: 'אלקטרה הסתת אילת' },
  { code: '2502543', short: 'פטקום אילת' },
  { code: '165',     short: 'אלקטרה רד 16' },
  { code: '69',      short: 'א.ל.מ ביג אילת' },
  { code: '2502610', short: 'ת. צורף ראשי' },
];

function isMixer(code, name) {
  const c = (code || '').toUpperCase();
  const n = name || '';
  return /DSM|DHM/.test(c) || /מיקסר/.test(n);
}

async function main() {
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log(`Connected\n`);

  const cardCodes = TOP_BUYERS.map(b => `'${b.code}'`).join(',');

  const lines = (await pool.request().query(`
    SELECT
      H.DocEntry, H.CardCode, H.CardName, H.DocDate,
      L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.LineTotal
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -90, GETDATE())
      AND H.CardCode IN (${cardCodes})
      AND (
        L.ItemCode LIKE 'DAV%' OR L.ItemCode LIKE 'DSM%' OR L.ItemCode LIKE 'DHM%'
        OR L.ItemCode LIKE 'DCK%' OR L.ItemCode LIKE 'DMG%' OR L.ItemCode LIKE 'DGR%'
        OR L.ItemCode LIKE 'DHB%' OR L.Dscription LIKE N'%DAVO%'
      )
  `)).recordset;

  // Aggregate per buyer
  const byBuyer = new Map();
  for (const r of lines) {
    if (!byBuyer.has(r.CardCode)) {
      byBuyer.set(r.CardCode, {
        cardCode: r.CardCode, cardName: r.CardName,
        invoices: new Map(),
        mixerRev: 0, nonMixerRev: 0,
        mixerQty: 0, nonMixerQty: 0,
      });
    }
    const b = byBuyer.get(r.CardCode);
    if (!b.invoices.has(r.DocEntry)) b.invoices.set(r.DocEntry, { hasMixer: false, hasNonMixer: false });
    const inv = b.invoices.get(r.DocEntry);
    if (isMixer(r.ItemCode, r.ItemName)) {
      b.mixerRev += r.LineTotal || 0;
      b.mixerQty += r.Quantity || 0;
      inv.hasMixer = true;
    } else {
      b.nonMixerRev += r.LineTotal || 0;
      b.nonMixerQty += r.Quantity || 0;
      inv.hasNonMixer = true;
    }
  }

  console.log('='.repeat(110));
  console.log('  PER-BUYER DAVO MIX (90d)');
  console.log('='.repeat(110));
  console.log('  Buyer'.padEnd(38) + ' Total'.padStart(12) + ' Mixer'.padStart(12) + ' NonMix'.padStart(11) + ' NM%'.padStart(7) + ' AttachR'.padStart(10) + ' Invs'.padStart(7));
  console.log('-'.repeat(110));

  const buyers = [...byBuyer.values()];
  for (const b of buyers) {
    const total = b.mixerRev + b.nonMixerRev;
    const nmShare = total ? b.nonMixerRev / total : 0;
    const invs = [...b.invoices.values()];
    const mixerInvs = invs.filter(i => i.hasMixer);
    const mixerWithAttach = mixerInvs.filter(i => i.hasNonMixer);
    const attachRate = mixerInvs.length ? mixerWithAttach.length / mixerInvs.length : 0;
    const short = TOP_BUYERS.find(x => x.code === b.cardCode)?.short || b.cardName.slice(0, 30);
    console.log(
      `  ${short.padEnd(36)}` +
      ` ₪${Math.round(total).toLocaleString().padStart(10)}` +
      ` ₪${Math.round(b.mixerRev).toLocaleString().padStart(10)}` +
      ` ₪${Math.round(b.nonMixerRev).toLocaleString().padStart(9)}` +
      ` ${(nmShare*100).toFixed(1).padStart(5)}%` +
      ` ${(attachRate*100).toFixed(1).padStart(7)}%` +
      ` ${invs.length.toString().padStart(6)}`
    );
  }

  // What non-mixer items each buyer ALREADY purchases
  console.log('\n' + '='.repeat(110));
  console.log('  TOP 3 NON-MIXER ITEMS PER BUYER (90d)');
  console.log('='.repeat(110));

  const itemByBuyer = new Map();
  for (const r of lines) {
    if (isMixer(r.ItemCode, r.ItemName)) continue;
    const k = `${r.CardCode}|${r.ItemCode}`;
    const a = itemByBuyer.get(k) || { cardCode: r.CardCode, itemCode: r.ItemCode, itemName: r.ItemName, qty: 0, revenue: 0 };
    a.qty += r.Quantity || 0;
    a.revenue += r.LineTotal || 0;
    itemByBuyer.set(k, a);
  }

  const itemsByBuyerCode = new Map();
  for (const a of itemByBuyer.values()) {
    if (!itemsByBuyerCode.has(a.cardCode)) itemsByBuyerCode.set(a.cardCode, []);
    itemsByBuyerCode.get(a.cardCode).push(a);
  }

  for (const buyer of TOP_BUYERS) {
    const items = (itemsByBuyerCode.get(buyer.code) || []).sort((a, b) => b.revenue - a.revenue).slice(0, 3);
    if (!items.length) {
      console.log(`\n  ${buyer.short}:  (אין רכישות non-mixer)`);
      continue;
    }
    console.log(`\n  ${buyer.short}:`);
    for (const it of items) {
      console.log(`    ₪${Math.round(it.revenue).toLocaleString().padStart(9)}  qty:${it.qty.toString().padStart(3)}  ${it.itemName.slice(0, 60)}`);
    }
  }

  // Save to JSON for the email-drafting step
  const fs = await import('fs');
  const out = buyers.map(b => {
    const total = b.mixerRev + b.nonMixerRev;
    const invs = [...b.invoices.values()];
    const mixerInvs = invs.filter(i => i.hasMixer);
    const mixerWithAttach = mixerInvs.filter(i => i.hasNonMixer);
    return {
      cardCode: b.cardCode,
      cardName: b.cardName,
      short: TOP_BUYERS.find(x => x.code === b.cardCode)?.short,
      total, mixerRev: b.mixerRev, nonMixerRev: b.nonMixerRev,
      mixerQty: b.mixerQty, nonMixerQty: b.nonMixerQty,
      nmShare: total ? b.nonMixerRev / total : 0,
      invoiceCount: invs.length,
      mixerInvoiceCount: mixerInvs.length,
      mixerWithAttach: mixerWithAttach.length,
      attachRate: mixerInvs.length ? mixerWithAttach.length / mixerInvs.length : 0,
      topNonMixer: (itemsByBuyerCode.get(b.cardCode) || []).sort((a,b) => b.revenue - a.revenue).slice(0, 5).map(i => ({
        itemCode: i.itemCode, itemName: i.itemName, qty: i.qty, revenue: i.revenue,
      })),
    };
  });
  fs.writeFileSync('davo-buyer-breakdown.json', JSON.stringify(out, null, 2));
  console.log('\nSaved breakdown to davo-buyer-breakdown.json');

  await pool.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
