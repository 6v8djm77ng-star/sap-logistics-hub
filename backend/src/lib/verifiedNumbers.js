/**
 * verifiedNumbers.js — shared numeric-integrity scanners for verified-data agents.
 *
 * Ported from backend-sandbox/lib/verifiedMetrics.js (validated in
 * docs/architecture-review/verified-metrics-llm-validation.md — 0% fabrication
 * across 5 identical runs). Pure functions, no I/O.
 *
 * The harvester (collectVerifiedValueSet) and the narrative scanner
 * (findUnverifiedNumbers) MUST share the same literal regex — every number a
 * deterministic string emits has to be findable the same way the LLM's
 * narrative gets scanned, otherwise the verified set silently under-indexes.
 */

// Patterns:
//   1. thousands-grouped: 1,283,000 / 1.283.000 / 5,000.5
//   2. K/M/B suffix:      1.18M / 5K
//   3. percent:           21% / 25.6%
//   4. plain 4+ digits:   89500 / 2026
//
// Trailing-boundary note: `\b` after `%` or `[KkMmBb]` silently fails when
// followed by Hebrew or whitespace (both non-word in JS regex). We use suffix
// terminators with explicit no-letter lookaheads instead.
const NUMBER_LITERAL_RE = /\b\d{1,3}(?:[,.]\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?[KkMmBb](?![A-Za-z])|\b\d+(?:\.\d+)?%|\b\d{4,}\b/g;

/**
 * Collect all numeric + string values from a verified payload
 * ({ metrics: [], anomalies: [] }). Used by post-processors to validate
 * narrative numbers/names.
 *
 * numbers: metric.value (numeric), numeric literals inside deterministic
 *          anomaly descriptions, threshold_used values.
 * strings: metric.value (string), metric.id, anomaly.id — used to suppress
 *          false positives where a number sits inside a verified identifier.
 */
export function collectVerifiedValueSet(verified) {
  const numbers = new Set();
  const strings = new Set();

  const harvest = (text) => {
    if (typeof text !== 'string' || !text) return;
    const re = new RegExp(NUMBER_LITERAL_RE.source, 'g');
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const norm = normalizeNumberLiteral(mm[0]);
      if (norm !== null) numbers.add(norm);
    }
  };

  for (const m of (verified.metrics || [])) {
    if (typeof m.value === 'number') {
      numbers.add(m.value);
    } else if (typeof m.value === 'string') {
      strings.add(m.value);
    }
    if (m.id) strings.add(m.id);
  }

  for (const a of (verified.anomalies || [])) {
    if (a.id) strings.add(a.id);
    harvest(a.description);
    if (a.threshold_used && typeof a.threshold_used === 'object') {
      for (const v of Object.values(a.threshold_used)) {
        if (typeof v === 'number') numbers.add(v);
      }
    }
  }

  return { numbers, strings };
}

/**
 * Scan narrative text for numeric literals not present in the verified set.
 * Suppression rules:
 *   A. number falls inside a known verified identifier string
 *   B. plain 4-digit number in [1900..2099] — treated as a year
 */
export function findUnverifiedNumbers(text, numbers, strings = new Set()) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  const idSpans = computeIdSpans(text, strings);

  const re = new RegExp(NUMBER_LITERAL_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const idx = m.index;

    if (idSpans.some(([s, e]) => idx >= s && (idx + raw.length) <= e)) continue;

    if (/^\d{4}$/.test(raw)) {
      const n = Number(raw);
      if (n >= 1900 && n <= 2099) continue;
    }

    const normalized = normalizeNumberLiteral(raw);
    if (normalized === null) continue;
    if (!numbers.has(normalized)) {
      matches.push({ raw, normalized });
    }
  }
  return matches;
}

function computeIdSpans(text, strings) {
  const spans = [];
  for (const id of strings) {
    if (typeof id !== 'string' || id.length < 4) continue;
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(id, from);
      if (at === -1) break;
      spans.push([at, at + id.length]);
      from = at + 1;
    }
  }
  return spans;
}

export function normalizeNumberLiteral(s) {
  let str = s.trim();
  const isPct = str.endsWith('%');
  if (isPct) str = str.slice(0, -1).trim();
  let mult = 1;
  if (/[Mm]$/.test(str)) { mult = 1_000_000; str = str.slice(0, -1).trim(); }
  else if (/[Kk]$/.test(str)) { mult = 1_000; str = str.slice(0, -1).trim(); }
  else if (/[Bb]$/.test(str)) { mult = 1_000_000_000; str = str.slice(0, -1).trim(); }
  if (str.includes(',')) {
    // Israeli convention: comma is a thousands separator
    str = str.replace(/,/g, '');
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  return n * mult;
}
