/**
 * Resolves a short id (e.g. /m/admin/AB12CD34) into the full token,
 * then logs the user in and redirects.
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.js';
import api from '../services/api.js';
import { Loader2, CheckCircle, AlertCircle, Smartphone } from 'lucide-react';

export default function MobileShortLinkPage() {
  const { shortId } = useParams();
  const navigate = useNavigate();
  const { setAuth } = useAuthStore();
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);

  useEffect(() => {
    if (!shortId) return;
    const run = async () => {
      try {
        const { data } = await api.get(`/auth/mobile-link/${shortId}`);
        const token = data.token;
        const parts = token.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        setAuth({
          user: { id: payload.sub, name: payload.name, role: payload.role, username: payload.username },
          token,
        });
        setUser({ name: payload.name, role: payload.role });
        setStatus('ok');
        setTimeout(() => navigate('/', { replace: true }), 1500);
      } catch (err) {
        setError(err.response?.data?.error || 'הקישור לא תקין או פג תוקף');
        setStatus('error');
      }
    };
    run();
  }, [shortId, navigate, setAuth]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-700 via-brand-600 to-purple-700 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl p-8 max-w-md w-full text-center shadow-2xl">
        <Smartphone size={48} className="mx-auto text-brand-600 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-1">SAP Logistics Hub</h1>
        <p className="text-sm text-gray-500 mb-6">התחברות במובייל</p>

        {status === 'loading' && (
          <div className="space-y-3">
            <Loader2 size={32} className="animate-spin mx-auto text-brand-500" />
            <p className="text-gray-600">מתחבר…</p>
          </div>
        )}

        {status === 'ok' && (
          <div className="space-y-3">
            <CheckCircle size={48} className="mx-auto text-green-500" />
            <p className="text-lg font-bold text-green-700">שלום {user?.name}!</p>
            <p className="text-sm text-gray-600">מעביר אותך למערכת…</p>
            <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-right text-sm">
              <div className="font-bold text-blue-900 mb-2">💡 הוסף למסך הבית:</div>
              <p className="text-blue-800">
                תפריט הדפדפן (⋮) → <span className="font-semibold">"הוסף למסך הבית"</span>
              </p>
              <p className="text-blue-700 text-xs mt-2">חיבור נשמר 30 ימים.</p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <AlertCircle size={48} className="mx-auto text-red-500" />
            <p className="text-lg font-bold text-red-700">שגיאה</p>
            <p className="text-sm text-gray-600">{error}</p>
            <p className="text-xs text-gray-500">
              צור קישור חדש מהדפדפן במחשב.
            </p>
            <button
              onClick={() => navigate('/login')}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700"
            >
              חזור לכניסה
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
