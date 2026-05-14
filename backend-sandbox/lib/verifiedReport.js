// =====================================================================
// verifiedReport.js — deterministic delivery-run report engine
// (Sandbox Experiment 3 — implementation phase)
//
// Same architectural contract as verifiedAnomalies.js / verifiedMetrics.js:
//
//   - Pure JavaScript. No LLM, no estimation, no extrapolation.
//   - Same input + same source files → byte-identical output (modulo
//     the computed_at timestamp).
//   - Validation errors fail closed (no LLM call downstream).
//   - Missing source = `confidence: 'insufficient_data'`, NEVER an estimate.
//   - Driver-supplied notes are sanitized engine-side BEFORE the LLM
//     ever sees them — closes the prompt-injection surface flagged in
//     experiment-3-report-explainer-architecture.md §13 #10.
//
// In Experiment 3 the LLM's job is to *explain* report sections (Hebrew
// narrative, prioritization, bounded recommendations). It MUST NOT:
//   - invent KPIs / sections / records
//   - infer causality where the engine does not provide a causal field
//   - override engine-assigned criticality
//   - introduce timelines outside the canonical enum
//
// Section taxonomy (v1):
//   1. run_summary       (always)
//   2. failure_breakdown (when failures > 0)
//   3. flagged_stops     (when ≥1 stop has Status != DELIVERED OR delay)
//   4. customer_impact   (when ≥1 customer affected by failure/delay)
//
// Sections deferred to v2: geographic_pattern, time_distribution.
//
// See: docs/architecture-review/experiment-3-report-explainer-architecture.md
// =====================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = path.resolve(__dirname, '..', 'mock-data');

// =====================================================================
// Report version. Bump on ANY change to:
//   - section taxonomy
//   - threshold bands
//   - failure-reason label mapping
//   - per-section criticality logic
// The same (input, source files, REPORT_VERSION) tuple must always
// produce the same output.
// =====================================================================
export const REPORT_VERSION = 1;

// =====================================================================
// THRESHOLDS — locked in code; analogous to verifiedAnomalies.THRESHOLDS.
// =====================================================================
export const THRESHOLDS = Object.freeze({
  // Completion-rate criticality bands (descending — lower = worse)
  completion_rate_pct: { high_below: 80, medium_below: 90, low_below: 100 },
  // Per-run failure-count bands (ascending — higher = worse)
  failure_count:        { low: 1, medium: 3, high: 5 },
  // Per-stop delay bands (minutes from scheduled or first-arrival baseline)
  delayed_stop_minutes: { low: 15, medium: 30, high: 60 },
  // Customers-affected bands
  customers_affected:   { low: 1, medium: 2, high: 3 },
});

// =====================================================================
// Failure-reason policy mapping.
// The LLM is allowed to verbatim-quote `failure_reason_label_he`
// AS A SAFE CAUSALITY VEHICLE (architecture §10). Inferred causality
// remains forbidden. To preserve that contract: this mapping is the
// ONLY source of Hebrew failure-reason strings the LLM may produce.
// =====================================================================
export const FAILURE_REASON_LABELS = Object.freeze({
  CUSTOMER_NOT_AVAILABLE: 'הלקוח לא היה זמין',
  ADDRESS_NOT_FOUND:      'הכתובת לא נמצאה',
  VEHICLE_BREAKDOWN:      'תקלה ברכב',
  WRONG_ITEMS_LOADED:     'נטענו פריטים לא נכונים',
  OTHER:                  'אחר',
  // Catch-all for any code not explicitly mapped — the engine emits
  // this label and surfaces a warning rather than throwing.
  UNKNOWN:                'סיבה לא מוכרת',
});

export function failureReasonLabel(code) {
  if (typeof code !== 'string' || !code) return FAILURE_REASON_LABELS.UNKNOWN;
  return FAILURE_REASON_LABELS[code] || FAILURE_REASON_LABELS.UNKNOWN;
}

// =====================================================================
// Source loader (same shape as verifiedAnomalies / verifiedMetrics).
// =====================================================================
function loadSource(filename) {
  const filepath = path.join(MOCK_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return { ok: false, code: 'mock_missing', message: `${filename} not present in mock-data/` };
  }
  let raw;
  try { raw = fs.readFileSync(filepath, 'utf8'); }
  catch (e) { return { ok: false, code: 'mock_read_error', message: e.message }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, code: 'mock_parse_error', message: e.message }; }
  return { ok: true, data: parsed };
}

