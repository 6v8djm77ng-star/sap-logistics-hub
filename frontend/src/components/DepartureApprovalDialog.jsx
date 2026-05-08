/**
 * Manager pre-departure checklist + approval.
 *
 * After picking + QC, the manager reviews 5 items, signs off, and only then
 * the driver app shows the route as "ready to start".
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { X, Check, AlertTriangle, ShieldCheck } from 'lucide-react';

const CHECKLIST_ITEMS = [
  { key: 'pickingComplete', label: 'הליקוט הסתיים ועבר QC', auto: true },
  { key: 'truckLoaded',     label: 'המשאית נטענה לפי תוכנית LIFO',  auto: false },
  { key: 'documentsPrinted', label: 'ריכוז העמסה / חלוקה הודפסו',     auto: false },
  { key: 'fuelOk',          label: 'דלק במשאית מספיק למסלול',         auto: false },
  { key: 'driverPresent',   label: 'הנהג נוכח ומוכן לצאת',            auto: false },
];

export default function DepartureApprovalDialog({ runId, runNumber, onClose }) {
  const queryClient = useQueryClient();
  const [checklist, setChecklist] = useState(() =>
    Object.fromEntries(CHECKLIST_ITEMS.map((c) => [c.key, c.auto]))
  );
  const [notes, setNotes] = useState('');

  const allChecked = CHECKLIST_ITEMS.every((c) => checklist[c.key]);

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/runs/${runId}/approve-departure`, {
      notes: notes || null,
      checklist,
    }).then((r) => r.data),
    onSuccess: () => {
      toast.success('אישור היציאה נרשם - הנהג יכול לצאת');
      queryClient.invalidateQueries({ queryKey: ['run'] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b bg-gradient-to-l from-green-50 to-blue-50">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <ShieldCheck className="text-green-600" size={22} />
            אישור יציאה למסלול
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-white/50 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          <div className="text-sm text-gray-500 mb-3">
            מסלול: <span className="font-mono font-semibold">{runNumber}</span>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm flex gap-2">
            <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
            <span className="text-amber-900">
              סמן כל פריט אחרי שאישרת אותו פיזית. אישור היציאה הוא <strong>הגייט האחרון</strong> לפני שהנהג יוצא.
            </span>
          </div>

          <div className="space-y-2 mb-4">
            {CHECKLIST_ITEMS.map((item) => (
              <label
                key={item.key}
                className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                  checklist[item.key]
                    ? 'border-green-300 bg-green-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={!!checklist[item.key]}
                  onChange={(e) => setChecklist((c) => ({ ...c, [item.key]: e.target.checked }))}
                  className="mt-0.5 w-5 h-5"
                />
                <div className="flex-1">
                  <div className={`font-medium ${checklist[item.key] ? 'text-green-900' : 'text-gray-700'}`}>
                    {item.label}
                  </div>
                  {item.auto && (
                    <div className="text-[10px] text-green-600 mt-0.5">✓ אומת אוטומטית</div>
                  )}
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">הערות (לא חובה)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="לדוגמה: 5 ארגזי קרח כי חם היום"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => approveMutation.mutate()}
            disabled={!allChecked || approveMutation.isPending}
            className="flex-1 py-2 bg-green-600 text-white rounded-lg font-bold disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
          >
            <Check size={16} />
            {approveMutation.isPending ? 'מאשר...' : allChecked ? 'אשר יציאה' : `סמן הכל (${Object.values(checklist).filter(Boolean).length}/${CHECKLIST_ITEMS.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
