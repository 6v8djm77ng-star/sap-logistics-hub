/**
 * QC Control Page — Post-Picking Quality Control (v2, 2026-05-26).
 *
 * v2 layout matches OpenOrdersPage: one collapsed row per RunOrder, each
 * expandable to show the picked items with per-item visual approve/reject
 * marks. The final action stays at the order level — POST
 * /api/qc/approve-order/:runOrderId creates DN/INV per the customer's
 * DocPolicy with whatever was picked (isPartial path is already in the
 * backend). Per-item marks are visual aids for the controller; backend
 * still consumes the existing per-order semantics.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import api from '../services/api.js';
import { format } from 'date-fns';
import {
  ShieldCheck, Check, X, AlertTriangle, Filter, RotateCcw, Package,
  ChevronDown, ChevronUp, Circle, CheckCircle2, XCircle,
} from 'lucide-react';

const qcApi = {
  pending: (params) => api.get('/qc/pending', { params }).then((r) => r.data),
  approve: (runOrderId) => api.post(`/qc/approve-order/${runOrderId}`).then((r) => r.data),
  reject:  (runOrderId, reason) =>
    api.post(`/qc/reject-order/${runOrderId}`, { reason }).then((r) => r.data),
};

// ─────────────────────────────────────────────────────────────────────
// Reject dialog (order-level)
// ─────────────────────────────────────────────────────────────────────
function RejectDialog({ row, onClose, onConfirm, isPending }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5">
        <h2 className="font-bold text-lg mb-1 text-red-700 flex items-center gap-2">
          <AlertTriangle size={18} /> דחיית הזמנה
        </h2>
        <p className="text-sm text-gray-600 mb-3">
          הזמנה <span className="font-mono">#{row.SapDocNum}</span> · {row.SapCardName}
        </p>
        <label className="block text-xs text-gray-600 mb-1">סיבת הדחייה (חובה)</label>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:ring-2 focus:ring-red-300 focus:outline-none"
          placeholder="לדוגמה: פגם באריזה / חוסר מלאי / כמות שגויה"
        />
        <div className="text-xs text-gray-400 mt-1">{reason.length}/500</div>
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="flex-1 py-2 border rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            ביטול
          </button>
          <button
            type="button"
            disabled={!reason.trim() || isPending}
            onClick={() => onConfirm(reason.trim())}
            className="flex-1 py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50"
          >
            {isPending ? 'דוחה…' : 'דחה הזמנה'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Order row — collapsed header + expanded picked-items detail
// ─────────────────────────────────────────────────────────────────────
function OrderRow({ row, onApprove, onReject, isApprovePending }) {
  const [expanded, setExpanded] = useState(false);
  // itemMarks: { [allocationId]: 'ok' | 'bad' | undefined } — visual only.
  const [itemMarks, setItemMarks] = useState({});

  const items = row.pickedItems || [];
  const okCount  = items.filter((i) => itemMarks[i.AllocationId] === 'ok').length;
  const badCount = items.filter((i) => itemMarks[i.AllocationId] === 'bad').length;

  const markItem = (allocId, value) => {
    setItemMarks((prev) => ({
      ...prev,
      [allocId]: prev[allocId] === value ? undefined : value,
    }));
  };

  const colSpanExpanded = 8;

  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer border-t"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-3 py-2 w-8">
          <button className="p-1 hover:bg-gray-200 rounded">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </td>
        <td className="px-3 py-2 font-mono text-xs">
          #{row.SapDocNum}
        </td>
        <td className="px-3 py-2">
          <div className="text-xs font-mono">{row.RunNumber}</div>
          <div className="text-xs text-gray-500">{row.RunDate}</div>
        </td>
        <td className="px-3 py-2 text-xs">
          {row.ZoneName || row.ZoneCode || '—'}
        </td>
        <td className="px-3 py-2 text-xs">
          {row.AssignedPickerName || row.PickedByName || '—'}
        </td>
        <td className="px-3 py-2 text-center">
          <span className="font-semibold">{items.length}</span>
          <span className="text-xs text-gray-500"> ({row.totalPicked}/{row.totalOrdered} יח׳)</span>
          {row.isPartial && (
            <div className="text-xs text-amber-600 mt-0.5">חלקי</div>
          )}
        </td>
        <td className="px-3 py-2 text-left font-mono text-sm">
          ₪{Number(row.OrderTotal || 0).toLocaleString()}
        </td>
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => onApprove(row.RunOrderId)}
              disabled={isApprovePending}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-green-600 text-white text-xs font-semibold hover:bg-green-700 disabled:opacity-50"
              title="אשר הזמנה — יצירת תעודות לפי מדיניות"
            >
              <Check size={14} /> אשר הזמנה
            </button>
            <button
              type="button"
              onClick={() => onReject(row)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-50"
              title="דחה הזמנה — סיבה נדרשת"
            >
              <X size={14} /> דחה
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50/70 border-t border-dashed">
          <td colSpan={colSpanExpanded} className="px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-bold text-sm flex items-center gap-2">
                <Package size={14} /> פריטים שלוקטו ({items.length})
              </h4>
              <div className="text-xs text-gray-600">
                סומנו: <span className="text-green-700 font-bold">{okCount} תקינים</span>
                {' · '}
                <span className="text-red-700 font-bold">{badCount} בעייתיים</span>
              </div>
            </div>
            {items.length === 0 ? (
              <div className="text-sm text-gray-500 py-2">אין פריטים לתצוגה.</div>
            ) : (
              <table className="w-full text-sm bg-white border rounded-lg overflow-hidden">
                <thead className="bg-gray-100 text-xs text-gray-600">
                  <tr>
                    <th className="px-3 py-2 text-right">פריט</th>
                    <th className="px-3 py-2 text-right">קוד</th>
                    <th className="px-3 py-2 text-center">הוזמן</th>
                    <th className="px-3 py-2 text-center">נלקט</th>
                    <th className="px-3 py-2 text-center">חוסר</th>
                    <th className="px-3 py-2 text-center">סטטוס</th>
                    <th className="px-3 py-2 text-center">סימון בקרה</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((item) => {
                    const mark = itemMarks[item.AllocationId];
                    return (
                      <tr key={item.AllocationId} className={
                        mark === 'ok' ? 'bg-green-50/50' :
                        mark === 'bad' ? 'bg-red-50/50' : ''
                      }>
                        <td className="px-3 py-2">{item.ItemName || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{item.ItemCode || '—'}</td>
                        <td className="px-3 py-2 text-center font-mono">{item.Ordered}</td>
                        <td className={`px-3 py-2 text-center font-mono font-semibold ${
                          item.IsEmpty ? 'text-red-600' :
                          item.IsPartial ? 'text-amber-600' : 'text-green-700'
                        }`}>{item.Picked}</td>
                        <td className="px-3 py-2 text-center font-mono">
                          {item.Missing > 0 ? (
                            <span className="text-red-600">{item.Missing}</span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {item.IsEmpty ? (
                            <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-800">לא לוקט</span>
                          ) : item.IsPartial ? (
                            <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-800">חלקי</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">מלא</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => markItem(item.AllocationId, 'ok')}
                              className={`p-1 rounded ${
                                mark === 'ok'
                                  ? 'bg-green-600 text-white'
                                  : 'border border-gray-300 text-gray-500 hover:bg-green-50 hover:text-green-700'
                              }`}
                              title="סמן כתקין"
                            >
                              <CheckCircle2 size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => markItem(item.AllocationId, 'bad')}
                              className={`p-1 rounded ${
                                mark === 'bad'
                                  ? 'bg-red-600 text-white'
                                  : 'border border-gray-300 text-gray-500 hover:bg-red-50 hover:text-red-700'
                              }`}
                              title="סמן כבעייתי"
                            >
                              <XCircle size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="mt-2 text-xs text-gray-500">
              סימני הבקרה הם ויזואליים בלבד לעזרה. אישור הזמנה מהכפתור הירוק יוצר תעודות לפי
              כמויות הליקוט בפועל (חוסרים יסומנו ב-DN כ-Shortages).
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────
export default function QcControlPage() {
  const qc = useQueryClient();
  const [runDate, setRunDate] = useState('');
  const [zoneCode, setZoneCode] = useState('');
  const [pickerId, setPickerId] = useState('');
  const [rejecting, setRejecting] = useState(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['qc-pending', runDate, zoneCode, pickerId],
    queryFn: () => qcApi.pending({
      runDate:  runDate  || undefined,
      zoneCode: zoneCode || undefined,
      pickerId: pickerId || undefined,
    }),
    refetchInterval: 30_000,
  });

  const orders = data?.orders || [];

  const approveMutation = useMutation({
    mutationFn: (runOrderId) => qcApi.approve(runOrderId),
    onSuccess: (res) => {
      const dn = res.deliveryNote ? `, DN ${res.deliveryNote.DocNumber}` : '';
      const inv = res.invoice ? `, INV ${res.invoice.DocNumber}` : '';
      toast.success(`הזמנה אושרה${dn}${inv}`);
      qc.invalidateQueries({ queryKey: ['qc-pending'] });
    },
    onError: (err) => {
      const msg = err.response?.data?.message || err.response?.data?.error || 'אישור נכשל';
      toast.error(msg, { duration: 6000 });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ runOrderId, reason }) => qcApi.reject(runOrderId, reason),
    onSuccess: () => {
      toast.success('הזמנה נדחתה');
      setRejecting(null);
      qc.invalidateQueries({ queryKey: ['qc-pending'] });
    },
    onError: (err) => {
      const msg = err.response?.data?.message || err.response?.data?.error || 'דחייה נכשלה';
      toast.error(msg, { duration: 6000 });
    },
  });

  const uniqueDates   = [...new Set(orders.map((o) => o.RunDate).filter(Boolean))].sort();
  const uniqueZones   = [...new Set(orders.map((o) => o.ZoneCode).filter(Boolean))].sort();
  const uniquePickers = [...new Map(
    orders.filter((o) => o.AssignedPickerId)
          .map((o) => [o.AssignedPickerId, o.AssignedPickerName || `Picker ${o.AssignedPickerId}`])
  )];
  const clearFilters = () => { setRunDate(''); setZoneCode(''); setPickerId(''); };
  const hasFilter = !!(runDate || zoneCode || pickerId);

  return (
    <div className="p-4 md:p-6 max-w-screen-2xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <ShieldCheck className="text-blue-600" size={28} />
        <h1 className="text-2xl font-bold">בקרה אחרי ליקוט</h1>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        לחיצה על שורה פותחת את הפריטים שלוקטו עם סימוני בקרה (תקין / בעייתי).
        כפתור "אשר הזמנה" → תעודות נוצרות לפי מדיניות הלקוח עם כמויות הליקוט בפועל.
        שום פעולה לא נשלחת ל-SAP.
      </p>

      {/* Filters */}
      <div className="bg-white border rounded-xl p-3 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">תאריך מסלול</label>
          <select value={runDate} onChange={(e) => setRunDate(e.target.value)}
                  className="border rounded-lg px-3 py-1.5 text-sm bg-white">
            <option value="">כל התאריכים</option>
            {uniqueDates.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">אזור</label>
          <select value={zoneCode} onChange={(e) => setZoneCode(e.target.value)}
                  className="border rounded-lg px-3 py-1.5 text-sm bg-white">
            <option value="">כל האזורים</option>
            {uniqueZones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">מלקט</label>
          <select value={pickerId} onChange={(e) => setPickerId(e.target.value)}
                  className="border rounded-lg px-3 py-1.5 text-sm bg-white">
            <option value="">כל המלקטים</option>
            {uniquePickers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        {hasFilter && (
          <button type="button" onClick={clearFilters}
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1 pb-2">
            <Filter size={12} /> נקה סינון
          </button>
        )}
        <button type="button" onClick={() => refetch()}
                className="ml-auto inline-flex items-center gap-1 text-xs text-gray-600 hover:bg-gray-100 px-2 py-1 rounded"
                title="רענן">
          <RotateCcw size={12} /> רענן
        </button>
      </div>

      {/* Counter */}
      <div className="text-sm text-gray-600 mb-2">
        {isLoading ? 'טוען…' : (
          <>
            <span className="font-bold text-blue-700">{orders.length}</span> הזמנות ממתינות לאישור
          </>
        )}
      </div>

      {/* Customer-grouped rendering: same customer's orders share one
          header instead of repeating the customer name on every row.
          Group key = `${CompanyCode}:${SapCardCode}` so two different
          companies with the same CardCode don't collide. Within a group
          we keep the source order from the API (newest first). */}
      {(() => null)()}
      {/* (computed inline below) */}

      {/* Empty state */}
      {orders.length === 0 && !isLoading ? (
        <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-5 text-sm">
          <p className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
            <Package size={16} /> אין הזמנות ממתינות לבקרה
          </p>
          <p className="text-blue-800">
            הזמנות יופיעו כאן כשהמלקטים יסיימו ליקוט וה-Wave יעבור ל-PENDING_QC.
          </p>
        </div>
      ) : (
        <div className="bg-white border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2 text-right">הזמנה</th>
                <th className="px-3 py-2 text-right">מסלול</th>
                <th className="px-3 py-2 text-right">אזור</th>
                <th className="px-3 py-2 text-right">מלקט</th>
                <th className="px-3 py-2 text-center">פריטים</th>
                <th className="px-3 py-2 text-left">סכום</th>
                <th className="px-3 py-2 text-center">פעולות</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Group orders by customer (CompanyCode:SapCardCode) and
                // preserve the API order within each group.
                const groups = new Map();
                for (const o of orders) {
                  const key = `${o.CompanyCode || ''}:${o.SapCardCode || ''}`;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key).push(o);
                }
                const rendered = [];
                for (const [groupKey, groupOrders] of groups) {
                  const first = groupOrders[0];
                  const groupSum = groupOrders.reduce(
                    (s, o) => s + Number(o.OrderTotal || 0), 0,
                  );
                  rendered.push(
                    <tr key={`hdr-${groupKey}`} className="bg-purple-50 border-t-2 border-purple-200">
                      <td colSpan={8} className="px-3 py-2">
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-purple-900 flex items-center gap-2">
                            <Package size={14} className="text-purple-700" />
                            {first.SapCardName}
                            <span className="text-xs text-purple-600 font-mono">{first.SapCardCode}</span>
                          </div>
                          <div className="text-xs text-purple-800">
                            {groupOrders.length} הזמנות · סה״כ ₪{groupSum.toLocaleString()}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                  for (const row of groupOrders) {
                    rendered.push(
                      <OrderRow
                        key={row.RunOrderId}
                        row={row}
                        onApprove={(id) => approveMutation.mutate(id)}
                        onReject={(r) => setRejecting(r)}
                        isApprovePending={approveMutation.isPending}
                      />
                    );
                  }
                }
                return rendered;
              })()}
            </tbody>
          </table>
        </div>
      )}

      {/* Reject dialog */}
      {rejecting && (
        <RejectDialog
          row={rejecting}
          isPending={rejectMutation.isPending}
          onClose={() => setRejecting(null)}
          onConfirm={(reason) =>
            rejectMutation.mutate({ runOrderId: rejecting.RunOrderId, reason })
          }
        />
      )}
    </div>
  );
}