// =====================================================================
// Schemas
// =====================================================================
const stopSchema = z.object({
  StopId:        z.number().int(),
  Order:         z.number().int().optional(),
  CustomerName:  z.string(),
  City:          z.string().optional(),
  Status:        z.string(),                  // DELIVERED | FAILED | etc.
  ArrivedAt:     z.string().optional(),
  CompletedAt:   z.string().optional(),
  FailureReason: z.string().optional(),
  Notes:         z.string().optional(),
}).passthrough();

const orderSchema = z.object({
  RunOrderId:  z.number().int(),
  StopId:      z.number().int(),
  SapDocNum:   z.union([z.number().int(), z.string()]).optional(),
  SapDocEntry: z.union([z.number().int(), z.string()]).optional(),
  Status:      z.string(),
}).passthrough();

const runSchema = z.object({
  RunId:      z.number().int(),
  RunNumber:  z.string(),
  RunDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  DriverId:   z.number().int().optional(),
  DriverName: z.string().optional(),
  Status:     z.string(),
  Stops:      z.array(stopSchema),
  Orders:     z.array(orderSchema).optional(),
}).passthrough();

// =====================================================================
// Driver-note sanitization.
// Closes the prompt-injection surface flagged in architecture §13 #10.
// We strip:
//   - common prompt-injection markers ("ignore previous instructions",
//     "system:", "<|...|>", angle-bracket tags, code fences)
//   - any line beginning with "###" or "<<<" (markdown/heredoc-ish)
//   - trailing whitespace and CR/LF normalization
// We bound the length to prevent prompt-bloat / exfiltration vectors.
// The original (pre-sanitization) is NEVER surfaced to the LLM.
// =====================================================================
const NOTE_MAX_LEN = 200;

function sanitizeDriverNote(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let s = raw;

  // Normalize whitespace
  s = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');

  // Strip code fences / heredoc-ish markers
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/^<<<[\s\S]*?>>>/gm, ' ');
  s = s.replace(/^###.*$/gm, ' ');

  // Strip explicit prompt-injection idioms (case-insensitive)
  const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
    /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi,
    /you\s+are\s+now\s+a\s+/gi,
    /system\s*[:>]\s*/gi,
    /assistant\s*[:>]\s*/gi,
    /\bact\s+as\b/gi,
    /\b(jailbreak|dan)\b/gi,
    /<\|[a-z_]+\|>/gi,                        // chat-template tokens
    /\[INST\]|\[\/INST\]/g,
  ];
  for (const re of INJECTION_PATTERNS) s = s.replace(re, ' ');

  // Strip angle-bracket tags (preserves text content)
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Bound length
  if (s.length > NOTE_MAX_LEN) s = s.slice(0, NOTE_MAX_LEN - 3) + '...';

  return s;
}

// =====================================================================
// Classifiers (reused pattern from verifiedAnomalies)
// =====================================================================
function classifyAscending(observed, bands) {
  if (observed >= bands.high)   return { criticality: 'high',   reason: `observed ${observed} ≥ high threshold ${bands.high}` };
  if (observed >= bands.medium) return { criticality: 'medium', reason: `observed ${observed} ≥ medium threshold ${bands.medium}` };
  if (observed >= bands.low)    return { criticality: 'low',    reason: `observed ${observed} ≥ low threshold ${bands.low}` };
  return { criticality: 'info', reason: `observed ${observed} below low threshold ${bands.low}` };
}

function classifyDescending(observed, bands) {
  if (observed < bands.high_below)   return { criticality: 'high',   reason: `observed ${observed} < high threshold ${bands.high_below}` };
  if (observed < bands.medium_below) return { criticality: 'medium', reason: `observed ${observed} < medium threshold ${bands.medium_below}` };
  if (observed < bands.low_below)    return { criticality: 'low',    reason: `observed ${observed} < low threshold ${bands.low_below}` };
  return { criticality: 'info', reason: `observed ${observed} meets ${bands.low_below}` };
}

const CRIT_RANK = { info: 0, low: 1, medium: 2, high: 3 };
function maxCriticality(...crits) {
  let best = 'info';
  for (const c of crits) {
    if ((CRIT_RANK[c] ?? 0) > (CRIT_RANK[best] ?? 0)) best = c;
  }
  return best;
}

