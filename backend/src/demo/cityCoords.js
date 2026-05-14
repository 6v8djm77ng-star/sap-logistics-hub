/**
 * ⚠️ PILOT-ONLY FALLBACK — not a real routing solution.
 *
 * Lightweight in-memory geocoder for Israeli cities used in delivery
 * stops. Coordinates are city CENTROIDS, accurate to ~1–2 km. Two stops
 * in the same city share identical coordinates, so any in-city ordering
 * the optimizer produces is essentially arbitrary.
 *
 * This file exists only so the route-optimize endpoint stops returning
 * 400 in the pilot environment where stops have no stored Latitude /
 * Longitude. The endpoint still falls back to these city centroids
 * when a stop has no stored coords, even though the actual road
 * distances are computed by self-hosted OSRM (see infra/osrm/).
 *
 * Long-term fix: run a proper geocoding pass at order ingestion time
 * (one-shot, cached per address) so every stop carries real lat/lng,
 * and `resolveStopLatLng` never needs the centroid fallback.
 *
 * Lookup is forgiving: noisy values like "טירת הכרמל 39026/22" or
 * 'ראשל"צ' still match the canonical key. See resolveStopLatLng() for
 * the precedence (stored coords win when present).
 */

const CITIES = {
  // North
  'חיפה':        { lat: 32.7940, lng: 34.9896 },
  'קריות':       { lat: 32.8400, lng: 35.0830 },
  'קרית אתא':    { lat: 32.8050, lng: 35.1050 },
  'נהריה':       { lat: 33.0090, lng: 35.0950 },
  'עכו':         { lat: 32.9170, lng: 35.0810 },
  'טבריה':       { lat: 32.7920, lng: 35.5320 },
  'צפת':         { lat: 32.9650, lng: 35.4960 },
  'קרמיאל':      { lat: 32.9180, lng: 35.2940 },
  'כרמיאל':      { lat: 32.9180, lng: 35.2940 },
  'מעלות':       { lat: 33.0150, lng: 35.2780 },
  'עפולה':       { lat: 32.6060, lng: 35.2900 },
  'בית שאן':     { lat: 32.5000, lng: 35.5000 },
  'יקנעם':       { lat: 32.6580, lng: 35.1090 },
  'נצרת':        { lat: 32.7020, lng: 35.2980 },
  'טירת הכרמל':  { lat: 32.7600, lng: 34.9700 },
  'זכרון יעקב':  { lat: 32.5740, lng: 34.9520 },
  'חדרה':        { lat: 32.4360, lng: 34.9180 },
  'קיסריה':      { lat: 32.5070, lng: 34.8950 },
  'בנימינה':     { lat: 32.5180, lng: 34.9510 },
  'רגבה':        { lat: 32.9870, lng: 35.0860 },

  // Sharon
  'נתניה':       { lat: 32.3290, lng: 34.8540 },
  'הרצליה':      { lat: 32.1620, lng: 34.8450 },
  'רעננה':       { lat: 32.1830, lng: 34.8710 },
  'כפר סבא':     { lat: 32.1750, lng: 34.9100 },
  'הוד השרון':   { lat: 32.1500, lng: 34.8890 },
  'רמת השרון':   { lat: 32.1480, lng: 34.8400 },
  'קדימה':       { lat: 32.2730, lng: 34.9290 },
  'אבן יהודה':   { lat: 32.2700, lng: 34.8870 },

  // Center / Tel Aviv
  'תל אביב':     { lat: 32.0850, lng: 34.7820 },
  "תל אביב-יפו": { lat: 32.0680, lng: 34.7650 },
  'רמת גן':      { lat: 32.0680, lng: 34.8240 },
  'גבעתיים':     { lat: 32.0720, lng: 34.8120 },
  'בני ברק':     { lat: 32.0820, lng: 34.8330 },
  'פתח תקוה':    { lat: 32.0890, lng: 34.8870 },
  'פתח תקווה':   { lat: 32.0890, lng: 34.8870 },
  'חולון':       { lat: 32.0100, lng: 34.7740 },
  'בת ים':       { lat: 32.0170, lng: 34.7500 },
  'אור יהודה':   { lat: 32.0290, lng: 34.8500 },
  'יהוד':        { lat: 32.0330, lng: 34.8830 },
  'ראשון לציון': { lat: 31.9710, lng: 34.7890 },
  'ראש"לצ':       { lat: 31.9710, lng: 34.7890 },
  'ראשל"צ':      { lat: 31.9710, lng: 34.7890 },
  'נס ציונה':    { lat: 31.9290, lng: 34.7990 },
  'רחובות':      { lat: 31.8970, lng: 34.8090 },
  'יבנה':        { lat: 31.8780, lng: 34.7390 },
  'גדרה':        { lat: 31.8140, lng: 34.7790 },
  'רמלה':        { lat: 31.9300, lng: 34.8650 },
  'לוד':         { lat: 31.9520, lng: 34.8920 },
  'מודיעין':     { lat: 31.8920, lng: 35.0090 },
  'בית שמש':     { lat: 31.7460, lng: 34.9870 },
  'ירושלים':     { lat: 31.7820, lng: 35.2180 },

  // South
  'אשדוד':       { lat: 31.7920, lng: 34.6420 },
  'אשקלון':      { lat: 31.6690, lng: 34.5740 },
  'קרית גת':     { lat: 31.6100, lng: 34.7670 },
  'קריית גת':    { lat: 31.6100, lng: 34.7670 },
  'קריית מלאכי': { lat: 31.7290, lng: 34.7440 },
  'באר שבע':     { lat: 31.2520, lng: 34.7910 },
  'דימונה':      { lat: 31.0710, lng: 35.0330 },
  'ערד':         { lat: 31.2590, lng: 35.2120 },
  'נתיבות':      { lat: 31.4200, lng: 34.5870 },
  'אופקים':      { lat: 31.3140, lng: 34.6210 },
  'שדרות':       { lat: 31.5240, lng: 34.5950 },
  'אילת':        { lat: 29.5570, lng: 34.9520 },
};

/** Strip noisy suffixes (zip codes, slashes, branch numbers) so 'טירת הכרמל 39026/22' matches 'טירת הכרמל'. */
function normalize(name) {
  return String(name || '')
    .replace(/[\d/]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Return { lat, lng } for a city name, or null if we can't resolve it. */
export function geocodeCity(name) {
  const n = normalize(name);
  if (!n) return null;
  if (CITIES[n]) return CITIES[n];
  // Loose match: any known key that is a substring or has the same first 3 chars.
  for (const k of Object.keys(CITIES)) {
    if (n.includes(k) || k.includes(n)) return CITIES[k];
  }
  return null;
}

/** Lookup with fallback: prefer stored Latitude/Longitude, then geocoder. */
export function resolveStopLatLng(stop) {
  const lat = Number(stop?.Latitude);
  const lng = Number(stop?.Longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
    return { lat, lng, source: 'stored' };
  }
  const g = geocodeCity(stop?.City);
  if (g) return { lat: g.lat, lng: g.lng, source: 'city' };
  return null;
}

export const CITY_COUNT = Object.keys(CITIES).length;
