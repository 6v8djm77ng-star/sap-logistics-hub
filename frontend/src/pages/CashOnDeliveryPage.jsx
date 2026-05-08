/**
 * Cash on Delivery (COD) reconciliation page - office sees what each driver
 * collected, marks deposits.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Banknote, CheckCircle, Clock, User, MapPin } from 'lucide-react';

export default function CashOnDeliveryPage() {
  const queryClient = useQueryClient();
  const [runDate, setRunDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const { data, isLoading } = useQuery({
    queryKey: ['cod', runDate],
    queryFn: () => api.get('/cod', { params: { runDate } }).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const depositMutation = useMutation({
    mutationFn: (codId) => api.patch(`/cod/${codId}/deposit`).then((r) => r.data),
    onSuccess: () => {
      toast.success('סומן כהופקד');
      queryClient.invalidateQueries({ queryKey: ['cod'] });
    },
  });

  const records = data?.records || [];
  const byDriver = useMemo(() => {
    const m = new Map();
    for (const r of records) {
      if (!m.has(r.DriverId)) {
        m.set(r.DriverId, {
          DriverId: r.DriverId,
          DriverName: r.DriverName || `Driver ${r.DriverId}`,
          records: [],
          total: 0,
          pending: 0,
        });
      }
      const e = m.get(r.DriverId);
      e.records.push(r);
      e.total += Number(r.Amount || 0);
      if (r.Status !== 'DEPOSITED') e.pending += Number(r.Amount || 0);
    }
    return Array.from(m.values()).sort((a, b) => b.pending - a.pending);
  }, [records]);

  const grandTotal = records.reduce((s, r) => s + Number(r.Amount || 0), 0);
  const grandPending = records.filter((r) => r.Status !== 'DEPOSITED').reduce((s, r) => s + Number(r.Amount || 0), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Banknote className="text-green-600" /> תשלום במזומן (COD)
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            כסף שנהגים גבו מלקוחות - מעקב והפקדה
          </p>
        </div>
        <input
          type="date"
          value={runDate}
          onChange={(e) => setRunDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <SummaryCard label="סה״כ נגבה היום" value={grandTotal} icon={Banknote} color="bg-green-50 border-green-200 text-green-700" />
        <SummaryCard label="ממתין להפקדה" value={grandPending} icon={Clock} color="bg-amber-50 border-amber-200 text-amber-700" />
        <SummaryCard label="מספר עסקאות" value={records.length} icon={MapPin} color="bg-blue-50 border-blue-200 text-blue-700" />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : byDriver.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Banknote className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-2">אין גביות במזומן ביום זה</p>
          <p className="text-xs text-gray-400">נהגים מתעדים גבייה דרך אפליקציית הנהג</p>
        </div>
      ) : (
        <div className="space-y-4">
          {byDriver.map((d) => (
            <DriverPanel key={d.DriverId} driver={d} onDeposit={(id) => depositMutation.mutate(id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon, color }) {
  return (
    <div className={`border rounded-xl p-4 ${color}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs opacity-80">{label}</div>
          <div className="text-3xl font-bold mt-1">
            {typeof value === 'number' && label !== 'מספר עסקאות'
              ? value.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 })
              : value.toLocaleString('he-IL')}
          </div>
        </div>
        <Icon size={28} className="opacity-30" />
      </div>
    </div>
  );
}

function DriverPanel({ driver, onDeposit }) {
  return (
    <div className="bg-white border rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold">
          <User size={16} /> {driver.DriverName}
        </div>
        <div className="text-sm">
          סה"כ: <span className="font-bold">{driver.total.toLocaleString('he-IL')} ₪</span>
          {driver.pending > 0 && (
            <span className="mr-2 text-amber-700">
              · ממתין להפקדה: <span className="font-bold">{driver.pending.toLocaleString('he-IL')} ₪</span>
            </span>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600 text-xs">
          <tr>
            <th className="px-3 py-2 text-right">לקוח</th>
            <th className="px-3 py-2 text-right">עיר</th>
            <th className="px-3 py-2 text-right">סכום</th>
            <th className="px-3 py-2 text-right">אמצעי</th>
            <th className="px-3 py-2 text-right">קבלה</th>
            <th className="px-3 py-2 text-center">סטטוס</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {driver.records.map((r) => (
            <tr key={r.CodId} className="hover:bg-gray-50">
              <td className="px-3 py-2 font-medium">{r.BranchName}</td>
              <td className="px-3 py-2 text-gray-600">{r.City}</td>
              <td className="px-3 py-2 font-bold">{Number(r.Amount).toLocaleString('he-IL')} ₪</td>
              <td className="px-3 py-2">
                <span className="text-xs px-2 py-0.5 bg-gray-100 rounded">
                  {r.Method === 'CASH' ? 'מזומן' : r.Method === 'CHEQUE' ? 'צ׳ק' : r.Method}
                </span>
              </td>
              <td className="px-3 py-2 text-xs font-mono">{r.ReceiptNumber || '—'}</td>
              <td className="px-3 py-2 text-center">
                {r.Status === 'DEPOSITED' ? (
                  <span className="inline-flex items-center gap-1 text-green-700 text-xs">
                    <CheckCircle size={12} /> הופקד
                  </span>
                ) : (
                  <button
                    onClick={() => onDeposit(r.CodId)}
                    className="px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700"
                  >
                    סמן הופקד
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