// =====================================================================
// Section builders
// =====================================================================

function buildRunSummarySection(run, computed_at) {
  const stops = run.Stops || [];
  const total_stops = stops.length;
  const completed_stops = stops.filter((s) => s.Status === 'DELIVERED').length;
  const failed_stops    = stops.filter((s) => s.Status === 'FAILED').length;
  const completion_rate_pct = total_stops > 0
    ? Number(((completed_stops / total_stops) * 100).toFixed(2))
    : 0;

  const compRateClass = total_stops > 0
    ? classifyDescending(completion_rate_pct, THRESHOLDS.completion_rate_pct)
    : { criticality: 'info', reason: 'no stops' };

  // Crude run duration: from earliest ArrivedAt to latest CompletedAt/ArrivedAt
  let run_duration_minutes = null;
  const times = [];
  for (const s of stops) {
    if (s.ArrivedAt)   times.push(new Date(s.ArrivedAt.replace(' ', 'T')).getTime());
    if (s.CompletedAt) times.push(new Date(s.CompletedAt.replace(' ', 'T')).getTime());
  }
  const validTimes = times.filter((t) => Number.isFinite(t));
  if (validTimes.length >= 2) {
    run_duration_minutes = Math.round((Math.max(...validTimes) - Math.min(...validTimes)) / 60000);
  }

  return {
    id: 'run_summary',
    kind: 'kpi_block',
    label_he: 'סיכום סבב',
    criticality: compRateClass.criticality,
    criticality_reason: compRateClass.reason,
    kpis: [
      { id: 'total_stops',         label_he: 'סך עצירות',         value: total_stops,         unit: 'count' },
      { id: 'completed_stops',     label_he: 'עצירות הושלמו',     value: completed_stops,     unit: 'count' },
      { id: 'failed_stops',        label_he: 'עצירות כשלו',        value: failed_stops,        unit: 'count' },
      { id: 'completion_rate_pct', label_he: 'אחוז השלמה',         value: completion_rate_pct, unit: 'pct',
        thresholds: THRESHOLDS.completion_rate_pct },
      { id: 'run_duration_minutes', label_he: 'משך סבב (דק)',       value: run_duration_minutes, unit: 'minutes' },
    ],
    records: [],
    source: 'mock-data/runs.json',
    computed_at,
  };
}

function buildFailureBreakdownSection(run, computed_at) {
  const stops = run.Stops || [];
  const failed = stops.filter((s) => s.Status === 'FAILED');
  if (failed.length === 0) return null;

  // Aggregate by reason
  const byReason = new Map();
  for (const s of failed) {
    const code = s.FailureReason || 'UNKNOWN';
    const entry = byReason.get(code) || { reason_code: code, count: 0, stop_ids: [], customer_names: [] };
    entry.count += 1;
    entry.stop_ids.push(s.StopId);
    if (s.CustomerName && !entry.customer_names.includes(s.CustomerName)) {
      entry.customer_names.push(s.CustomerName);
    }
    byReason.set(code, entry);
  }

  const rows = [...byReason.values()].map((r) => ({
    reason_code: r.reason_code,
    reason_label_he: failureReasonLabel(r.reason_code),
    count: r.count,
    pct: Number(((r.count / failed.length) * 100).toFixed(2)),
    stop_ids: r.stop_ids,
    customer_names: r.customer_names,
  }));

  // Section criticality from failure-count bands
  const cls = classifyAscending(failed.length, THRESHOLDS.failure_count);

  return {
    id: 'failure_breakdown',
    kind: 'categorical_breakdown',
    label_he: 'פירוט כשלים לפי סיבה',
    criticality: cls.criticality,
    criticality_reason: cls.reason,
    kpis: [
      { id: 'total_failures_in_run', label_he: 'סך כשלים בסבב', value: failed.length, unit: 'count',
        thresholds: THRESHOLDS.failure_count },
    ],
    rows,
    records: [],
    source: 'mock-data/runs.json',
    computed_at,
  };
}

