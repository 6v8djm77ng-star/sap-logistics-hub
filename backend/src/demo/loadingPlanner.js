/**
 * Truck loading optimizer — calculates total volume per stop and decides
 * the LOAD order for a run.
 *
 * Loading rule: LIFO (Last In, First Out).
 * The LAST stop the driver delivers to should be loaded FIRST (deepest in the
 * truck). The FIRST stop should be loaded LAST (closest to the truck door).
 *
 * Estimated volume per item: we use ItemGroup-based heuristics since SAP's
 * OITM doesn't always have proper dimensions. Easy to override via .env later.
 */

// Default volume per unit in litres. Heuristic, not exact.
// Override per-group in env if needed. For now generous estimates per category.
const DEFAULT_VOL_PER_UNIT_L = 5;
const GROUP_VOL_L = {
  108: 25,   // floor cleaners (Floor One, etc.) - large boxes
  // add more groups as you learn
};

/**
 * Estimate volume in litres for a wave allocation.
 */
export function estimateLineVolume(line) {
  const group = Number(line.ItemGroup || line.SapItemGroup || 0);
  const perUnit = GROUP_VOL_L[group] || DEFAULT_VOL_PER_UNIT_L;
  return perUnit * Number(line.Quantity || line.TotalQuantity || 0);
}

/**
 * Compute per-stop volume + total weight estimate from a run's order lines.
 */
export function computeStopVolumes(stops, ordersWithLines) {
  const byStop = new Map();
  for (const stop of stops) byStop.set(stop.StopId, { stop, volumeL: 0, lineCount: 0 });
  for (const ol of ordersWithLines) {
    for (const ln of ol.lines || []) {
      const v = estimateLineVolume(ln);
      const entry = byStop.get(ol.StopId);
      if (entry) {
        entry.volumeL += v;
        entry.lineCount += 1;
      }
    }
  }
  return Array.from(byStop.values());
}

/**
 * Given a delivery order (first to last), produce the LOADING order (first to last).
 * LIFO: deliveries first → loaded last.
 *
 * Returns array of { stopId, deliveryOrder, loadOrder, volumeL }.
 */
export function planLoadingOrder(stops) {
  const sorted = [...stops].sort(
    (a, b) => Number(a.StopOrder || 0) - Number(b.StopOrder || 0)
  );
  const total = sorted.length;
  return sorted.map((s, i) => ({
    stopId: s.StopId,
    branchName: s.BranchName,
    city: s.City,
    deliveryOrder: i + 1,                // sequence the driver delivers in
    loadOrder: total - i,                // reverse: last delivered → loaded first (deep)
    volumeL: Number(s.volumeL || 0),
  }));
}

/**
 * Estimate truck capacity utilisation.
 * Default truck = 12 cubic metres (12,000 L) — typical Mercedes Sprinter.
 */
export function utilisationPercent(stops, capacityL = 12000) {
  const total = stops.reduce((s, x) => s + Number(x.volumeL || 0), 0);
  return Math.min(100, Math.round((total / capacityL) * 100));
}
