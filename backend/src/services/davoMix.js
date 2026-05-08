/**
 * DAVO Mix Tracker — read-only product-mix analytics for the DAVO 60/40 initiative.
 *
 * All queries hit OIG (company A) and are scoped to DAVO SKUs only.
 * Categorization is heuristic, based on SAP item code prefixes + Hebrew name patterns.
 */
import { query } from './sap/sqlReader.js';

const COMPANY = 'A';

const MIXER_NAME_RX = /מיקסר/;
const MIXER_CODE_RX = /^(DSM|DHM)/i;

const DAVO_FILTER_SQL = `(
  L.ItemCode LIKE 'DAV%' OR L.ItemCode LIKE 'DSM%' OR L.ItemCode LIKE 'DHM%'
  OR L.ItemCode LIKE 'DCK%' OR L.ItemCode LIKE 'DMG%' OR L.ItemCode LIKE 'DGR%'
  OR L.ItemCode LIKE 'DHB%' OR L.Dscription LIKE N'%DAVO%'
)`;

function isMixer(itemCode, itemName) {
  return MIXER_CODE_RX.test(itemCode || '') || MIXER_NAME_RX.test(itemName || '');
}

function categorize(itemCode, itemName) {
  const c = (itemCode || '').toUpperCase();
  const n = itemName || '';
  if (isMixer(c, n)) return 'מיקסרים';
  if (c.startsWith('DCK') || /קומקום/.test(n)) return 'קומקומים';
  if (c.startsWith('DMG') || /מטחנת בשר/.test(n)) return 'מטחנות בשר';
  if (c.startsWith('DGR') || /גריל|טוסט|וופל/.test(n)) return 'טוסטרים/גריל';
  if (c.startsWith('DHB') || /בלנדר/.test(n)) return 'בלנדרים';
  if (/תנור|אובן/.test(n) || c.includes('1508') || c.includes('1509')) return 'תנורי אובן';
  if (/גלידה|קרח/.test(n)) return 'מכשירי גלידה';
  if (/מקציף|קפה/.test(n)) return 'קפה/חלב';
  if (/מסחט/.test(n)) return 'מסחטות';
  if (/כירי/.test(n)) return 'כיריים';
  if (/MY ?COOK/i.test(n) || c.includes('MYCOOK')) return 'MY COOK';
  if (/משקל/.test(n)) return 'משקלי מטבח';
  if (/מגהץ/.test(n)) return 'מגהצים';
  return 'אחר';
}

/**
 * Headline summary: total, mixer vs non-mixer split, target gap.
 * @param {number} days  lookback window (default 90)
 */
export async function getMixSummary({ days = 90 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);

  const rows = await query(COMPANY, `
    SELECT
      L.ItemCode,
      MAX(L.Dscription) AS ItemName,
      SUM(L.Quantity)   AS QtySold,
      SUM(L.LineTotal)  AS Revenue,
      COUNT(DISTINCT H.DocEntry) AS OrderCount
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND ${DAVO_FILTER_SQL}
    GROUP BY L.ItemCode
    ORDER BY SUM(L.LineTotal) DESC
  `, { days: safeDays });

  let mixerRev = 0, mixerQty = 0, mixerSkus = 0;
  let nonMixerRev = 0, nonMixerQty = 0, nonMixerSkus = 0;
  for (const r of rows) {
    if (isMixer(r.ItemCode, r.ItemName)) {
      mixerRev += r.Revenue || 0;
      mixerQty += r.QtySold || 0;
      mixerSkus += 1;
    } else {
      nonMixerRev += r.Revenue || 0;
      nonMixerQty += r.QtySold || 0;
      nonMixerSkus += 1;
    }
  }

  const totalRev = mixerRev + nonMixerRev;
  const months = safeDays / 30;
  const monthlyMixer = mixerRev / months;
  const monthlyNonMixer = nonMixerRev / months;

  // Target: 60% non-mixer / 40% mixer with mixers held flat
  const targetMonthlyTotal = monthlyMixer / 0.4;
  const targetMonthlyNonMixer = targetMonthlyTotal - monthlyMixer;
  const gap = targetMonthlyNonMixer - monthlyNonMixer;

  return {
    days: safeDays,
    mixerShare: totalRev ? mixerRev / totalRev : 0,
    nonMixerShare: totalRev ? nonMixerRev / totalRev : 0,
    revenue: { total: totalRev, mixer: mixerRev, nonMixer: nonMixerRev },
    units:   { mixer: mixerQty, nonMixer: nonMixerQty },
    skuCount: { mixer: mixerSkus, nonMixer: nonMixerSkus },
    monthly: { mixer: monthlyMixer, nonMixer: monthlyNonMixer, total: totalRev / months },
    target:  {
      ratio: 0.6, // non-mixer share goal
      monthlyTotal: targetMonthlyTotal,
      monthlyNonMixer: targetMonthlyNonMixer,
      gapMonthly: gap,
      gapMultiplier: monthlyNonMixer ? targetMonthlyNonMixer / monthlyNonMixer : null,
    },
  };
}

