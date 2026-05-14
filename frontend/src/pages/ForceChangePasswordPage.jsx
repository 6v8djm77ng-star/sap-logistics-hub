/**
 * Force-change-password screen.
 *
 * Gate: rendered only when the logged-in user has mustChangePassword=true.
 * Reaches here via the AuthGuard in App.jsx. Once the password is rotated
 * the server clears the flag and revokes the temp-password token, so we
 * log the user out and bounce them back to /login to start a fresh session.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldAlert, Eye, EyeOff } from 'lucide-react';
import api from '../services/api.js';
import { useAuthStore } from '../stores/auth.js';

const PWD_RULES = [
  { test: (p) => p.length >= 10, label: 'לפחות 10 תווים' },
  { test: (p) => /[A-Za-z֐-׿]/.test(p), label: 'אות אחת לפחות' },
  { test: (p) => /\d/.test(p), label: 'ספרה אחת לפחות' },
  { test: (p) => /[^A-Za-z0-9֐-׿]/.test(p), label: 'תו מיוחד אחד לפחות (!@#$ וכו׳)' },
];

export default function ForceChangePasswordPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const changePwdMutation = useMutation({
    mutationFn: () => api.post('/users/me/change-password', {
      oldPassword: oldPwd, newPassword: newPwd,
    }).then((r) => r.data),
    onSuccess: () => {
      toast.success('הסיסמה הוחלפה. התחבר/י מחדש עם הסיסמה החדשה', { duration: 5000 });
      logout();
      setTimeout(() => navigate('/login', { replace: true }), 800);
    },
    onError: (err) => {
      const data = err.response?.data || {};
      toast.error(data.error || 'שגיאה בהחלפת הסיסמה');
    },
  });

  const passesAllRules = PWD_RULES.every((r) => r.test(newPwd));
  const matches = newPwd && newPwd === confirmPwd;
  const sameAsOld = newPwd && newPwd === oldPwd;
  const canSubmit = oldPwd && passesAllRules && matches && !sameAsOld;

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-amber-300 p-6 space-y-5">
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-300 rounded-lg p-3">
          <ShieldAlert className="text-amber-600 shrink-0 mt-0.5" size={22} />
          <div>
            <div className="font-bold text-amber-900">החלפת סיסמה נדרשת</div>
            <div className="text-sm text-amber-800 mt-1">
              {user?.passwordResetReason === 'admin_reset'
                ? 'מנהל המערכת איפס לך את הסיסמה. בחר/י סיסמה חדשה כדי להמשיך.'
                : 'עליך לבחור סיסמה חדשה לפני שתוכל/י להמשיך.'}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700">סיסמה זמנית/נוכחית</label>
            <div className="relative mt-1">
              <input
                type={showOld ? 'text' : 'password'}
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowOld((s) => !s)}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showOld ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">סיסמה חדשה</label>
            <div className="relative mt-1">
              <input
                type={showNew ? 'text' : 'password'}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNew((s) => !s)}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showNew ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">אימות סיסמה חדשה</label>
            <input
              type={showNew ? 'text' : 'password'}
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              className={`w-full mt-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 ${
                confirmPwd && !matches ? 'border-red-400' : 'border-gray-300'
              }`}
              autoComplete="new-password"
            />
            {confirmPwd && !matches && (
              <div className="text-xs text-red-600 mt-1">הסיסמאות לא תואמות</div>
            )}
          </div>
        </div>

        <ul className="text-xs space-y-1 bg-gray-50 rounded p-3 border border-gray-200">
          {PWD_RULES.map((rule, i) => {
            const ok = rule.test(newPwd);
            return (
              <li key={i} className={ok ? 'text-green-700' : 'text-gray-500'}>
                {ok ? '✓' : '○'} {rule.label}
              </li>
            );
          })}
          {sameAsOld && (
            <li className="text-red-600">✗ הסיסמה החדשה זהה לסיסמה הזמנית — בחר/י סיסמה שונה</li>
          )}
        </ul>

        <button
          onClick={() => changePwdMutation.mutate()}
          disabled={!canSubmit || changePwdMutation.isPending}
          className="w-full px-4 py-2.5 bg-brand-600 text-white rounded-lg font-bold hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {changePwdMutation.isPending ? 'מעדכן...' : 'החלף סיסמה'}
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
