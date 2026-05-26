/**
 * QC Control Page — Post-Picking Quality Control (P4+P5, 2026-05-26).
 *
 * One row per RunOrder sitting in a PENDING_QC wave that hasn't been
 * approved or rejected. The QC controller / admin can:
 *   - Approve  → POST /api/qc/approve-order/:runOrderId  → DN/INV created
 *                 per customer DocPolicy (LOCAL, no SAP HTTP)
 *   - Reject   → POST /api/qc/reject-order/:runOrderId   → marks
 *                 QcRejected with a required reason
 *
 * Filters in URL/state (NOT yet persisted to localStorage — keep light):
 *   - runDate, pickerId, zoneCode
 *
 * Empty-list state shows guidance so the controller knows the screen is
 * working even when there's nothing to review.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import api from '../services/api.js';
import { format } from 'date-fns';
import {
  ShieldCheck, Check, X, AlertTriangle, Filter, RotateCcw, Package,
} from 'lucide-react';

const qcApi = {
  pending: (params) => api.get('/qc/pending', { params }).then((r) => r.data),
  approve: (runOrderId) => api.post(`/qc/approve-order/${runOrderId}`).then((r) => r.data),
  reject:  (runOrderId, reason) =>
    api.post(`/qc/reject-order/${runOrderId}`, { reason }).then((r) => r.data),
};

// ─────────────────────────────────────────────────────────────────────
// Reject dialog
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
          placeholder="לדוגמה: פגם באריזה / חוסר מלאי לא מתועד / כמות שגויה"
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
// Page
// ─────────────────────────────────────────────────────────────────────
export default function QcControlPage() {
  const qc = useQueryClient();
  const [runDate, setRunDate] = useState('');
  const [zoneCode, setZoneCode] = useState('');
  const [pickerId, setPickerId] = useState('');
  const [rejecting, setRejecting] = useState(null); // row being rejected

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

  // Build dropdown options from the actual data — only days/zones/pickers
  // that have something to review today. Saves the user from having to
  // know the master list.
  const uniqueDates   = [...new Set(orders.map((o) => o.RunDate).filter(Boolean))].sort();
  const uniqueZones   = [...new Set(orders.map((o) => o.ZoneCode).filter(Boolean))].sort();
  const uniquePickers = [...new Map(
    orders.filter((o) => o.AssignedPickerId)
          .map((o) => [o.AssignedPickerId, o.AssignedPickerName || `Picker ${o.AssignedPickerId}`])
  )];

  const clearFilters = () => {
    setRunDate(''); setZoneCode(''); setPickerId('');
  };
  const hasFilter = !!(runDate || zoneCode || pickerId);

  return (
    <div className="p-4 md:p-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <ShieldCheck className="text-blue-600" size={28} />
        <h1 className="text-2xl font-bold">בקרה אחרי ליקוט</h1>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        אישור פר-הזמנה אחרי שהמלקט סיים. אישור → תעודות נוצרות לפי מדיניות הלקוח.
        דחייה → ההזמנה מסומנת ולא מקבלת מסמך. שום פעולה לא נשלחת ל-SAP.
      </p>

      {/* Filters */}
      <div className="bg-white border rounded-xl p-3 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">תאריך מסלול</label>
          <select
            value={runDate}
            onChange={(e) => setRunDate(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="">כל התאריכים</option>
            {uniqueDates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">אזור</label>
          <select
            value={zoneCode}
            onChange={(e) => setZoneCode(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="">כל האזורים</option>
            {uniqueZones.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">מלקט</label>
          <select
            value={pickerId}
            onChange={(e) => setPickerId(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white"
          >
            <option value="">כל המלקטים</option>
            {uniquePickers.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>
        {hasFilter && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1 pb-2"
          >
            <Filter size={12} /> נקה סינון
          </button>
        )}
        <button
          type="button"
          onClick={() => refetch()}
          className="ml-auto inline-flex items-center gap-1 text-xs text-gray-600 hover:bg-gray-100 px-2 py-1 rounded"
          title="רענן"
        >
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

      {/* Table or empty state */}
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
                <th className="px-3 py-2 text-right">הזמנה</th>
                <th className="px-3 py-2 text-right">לקוח</th>
                <th className="px-3 py-2 text-right">מסלול</th>
                <th className="px-3 py-2 text-right">אזור</th>
                <th className="px-3 py-2 text-right">מלקט</th>
                <th className="px-3 py-2 text-right">תאריך הגשה</th>
                <th className="px-3 py-2 text-left">סכום</th>
                <th className="px-3 py-2 text-center">פעולות</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {orders.map((row) => (
                <tr key={row.RunOrderId} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">
                    #{row.SapDocNum}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.SapCardName}</div>
                    <div className="text-xs text-gray-500 font-mono">{row.SapCardCode}</div>
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
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {row.QcSubmittedAt
                      ? format(new Date(row.QcSubmittedAt), 'dd/MM HH:mm')
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-left font-mono">
                    ₪{Number(row.OrderTotal || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => approveMutation.mutate(row.RunOrderId)}
                        disabled={approveMutation.isPending}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-green-600 text-white text-xs font-semibold hover:bg-green-700 disabled:opacity-50"
                        title="אשר הזמנה — יצירת תעודות לפי מדיניות"
                      >
                        <Check size={14} /> אשר
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejecting(row)}
                        disabled={rejectMutation.isPending}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-50 disabled:opacity-50"
                        title="דחה הזמנה — סיבה נדרשת"
                      >
                        <X size={14} /> דחה
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
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
