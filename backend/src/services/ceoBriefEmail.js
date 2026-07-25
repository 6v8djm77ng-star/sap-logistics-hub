/**
 * CEO Daily Brief email delivery.
 *
 * Renders the v2 brief (agents/ceoBrief.js postProcess output) as a Hebrew
 * RTL HTML email and sends it via the shared notifications transport.
 *
 * Gated by CEO_BRIEF_EMAIL_ENABLED + CEO_BRIEF_EMAIL_TO (comma-separated).
 */
import { env } from '../config/env.js';
import { sendEmail } from './notifications.js';
import { apiLogger } from '../utils/logger.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });

function fmtValue(m) {
  if (m.value === null || m.value === undefined) return 'נתונים אינם זמינים';
  if (typeof m.value === 'string') return esc(m.value);
  switch (m.unit) {
    case 'ILS': return `₪${nf.format(m.value)}`;
    case 'pct': return `${nf.format(m.value)}%`;
    default: return nf.format(m.value);
  }
}

const SEVERITY_COLORS = { high: '#c0392b', medium: '#d68910', low: '#7f8c8d' };
const CONFIDENCE_LABELS = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };

// Metrics worth a KPI row even when the narrative skips them
const HEADLINE_METRIC_IDS = [
  'revenue_yesterday_ils', 'revenue_last7_ils', 'revenue_wow_delta_pct',
  'revenue_mtd_ils', 'revenue_mtd_delta_pct',
  'revenue_last7_company_a_ils', 'revenue_last7_company_b_ils',
];

export function renderCeoBriefHtml(brief) {
  const n = brief.narrative || {};
  const conf = brief.confidence?.overall || 'low';
  const metricById = new Map((brief.verified_metrics || []).map((m) => [m.id, m]));

  const kpiRows = HEADLINE_METRIC_IDS
    .map((id) => metricById.get(id))
    .filter(Boolean)
    .map((m) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(m.label_he)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold;white-space:nowrap;">${fmtValue(m)}</td>
    </tr>`).join('');

  const anomalyById = new Map((brief.verified_anomalies || []).map((a) => [a.id, a]));
  const anomalyItems = (n.anomaly_interpretations || []).map((ai) => {
    const a = anomalyById.get(ai.anomaly_id);
    const sev = a?.severity || 'low';
    return `<li style="margin-bottom:8px;">
      <span style="color:${SEVERITY_COLORS[sev]};font-weight:bold;">[${sev === 'high' ? 'חמור' : sev === 'medium' ? 'בינוני' : 'קל'}]</span>
      ${esc(ai.business_meaning)}
    </li>`;
  }).join('');

  const riskItems = (n.risks || []).map((r) => `<li style="margin-bottom:8px;">
    <span style="color:${SEVERITY_COLORS[r.severity] || '#7f8c8d'};font-weight:bold;">[${r.severity === 'high' ? 'גבוה' : r.severity === 'medium' ? 'בינוני' : 'נמוך'}]</span>
    ${esc(r.description)}
  </li>`).join('');

  const actionItems = (n.recommended_actions || []).map((a) => `<li style="margin-bottom:8px;">
    <b>${esc(a.action)}</b>${a.rationale ? ` — ${esc(a.rationale)}` : ''}
  </li>`).join('');

  const integrityIssues =
    (brief.integrity?.unverified_numbers_in_text?.length || 0) +
    (brief.integrity?.unknown_metric_ids?.length || 0) +
    (brief.integrity?.unknown_anomaly_ids?.length || 0);

  const section = (title, inner) => (inner ? `
    <h3 style="margin:18px 0 8px;color:#1a5276;">${title}</h3>
    ${inner}` : '');

  return `<div dir="rtl" style="font-family:Arial,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;color:#222;">
  <div style="background:#1a5276;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;">תקציר מנכ"ל יומי — ${esc(brief.anchor_date)}</h2>
    <div style="font-size:13px;margin-top:4px;">
      רמת ודאות: ${CONFIDENCE_LABELS[conf] || conf} · כל המספרים חושבו דטרמיניסטית מנתוני SAP
    </div>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:16px 20px;border-radius:0 0 8px 8px;">
    ${n.executive_summary ? `<p style="font-size:15px;line-height:1.6;">${esc(n.executive_summary)}</p>` : ''}

    ${section('מדדים מרכזיים', kpiRows ? `<table style="border-collapse:collapse;width:100%;font-size:14px;">${kpiRows}</table>` : '')}
    ${section('חריגות', anomalyItems ? `<ul style="padding-right:18px;margin:0;font-size:14px;">${anomalyItems}</ul>` : '')}
    ${section('סיכונים', riskItems ? `<ul style="padding-right:18px;margin:0;font-size:14px;">${riskItems}</ul>` : '')}
    ${section('פעולות מומלצות', actionItems ? `<ul style="padding-right:18px;margin:0;font-size:14px;">${actionItems}</ul>` : '')}
    ${n.prioritization_note ? `<div style="background:#fef9e7;border-right:4px solid #d68910;padding:10px 14px;margin-top:16px;font-size:14px;">${esc(n.prioritization_note)}</div>` : ''}

    <div style="margin-top:20px;padding-top:10px;border-top:1px solid #eee;font-size:12px;color:#888;">
      שלמות מקורות: ${Math.round((brief.integrity?.sources_completeness ?? 0) * 100)}% ·
      ציון אמינות נרטיב: ${brief.integrity?.integrity_score ?? '—'} ·
      ${integrityIssues === 0 ? 'לא נמצאו מספרים לא-מאומתים בנרטיב' : `⚠ ${integrityIssues} ממצאי אמינות — ראו את הריצה המלאה במערכת`}
    </div>
  </div>
</div>`;
}

/**
 * Send the brief if email delivery is enabled. Never throws — a delivery
 * failure must not fail the agent run that produced the brief.
 */
export async function sendCeoBriefEmail(brief, { runId } = {}) {
  if (!env.CEO_BRIEF_EMAIL_ENABLED) return { skipped: true, reason: 'disabled' };
  const to = (env.CEO_BRIEF_EMAIL_TO || '').trim();
  if (!to) {
    apiLogger.warn('[ceoBriefEmail] CEO_BRIEF_EMAIL_ENABLED=true but CEO_BRIEF_EMAIL_TO is empty');
    return { skipped: true, reason: 'no-recipients' };
  }

  try {
    const result = await sendEmail({
      to,
      subject: `תקציר מנכ"ל יומי — ${brief.anchor_date}`,
      html: renderCeoBriefHtml(brief),
      eventType: 'CEO_BRIEF',
      entity: runId ? { type: 'AgentRun', id: runId } : undefined,
    });
    return result;
  } catch (err) {
    apiLogger.error('[ceoBriefEmail] send failed', { error: err.message });
    return { sent: false, error: err.message };
  }
}
