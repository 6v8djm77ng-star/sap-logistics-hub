// Pure preview logic for POST /api/runs/from-selected-orders/preview.
//
// Given a request (orderRefs + runDate), a SAP open-orders snapshot, a
// store snapshot (runs + stops + runOrders), and a city→zone resolver,
// return the same {status, body} shape an HTTP handler would send — but
// without touching the store, calling SAP, or creating anything.
//
// Mirrors the validation/grouping logic of the live endpoint at
// demoServer.js POST /api/runs/from-selected-orders so the operator can
// see exactly what would happen before committing.

'use strict';

const MAX_ORDERS = 500;

// Parse the city out of a SAP ShipToAddress field. The original endpoint
// inlines this; we keep the same rule: last non-empty line is the city,
// first line (if multiple) is the street.
function parseAddress(order) {
  const parts = (order.ShipToAddress || '')
    .split(/\r?\n|\r/).map((p) => p.trim()).filter(Boolean);
  const city = parts[parts.length - 1] || order.CustCity || '';
  const street = parts.length > 1 ? parts[0] : '';
  return { city, street };
}

// Build a rich conflict descriptor for an order that is already on some
// existing run. The caller passes the order + a snapshot of runs / stops /
// runOrders / waves; we walk runOrder → stop → run, then pick the most
// recently created non-COMPLETED/CANCELLED wave on that run if any. Exported
// so both the preview helper and the live from-selected-orders endpoint can
// share the same shape.
export function enrichConflict(order, { runs = [], stops = [], runOrders = [], waves = [] } = {}) {
  const runOrder = runOrders.find(
    (ro) => ro.CompanyCode === order.CompanyCode && ro.SapDocEntry === order.DocEntry
  );
  const stop = runOrder ? stops.find((s) => s.StopId === runOrder.StopId) : null;
  const run = stop ? runs.find((r) => r.RunId === stop.RunId) : null;
  const activeWaves = run
    ? waves.filter((w) =>
        w.RunId === run.RunId && w.Status !== 'COMPLETED' && w.Status !== 'CANCELLED'
      )
    : [];
  const wave = activeWaves.length > 0
    ? activeWaves.reduce((latest, w) => (w.WaveId > latest.WaveId ? w : latest))
    : null;
  return {
    companyCode: order.CompanyCode,
    docEntry: order.DocEntry,
    docNum: order.DocNum,
    cardName: order.CardName,
    key: `${order.CompanyCode}-${order.DocEntry}`,
    existingRunId: run ? run.RunId : null,
    existingRunNumber: run ? run.RunNumber : null,
    existingRunDate: run ? run.RunDate : null,
    existingRunStatus: run ? run.Status : null,
    existingWaveId: wave ? wave.WaveId : null,
    existingWaveNumber: wave ? wave.WaveNumber : null,
  };
}

