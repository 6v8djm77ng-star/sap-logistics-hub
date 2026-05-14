/**
 * Complete-profile gate — blocks dashboard access until the user fills
 * FullName + Email + Phone. Role stays admin-controlled so it's not
 * editable here.
 *
 * Reached via the AuthGuard in App.jsx whenever profileCompleted=false.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { UserCircle, ShieldAlert } from 'lucide-react';
import api from '../services/api.js';
import { useAuthStore } from '../stores/auth.js';

export default function CompleteProfilePage() {
  const navigate = useNavigate();
  const { user, setAuth, logout } = useAuthStore();
  const [fullName, setFullName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [phone, setPhone] = useState(user?.phone || '');

  const updateMutation = useMutation({
    mutationFn: () => api.patch('/users/me/profile', { fullName, email, phone }).then((r) => r.data),
    onSuccess: (data) => {
      toast.success('הפרטים נשמרו');
      setAuth({ user: { ...user, ...data.user }, token: localStorage.getItem('token') });
      navigate('/', { replace: true });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בשמירה'),
  });

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const phoneValid = /^[0-9+\-\s()]{7,20}$/.test(phone);
  const nameValid = fullName.trim().length >= 2;
  const canSubmit = emailValid && phoneValid && nameValid;

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-blue-300 p-6 space-y-5">
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-300 rounded-lg p-3">
          <ShieldAlert className="text-blue-600 shrink-0 mt-0.5" size={22} />
          <div>
            <div className="font-bold text-blue-900">השלמת פרטי משתמש</div>
            <div className="text-sm text-blue-800 mt-1">
              לפני הכניסה למערכת יש למלא פרטים חיוניים. הם משמשים, בין השאר, לשחזור סיסמה.
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 text-gray-700">
          <UserCircle size={20} />
          <span className="font-medium">{user?.username}</span>
          {user?.role && <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{user.role}</span>}
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700">שם מלא <span className="text-red-500">*</span></label>
            <input
              type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
              className={`w-full mt-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 ${
                fullName && !nameValid ? 'border-red-400' : 'border-gray-300'
              }`}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">מייל <span className="text-red-500">*</span></label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className={`w-full mt-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 ${
                email && !emailValid ? 'border-red-400' : 'border-gray-300'
              }`}
            />
            {email && !emailValid && <div className="text-xs text-red-600 mt-1">פורמט מייל לא תקין</div>}
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">טלפון נייד <span className="text-red-500">*</span></label>
            <input
              type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel" placeholder="05X-XXXXXXX"
              className={`w-full mt-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 ${
                phone && !phoneValid ? 'border-red-400' : 'border-gray-300'
              }`}
            />
          </div>
        </div>

        <button
          onClick={() => updateMutation.mutate()}
          disabled={!canSubmit || updateMutation.isPending}
          className="w-full px-4 py-2.5 bg-brand-600 text-white rounded-lg font-bold hover:bg-brand-700 disabled:opacity-50"
        >
          {updateMutation.isPending ? 'שומר...' : 'שמור והמשך'}
        </button>

        <button
          onClick={() => { logout(); navigate('/login', { replace: true }); }}
          className="w-full text-sm text-gray-500 hover:text-gray-700"
        >
          התנתק/י וחזור/י לדף הכניסה
        </button>
      </div>
    </div>
  );
}
