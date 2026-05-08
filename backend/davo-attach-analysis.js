/**
 * DAVO attach-rate analysis — for orders containing a DAVO mixer in last 90d:
 * - what % include a non-mixer DAVO item
 * - what's the AOV of mixer-only vs mixer+attach orders
 * - which non-mixer items attach most often
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

function isMixer(code, name) {
  const c = (code || '').toUpperCase();
  const n = name || '';
  return c.includes('DSM') || c.includes('DHM') || /מיקסר/.test(n);
}
function isDavo(code, name) {
  const c = (code || '').toUpperCase();
  const n = name || '';
  return /^(DAV|DSM|DHM|DCK|DMG|DGR|DHB)/.test(c) || /DAVO/.test(n);
}

async function main() {
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log(`Connected\n`);

  // Pull all DAVO lines from last 90d, grouped by invoice
  const rows = (await pool.request().query(`
    SELECT
      H.DocEntry, H.DocNum, H.DocDate, H.DocTotal, H.CardCode, H.CardName,
      L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.LineTotal
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -90, GETDATE())
      AND (
        L.ItemCode LIKE 'DAV%' OR L.ItemCode LIKE 'DSM%' OR L.ItemCode LIKE 'DHM%'
        OR L.ItemCode LIKE 'DCK%' OR L.ItemCode LIKE 'DMG%' OR L.ItemCode LIKE 'DGR%'
        OR L.ItemCode LIKE 'DHB%' OR L.Dscription LIKE N'%DAVO%'
      )
  `)).recordset;

  // Group by invoice
  const byInvoice = new Map();
  for (const r of rows) {
    if (!byInvoice.has(r.DocEntry)) {
      byInvoice.set(r.DocEntry, {
        DocNum: r.DocNum, DocDate: r.DocDate, DocTotal: r.DocTotal,
        CardCode: r.CardCode, CardName: r.CardName,
        lines: [], hasMixer: false, hasNonMixer: false,
        davoMixerRev: 0, davoNonMixerRev: 0,
      });
    }
    const inv = byInvoice.get(r.DocEntry);
    inv.lines.push(r);
    const m = isMixer(r.ItemCode, r.ItemName);
    if (m) { inv.hasMixer = true; inv.davoMixerRev += r.LineTotal; }
    else   { inv.hasNonMixer = true; inv.davoNonMixerRev += r.LineTotal; }
  }

  const invoices = [...byInvoice.values()];
  const mixerOrders = invoices.filter(i => i.hasMixer);
  const mixerOnly   = mixerOrders.filter(i => !i.hasNonMixer);
  const mixerWithAttach = mixerOrders.filter(i => i.hasNonMixer);
  const nonMixerOnly = invoices.filter(i => !i.hasMixer && i.hasNonMixer);

  console.log('='.repeat(64));
  console.log('  DAVO ORDER COMPOSITION (90d, OIG)');
  console.log('='.repeat(64));
  console.log(`Total invoices touching DAVO:           ${invoices.length}`);
  console.log(`  Contain a DAVO mixer:                 ${mixerOrders.length}`);
  console.log(`    - Mixer ONLY (no DAVO non-mixer):   ${mixerOnly.length}`);
  console.log(`    - Mixer + DAVO non-mixer attach:    ${mixerWithAttach.length}  (${(mixerWithAttach.length/Math.max(mixerOrders.length,1)*100).toFixed(1)}% attach)`);
  console.log(`  DAVO non-mixer ONLY (no mixer):       ${nonMixerOnly.length}`);
  console.log('');

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const avg = arr => arr.length ? sum(arr) / arr.length : 0;

  console.log('AOV (DAVO portion of invoice):');
  console.log(`  Mixer-only invoices:    ₪${Math.round(avg(mixerOnly.map(i => i.davoMixerRev))).toLocaleString()}`);
  console.log(`  Mixer + attach invoices: ₪${Math.round(avg(mixerWithAttach.map(i => i.davoMixerRev + i.davoNonMixerRev))).toLocaleString()} (mixer: ₪${Math.round(avg(mixerWithAttach.map(i => i.davoMixerRev))).toLocaleString()}, attach: ₪${Math.round(avg(mixerWithAttach.map(i => i.davoNonMixerRev))).toLocaleString()})`);
  console.log(`  Non-mixer only:          ₪${Math.round(avg(nonMixerOnly.map(i => i.davoNonMixerRev))).toLocaleString()}`);
  console.log('');

  // What attaches most often when a mixer is in the cart?
  const attachCounts = new Map();
  for (const inv of mixerWithAttach) {
    for (const l of inv.lines) {
      if (!isMixer(l.ItemCode, l.ItemName)) {
        const k = `${l.ItemCode} | ${(l.ItemName || '').slice(0, 40)}`;
        const a = attachCounts.get(k) || { qty: 0, rev: 0, orders: 0 };
        a.qty += l.Quantity; a.rev += l.LineTotal; a.orders += 1;
        attachCounts.set(k, a);
      }
    }
  }
  const topAttach = [...attachCounts.entries()].sort((a,b) => b[1].orders - a[1].orders).slice(0, 15);
  console.log('TOP 15 NON-MIXER ITEMS THAT ATTACH TO MIXER ORDERS:');
  for (const [k, a] of topAttach) {
    console.log(`  ${String(a.orders).padStart(4)}x  ₪${Math.round(a.rev).toLocaleString().padStart(9)}  qty:${String(a.qty).padStart(4)}   ${k}`);
  }
  console.log('');

  // Customer-type heuristic: B2B usually has CardCode starting with C2, C3 or similar patterns; or look at order frequency
  const customerOrderCounts = new Map();
  for (const i of invoices) {
    const a = customerOrderCounts.get(i.CardCode) || { name: i.CardName, count: 0, rev: 0 };
    a.count += 1; a.rev += i.davoMixerRev + i.davoNonMixerRev;
    customerOrderCounts.set(i.CardCode, a);
  }
  const topCust = [...customerOrderCounts.entries()].sort((a,b) => b[1].rev - a[1].rev).slice(0, 10);
  console.log('TOP 10 DAVO BUYERS (90d):');
  for (const [code, a] of topCust) {
    console.log(`  ${code.padEnd(12)} orders:${String(a.count).padStart(4)}  ₪${Math.round(a.rev).toLocaleString().padStart(11)}   ${(a.name || '').slice(0, 40)}`);
  }

  // Distribution: 1-time vs repeat
  const oneTime = [...customerOrderCounts.values()].filter(c => c.count === 1).length;
  const repeat = [...customerOrderCounts.values()].filter(c => c.count > 1).length;
  console.log(`\nUnique DAVO buyers: ${customerOrderCounts.size}  (1-time: ${oneTime}, repeat: ${repeat})`);

  await pool.close();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