function buildFlaggedStopsSection(run, computed_at) {
  const stops = run.Stops || [];

  // Per-stop flag: failed OR delayed > threshold (delay computation requires
  // a baseline that mock data doesn't carry; for v1 we flag failed only).
  const flagged = [];
  for (const s of stops) {
    if (s.Status !== 'DELIVERED') {
      const reason_code = s.FailureReason || 'UNKNOWN';
      flagged.push({
        record_id: `stop_${s.StopId}`,
        stop_id: s.StopId,
        order_index: s.Order ?? null,
        customer_name: s.CustomerName,
        city: s.City || null,
        status: s.Status,
        failure_reason_code: reason_code,
        // Verbatim quotable label (architecture §10 — safe causality vehicle)
        failure_reason_label_he: failureReasonLabel(reason_code),
        // Sanitized driver note (engine-side, NEVER raw)
        notes_from_driver: sanitizeDriverNote(s.Notes),
        engine_criticality: 'high',     // a failed stop is operationally serious
      });
    }
  }
  if (flagged.length === 0) return null;

  return {
    id: 'flagged_stops',
    kind: 'record_list',
    label_he: 'עצירות מסומנות',
    criticality: maxCriticality(...flagged.map((r) => r.engine_criticality)),
    criticality_reason: `${flagged.length} flagged stop(s); max engine_criticality = high`,
    kpis: [
      { id: 'flagged_stops_count', label_he: 'מספר עצירות מסומנות', value: flagged.length, unit: 'count' },
    ],
    records: flagged,
    source: 'mock-data/runs.json',
    computed_at,
  };
}

function buildCustomerImpactSection(run, computed_at) {
  const stops = run.Stops || [];
  // Collect customers affected by any non-DELIVERED stop
  const byCustomer = new Map();
  for (const s of stops) {
    if (s.Status === 'DELIVERED') continue;
    const key = s.CustomerName || '<unknown_customer>';
    const e = byCustomer.get(key) || { customer_name: key, stop_count: 0, failed_count: 0, stop_ids: [], reasons: new Set() };
    e.stop_count += 1;
    if (s.Status === 'FAILED') e.failed_count += 1;
    e.stop_ids.push(s.StopId);
    if (s.FailureReason) e.reasons.add(s.FailureReason);
    byCustomer.set(key, e);
  }
  if (byCustomer.size === 0) return null;

  const records = [...byCustomer.values()].map((c) => ({
    record_id: `customer_${slug(c.customer_name)}`,
    customer_name: c.customer_name,
    stop_count: c.stop_count,
    failed_count: c.failed_count,
    affected_stop_ids: c.stop_ids,
    reason_codes: [...c.reasons],
    reason_labels_he: [...c.reasons].map(failureReasonLabel),
    engine_criticality: c.failed_count >= 1 ? 'high' : 'medium',
  }));

  const cls = classifyAscending(byCustomer.size, THRESHOLDS.customers_affected);

  return {
    id: 'customer_impact',
    kind: 'entity_impact',
    label_he: 'השפעה על לקוחות',
    criticality: maxCriticality(cls.criticality, ...records.map((r) => r.engine_criticality)),
    criticality_reason: `${byCustomer.size} customers affected; ${cls.reason}`,
    kpis: [
      { id: 'customers_affected_count', label_he: 'לקוחות מושפעים', value: byCustomer.size, unit: 'count',
        thresholds: THRESHOLDS.customers_affected },
    ],
    records,
    source: 'mock-data/runs.json',
    computed_at,
  };
}

// Slug helper for record_id stability — strips non-word chars, lowercases.
function slug(s) {
  return String(s).toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
}

