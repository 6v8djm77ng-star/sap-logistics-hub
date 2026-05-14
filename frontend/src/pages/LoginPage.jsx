import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { authApi } from '../services/api.js';
import { useAuthStore } from '../stores/auth.js';

export default function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await authApi.login(username, password);
      setAuth({ user: data.user, token: data.token });
      // Phase 4a — users flagged for password rotation bounce straight to
      // the force-change screen. AuthGuard would catch them on the next
      // route anyway, but this avoids a flash of the dashboard.
      if (data.user?.mustChangePassword) {
        toast.info('יש להחליף את הסיסמה כדי להמשיך');
        navigate('/force-change-password', { replace: true });
      } else {
        toast.success(`שלום ${data.user.name}`);
        navigate('/');
      }
    } catch (err) {
      toast.error('שם משתמש או סיסמה שגויים');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 to-brand-100 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">SAP Logistics Hub</h1>
          <p className="text-sm text-gray-500 mt-2">מערכת תכנון הפצה</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              שם משתמש
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              סיסמה
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'מתחבר...' : 'התחברות'}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-gray-200 text-center">
          <a href="/driver/login" className="text-sm text-brand-600 hover:underline">
            התחברות לנהג →
          </a>
        </div>
      </div>
    </div>
  );
}
