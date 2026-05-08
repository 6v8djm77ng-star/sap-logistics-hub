/**
 * DAVO product-mix analysis (read-only).
 * Pulls last 90 days of DAVO sales from OIG (company A) and breaks into mixer vs non-mixer.
 * Run: node davo-mix-analysis.js
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
  requestTimeout: 30000,
};

const MIXER_PATTERNS = ['DSM', 'DHM', 'מיקסר'];

function isMixer(code, name) {
  const c = (code || '').toUpperCase();
  const n = name || '';
  return MIXER_PATTERNS.some(p => c.includes(p) || n.includes(p));
}

async function main() {
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log(`Connected to ${config.database}\n`);

  // 90-day window
  const sqlText = `
    SELECT
      L.ItemCode,
      MAX(L.Dscription) AS ItemName,
      SUM(L.Quantity) AS QtySold,
      SUM(L.LineTotal) AS Revenue,
      COUNT(DISTINCT H.DocEntry) AS OrderCount
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -90, GETDATE())
      AND (
        L.ItemCode LIKE 'DAV%'
        OR L.ItemCode LIKE 'DSM%'
        OR L.ItemCode LIKE 'DHM%'
        OR L.ItemCode LIKE 'DCK%'
        OR L.ItemCode LIKE 'DMG%'
        OR L.ItemCode LIKE 'DGR%'
        OR L.ItemCode LIKE 'DHB%'
        OR L.Dscription LIKE N'%DAVO%'
      )
    GROUP BY L.ItemCode
    ORDER BY SUM(L.LineTotal) DESC
  `;

  const result = await pool.request().query(sqlText);
  const rows = result.recordset;

  if (!rows.length) {
    console.log('No DAVO rows found in last 90 days. Try widening filters.');
    await pool.close();
    return;
  }

  const monthlyDivisor = 3; // 90d => 3 months

  let mixerRev = 0, mixerQty = 0;
  let nonMixerRev = 0, nonMixerQty = 0;
  const byCategory = new Map();

  for (const r of rows) {
    const mixer = isMixer(r.ItemCode, r.ItemName);
    if (mixer) {
      mixerRev += r.Revenue || 0;
      mixerQty += r.QtySold || 0;
    } else {
      nonMixerRev += r.Revenue || 0;
      nonMixerQty += r.QtySold || 0;
    }
    const key = mixer ? 'מיקסרים' : guessCategory(r.ItemCode, r.ItemName);
    const agg = byCategory.get(key) || { revenue: 0, qty: 0, items: 0 };
    agg.revenue += r.Revenue || 0;
    agg.qty += r.QtySold || 0;
    agg.items += 1;
    byCategory.set(key, agg);
  }

  const total = mixerRev + nonMixerRev;
  const mixerShare = total ? (mixerRev / total) * 100 : 0;
  const monthlyTotal = total / monthlyDivisor;
  const monthlyMixer = mixerRev / monthlyDivisor;
  const monthlyNonMixer = nonMixerRev / monthlyDivisor;

  console.log('='.repeat(64));
  console.log('  DAVO 90-DAY SUMMARY (OIG / company A)');
  console.log('='.repeat(64));
  console.log(`Total DAVO revenue (90d):  ₪${Math.round(total).toLocaleString()}`);
  console.log(`  Mixers:                  ₪${Math.round(mixerRev).toLocaleString()}  (${mixerShare.toFixed(1)}%)`);
  console.log(`  Non-mixer:               ₪${Math.round(nonMixerRev).toLocaleString()}  (${(100 - mixerShare).toFixed(1)}%)`);
  console.log('');
  console.log(`Monthly (avg of 3 mo):`);
  console.log(`  Total:                   ₪${Math.round(monthlyTotal).toLocaleString()}/mo`);
  console.log(`  Mixers:                  ₪${Math.round(monthlyMixer).toLocaleString()}/mo  (${mixerQty} units / 90d)`);
  console.log(`  Non-mixer:               ₪${Math.round(monthlyNonMixer).toLocaleString()}/mo  (${nonMixerQty} units / 90d)`);
  console.log('');
  console.log('Target: 60% non-mixer / 40% mixer, mixers held flat');
  const targetMonthly = monthlyMixer / 0.4;
  const targetNonMixer = targetMonthly - monthlyMixer;
  const gap = targetNonMixer - monthlyNonMixer;
  console.log(`  Target monthly DAVO:     ₪${Math.round(targetMonthly).toLocaleString()}/mo`);
  console.log(`  Target non-mixer:        ₪${Math.round(targetNonMixer).toLocaleString()}/mo`);
  console.log(`  Gap to close:            ₪${Math.round(gap).toLocaleString()}/mo  (×${(targetNonMixer / Math.max(monthlyNonMixer, 1)).toFixed(2)} of current)`);
  console.log('');

  console.log('='.repeat(64));
  console.log('  BY CATEGORY (90d)');
  console.log('='.repeat(64));
  const sorted = [...byCategory.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  for (const [cat, d] of sorted) {
    const pct = total ? (d.revenue / total * 100).toFixed(1) : '0.0';
    console.log(`  ${cat.padEnd(20)} ₪${Math.round(d.revenue).toLocaleString().padStart(11)}  ${pct.padStart(5)}%   qty:${d.qty}   skus:${d.items}`);
  }

  console.log('');
  console.log('='.repeat(64));
  console.log('  TOP 15 SKUs BY REVENUE');
  console.log('='.repeat(64));
  for (const r of rows.slice(0, 15)) {
    const tag = isMixer(r.ItemCode, r.ItemName) ? '[M]' : '[ ]';
    const name = (r.ItemName || '').slice(0, 38);
    console.log(`  ${tag} ${(r.ItemCode || '').padEnd(14)} ₪${Math.round(r.Revenue).toLocaleString().padStart(10)}  qty:${String(r.QtySold).padStart(4)}   ${name}`);
  }

  await pool.close();
}

function guessCategory(code, name) {
  const c = (code || '').toUpperCase();
  const n = name || '';
  if (c.startsWith('DCK') || /קומקום/.test(n)) return 'קומקומים';
  if (c.startsWith('DMG') || /מטחנ/.test(n)) return 'מטחנות בשר';
  if (c.startsWith('DGR') || /גריל|טוסט|וופל/.test(n)) return 'טוסטרים/גריל';
  if (c.startsWith('DHB') || /בלנדר/.test(n)) return 'בלנדרים';
  if (/תנור|אובן/.test(n) || c.includes('1508') || c.includes('1509')) return 'תנורי אובן';
  if (/גלידה|קרח/.test(n)) return 'מכשירי גלידה';
  if (/מקציף|קפה/.test(n)) return 'קפה/חלב';
  if (/מסחט/.test(n)) return 'מסחטות';
  if (/כירי/.test(n)) return 'כיריים';
  if (/MY COOK|MYCOOK/i.test(n) || c.includes('MYCOOK')) return 'MY COOK';
  if (/משקל/.test(n)) return 'משקלי מטבח';
  if (/מגהץ/.test(n)) return 'מגהצים';
  return 'אחר';
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
