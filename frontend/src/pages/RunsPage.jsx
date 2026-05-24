import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { runsApi, zonesApi, driversApi } from '../services/api.js';
import api, { downloadFile } from '../services/api.js';
import StatusPill from '../components/StatusPill.jsx';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Plus, X, Trash2, Copy, Printer } from 'lucide-react';

function NewRunDialog({ onClose, onCreated }) {
  const { data: zones } = useQuery({ queryKey: ['zones'], queryFn: zonesApi.list });
  const { data: drivers } = useQuery({ queryKey: ['drivers'], queryFn: driversApi.list });

  const [form, setForm] = useState({
    runDate: format(new Date(), 'yyyy-MM-dd'),
    zoneId: '',
    driverId: '',
    notes: '',
  });

  const mutation = useMutation({
    mutationFn: () => api.post('/runs', {
      runDate: form.runDate,
      zoneId: Number(form.zoneId),
      driverId: Number(form.driverId) || null,
      notes: form.notes,
    }).then((r) => r.data),
    onSuccess: (run) => {
      toast.success(`מסלול ${run.RunNumber} נוצרה`);
      onCreated(run);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">מסלול חדש</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">תאריך מסלול</label>
            <input
              type="date"
              value={form.runDate}
              onChange={(e) => setForm({ ...form, runDate: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">אזור *</label>
            <select
              value={form.zoneId}
              onChange={(e) => setForm({ ...form, zoneId: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">-- בחר אזור --</option>
              {zones?.map((z) => (
                <option key={z.ZoneId} value={z.ZoneId}>{z.Name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">נהג</label>
            <select
              value={form.driverId}
              onChange={(e) => setForm({ ...form, driverId: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            >
              <option value="">-- ללא נהג בשלב זה --</option>
              {drivers?.filter((d) => d.IsActive).map((d) => (
                <option key={d.DriverId} value={d.DriverId}>{d.FullName} ({d.Code})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">הערות</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!form.zoneId || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'יוצר...' : 'צור מסלול'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RunsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [creating, setCreating] = useState(false);

  const { data: runs, isLoading } = useQuery({
    queryKey: ['runs', date],
    queryFn: () => runsApi.list({ runDate: date }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/runs/${id}`).then((r) => r.data),
    onSuccess: () => {
      toast.success('מסלול נמחק');
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: ({ runId, targetDate }) =>
      api.post(`/runs/${runId}/duplicate`, { runDate: targetDate }).then((r) => r.data),
    onSuccess: (newRun) => {
      toast.success(`מסלול ${newRun.RunNumber} שוכפלה`);
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${newRun.RunId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בשכפול'),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">מסלולי הפצה</h1>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          {runs && runs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                downloadFile(
                  `/reports/runs/bulk-manifest.pdf?runDate=${date}`,
                  `bulk-manifest-${date}.pdf`,
                ).catch((err) => toast.error(err.response?.data?.error || 'הורדה נכשלה'));
              }}
              className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50"
              title="הדפס דף נהג מרוכז של כל המסלולים ליום זה"
            >
              <Printer size={16} /> הדפס את כל המסלולים
            </button>
          )}
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
          >
            <Plus size={16} /> מסלול חדש
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-3 text-right">מספר מסלול</th>
              <th className="px-4 py-3 text-right">אזור</th>
              <th className="px-4 py-3 text-right">נהג</th>
              <th className="px-4 py-3 text-center">עצירות</th>
              <th className="px-4 py-3 text-center">הזמנות</th>
              <th className="px-4 py-3 text-center">סטטוס</th>
              <th className="px-4 py-3 w-24" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">טוען...</td></tr>
            ) : !runs?.length ? (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">
                אין מסלולים לתאריך זה. <button onClick={() => setCreating(true)} className="text-brand-600 hover:underline">+ צור מסלול חדש</button>
              </td></tr>
            ) : runs.map((r) => (
              <tr key={r.RunId} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{r.RunNumber}</td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.ZoneColor || '#9ca3af' }} />
                    {r.ZoneName}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">{r.DriverName || '—'}</td>
                <td className="px-4 py-3 text-center">{r.StopCount}</td>
                <td className="px-4 py-3 text-center">{r.OrderCount}</td>
                <td className="px-4 py-3 text-center"><StatusPill status={r.Status} size="sm" /></td>
                <td className="px-4 py-3 text-left whitespace-nowrap">
                  <Link to={`/runs/${r.RunId}`} className="text-brand-600 hover:underline text-sm mr-2">פרטים ←</Link>
                  <button
                    onClick={() => {
                      const target = prompt(`שכפל את המסלול ${r.RunNumber} לתאריך:`, format(new Date(), 'yyyy-MM-dd'));
                      if (target) duplicateMutation.mutate({ runId: r.RunId, targetDate: target });
                    }}
                    className="p-1 text-brand-600 hover:bg-brand-50 rounded mr-1"
                    title="שכפל ליום אחר"
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`למחוק את המסלול ${r.RunNumber}?`)) {
                        deleteMutation.mutate(r.RunId);
                      }
                    }}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                    title="מחק"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewRunDialog
          onClose={() => setCreating(false)}
          onCreated={(run) => { setCreating(false); navigate(`/runs/${run.RunId}`); }}
        />
      )}
    </div>
  );
}
