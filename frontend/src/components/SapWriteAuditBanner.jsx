/**
 * SAP write audit banner — Phase A2f (2026-05-20).
 *
 * Renders a compact summary of the SAP writer's mode (DRY-RUN / LIVE)
 * plus the A2e audit aggregate (write attempts + stuck-write errors +
 * most-recent payload timestamp).
 *
 * Data sources:
 *   - /api/sap/writer/status  (writer mode, whitelist; from A2c-1 + A1)
 *   - /api/documents/stats    (returns an `audit` block from A2e)
 *
 * The component is purely presentational over those two endpoints.
 * It does not write, does not call SAP, and does not mutate any state.
 *
 * Color/severity:
 *   - red    when audit.combinedErrorsCount > 0  (stuck writes)
 *   - amber  when writer mode is LIVE            (operator should know)
 *   - blue   when writer mode is DRY-RUN with activity (default healthy)
 *   - gray   when no attempts yet                (neutral first-run state)
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, Clock, FileText, Receipt, Activity } from 'lucide-react';
import { sapApi } from '../services/api.js';

function formatTimestamp(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('he-IL', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function pickSeverity({ mode, combinedErrorsCount, totalAttempts }) {
  if (combinedErrorsCount > 0) return 'error';
  if (mode === 'LIVE')         return 'warn';
  if (totalAttempts > 0)       return 'info';
  return 'neutral';
}

const SEVERITY_CLASSES = {
  error:   { wrap: 'bg-red-50    border-red-300    text-red-900',    badge: 'bg-red-600    text-white' },
  warn:    { wrap: 'bg-amber-50  border-amber-300  text-amber-900',  badge: 'bg-amber-600  text-white' },
  info:    { wrap: 'bg-blue-50   border-blue-300   text-blue-900',   badge: 'bg-blue-600   text-white' },
  neutral: { wrap: 'bg-gray-50   border-gray-300   text-gray-700',   badge: 'bg-gray-500   text-white' },
};

/**
 * Stats from useQuery in DocumentsPage are passed in instead of refetched
 * here, so the banner stays in sync with the parent view (same runDate
 * filter, same refresh cadence). The parent calls docsApi.stats and now
 * receives an audit block per A2e — we render that block.
 */
export default function SapWriteAuditBanner({ stats }) {
  // Writer status is a small payload; refetch every 60s in case the
  // operator flips SAP_WRITE_ENABLED via .env + server restart.
  const { data: writer } = useQuery({
    queryKey: ['sap-writer-status'],
    queryFn: () => sapApi.writerStatus(),
    refetchInterval: 60_000,
    // 401 / network errors should never break the page; fall back to
    // "mode unknown" rather than crashing.
    retry: 0,
  });

  const audit = stats?.audit;
  const dnAttempts  = audit?.deliveryNotes?.totalAttempts ?? 0;
  const invAttempts = audit?.invoices?.totalAttempts ?? 0;
  const totalAttempts = dnAttempts + invAttempts;
  const combinedErrorsCount = audit?.combinedErrorsCount ?? 0;
  const lastWriteAt = audit?.lastWriteAttemptAt;

  // Writer mode falls back gracefully when /writer/status is unreachable.
  // We default to DRY-RUN because that's the safe assumption — never
  // claim LIVE when the actual mode is unknown.
  const mode = writer?.mode || 'DRY-RUN';
  const writeEnabled = !!writer?.writeEnabled;

  const severity = pickSeverity({ mode, combinedErrorsCount, totalAttempts });
  const cls = SEVERITY_CLASSES[severity];

  const hasAnyActivity = totalAttempts > 0 || combinedErrorsCount > 0 || lastWriteAt;

  return (
    <div className={`rounded-xl border px-4 py-3 mb-4 ${cls.wrap}`}>
      <div className="flex items-center gap-3 flex-wrap">
        {/* Mode badge */}
        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${cls.badge}`}>
          {mode === 'LIVE' ? <ShieldAlert size={14} /> : <Activity size={14} />}
          SAP {mode}
          {mode === 'LIVE' && !writeEnabled ? ' (config)' : ''}
        </span>

        {/* Audit summary */}
        {hasAnyActivity ? (
          <>
            <span className="inline-flex items-center gap-1 text-sm">
              <FileText size={14} />
              <span className="font-medium">{dnAttempts}</span>
              <span className="opacity-75">תעודות משלוח (ניסיונות)</span>
            </span>
            <span className="inline-flex items-center gap-1 text-sm">
              <Receipt size={14} />
              <span className="font-medium">{invAttempts}</span>
              <span className="opacity-75">חשבוניות (ניסיונות)</span>
            </span>
            {lastWriteAt ? (
              <span className="inline-flex items-center gap-1 text-sm">
                <Clock size={14} />
                <span className="opacity-75">נשלח לאחרונה:</span>
                <span className="font-medium">{formatTimestamp(lastWriteAt)}</span>
              </span>
            ) : null}
            {combinedErrorsCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-sm font-semibold mr-auto">
                <AlertTriangle size={14} />
                {combinedErrorsCount} כתיבות תקועות — נדרשת בדיקה ידנית
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-sm opacity-90">
            טרם בוצעו ניסיונות כתיבה ל-SAP
          </span>
        )}
      </div>
    </div>
  );
}
