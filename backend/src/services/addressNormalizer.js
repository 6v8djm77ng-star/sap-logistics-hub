/**
 * Address normalization - the key to unifying customers across both SAP companies.
 *
 * The same physical store may have different CardCodes in Company A vs B,
 * and addresses may be typed slightly differently. We normalize to canonical form
 * so we can detect "this is the same place".
 */

// Hebrew street type synonyms
const STREET_TYPES = {
  'רחוב': 'רח',
  'רח\'': 'רח',
  "רח'": 'רח',
  'שדרות': 'שד',
  'שד\'': 'שד',
  'דרך': 'דר',
  'דרך ': 'דר',
  'כיכר': 'כיכר',
};

// Common abbreviations / synonyms for building/branch names
const BRANCH_KEYWORDS = {
  'קניון': 'קניון',
  'מרכז מסחרי': 'מ.מ',
  'סופר': 'סופר',
};

function normalizeHebrew(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/[״"]/g, '')
    .replace(/['׳]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeStreet(street) {
  if (!street) return '';
  let s = normalizeHebrew(street);
  for (const [full, short] of Object.entries(STREET_TYPES)) {
    s = s.replace(new RegExp(`^${full}\\s+`, 'i'), `${short} `);
    s = s.replace(new RegExp(`\\s+${full}\\s+`, 'ig'), ` ${short} `);
  }
  return s.trim();
}

function normalizeCity(city) {
  if (!city) return '';

  // Step 1: apply variants BEFORE stripping quotes (so 'ת"א' matches the map)
  const rawVariants = {
    'ת"א': 'תל אביב',
    'תא': 'תל אביב',
    'תל-אביב': 'תל אביב',
    'ב"ש': 'באר שבע',
    'בש': 'באר שבע',
    'באר-שבע': 'באר שבע',
    'פ"ת': 'פתח תקווה',
    'פת': 'פתח תקווה',
    'ראשל"צ': 'ראשון לציון',
    'ראשלצ': 'ראשון לציון',
    'פתח תקוה': 'פתח תקווה',
    'רמה"ש': 'רמת השרון',
    'רג': 'רמת גן',
    'ר"ג': 'רמת גן',
  };

  const trimmed = String(city).trim().toLowerCase();
  if (rawVariants[trimmed]) return rawVariants[trimmed];

  // Step 2: normalize (strip quotes, collapse whitespace)
  const normalized = normalizeHebrew(city);

  // Step 3: check again after normalization (catches cases like 'ת א' -> 'תא')
  return rawVariants[normalized] || normalized;
}

/**
 * Extract building number from a street string, if not given separately.
 * "הרצל 45" -> { street: "הרצל", number: "45" }
 */
function extractBuildingNumber(street) {
  const match = street?.match(/^(.+?)\s+(\d+[א-ת]?)$/);
  if (match) return { street: match[1].trim(), number: match[2] };
  return { street: street || '', number: '' };
}

/**
 * Normalize an address to a canonical key for matching.
 * Returns { normalizedKey, street, buildingNumber, city, zipCode }
 */
export function normalizeAddress({ street, buildingNumber, city, zipCode, branchName }) {
  let s = street || '';
  let n = buildingNumber || '';

  if (s && !n) {
    const extracted = extractBuildingNumber(s);
    s = extracted.street;
    n = extracted.number;
  }

  const normStreet = normalizeStreet(s);
  const normCity = normalizeCity(city);
  const normBranch = normalizeHebrew(branchName);

  // Canonical key - used for matching same addresses
  // Zip is strong signal when present; otherwise fall back to street+city
  const keyParts = zipCode
    ? [normStreet, n, normCity, zipCode]
    : [normStreet, n, normCity, normBranch];

  const normalizedKey = keyParts
    .filter(Boolean)
    .join('|')
    .replace(/\s+/g, '-');

  return {
    normalizedKey,
    street: normStreet,
    buildingNumber: n,
    city: normCity,
    zipCode: zipCode || null,
    branchName: normBranch || null,
  };
}

/**
 * Compute similarity score between two addresses [0-1].
 * Used for fuzzy matching when exact normalization doesn't catch it.
 */
export function addressSimilarity(a, b) {
  const normA = normalizeAddress(a);
  const normB = normalizeAddress(b);

  if (normA.normalizedKey === normB.normalizedKey) return 1;

  let score = 0;
  let weight = 0;

  // City match is mandatory for similarity
  if (normA.city && normB.city) {
    if (normA.city === normB.city) {
      score += 0.3;
    } else {
      return 0; // Different cities = definitely different
    }
    weight += 0.3;
  }

  // Street match
  if (normA.street && normB.street) {
    if (normA.street === normB.street) score += 0.4;
    else if (normA.street.includes(normB.street) || normB.street.includes(normA.street)) score += 0.2;
    weight += 0.4;
  }

  // Building number
  if (normA.buildingNumber && normB.buildingNumber) {
    if (normA.buildingNumber === normB.buildingNumber) score += 0.2;
    weight += 0.2;
  }

  // Zip code
  if (normA.zipCode && normB.zipCode && normA.zipCode === normB.zipCode) {
    score += 0.1;
    weight += 0.1;
  }

  return weight > 0 ? score / weight : 0;
}
