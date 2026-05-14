// =====================================================================
// sandboxPolicy.js — deterministic policy + qualitative-integrity rules
//
// Centralizes the phrase lists, allowed enums, and classifier helpers
// that the post-processor uses to bound LLM interpretations.
//
// Architectural note: this module owns the *policy*. The phrases below
// are deterministic — the same narrative text will always be classified
// the same way. The classifier does NOT use an LLM; it's regex/substring
// + verified-id awareness.
//
// Sandbox-only. No production exposure, no autonomous execution.
// =====================================================================

// ---------------------------------------------------------------------
// Allowed action time horizons (deterministic enum).
// The LLM submits one of the canonical_id values via the structured
// `recommended_action.time_horizon` field. Free-text horizons like
// "תוך 6 חודשים" or "within 90 days" are forbidden by schema enforcement
// AND by a free-text scanner as belt-and-suspenders.
// ---------------------------------------------------------------------
export const ALLOWED_TIME_HORIZONS = Object.freeze([
  { canonical_id: 'immediate',         label_he: 'מיידי',                 label_en: 'immediate' },
  { canonical_id: 'today',             label_he: 'היום',                  label_en: 'today' },
  { canonical_id: 'this_week',         label_he: 'השבוע',                 label_en: 'this week' },
  { canonical_id: 'next_review_cycle', label_he: 'בסבב הבדיקה הבא',         label_en: 'next review cycle' },
  { canonical_id: 'not_specified',     label_he: 'לא צוין',                label_en: 'not specified' },
]);

export const ALLOWED_TIME_HORIZON_IDS = Object.freeze(
  ALLOWED_TIME_HORIZONS.map((h) => h.canonical_id)
);

// ---------------------------------------------------------------------
// Phrase lists — Hebrew + English. Substring match (case-insensitive
// for English). Tokenization is intentionally simple: false positives
// are acceptable because the rule is "evidence-link, not silence" —
// i.e., flag the phrase, then suppress the flag if the same sentence
// names a verified anomaly_id, metric_id, or whitelisted policy field.
// ---------------------------------------------------------------------

export const TREND_PHRASES = Object.freeze([
  // Hebrew
  'מגמה', 'מגמת', 'הולך וגובר', 'הולך ופוחת', 'מתפתח', 'מתפתחת', 'תוואי', 'תוואי שלילי', 'תוואי חיובי',
  'בעלייה', 'בירידה', 'מתחזק', 'נחלש', 'מחמיר', 'משתפר', 'הולך ומחמיר', 'הולך ומשתפר',
  'שבוע אחר שבוע', 'חודש אחר חודש', 'תקופתית', 'מהשבוע שעבר', 'ביחס לשבוע',
  // English (case-insensitive)
  'trend', 'trending', 'increasing', 'decreasing', 'declining', 'rising', 'falling',
  'growing', 'shrinking', 'worsening', 'improving', 'week-over-week', 'wow',
  'month-over-month', 'mom', 'year-over-year', 'yoy',
  'compared to last week', 'compared to last month', 'over time',
]);

export const CAUSAL_PHRASES = Object.freeze([
  // Hebrew
  'נובע', 'נובעת', 'נגרם', 'נגרמת', 'כתוצאה', 'בגלל', 'בעקבות',
  'מצביע על', 'מוביל ל', 'מוביל לכך', 'גורם ל', 'גורם לכך',
  'תוצאה של', 'נגרם על ידי',
  // English
  'caused by', 'due to', 'because of', 'leads to', 'results from',
  'driven by', 'indicates', 'indicates that', 'likely caused by',
  'attributable to', 'as a result of',
]);

// Urgency words. Per-anomaly handling:
//   - If the linked anomaly's engine severity = high → urgency words are OK
//   - If the linked anomaly's engine severity ∈ {medium, low} → flag as overpromotion
// In executive_summary / prioritization_note (un-anchored to one anomaly):
//   - Urgency word is OK iff at least one anomaly in the verified set is high-severity
export const URGENCY_PHRASES = Object.freeze([
  // Hebrew
  'קריטי', 'חירום', 'דחוף', 'מיידי', 'מיידי ביותר', 'דחוף ביותר',
  'מסוכן ביותר', 'בהול',
  // English
  'critical', 'urgent', 'emergency', 'immediately', 'asap',
  'mission-critical', 'top priority',
]);