// =====================================================================
// Main entry
// =====================================================================
export function computeReport(input) {
  const computed_at = new Date().toISOString();
  const warnings = [];
  const errors = [];
  const sources_consulted = [];
  const sources_returning_data = [];
  const sources_missing = [];
  // Pre-declare locals so finalize() never hits a TDZ error path on early return.
  let run = null;
  let subject = null;
  let sections = [];
  let summary = { total_sections: 0, by_criticality: { high: 0, medium: 0, low: 0, info: 0 }, computed_overall_criticality: 'info' };
  let targetRunId = null;

  const run_id = input?.run_id;

  if (run_id === undefined || run_id === null || !Number.isFinite(Number(run_id))) {
    errors.push({ code: 'bad_input', message: 'run_id (number) is required' });
    return finalize();
  }
  targetRunId = Number(run_id);

  // -----------------------------------------------------------------
  // Load runs.json
  // -----------------------------------------------------------------
  sources_consulted.push('mock-data/runs.json');
  const runsSrc = loadSource('runs.json');
  if (!runsSrc.ok) {
    sources_missing.push('mock-data/runs.json');
    errors.push({ code: runsSrc.code, message: runsSrc.message, source: 'mock-data/runs.json' });
    return finalize();   // hard fail — primary source missing
  }

  let runs;
  try { runs = z.array(runSchema).parse(runsSrc.data); }
  catch (e) {
    errors.push({ code: 'schema_violation', message: `runs.json failed validation: ${e.message}`,
                  source: 'mock-data/runs.json' });
    return finalize();
  }
  sources_returning_data.push('mock-data/runs.json');

  run = runs.find((r) => r.RunId === targetRunId) || null;
  if (!run) {
    errors.push({ code: 'run_not_found', message: `run_id ${targetRunId} not present in runs.json` });
    return finalize();
  }

  // -----------------------------------------------------------------
  // Load failures.json (optional context — affects no current section
  // in v1 but consulted for sources_completeness reporting)
  // -----------------------------------------------------------------
  sources_consulted.push('mock-data/failures.json');
  const failuresSrc = loadSource('failures.json');
  if (!failuresSrc.ok) {
    sources_missing.push('mock-data/failures.json');
    warnings.push({ code: failuresSrc.code, message: failuresSrc.message, source: 'mock-data/failures.json' });
  } else {
    sources_returning_data.push('mock-data/failures.json');
  }

  // -----------------------------------------------------------------
  // Subject
  // -----------------------------------------------------------------
  subject = {
    kind: 'delivery_run',
    run_id: run.RunId,
    run_number: run.RunNumber,
    run_date: run.RunDate,
    driver_id: run.DriverId ?? null,
    driver_name: run.DriverName ?? null,
    status: run.Status,
  };

  // -----------------------------------------------------------------
  // Build sections (deterministic order)
  // -----------------------------------------------------------------
  sections = [];
  const s1 = buildRunSummarySection(run, computed_at);             if (s1) sections.push(s1);
  const s2 = buildFailureBreakdownSection(run, computed_at);       if (s2) sections.push(s2);
  const s3 = buildFlaggedStopsSection(run, computed_at);           if (s3) sections.push(s3);
  const s4 = buildCustomerImpactSection(run, computed_at);         if (s4) sections.push(s4);

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  const by_criticality = { high: 0, medium: 0, low: 0, info: 0 };
  for (const s of sections) by_criticality[s.criticality] = (by_criticality[s.criticality] || 0) + 1;
  const computed_overall_criticality = sections.reduce(
    (acc, s) => maxCriticality(acc, s.criticality), 'info'
  );

  summary = {
    total_sections: sections.length,
    by_criticality,
    computed_overall_criticality,
  };

  return finalize();

  // ------------------------------------------------------------------
  function finalize() {
    return {
      report_id: errors.length === 0 && run ? `report_run_${run.RunId}_${run.RunDate}` : null,
      report_kind: 'delivery_run_explanation',
      report_version: REPORT_VERSION,
      subject,
      sections,
      summary,
      warnings,
      errors,
      meta: {
        computed_at,
        report_version: REPORT_VERSION,
        sources_consulted,
        sources_returning_data,
        sources_missing,
        sources_completeness: sources_consulted.length === 0 ? 0
          : Number((sources_returning_data.length / sources_consulted.length).toFixed(2)),
        run_id: targetRunId,
        thresholds: THRESHOLDS,
        failure_reason_labels: FAILURE_REASON_LABELS,
      },
    };
  }
}