/**
 * Per-category breakdown across the lookback window.
 */
export async function getCategoryBreakdown({ days = 90 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);

  const rows = await query(COMPANY, `
    SELECT
      L.ItemCode,
      MAX(L.Dscription) AS ItemName,
      SUM(L.Quantity) AS QtySold,
      SUM(L.LineTotal) AS Revenue
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND ${DAVO_FILTER_SQL}
    GROUP BY L.ItemCode
  `, { days: safeDays });

  const byCat = new Map();
  let total = 0;
  for (const r of rows) {
    const cat = categorize(r.ItemCode, r.ItemName);
    const a = byCat.get(cat) || { category: cat, revenue: 0, qty: 0, skus: 0 };
    a.revenue += r.Revenue || 0;
    a.qty += r.QtySold || 0;
    a.skus += 1;
    byCat.set(cat, a);
    total += r.Revenue || 0;
  }

  const out = [...byCat.values()].sort((a, b) => b.revenue - a.revenue);
  for (const r of out) r.share = total ? r.revenue / total : 0;

  return { days: safeDays, total, categories: out };
}

/**
 * Attach-rate analysis: of invoices containing a DAVO mixer, what % include
 * a DAVO non-mixer item, and what's the AOV uplift.
 */
export async function getAttachRate({ days = 90 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);

  const lines = await query(COMPANY, `
    SELECT
      H.DocEntry, H.DocTotal,
      L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.LineTotal
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND ${DAVO_FILTER_SQL}
  `, { days: safeDays });

  const byInv = new Map();
  for (const r of lines) {
    if (!byInv.has(r.DocEntry)) {
      byInv.set(r.DocEntry, { mixerRev: 0, attachRev: 0, hasMixer: false, hasAttach: false });
    }
    const inv = byInv.get(r.DocEntry);
    if (isMixer(r.ItemCode, r.ItemName)) {
      inv.hasMixer = true;
      inv.mixerRev += r.LineTotal || 0;
    } else {
      inv.hasAttach = true;
      inv.attachRev += r.LineTotal || 0;
    }
  }

  const all = [...byInv.values()];
  const withMixer = all.filter(i => i.hasMixer);
  const mixerOnly = withMixer.filter(i => !i.hasAttach);
  const mixerWithAttach = withMixer.filter(i => i.hasAttach);
  const nonMixerOnly = all.filter(i => !i.hasMixer && i.hasAttach);

  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

  return {
    days: safeDays,
    invoiceCount: {
      total: all.length,
      withMixer: withMixer.length,
      mixerOnly: mixerOnly.length,
      mixerWithAttach: mixerWithAttach.length,
      nonMixerOnly: nonMixerOnly.length,
    },
    attachRate: withMixer.length ? mixerWithAttach.length / withMixer.length : 0,
    targetAttachRate: 0.22,
    aov: {
      mixerOnly: avg(mixerOnly.map(i => i.mixerRev)),
      mixerWithAttach: avg(mixerWithAttach.map(i => i.mixerRev + i.attachRev)),
      attachPortion: avg(mixerWithAttach.map(i => i.attachRev)),
      nonMixerOnly: avg(nonMixerOnly.map(i => i.attachRev)),
    },
  };
}

/**
 * Top non-mixer SKUs that attach most often to a mixer order.
 */
