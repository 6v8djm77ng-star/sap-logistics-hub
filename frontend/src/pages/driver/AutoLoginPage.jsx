/**
 * Auto-login page for drivers — opens via /m/:code link.
 *
 * Use case: the office sends a driver a one-time link
 *   http://192.168.0.14:4000/m/DRV-01
 * Driver opens it once on phone → gets a 30-day session →
 * adds the page to home screen as a PWA → never has to log in again.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth.js';
import api from '../../services/api.js';
import { Loader2, CheckCircle, AlertCircle, Smartphone } from 'lucide-react';

export default function AutoLoginPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState('loading'); // loading / ok / error
  const [error, setError] = useState('');
  const [driver, setDriver] = useState(null);

  useEffect(() => {
    const run = async () => {
      try {
        const { data } = await api.post('/auth/driver-login', { code });
        setAuth({
          user: { id: data.driver.id, name: data.driver.name, role: 'DRIVER' },
          token: data.token,
        });
        setDriver(data.driver);
        setStatus('ok');
        // Auto-redirect after 1.5 seconds
        setTimeout(() => navigate('/driver', { replace: true }), 1500);
      } catch (err) {
        setError(err.response?.data?.error || err.message || 'שגיאה לא ידועה');
        setStatus('error');
      }
    };
    if (code) run();
  }, [code, navigate, setAuth]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-600 to-brand-800 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center shadow-2xl">
        <div className="mb-4">
          <Smartphone size={48} className="mx-auto text-brand-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">SAP Logistics</h1>
        <p className="text-sm text-gray-500 mb-6">מערכת נהגים</p>

        {status === 'loading' && (
          <div className="space-y-3">
            <Loader2 size={32} className="animate-spin mx-auto text-brand-500" />
            <p className="text-gray-600">מתחבר אוטומטית כ-{code}…</p>
          </div>
        )}

        {status === 'ok' && (
          <div className="space-y-3">
            <CheckCircle size={48} className="mx-auto text-green-500" />
            <p className="text-lg font-bold text-green-700">
              שלום {driver?.name}!
            </p>
            <p className="text-sm text-gray-600">מעביר אותך למסך הנהג…</p>

            <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-right text-sm">
              <div className="font-bold text-blue-900 mb-2">💡 טיפ:</div>
              <p className="text-blue-800">
                לחץ על תפריט הדפדפן (⋮) ובחר{' '}
                <span className="font-semibold">"הוסף למסך הבית"</span>{' '}
                או <span className="font-semibold">"Install"</span> כדי להפוך את האתר לאפליקציה.
              </p>
              <p className="text-blue-700 text-xs mt-2">
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
              קוד נהג: <span className="font-mono font-bold">{code}</span>
            </p>
            <button
              onClick={() => navigate('/driver/login')}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
            >
              חזור לכניסה ידנית
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
