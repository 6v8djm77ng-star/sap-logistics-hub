/**
 * Road-distance route optimization - finds the optimal stop order to minimize
 * total driving distance/time across a run, using Google Maps Distance Matrix
 * for real road distances + 2-opt local search.
 *
 * Hard requirement: GOOGLE_MAPS_API_KEY must be set in backend/.env.
 * If the key is missing or the API call fails, the optimizer throws — callers
 * MUST NOT silently fall back to great-circle / haversine distances, since
 * that would change StopOrder based on misleading data.
 *
 * (Previous versions of this file had a silent haversine fallback. Removed
 * on purpose — see fix(routes): require Google Maps for road-distance
 * optimization.)
 */

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

export class GoogleMapsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleMapsConfigError';
    this.code = 'MISSING_GOOGLE_MAPS_KEY';
  }
}

export class GoogleMapsApiError extends Error {
  constructor(message, upstreamStatus) {
    super(message);
    this.name = 'GoogleMapsApiError';
    this.code = 'GOOGLE_MAPS_API_FAILED';
    this.upstreamStatus = upstreamStatus;
  }
}

/** Build matrix from Google Distance Matrix API. Throws on any failure. */
async function buildGoogleMatrix(points) {
  if (!GOOGLE_KEY) {
    throw new GoogleMapsConfigError('אופטימיזציית כביש דורשת GOOGLE_MAPS_API_KEY');
  }
  const origins = points.map((p) => `${p.lat},${p.lng}`).join('|');
  const dests = origins;
  // Note: key is passed as a query param. We never log this URL — see the
  // catch arm in the endpoint that logs `err.message` only, never the URL.
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&mode=driving&key=${encodeURIComponent(GOOGLE_KEY)}`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new GoogleMapsApiError(`Google Maps Distance Matrix לא הגיב: ${e.message}`);
  }
  if (!res.ok) {
    throw new GoogleMapsApiError(
      `Google Maps Distance Matrix החזיר HTTP ${res.status}`,
      res.status,
    );
  }
  const payload = await res.json();
  if (payload.status !== 'OK') {
    // Don't leak Google's error_message into the response — it can sometimes
    // include the partial key. Just surface the status code.
    throw new GoogleMapsApiError(
      `Google Maps Distance Matrix החזיר status=${payload.status}`,
    );
  }

  const n = points.length;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      // Bugfix: the previous loop variable was `j`, which shadowed the parsed
      // JSON also bound to `j` — so `j.rows` was always undefined and the
      // function silently fell back to haversine for every call.
      const el = payload.rows?.[i]?.elements?.[k];
      if (el?.status === 'OK') {
        m[i][k] = el.distance.value / 1000; // metres → km
      } else {
        throw new GoogleMapsApiError(
          `Google Maps Distance Matrix חסר זוג מרחקים (i=${i},j=${k},status=${el?.status || 'missing'})`,
        );
      }
    }
  }
  return m;
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
 * Optimize a list of stops using Google Maps driving distance.
 *
 * @param {Array<{id, lat, lng}>} stops - the stops to visit (0+).
 * @param {Object} [options]
 * @param {{lat,lng}} [options.start] - depot/starting point. Defaults to first stop.
 * @returns {Promise<{order: Array, totalKm: number, source: 'google'}>}
 * @throws {GoogleMapsConfigError} when GOOGLE_MAPS_API_KEY is missing.
 * @throws {GoogleMapsApiError} when the Distance Matrix call fails.
 */
export async function optimizeRoute(stops, options = {}) {
  if (!stops || stops.length < 2) {
    return { order: stops || [], totalKm: 0, source: 'google' };
  }
  const start = options.start;
  // Prepend depot as index 0 if provided
  const points = start ? [start, ...stops] : [...stops];

  const matrix = await buildGoogleMatrix(points);

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
    source: 'google',
  };
}