export async function getTopAttachItems({ days = 90, limit = 15 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);
  const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 50);

  // First: invoices that contain a mixer
  const lines = await query(COMPANY, `
    SELECT
      H.DocEntry, L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.LineTotal
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND ${DAVO_FILTER_SQL}
  `, { days: safeDays });

  const mixerInvoices = new Set();
  for (const r of lines) {
    if (isMixer(r.ItemCode, r.ItemName)) mixerInvoices.add(r.DocEntry);
  }

  const counts = new Map();
  for (const r of lines) {
    if (!mixerInvoices.has(r.DocEntry)) continue;
    if (isMixer(r.ItemCode, r.ItemName)) continue;
    const k = r.ItemCode;
    const a = counts.get(k) || { itemCode: k, itemName: r.ItemName, attaches: 0, qty: 0, revenue: 0 };
    a.attaches += 1;
    a.qty += r.Quantity || 0;
    a.revenue += r.LineTotal || 0;
    counts.set(k, a);
  }

  return {
    days: safeDays,
    items: [...counts.values()].sort((a, b) => b.attaches - a.attaches).slice(0, safeLimit),
  };
}

/**
 * Per-buyer mix breakdown — for one specific CardCode, calc mixer/non-mixer split,
 * attach rate, and top non-mixer items already purchased.
 */
export async function getBuyerBreakdown({ cardCode, days = 90 } = {}) {
  if (!cardCode) throw new Error('cardCode is required');
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);

  const lines = await query(COMPANY, `
    SELECT
      H.DocEntry, H.DocDate, H.CardCode, H.CardName,
      L.ItemCode, L.Dscription AS ItemName, L.Quantity, L.LineTotal
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND H.CardCode = @cardCode
      AND ${DAVO_FILTER_SQL}
  `, { days: safeDays, cardCode });

  if (!lines.length) {
    return { cardCode, found: false };
  }

  const cardName = lines[0].CardName;
  const invoices = new Map();
  let mixerRev = 0, nonMixerRev = 0, mixerQty = 0, nonMixerQty = 0;
  const itemAgg = new Map();

  for (const r of lines) {
    if (!invoices.has(r.DocEntry)) invoices.set(r.DocEntry, { hasMixer: false, hasNonMixer: false });
    const inv = invoices.get(r.DocEntry);
    const m = isMixer(r.ItemCode, r.ItemName);
    if (m) { mixerRev += r.LineTotal || 0; mixerQty += r.Quantity || 0; inv.hasMixer = true; }
    else { nonMixerRev += r.LineTotal || 0; nonMixerQty += r.Quantity || 0; inv.hasNonMixer = true; }

    const a = itemAgg.get(r.ItemCode) || { itemCode: r.ItemCode, itemName: r.ItemName, qty: 0, revenue: 0, isMixer: m };
    a.qty += r.Quantity || 0;
    a.revenue += r.LineTotal || 0;
    itemAgg.set(r.ItemCode, a);
  }

  const allInvs = [...invoices.values()];
  const mixerInvs = allInvs.filter(i => i.hasMixer);
  const mixerWithAttach = mixerInvs.filter(i => i.hasNonMixer);
  const total = mixerRev + nonMixerRev;

  const allItems = [...itemAgg.values()].sort((a, b) => b.revenue - a.revenue);
  const topNonMixer = allItems.filter(i => !i.isMixer).slice(0, 5);
  const topMixer = allItems.filter(i => i.isMixer).slice(0, 5);

  return {
    found: true,
    cardCode, cardName,
    days: safeDays,
    revenue: { total, mixer: mixerRev, nonMixer: nonMixerRev },
    units: { mixer: mixerQty, nonMixer: nonMixerQty },
    nmShare: total ? nonMixerRev / total : 0,
    invoiceCount: {
      total: allInvs.length,
      withMixer: mixerInvs.length,
      mixerWithAttach: mixerWithAttach.length,
    },
    attachRate: mixerInvs.length ? mixerWithAttach.length / mixerInvs.length : 0,
    topMixer,
    topNonMixer,
  };
}

/**
 * Top buyers (B2B retailers and end customers) for DAVO.
 */
export async function getTopDavoBuyers({ days = 90, limit = 10 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 90, 7), 365);
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);

  return query(COMPANY, `
    SELECT TOP ${safeLimit}
      H.CardCode,
      MAX(H.CardName) AS CardName,
      COUNT(DISTINCT H.DocEntry) AS OrderCount,
      SUM(L.LineTotal) AS DavoRevenue
    FROM OINV H
    INNER JOIN INV1 L ON L.DocEntry = H.DocEntry
    WHERE H.CANCELED = 'N'
      AND H.DocDate >= DATEADD(DAY, -@days, GETDATE())
      AND ${DAVO_FILTER_SQL}
    GROUP BY H.CardCode
    ORDER BY SUM(L.LineTotal) DESC
  `, { days: safeDays });
}
