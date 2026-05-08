/**
 * Edit business hours for a customer (chain). All branches inherit.
 */
import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { X, Clock, Save, RotateCcw } from 'lucide-react';

const DAYS = [
  { key: 'sunday',    label: 'ראשון' },
  { key: 'monday',    label: 'שני' },
  { key: 'tuesday',   label: 'שלישי' },
  { key: 'wednesday', label: 'רביעי' },
  { key: 'thursday',  label: 'חמישי' },
  { key: 'friday',    label: 'שישי' },
  { key: 'saturday',  label: 'שבת' },
];

const DEFAULT_DAY = { open: '08:00', close: '17:00', breakStart: null, breakEnd: null, closed: false };

export default function CustomerHoursDialog({ parentName, onClose }) {
  const queryClient = useQueryClient();
  const [hours, setHours] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/customers/hours/${encodeURIComponent(parentName)}`)
      .then((r) => setHours(r.data.hours))
      .finally(() => setLoading(false));
  }, [parentName]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/customers/hours/${encodeURIComponent(parentName)}`, { hours }),
    onSuccess: () => {
      toast.success('שעות הפעילות נשמרו');
      queryClient.invalidateQueries({ queryKey: ['customer-hours'] });
      onClose();
    },
    onError: () => toast.error('שגיאה בשמירה'),
  });

  const resetMutation = useMutation({
    mutationFn: () => api.patch(`/customers/hours/${encodeURIComponent(parentName)}`, { hours: null }),
    onSuccess: () => {
      toast.success('שוחזר לברירת מחדל');
      queryClient.invalidateQueries({ queryKey: ['customer-hours'] });
      onClose();
    },
  });

  const updateDay = (dayKey, patch) => {
    setHours((h) => ({ ...h, [dayKey]: { ...(h[dayKey] || DEFAULT_DAY), ...patch } }));
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8">טוען...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="font-bold text-lg flex items-center gap-2">
              <Clock className="text-blue-600" size={20} />
              שעות פעילות
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">{parentName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-2">
          {DAYS.map((d) => {
            const day = hours[d.key] || DEFAULT_DAY;
            return (
              <div key={d.key} className={`border rounded-lg p-3 ${day.closed ? 'bg-gray-50 opacity-60' : 'bg-white'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="font-bold text-sm">{d.label}</div>
                  <label className="flex items-center gap-1.5 text-xs text-red-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={day.closed}
                      onChange={(e) => updateDay(d.key, { closed: e.target.checked })}
                    />
                    סגור כל היום
                  </label>
                </div>
                {!day.closed && (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <label>
                      <span className="text-xs text-gray-500">פתיחה</span>
                      <input
                        type="time"
                        value={day.open || ''}
                        onChange={(e) => updateDay(d.key, { open: e.target.value })}
                        className="block w-full mt-0.5 px-2 py-1 border border-gray-300 rounded"
                      />
                    </label>
                    <label>
                      <span className="text-xs text-gray-500">סגירה</span>
                      <input
                        type="time"
                        value={day.close || ''}
                        onChange={(e) => updateDay(d.key, { close: e.target.value })}
                        className="block w-full mt-0.5 px-2 py-1 border border-gray-300 rounded"
                      />
                    </label>
                    <label>
                      <span className="text-xs text-amber-600">תחילת הפסקה (לא חובה)</span>
                      <input
                        type="time"
                        value={day.breakStart || ''}
                        onChange={(e) => updateDay(d.key, { breakStart: e.target.value || null })}
                        className="block w-full mt-0.5 px-2 py-1 border border-amber-300 rounded"
                        placeholder="לדוג' 14:00"
                      />
                    </label>
                    <label>
                      <span className="text-xs text-amber-600">סוף הפסקה</span>
                      <input
                        type="time"
                        value={day.breakEnd || ''}
                        onChange={(e) => updateDay(d.key, { breakEnd: e.target.value || null })}
                        className="block w-full mt-0.5 px-2 py-1 border border-amber-300 rounded"
                        placeholder="לדוג' 16:00"
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="p-3 border-t bg-gray-50 flex gap-2">
          <button
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 inline-flex items-center gap-1 text-gray-600"
            title="חזור לברירת מחדל"
          >
            <RotateCcw size={14} /> איפוס
          </button>
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex-1 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            <Save size={14} /> שמור
          </button>
        </div>
      </div>
    </div>
  );
}