// =====================================================================
// Helper: collect every value-set the post-processor needs:
//   - numbers (KPI values, record numerics)
//   - strings (section_ids, KPI ids, record ids, customer names,
//              `failure_reason_label_he` mappings — the "safe quotable
//              identifiers" set)
//   - causal_safe_phrases (the failure_reason_label_he strings) —
//     used by sandboxPolicy.classifyNarrativeText to suppress
//     causality flags ONLY (architecture §10)
// =====================================================================
export function collectReportValueSet(verified) {
  const numbers = new Set();
  const strings = new Set();
  const causal_safe_phrases = new Set();

  const sections = (verified && Array.isArray(verified.sections)) ? verified.sections : [];

  for (const sec of sections) {
    if (sec.id) strings.add(sec.id);
    if (sec.label_he) strings.add(sec.label_he);

    for (const k of (sec.kpis || [])) {
      if (k.id) strings.add(k.id);
      if (typeof k.value === 'number') numbers.add(k.value);
      if (typeof k.value === 'string' && k.value.length >= 3) strings.add(k.value);
      // F4 (Experiment 3 rerun-2): index deterministic threshold numerics.
      // The LLM legitimately quotes threshold values (e.g. "80%" for the
      // completion-rate high-band boundary) when explaining why a section
      // is critical. Without this, every such quote was flagged as an
      // unverified number — a false positive caused by the value-set
      // indexer not seeing past `kpi.value`. Threshold values are
      // deterministic engine output (frozen in `THRESHOLDS`) and are
      // surfaced to the LLM in the user message, so they belong in
      // `numbers`. NOT a relaxation — the integrity contract is unchanged;
      // the indexer is now complete.
      if (k.thresholds && typeof k.thresholds === 'object') {
        for (const v of Object.values(k.thresholds)) {
          if (typeof v === 'number') numbers.add(v);
        }
      }
    }

    for (const r of (sec.rows || [])) {
      if (typeof r.count === 'number') numbers.add(r.count);
      if (typeof r.pct === 'number') numbers.add(r.pct);
      if (r.reason_code) strings.add(r.reason_code);
      if (r.reason_label_he) {
        strings.add(r.reason_label_he);
        causal_safe_phrases.add(r.reason_label_he);
      }
      for (const sid of (r.stop_ids || [])) {
        if (typeof sid === 'number') numbers.add(sid);
        strings.add(`stop_${sid}`);
      }
      for (const cn of (r.customer_names || [])) {
        if (typeof cn === 'string' && cn.length >= 3) strings.add(cn);
      }
    }

    for (const rec of (sec.records || [])) {
      if (rec.record_id) strings.add(rec.record_id);
      if (rec.customer_name) strings.add(rec.customer_name);
      if (rec.city) strings.add(rec.city);
      if (rec.failure_reason_code) strings.add(rec.failure_reason_code);
      if (rec.failure_reason_label_he) {
        strings.add(rec.failure_reason_label_he);
        causal_safe_phrases.add(rec.failure_reason_label_he);
      }
      // Numeric fields
      if (typeof rec.stop_id === 'number') numbers.add(rec.stop_id);
      if (typeof rec.stop_count === 'number') numbers.add(rec.stop_count);
      if (typeof rec.failed_count === 'number') numbers.add(rec.failed_count);
      // Driver notes are quotable; expose for verbatim-quote suppression
      if (rec.notes_from_driver && rec.notes_from_driver.length >= 4) {
        strings.add(rec.notes_from_driver);
      }
    }
  }

  // Subject ids
  if (verified?.subject?.run_number) strings.add(verified.subject.run_number);
  if (verified?.subject?.run_id) numbers.add(verified.subject.run_id);
  if (verified?.subject?.driver_name) strings.add(verified.subject.driver_name);

  // Summary counts (small numbers; quotable)
  const sm = verified?.summary || {};
  if (typeof sm.total_sections === 'number') numbers.add(sm.total_sections);
  for (const v of Object.values(sm.by_criticality || {})) {
    if (typeof v === 'number') numbers.add(v);
  }

  return { numbers, strings, causal_safe_phrases };
}

// =====================================================================
// Helper: per-section local id set for "in-section reference" coverage
// check (architecture §8 — narrative_no_in_section_id_ref).
// =====================================================================
export function localIdsForSection(section) {
  const ids = new Set();
  if (!section) return ids;
  if (section.id) ids.add(section.id);
  for (const k of (section.kpis || [])) {
    if (k.id) ids.add(k.id);
  }
  for (const r of (section.rows || [])) {
    if (r.reason_code) ids.add(r.reason_code);
    if (r.reason_label_he) ids.add(r.reason_label_he);
    for (const sid of (r.stop_ids || [])) ids.add(`stop_${sid}`);
    for (const cn of (r.customer_names || [])) ids.add(cn);
  }
  for (const rec of (section.records || [])) {
    if (rec.record_id) ids.add(rec.record_id);
    if (rec.customer_name) ids.add(rec.customer_name);
    if (rec.failure_reason_code) ids.add(rec.failure_reason_code);
    if (rec.failure_reason_label_he) ids.add(rec.failure_reason_label_he);
  }
  return ids;
}