export function previewSelectedOrders({
  runDate,
  orderRefs,
  sapOpenOrders,
  storeSnapshot,
  suggestZoneForCity,
}) {
  // ── Guard: NO_ORDERS ─────────────────────────────────────────────────
  if (!Array.isArray(orderRefs) || orderRefs.length === 0) {
    return {
      status: 400,
      body: { error: 'orders array required (1+)', code: 'NO_ORDERS' },
    };
  }
  // ── Guard: TOO_MANY ──────────────────────────────────────────────────
  if (orderRefs.length > MAX_ORDERS) {
    return {
      status: 400,
      body: { error: `too many orders (max ${MAX_ORDERS})`, code: 'TOO_MANY' },
    };
  }
  // ── Guard: BAD_REF ───────────────────────────────────────────────────
  for (const ref of orderRefs) {
    if (!ref || !ref.companyCode || ref.docEntry == null) {
      return {
        status: 400,
        body: { error: 'each order needs companyCode + docEntry', code: 'BAD_REF' },
      };
    }
  }

  // The HTTP handler is responsible for SAP_OFFLINE before calling us.
  const allOpen = Array.isArray(sapOpenOrders) ? sapOpenOrders : [];
  const requestedKeys = new Set(orderRefs.map((r) => `${r.companyCode}:${r.docEntry}`));
  const orders = allOpen.filter((o) => requestedKeys.has(`${o.CompanyCode}:${o.DocEntry}`));

  // ── Guard: ORDERS_MISSING ────────────────────────────────────────────
  const foundKeys = new Set(orders.map((o) => `${o.CompanyCode}:${o.DocEntry}`));
  const missing = orderRefs.filter((r) => !foundKeys.has(`${r.companyCode}:${r.docEntry}`));
  if (missing.length > 0) {
    return {
      status: 400,
      body: {
        error: `${missing.length} הזמנות לא נמצאו ברשימה הפתוחה (כנראה נסגרו או הוזמנו לקו אחר)`,
        code: 'ORDERS_MISSING',
        missing: missing.slice(0, 10),
      },
    };
  }

  // ── Guard: ALREADY_ASSIGNED ──────────────────────────────────────────
  // Same uniqueness check as the live endpoint, now enriched with the
  // existing run/wave identifiers so the UI can deep-link the operator to
  // wherever the order is already parked.
  const allRuns = (storeSnapshot && storeSnapshot.runs) || [];
  const allStops = (storeSnapshot && storeSnapshot.stops) || [];
  const allRunOrders = (storeSnapshot && storeSnapshot.runOrders) || [];
  const allWaves = (storeSnapshot && storeSnapshot.waves) || [];
  const stopIdToRunId = new Map(allStops.map((s) => [s.StopId, s.RunId]));
  const alreadyAssigned = new Set(
    allRunOrders
      .filter((o) => stopIdToRunId.has(o.StopId))
      .map((o) => `${o.CompanyCode}-${o.SapDocEntry}`)
  );
  const conflicts = orders.filter((o) => alreadyAssigned.has(`${o.CompanyCode}-${o.DocEntry}`));
  if (conflicts.length > 0) {
    const conflictCtx = { runs: allRuns, stops: allStops, runOrders: allRunOrders, waves: allWaves };
    return {
      status: 409,
      body: {
        error: `${conflicts.length} הזמנות כבר שייכות למסלול קיים`,
        code: 'ALREADY_ASSIGNED',
        conflicts: conflicts.slice(0, 10).map((o) => enrichConflict(o, conflictCtx)),
      },
    };
  }

  // ── Group by zone (mirrors the live endpoint) ────────────────────────
  const byZone = {};
  const unassigned = [];
  for (const order of orders) {
    const { city, street } = parseAddress(order);
    const zone = suggestZoneForCity(city);
    if (!zone) {
      unassigned.push({ ...order, cityParsed: city });
      continue;
    }
    if (!byZone[zone.Code]) byZone[zone.Code] = { zone, orders: [] };
    byZone[zone.Code].orders.push({ ...order, cityParsed: city, streetParsed: street });
  }

  // ── Build per-zone preview ───────────────────────────────────────────
  // For each zone, decide if we'd reuse an existing OPEN run on this date
  // or create a new one. Then count distinct addresses (= stops) and
  // orders. We do NOT mutate any state.
  const existingRuns = ((storeSnapshot && storeSnapshot.runs) || []).filter(
    (r) => r.RunDate === runDate && r.Status !== 'COMPLETED' && r.Status !== 'CANCELLED'
  );

  const runsPreview = [];
  for (const { zone, orders: zoneOrders } of Object.values(byZone)) {
    const reusable = existingRuns.find((r) => r.ZoneId === zone.ZoneId && r.Status === 'OPEN');
    const addressKeys = new Set(
      zoneOrders.map((o) => `${o.streetParsed}|${o.cityParsed}|${o.CardCode}`)
    );
    runsPreview.push({
      zoneCode: zone.Code,
      zoneName: zone.Name,
      zoneId: zone.ZoneId,
      wouldReuseExistingRunId: reusable ? reusable.RunId : null,
      wouldReuseExistingRunNumber: reusable ? reusable.RunNumber : null,
      stopCount: addressKeys.size,
      orderCount: zoneOrders.length,
    });
  }

  const runsToReuse = runsPreview.filter((r) => r.wouldReuseExistingRunId != null).length;
  const runsToCreate = runsPreview.length - runsToReuse;

  return {
    status: 200,
    body: {
      ok: true,
      preview: true,
      runDate,
      selectedCount: orderRefs.length,
      runsPreview,
      unassigned: unassigned.length > 0
        ? unassigned.map((o) => ({
            customerName: o.CardName, city: o.cityParsed, docNum: o.DocNum, companyCode: o.CompanyCode,
          }))
        : null,
      summary: {
        ordersRequested: orderRefs.length,
        ordersAssigned: orders.length - unassigned.length,
        ordersUnassigned: unassigned.length,
        runsToCreate,
        runsToReuse,
      },
    },
  };
}
