/**
 * DEV.19: Audit Log viewer.
 *
 * Why this exists:
 *   The audit log is the only durable record of who did what to the
 *   store — confirmSapDocument, revertSapConfirmation, export_test,
 *   reset-stuck-aggregate-docs, login.success, etc. Reading store.json
 *   directly is operator-hostile. This page is the minimum-viable UI
 *   to surface those entries without leaving the browser.
 *
 * Read-only. No actions. No mutations. Single backend call to the
 * existing GET /api/audit (admin-only).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { History, Filter, AlertTriangle } from 'lucide-react';
import api from '../services/api.js';

const ACTION_PALETTE = {
  'invoice.export_test':            { label: 'יצוא חשבונית ל-SAP',   color: 'bg-purple-100 text-purple-800' },
  'document.revert_confirm':        { label: 'ביטול אישור חשוד',     color: 'bg-amber-100 text-amber-800' },
  'login.success':                  { label: 'התחברות',              color: 'bg-green-50 text-green-700' },
  'login.failure':                  { label: 'כשל התחברות',          color: 'bg-red-50 text-red-700' },
  'admin.reset-stuck-aggregate-docs': { label: 'איפוס מסמכים תקועים', color: 'bg-orange-100 text-orange-800' },
  'role-permissions.update':        { label: 'עדכון הרשאות',         color: 'bg-blue-50 text-blue-700' },
};

function ActionBadge({ action }) {
  const meta = ACTION_PALETTE[action] || { label: action, color: 'bg-gray-100 text-gray-700' };
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function DetailsCell({ details }) {
  if (!details || (typeof details === 'object' && Object.keys(details).length === 0)) {
    return <span className="text-gray-400 text-xs">—</span>;
  }
  // Compact JSON view that's still readable. Truncate long fields so the
  // table stays scannable; the full value is in the title tooltip.
  const compact = JSON.stringify(details);
  const display = compact.length > 120 ? compact.slice(0, 120) + '…' : compact;
  return (
    <span className="font-mono text-xs text-gray-600" title={compact}>
      {display}
    </span>
  );
}

export default function AuditLogPage() {
  const [actionFilter, setActionFilter] = useState('');
  const [limit, setLimit] = useState(200);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['audit-log', actionFilter, limit],
    queryFn: () => api.get('/audit', {
      params: { action: actionFilter || undefined, limit },
    }).then((r) => r.data.trail || []),
    refetchInterval: 30_000,
  });

  // Distinct actions for the filter dropdown — pulled from the current
  // result set so options stay in sync with what's actually present.
  const distinctActions = Array.from(new Set((data || []).map((e) => e.action))).sort();

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="text-brand-600" /> יומן ביקורת (Audit Log)
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            רשומות מערכת — מי עשה מה ומתי. Read-only. רק admin.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-sm px-3 py-1.5 border rounded-lg hover:bg-gray-50"
        >
          רענן
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border rounded-xl p-3 mb-4 flex items-center gap-2 flex-wrap">
        <Filter size={14} className="text-gray-400" />
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="px-2 py-1 border rounded text-sm"
        >
          <option value="">כל הפעולות</option>
          {distinctActions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="px-2 py-1 border rounded text-sm"
        >
          <option value="50">50 אחרונים</option>
          <option value="200">200 אחרונים</option>
          <option value="500">500 אחרונים</option>
          <option value="1000">1000 אחרונים</option>
        </select>
        <span className="text-xs text-gray-500 mr-2">
          סה"כ: {data?.length || 0}
        </span>
      </div>

      {/* Table */}
      <div className="bg-white border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="p-3 text-right">זמן</th>
              <th className="p-3 text-right">פעולה</th>
              <th className="p-3 text-right">משתמש</th>
              <th className="p-3 text-right">IP</th>
              <th className="p-3 text-right">פרטים</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              <tr><td colSpan={5} className="p-8 text-center text-gray-500">טוען...</td></tr>
            ) : isError ? (
              <tr><td colSpan={5} className="p-8 text-center text-red-600">
                <AlertTriangle size={16} className="inline mr-1" />
                שגיאה: {error?.response?.data?.error || error?.message}
              </td></tr>
            ) : !data?.length ? (
              <tr><td colSpan={5} className="p-8 text-center text-gray-500">
                אין רשומות התואמות לסינון
              </td></tr>
            ) : data.map((e, idx) => (
              <tr key={`${e.at || idx}-${idx}`} className="hover:bg-gray-50">
                <td className="p-3 text-xs text-gray-600 whitespace-nowrap">
                  {e.at ? format(new Date(e.at), 'yyyy-MM-dd HH:mm:ss') : '—'}
                </td>
                <td className="p-3"><ActionBadge action={e.action} /></td>
                <td className="p-3 text-xs">
                  <div className="font-medium">{e.actorName || '—'}</div>
                  {e.actorSub != null && (
                    <div className="text-gray-500 font-mono">id={e.actorSub}</div>
                  )}
                </td>
                <td className="p-3 text-xs font-mono text-gray-500">{e.ip || '—'}</td>
                <td className="p-3"><DetailsCell details={e.details} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
