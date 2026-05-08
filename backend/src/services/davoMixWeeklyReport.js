/**
 * DAVO Mix Weekly Report — generates a structured progress report comparing
 * the current 7-day window to the prior 7-day window. Sent every Sunday morning
 * to recipients listed in DAVO_MIX_REPORT_RECIPIENTS.
 */
import * as davoMix from './davoMix.js';
import { sendEmail } from './notifications.js';
import { env } from '../config/env.js';
import { apiLogger } from '../utils/logger.js';

const TARGET_NON_MIXER_SHARE = 0.60;
const TARGET_ATTACH_RATE = 0.22;
const PHASE_1_NON_MIXER_TARGET = 0.16;  // Phase 1 milestone: 16% by end of Q1

function fmtNis(n, compact = true) {
  const v = Number(n || 0);
  if (compact && Math.abs(v) >= 1_000_000) return `₪${(v / 1_000_000).toFixed(2)}M`;
  if (compact && Math.abs(v) >= 1_000) return `₪${Math.round(v / 1_000).toLocaleString('he-IL')}k`;
  return `₪${Math.round(v).toLocaleString('he-IL')}`;
}

function fmtPct(n, digits = 1) {
  return `${(Number(n || 0) * 100).toFixed(digits)}%`;
}

function delta(curr, prev) {
  if (!prev || prev === 0) return { abs: curr, pct: null, direction: 'flat' };
  const abs = curr - prev;
  const pct = abs / prev;
  return { abs, pct, direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat' };
}

function deltaPct(curr, prev) {
  const abs = curr - prev;
  return { abs, direction: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat' };
}

function arrow(direction) {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : '◆';
}

/**
 * Build the report payload comparing last 7d vs prior 7d.
 */
export async function buildWeeklyReport() {
  const [thisWeek, lastWeek, attachThis, attachLast, topAttach, buyers, cats] =
    await Promise.all([
      davoMix.getMixSummary({ days: 7 }),
      davoMix.getMixSummary({ days: 14 }),  // includes this week + prior — we'll subtract
      davoMix.getAttachRate({ days: 7 }),
      davoMix.getAttachRate({ days: 14 }),
      davoMix.getTopAttachItems({ days: 7, limit: 5 }),
      davoMix.getTopDavoBuyers({ days: 7, limit: 5 }),
      davoMix.getCategoryBreakdown({ days: 7 }),
    ]);

  // Compute prior-week-only by subtracting this-week from 14-day window
  const priorWeek = {
    mixerRev: lastWeek.revenue.mixer - thisWeek.revenue.mixer,
    nonMixerRev: lastWeek.revenue.nonMixer - thisWeek.revenue.nonMixer,
    totalRev: lastWeek.revenue.total - thisWeek.revenue.total,
  };
  priorWeek.nonMixerShare = priorWeek.totalRev ? priorWeek.nonMixerRev / priorWeek.totalRev : 0;

  // Attach prior week — derive from 14d minus 7d for invoice counts
  const priorAttach = {
    withMixer: attachLast.invoiceCount.withMixer - attachThis.invoiceCount.withMixer,
    mixerWithAttach: attachLast.invoiceCount.mixerWithAttach - attachThis.invoiceCount.mixerWithAttach,
  };
  priorAttach.attachRate = priorAttach.withMixer
    ? priorAttach.mixerWithAttach / priorAttach.withMixer
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    weekRange: {
      thisWeek: '7 ימים אחרונים',
      priorWeek: '7 ימים שלפני',
    },
    headline: {
      totalRev: thisWeek.revenue.total,
      totalRevDelta: delta(thisWeek.revenue.total, priorWeek.totalRev),
      mixerRev: thisWeek.revenue.mixer,
      mixerRevDelta: delta(thisWeek.revenue.mixer, priorWeek.mixerRev),
      nonMixerRev: thisWeek.revenue.nonMixer,
      nonMixerRevDelta: delta(thisWeek.revenue.nonMixer, priorWeek.nonMixerRev),
      nonMixerShare: thisWeek.nonMixerShare,
      nonMixerShareDelta: deltaPct(thisWeek.nonMixerShare, priorWeek.nonMixerShare),
    },
    targets: {
      finalNonMixerShare: TARGET_NON_MIXER_SHARE,
      phase1NonMixerShare: PHASE_1_NON_MIXER_TARGET,
      gapToPhase1: PHASE_1_NON_MIXER_TARGET - thisWeek.nonMixerShare,
      attachTarget: TARGET_ATTACH_RATE,
    },
    attach: {
      rate: attachThis.attachRate,
      rateDelta: deltaPct(attachThis.attachRate, priorAttach.attachRate),
      gapToTarget: TARGET_ATTACH_RATE - attachThis.attachRate,
      aov: attachThis.aov,
      invoiceCount: attachThis.invoiceCount,
    },
    topAttach: topAttach.items,
    topBuyers: buyers,
    categories: cats.categories,
  };
}

/**
 * Render the report as Hebrew RTL HTML email body.
 */
export function renderReportHtml(r) {
  const arrows = {
    up: '<span style="color:#10b981;">▲</span>',
    down: '<span style="color:#ef4444;">▼</span>',
    flat: '<span style="color:#6b7280;">◆</span>',
  };
  const fmt = (n) => fmtNis(n);
  const arr = (d) => arrows[d.direction] || arrows.flat;

  const totalDeltaPctText = r.headline.totalRevDelta.pct !== null
    ? `${arr(r.headline.totalRevDelta)} ${fmtPct(Math.abs(r.headline.totalRevDelta.pct))}`
    : '—';
  const mixerDeltaPctText = r.headline.mixerRevDelta.pct !== null
    ? `${arr(r.headline.mixerRevDelta)} ${fmtPct(Math.abs(r.headline.mixerRevDelta.pct))}`
    : '—';
  const nonMixerDeltaPctText = r.headline.nonMixerRevDelta.pct !== null
    ? `${arr(r.headline.nonMixerRevDelta)} ${fmtPct(Math.abs(r.headline.nonMixerRevDelta.pct))}`
    : '—';

  const attachRateText = `${fmtPct(r.attach.rate)} ${arr(r.attach.rateDelta)}${fmtPct(Math.abs(r.attach.rateDelta.abs))}`;

  const topAttachRows = r.topAttach.map((it) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(it.itemName || '')}<br><span style="font-size:11px;color:#888;">${escapeHtml(it.itemCode)}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:left;direction:ltr;">${it.attaches}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:left;direction:ltr;">${fmt(it.revenue)}</td>
    </tr>
  `).join('');

  const buyerRows = r.topBuyers.map((b) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(b.CardName || '')}<br><span style="font-size:11px;color:#888;direction:ltr;">${b.CardCode}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:left;direction:ltr;">${b.OrderCount}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:left;direction:ltr;">${fmt(b.DavoRevenue)}</td>
    </tr>
  `).join('');

  const phase1Status = r.headline.nonMixerShare >= r.targets.phase1NonMixerShare
    ? `<span style="color:#10b981;font-weight:600;">✓ ביעד</span>`
    : `<span style="color:#f59e0b;font-weight:600;">פער של ${fmtPct(r.targets.gapToPhase1)} מיעד שלב 1 (16%)</span>`;

  const attachStatus = r.attach.rate >= r.targets.attachTarget
    ? `<span style="color:#10b981;">✓ ביעד</span>`
    : `<span style="color:#f59e0b;">פער של ${fmtPct(r.targets.gapToTarget)} מיעד 22%</span>`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<title>DAVO Mix — דוח שבועי</title>
</head>
<body style="margin:0;padding:0;font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a;background:#f5f5f5;">
<div style="max-width:700px;margin:0 auto;background:#fff;">
  <div style="background:#1a1a1a;color:#fff;padding:24px;">
    <div style="font-size:24px;font-weight:800;letter-spacing:2px;">DAVO <span style="color:#c9a06b;font-size:11px;letter-spacing:5px;font-weight:300;">BRANDS FOR LIFE</span></div>
    <div style="font-size:18px;margin-top:10px;">דוח שבועי — תמהיל DAVO</div>
    <div style="font-size:12px;color:#aaa;margin-top:4px;">${new Date(r.generatedAt).toLocaleDateString('he-IL')} · השבוע מול שבוע קודם</div>
  </div>

  <div style="padding:24px;">
    <h2 style="font-size:16px;color:#c9a06b;border-right:4px solid #c9a06b;padding-right:10px;margin:0 0 12px;">סיכום ראשי</h2>
    <table cellspacing="0" cellpadding="0" style="width:100%;font-size:13px;">
      <tr>
        <td style="padding:10px;background:#fafafa;border-radius:6px;width:33%;vertical-align:top;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;">סה"כ DAVO</div>
          <div style="font-size:20px;font-weight:700;direction:ltr;text-align:right;">${fmt(r.headline.totalRev)}</div>
          <div style="font-size:11px;margin-top:4px;">${totalDeltaPctText} מהשבוע הקודם</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:10px;background:#fafafa;border-radius:6px;width:33%;vertical-align:top;">
          <div style="font-size:11px;color:#888;text-transform:uppercase;">מיקסרים</div>
          <div style="font-size:20px;font-weight:700;direction:ltr;text-align:right;">${fmt(r.headline.mixerRev)}</div>
          <div style="font-size:11px;margin-top:4px;">${mixerDeltaPctText} מהשבוע הקודם</div>
        </td>
        <td style="width:8px;"></td>
        <td style="padding:10px;background:#fef9e7;border-radius:6px;width:33%;vertical-align:top;border:1px solid #c9a06b;">
          <div style="font-size:11px;color:#92400e;text-transform:uppercase;">non-mixer</div>
          <div style="font-size:20px;font-weight:700;direction:ltr;text-align:right;color:#92400e;">${fmt(r.headline.nonMixerRev)}</div>
          <div style="font-size:11px;margin-top:4px;">${nonMixerDeltaPctText} מהשבוע הקודם</div>
        </td>
      </tr>
    </table>

    <h2 style="font-size:16px;color:#c9a06b;border-right:4px solid #c9a06b;padding-right:10px;margin:24px 0 12px;">התקדמות ליעד 60/40</h2>
    <table cellspacing="0" cellpadding="0" style="width:100%;font-size:13px;background:#fafafa;border-radius:6px;">
      <tr>
        <td style="padding:14px;">
          <div style="margin-bottom:8px;">
            <strong>חלק non-mixer מתוך DAVO:</strong>
            <span style="font-size:18px;font-weight:700;color:#1a1a1a;direction:ltr;">${fmtPct(r.headline.nonMixerShare)}</span>
            ${arr(r.headline.nonMixerShareDelta)} ${fmtPct(Math.abs(r.headline.nonMixerShareDelta.abs))}
          </div>
          <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${Math.min(100, r.headline.nonMixerShare * 100 / TARGET_NON_MIXER_SHARE)}%;background:linear-gradient(90deg,#c9a06b,#e3c08a);"></div>
          </div>
          <div style="font-size:11px;color:#666;margin-top:6px;">${phase1Status} · יעד סופי: ${fmtPct(TARGET_NON_MIXER_SHARE)}</div>

          <div style="margin:18px 0 8px;">
            <strong>Attach rate:</strong>
            <span style="font-size:18px;font-weight:700;color:#1a1a1a;direction:ltr;">${attachRateText}</span>
          </div>
          <div style="height:8px;background:#e5e5e5;border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${Math.min(100, r.attach.rate * 100 / TARGET_ATTACH_RATE)}%;background:linear-gradient(90deg,#10b981,#34d399);"></div>
          </div>
          <div style="font-size:11px;color:#666;margin-top:6px;">${attachStatus}</div>
          <div style="font-size:11px;color:#666;margin-top:8px;">
            AOV mixer-only: <strong style="direction:ltr;">${fmt(r.attach.aov.mixerOnly)}</strong> ·
            AOV mixer+attach: <strong style="direction:ltr;color:#92400e;">${fmt(r.attach.aov.mixerWithAttach)}</strong>
          </div>
        </td>
      </tr>
    </table>

    <h2 style="font-size:16px;color:#c9a06b;border-right:4px solid #c9a06b;padding-right:10px;margin:24px 0 12px;">Top 5 פריטי attach השבוע</h2>
    <table cellspacing="0" cellpadding="0" style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="background:#1a1a1a;color:#fff;">
          <th style="padding:8px;text-align:right;">פריט</th>
          <th style="padding:8px;text-align:left;">attaches</th>
          <th style="padding:8px;text-align:left;">הכנסה</th>
        </tr>
      </thead>
      <tbody>${topAttachRows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#888;">אין נתונים</td></tr>'}</tbody>
    </table>

    <h2 style="font-size:16px;color:#c9a06b;border-right:4px solid #c9a06b;padding-right:10px;margin:24px 0 12px;">Top 5 לקוחות השבוע</h2>
    <table cellspacing="0" cellpadding="0" style="width:100%;font-size:12px;border-collapse:collapse;">
      <thead>
        <tr style="background:#1a1a1a;color:#fff;">
          <th style="padding:8px;text-align:right;">לקוח</th>
          <th style="padding:8px;text-align:left;">הזמנות</th>
          <th style="padding:8px;text-align:left;">הכנסה</th>
        </tr>
      </thead>
      <tbody>${buyerRows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#888;">אין נתונים</td></tr>'}</tbody>
    </table>

    <div style="margin-top:24px;padding:12px;background:#fef9e7;border-right:4px solid #c9a06b;font-size:12px;color:#666;line-height:1.6;">
      דוח אוטומטי שנוצר על ידי DAVO Mix Tracker · SAP Logistics Hub<br>
      לצפייה אינטראקטיבית — דשבורד DAVO Mix Tracker בתפריט
    </div>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Generate the report and email it to configured recipients.
 */
export async function runWeeklyReport({ triggerType = 'manual' } = {}) {
  apiLogger.info(`[davoMixWeeklyReport] running (trigger=${triggerType})`);
  const report = await buildWeeklyReport();
  const html = renderReportHtml(report);

  const recipients = (env.DAVO_MIX_REPORT_RECIPIENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (recipients.length === 0) {
    apiLogger.warn('[davoMixWeeklyReport] no recipients configured (DAVO_MIX_REPORT_RECIPIENTS)');
    return { report, html, sent: false, recipients };
  }

  const subject = `DAVO Mix — דוח שבועי | non-mixer ${fmtPct(report.headline.nonMixerShare)} · attach ${fmtPct(report.attach.rate)}`;

  const sendResults = await Promise.allSettled(recipients.map((to) =>
    sendEmail({
      to,
      subject,
      html,
      eventType: 'DAVO_MIX_WEEKLY_REPORT',
      entity: { type: 'DavoMixReport', id: report.generatedAt },
    })
  ));

  const failures = sendResults.filter((r) => r.status === 'rejected');
  if (failures.length) {
    apiLogger.warn(`[davoMixWeeklyReport] ${failures.length}/${recipients.length} sends failed`);
  }
  apiLogger.info(`[davoMixWeeklyReport] sent to ${recipients.length - failures.length} recipients`);

  return { report, html, sent: true, recipients, failures: failures.length };
}
