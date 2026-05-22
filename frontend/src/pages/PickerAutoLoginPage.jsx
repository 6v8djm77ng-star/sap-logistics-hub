/**
 * Auto-login page for warehouse pickers - opens via /pick/:code link.
 *
 * URL example:  http://192.168.0.14:4000/pick/PICK-01
 * Picker scans/clicks once on a handheld terminal → 30-day session →
 * adds to home screen → handheld becomes a dedicated picking device.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.js';
import api from '../services/api.js';
import { Loader2, CheckCircle, AlertCircle, Warehouse } from 'lucide-react';

export default function PickerAutoLoginPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(null);

  useEffect(() => {
    const run = async () => {
      try {
        const { data } = await api.post('/auth/picker-login', { code });
        setAuth({
          user: { id: data.picker.id, name: data.picker.name, role: 'WAREHOUSE' },
          token: data.token,
        });
        setPicker(data.picker);
        // Picker Task Inbox (2026-05-22): pre-seed the picker selector on
        // /picker/tasks so the handheld lands on this picker's own queue
        // without the operator picking themself from a dropdown. Uses the
        // same key PickerTasksPage reads on mount; the page also prunes
        // the value if the picker is no longer active, so this is safe.
        if (data.picker?.id != null) {
          try {
            localStorage.setItem('picker.tasks.selectedPickerId.v1', String(data.picker.id));
          } catch {}
        }
        setStatus('ok');
        // Redirect to the per-picker inbox instead of the manager-wide
        // /warehouse dashboard. The inbox keeps the picker focused on
        // exactly the waves assigned to them via SendToPickingModal.
        setTimeout(() => navigate('/picker/tasks', { replace: true }), 1500);
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'שגיאה לא ידועה');
        setStatus('error');
      }
    };
    if (code) run();
  }, [code, navigate, setAuth]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center shadow-2xl">
        <div className="mb-4">
          <Warehouse size={48} className="mx-auto text-amber-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">SAP Logistics</h1>
        <p className="text-sm text-gray-500 mb-6">מערכת ליקוט מחסן</p>

        {status === 'loading' && (
          <div className="space-y-3">
            <Loader2 size={32} className="animate-spin mx-auto text-amber-500" />
            <p className="text-gray-600">מתחבר אוטומטית כ-{code}…</p>
          </div>
        )}

        {status === 'ok' && (
          <div className="space-y-3">
            <CheckCircle size={48} className="mx-auto text-green-500" />
            <p className="text-lg font-bold text-green-700">
              שלום {picker?.name}!
            </p>
            <p className="text-sm text-gray-600">מעביר אותך למסך הליקוט…</p>

            <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 text-right text-sm">
              <div className="font-bold text-amber-900 mb-2">💡 התקנה במסופון:</div>
              <p className="text-amber-800">
                לחץ על תפריט הדפדפן (⋮) ובחר{' '}
                <span className="font-semibold">"הוסף למסך הבית"</span>{' '}
                או <span className="font-semibold">"Install"</span>.
              </p>
              <p className="text-amber-700 text-xs mt-2">
                ההתחברות תישמר ל-30 ימים - לא תצטרך להזין סיסמה.
              </p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <AlertCircle size={48} className="mx-auto text-red-500" />
            <p className="text-lg font-bold text-red-700">שגיאת חיבור</p>
            <p className="text-sm text-gray-600">{error}</p>
            <p className="text-xs text-gray-500 mt-3">
              קוד מלקט: <span className="font-mono font-bold">{code}</span>
            </p>
            <p className="text-xs text-gray-500">
              צריך להוסיף את המלקט במסך "מלקטים" קודם.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