// Vague action verbs — flagged when they appear in a recommendation
// without a concrete companion verb. Surfaces "review/examine/consider"
// patterns the user wants tightened.
export const VAGUE_ACTION_VERBS = Object.freeze([
  // Hebrew
  'בחן', 'בחנו', 'בחני', 'שקול', 'שקלו', 'שקלי',
  'עקוב', 'עקבו', 'עקבי', 'בדוק', 'בדקו', 'בדקי',
  'נטר', 'נטרו', 'סקור', 'סקרו', 'נתח', 'נתחו', 'הערך', 'העריכו',
  // English
  'review', 'examine', 'consider', 'monitor', 'check', 'analyze', 'assess', 'evaluate',
  'look into', 'investigate',
]);

// Time-horizon detection: matches "תוך 6 חודשים", "within 90 days", etc.
// We extract these so we can compare against the allowed enum.
// Free-text horizons are flagged when they don't match any canonical id.
export const TIME_HORIZON_REGEXES = Object.freeze([
  // Hebrew
  /תוך\s+\d+\s+(ימים|שבועות|חודשים|רבעונים|שנים)/g,
  /תוך\s+(שבועיים|שלושה\s+חודשים|רבעון|חצי\s+שנה|שנה|שנתיים)/g,
  /ב-?\d+\s+(ימים|שבועות|חודשים)\s+הקרוב(?:ים|ות)?/g,
  /בתוך\s+\d+\s+(ימים|שבועות|חודשים)/g,
  /[0-9]+\s+(ימים|שבועות|חודשים)\s+(קדימה|הבאים|מעכשיו)/g,
  // English (require a number — generic "next week" is allowed
  // by the canonical "next_review_cycle"/"this_week" enums anyway)
  /\bwithin\s+\d+\s+(days?|weeks?|months?|quarters?|years?)\b/gi,
  /\bin\s+the\s+next\s+\d+\s+(days?|weeks?|months?)\b/gi,
  /\bover\s+the\s+next\s+\d+\s+(days?|weeks?|months?)\b/gi,
  /\bby\s+(end\s+of\s+)?(q[1-4]|quarter|year)\b/gi,
]);

