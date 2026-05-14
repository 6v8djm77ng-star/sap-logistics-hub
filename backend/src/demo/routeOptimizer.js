/**
 * Road-distance route optimization - finds the optimal stop order to minimize
 * total driving distance/time across a run, using OSRM's Distance Matrix API
 * for real road distances + nearest-neighbour + 2-opt local search.
 *
 * Hard requirement: OSRM_BASE_URL must point to a running OSRM instance
 * (typically a self-hosted Docker container — see infra/osrm/).
 * If the URL is missing or the API call fails, the optimizer throws —
 * callers MUST NOT silently fall back to great-circle / haversine
 * distances, since that would change StopOrder based on misleading data.
 *
 * (Previous versions used Google Maps Distance Matrix; switched to
 * self-hosted OSRM to remove the per-request cost, the API-key dependency,
 * and the external rate limits. See:
 *  - fix(routes): require Google Maps for road-distance optimization
 *  - feat(routes): switch road-distance optimization from Google Maps to OSRM
 * )
 */

const OSRM_BASE_URL = (process.env.OSRM_BASE_URL || '').replace(/\/$/, '');

export class OsrmConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OsrmConfigError';
    this.code = 'MISSING_OSRM_URL';
  }
}

export class OsrmApiError extends Error {
  constructor(message, upstreamStatus) {
    super(message);
    this.name = 'OsrmApiError';
    this.code = 'OSRM_API_FAILED';
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * Build an N×N distance matrix from OSRM. Throws on any failure.
 * OSRM /table accepts coordinates as `lng,lat;lng,lat;...` (NOT lat,lng —
 * OSRM uses GeoJSON ordering). Response shape:
 *   { code: "Ok", distances: number[][] (metres), durations: number[][] (s) }
 * We only request `annotations=distance` because the optimizer minimizes
 * distance, not duration.
 */
async function buildOsrmMatrix(points) {
  if (!OSRM_BASE_URL) {
    throw new OsrmConfigError(
      'אופטימיזציית כביש דורשת OSRM_BASE_URL (ראה infra/osrm/README.md)',
    );
  }
  // GeoJSON order: lng,lat
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${OSRM_BASE_URL}/table/v1/driving/${coords}?annotations=distance`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new OsrmApiError(`OSRM לא הגיב: ${e.message}`);
  }
  if (!res.ok) {
    throw new OsrmApiError(`OSRM החזיר HTTP ${res.status}`, res.status);
  }
  const payload = await res.json();
  if (payload.code !== 'Ok') {
    // OSRM error codes: NoRoute, NoSegment, InvalidQuery, etc.
    throw new OsrmApiError(`OSRM החזיר code=${payload.code}`);
  }
  if (!Array.isArray(payload.distances) || payload.distances.length !== points.length) {
    throw new OsrmApiError(
      `OSRM החזיר מטריצה במבנה לא צפוי (rows=${payload.distances?.length}, expected=${points.length})`,
    );
  }

  // metres → km. OSRM returns null for unreachable pairs; flag those.
  return payload.distances.map((row, i) =>
    row.map((m, j) => {
      if (m == null) {
        // Unreachable pair would break tour math. Let the caller hit a
        // sentinel value (Infinity) so 2-opt naturally avoids it.
        if (i !== j) {
          // Don't throw — log and use Infinity so the algorithm still works
          // for the reachable subgraph (degenerate but better than crashing).
          console.warn(`[osrm] unreachable pair i=${i} j=${j}, using Infinity`);
        }
        return i === j ? 0 : Infinity;
      }
      return m / 1000;
    }),
  );
}

/** Total distance of a tour given a matrix and a permutation. */
function tourLength(matrix, perm) {
  let d = 0;
  for (let i = 0; i < perm.length - 1; i++) {
    d += matrix[perm[i]][perm[i + 1]];
  }
  return d;
}

/** Nearest-neighbour heuristic - good starting tour. */
function nearestNeighbour(matrix, startIdx = 0) {
  const n = matrix.length;
  const visited = new Set([startIdx]);
  const tour = [startIdx];
  while (tour.length < n) {
    const last = tour[tour.length - 1];
    let best = -1, bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      if (visited.has(i)) continue;
      if (matrix[last][i] < bestDist) {
        bestDist = matrix[last][i];
        best = i;
      }
    }
    if (best < 0) break;
    visited.add(best);
    tour.push(best);
  }
  return tour;
}

/** 2-opt local search - iteratively reverses segments that improve the tour. */
function twoOpt(matrix, tour) {
  const n = tour.length;
  let improved = true;
  let best = [...tour];
  let bestLen = tourLength(matrix, best);
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const newTour = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const newLen = tourLength(matrix, newTour);
        if (newLen < bestLen - 0.001) {
          best = newTour;
          bestLen = newLen;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Optimize a list of stops using OSRM driving distance.
 *
 * @param {Array<{id, lat, lng}>} stops - the stops to visit (0+).
 * @param {Object} [options]
 * @param {{lat,lng}} [options.start] - depot/starting point. Defaults to first stop.
 * @returns {Promise<{order: Array, totalKm: number, source: 'osrm'}>}
 * @throws {OsrmConfigError} when OSRM_BASE_URL is missing.
 * @throws {OsrmApiError} when the OSRM call fails.
 */
export async function optimizeRoute(stops, options = {}) {
  if (!stops || stops.length < 2) {
    return { order: stops || [], totalKm: 0, source: 'osrm' };
  }
  const start = options.start;
  // Prepend depot as index 0 if provided
  const points = start ? [start, ...stops] : [...stops];

  const matrix = await buildOsrmMatrix(points);

  // Start from depot (index 0)
  let tour = nearestNeighbour(matrix, 0);
  tour = twoOpt(matrix, tour);
  const totalKm = tourLength(matrix, tour);

  // Drop the depot if we added one
  const stopIndices = start ? tour.slice(1) : tour;
  const order = stopIndices.map((i) => stops[start ? i - 1 : i]).filter(Boolean);

  return {
    order,
    totalKm: Math.round(totalKm * 10) / 10,
    source: 'osrm',
  };
}
