/**
 * Route optimization - finds the optimal stop order to minimize total
 * driving distance / time across a run.
 *
 * Two modes:
 *   1. With GOOGLE_MAPS_API_KEY: uses Distance Matrix API for real road distances
 *      (free up to 25k requests/month).
 *   2. Without: falls back to haversine (great-circle) distance + 2-opt local search.
 *
 * Both modes return the same shape so callers don't need to know which is used.
 */

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

/** Great-circle distance in km between two lat/lng points. */
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371; // earth km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Build an N×N distance matrix using haversine. */
function buildHaversineMatrix(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      m[i][j] = i === j ? 0 : haversineKm(points[i], points[j]);
    }
  }
  return m;
}

/** Build matrix from Google Distance Matrix API. Falls back to haversine on error. */
async function buildGoogleMatrix(points) {
  if (!GOOGLE_KEY) return buildHaversineMatrix(points);
  try {
    const origins = points.map((p) => `${p.lat},${p.lng}`).join('|');
    const dests = origins;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${dests}&mode=driving&key=${GOOGLE_KEY}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.status !== 'OK') {
      console.warn('[route-opt] Google API:', j.status, j.error_message);
      return buildHaversineMatrix(points);
    }
    const n = points.length;
    const m = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const el = j.rows?.[i]?.elements?.[j];
        if (el?.status === 'OK') {
          m[i][j] = el.distance.value / 1000; // metres → km
        } else {
          m[i][j] = haversineKm(points[i], points[j]);
        }
      }
    }
    return m;
  } catch (e) {
    console.warn('[route-opt] Google fetch failed:', e.message);
    return buildHaversineMatrix(points);
  }
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
 * Optimize a list of stops.
 *
 * @param {Array<{id, lat, lng}>} stops - the stops to visit (0+).
 * @param {Object} [options]
 * @param {{lat,lng}} [options.start] - depot/starting point. Defaults to first stop.
 * @returns {Promise<{order: Array, totalKm: number, source: 'google'|'haversine'}>}
 */
export async function optimizeRoute(stops, options = {}) {
  if (!stops || stops.length < 2) {
    return { order: stops || [], totalKm: 0, source: 'haversine' };
  }
  const start = options.start;
  // Prepend depot as index 0 if provided
  const points = start ? [start, ...stops] : [...stops];
  const matrix = GOOGLE_KEY
    ? await buildGoogleMatrix(points)
    : buildHaversineMatrix(points);

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
    source: GOOGLE_KEY ? 'google' : 'haversine',
  };
}