// =====================================================================
// classifyNarrativeText — runs all four scanners over a piece of text.
//
// `verifiedIds` is a Set of all anomaly_ids + metric_ids; used for
// "evidence-link" suppression on trend/causal flags.
//
// `verifiedHighSeverityExists` is a boolean; used to allow urgency
// language in un-anchored summaries.
//
// `opts.causal_safe_phrases` (optional) is a Set of strings whose
// verbatim presence in a sentence suppresses the CAUSAL flag ONLY
// (not trend, not urgency, not time-horizon). Used by reportExplainer
// to allow `failure_reason_label_he` quotation as a safe causality
// vehicle (architecture experiment-3 §10). The strings are checked by
// substring match, same convention as verifiedIds.
// =====================================================================
export function classifyNarrativeText(text, verifiedIds, verifiedHighSeverityExists, opts = {}) {
  const causalSafePhrases = (opts && opts.causal_safe_phrases instanceof Set)
    ? opts.causal_safe_phrases
    : new Set();
  const out = {
    trend_claims: [],            // [{ phrase, sentence_excerpt }]
    causality_claims: [],
    urgency_claims: [],
    invented_time_horizons: [],
    vague_verb_hits: [],
    sentences_inspected: 0,
  };
  if (typeof text !== 'string' || !text) return out;

  // Crude sentence segmentation: split on Hebrew/English sentence terminators.
  // Hebrew uses ".", "?", "!" the same as English. Semicolon counts as a soft
  // boundary so multi-clause sentences get inspected separately.
  const sentences = text.split(/[.!?;]\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  out.sentences_inspected = sentences.length;

  for (const s of sentences) {
    const lc = s.toLowerCase();
    const idsInSentence = [];
    for (const id of verifiedIds) {
      if (typeof id !== 'string' || id.length < 4) continue;
      if (s.includes(id)) idsInSentence.push(id);
    }
    const hasIdRef = idsInSentence.length > 0;

    // Trend
    for (const p of TREND_PHRASES) {
      const isHebrew = /[֐-׿]/.test(p);
      const matched = isHebrew ? s.includes(p) : lc.includes(p.toLowerCase());
      if (matched && !hasIdRef) {
        out.trend_claims.push({ phrase: p, sentence: s.slice(0, 200) });
      }
    }

    // Causality — additionally suppressed if the sentence verbatim quotes
    // a deterministic causal-safe phrase (e.g., a failure_reason_label_he
    // string from verifiedReport.js). The phrase must appear ANYWHERE in
    // the sentence; this is the same substring contract used for ids.
    let hasCausalSafePhrase = false;
    for (const p of causalSafePhrases) {
      if (typeof p === 'string' && p.length >= 3 && s.includes(p)) {
        hasCausalSafePhrase = true;
        break;
      }
    }
    for (const p of CAUSAL_PHRASES) {
      const isHebrew = /[֐-׿]/.test(p);
      const matched = isHebrew ? s.includes(p) : lc.includes(p.toLowerCase());
      if (matched && !hasIdRef && !hasCausalSafePhrase) {
        out.causality_claims.push({ phrase: p, sentence: s.slice(0, 200) });
      }
    }

    // Urgency — flag if no high-severity anomaly exists OR if the sentence
    // does not link to a high-severity anomaly. Per-anomaly fine-grained
    // overpromotion is still handled separately by the existing
    // severity_overpromotions check in registry.js.
    for (const p of URGENCY_PHRASES) {
      const isHebrew = /[֐-׿]/.test(p);
      const matched = isHebrew ? s.includes(p) : lc.includes(p.toLowerCase());
      if (matched && !verifiedHighSeverityExists) {
        out.urgency_claims.push({ phrase: p, sentence: s.slice(0, 200) });
      }
    }

    // Invented time horizons (free-text)
    for (const re of TIME_HORIZON_REGEXES) {
      const re2 = new RegExp(re.source, re.flags);
      let m;
      while ((m = re2.exec(s)) !== null) {
        out.invented_time_horizons.push({ phrase: m[0], sentence: s.slice(0, 200) });
      }
    }

    // Vague verbs (any occurrence is reported; the integrity scoring
    // decides how severely to penalize)
    for (const v of VAGUE_ACTION_VERBS) {
      const isHebrew = /[֐-׿]/.test(v);
      const matched = isHebrew ? s.includes(v) : lc.includes(v.toLowerCase());
      if (matched) out.vague_verb_hits.push({ phrase: v, sentence: s.slice(0, 200) });
    }
  }

  return out;
}

// =====================================================================
// validateStructuredRecommendation — checks the structured action object
// for completeness + evidence link + allowed time horizon.
//
// Returns { ok: bool, issues: string[] }.
// =====================================================================
export function validateStructuredRecommendation(rec, anomaly, validIds) {
  const issues = [];
  if (!rec || typeof rec !== 'object') {
    return { ok: false, issues: ['recommendation_missing_or_not_object'] };
  }

  // Required structured fields
  if (!rec.owner || String(rec.owner).trim().length === 0) issues.push('owner_missing');
  if (!rec.target || String(rec.target).trim().length === 0) issues.push('target_missing');
  if (!rec.action || String(rec.action).trim().length === 0) issues.push('action_missing');

  // Evidence link
  const supportId = rec.supporting_id;
  if (!supportId) {
    issues.push('supporting_id_missing');
  } else if (!validIds.has(supportId)) {
    issues.push(`supporting_id_unknown:${supportId}`);
  }

  // Time horizon — must be canonical
  const th = rec.time_horizon;
  if (!th) {
    issues.push('time_horizon_missing');
  } else if (!ALLOWED_TIME_HORIZON_IDS.includes(th)) {
    issues.push(`time_horizon_invalid:${th}`);
  }

  // Action quality — vague-only check on the action verb itself
  if (rec.action) {
    const actionText = String(rec.action);
    const lc = actionText.toLowerCase();
    let vagueCount = 0;
    for (const v of VAGUE_ACTION_VERBS) {
      const isHebrew = /[֐-׿]/.test(v);
      if (isHebrew ? actionText.includes(v) : lc.includes(v.toLowerCase())) vagueCount++;
    }
    // Heuristic: short action (<25 chars) that contains any vague verb
    // is "vague-only". Longer text with a vague verb is allowed because
    // it likely contains a concrete companion verb.
    if (vagueCount > 0 && actionText.length < 25) {
      issues.push(`vague_only_action:${actionText.slice(0, 60)}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// =====================================================================
// labelForTimeHorizon — convenience for the buildUserMessage prompt
// (lists the allowed enum to the model)
// =====================================================================
export function timeHorizonChoicesForPrompt() {
  return ALLOWED_TIME_HORIZONS
    .map((h) => `      ${h.canonical_id.padEnd(20)} (${h.label_he} / ${h.label_en})`)
    .join('\n');
}
