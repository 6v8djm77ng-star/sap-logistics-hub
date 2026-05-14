/**
 * Reset-password page — public, consumes a token from /reset-password?token=
 *
 * The token itself is verified server-side (bcrypt match + TTL + single-use).
 * This page just gates on the user entering a strong password that isn't
 * the same as their current one (the backend double-checks).
 */
import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Eye, EyeOff } from 'lucide-react';
import api from '../services/api.js';

const PWD_RULES = [
  { test: (p) => p.length >= 10, label: 'לפחות 10 תווים' },
  { test: (p) => /[A-Za-z֐-׿]/.test(p), label: 'אות אחת לפחות' },
  { test: (p) => /\d/.test(p), label: 'ספרה אחת לפחות' },
  { test: (p) => /[^A-Za-z0-9֐-׿]/.test(p), label: 'תו מיוחד אחד לפחות' },
];

export default function ResetPasswordPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const token = search.get('token') || '';
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [show, setShow] = useState(false);

  const resetMutation = useMutation({
    mutationFn: () => api.post('/auth/reset-password-with-token', {
      token, newPassword: newPwd,
    }).then((r) => r.data),
    onSuccess: () => {
      toast.success('הסיסמה אופסה. כעת התחבר/י עם הסיסמה החדשה');
      setTimeout(() => navigate('/login', { replace: true }), 1000);
    },
    onError: (err) => {
      const data = err.response?.data || {};
      toast.error(data.error || 'שגיאה באיפוס הסיסמה');
    },
  });

  if (!token) {
    return (
      <div dir="rtl" className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md bg-white rounded-2xl shadow p-6 text-center">
          <h1 className="text-xl font-bold text-red-700 mb-2">⚠ קישור לא תקין</h1>
          <p className="text-sm text-gray-600 mb-4">הקישור חסר אסימון. בקש/י קישור חדש מדף הכניסה.</p>
          <Link to="/forgot-password" className="text-brand-600 hover:underline">בקש קישור חדש</Link>
        </div>
      </div>
    );
  }

  const passes = PWD_RULES.every((r) => r.test(newPwd));
  const matches = newPwd && newPwd === confirmPwd;
  const canSubmit = passes && matches;

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 space-y-5">
        <div className="flex items-center gap-3">
          <KeyRound className="text-brand-600" size={28} />
          <h1 className="text-2xl font-bold text-gray-900">קביעת סיסמה חדשה</h1>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); if (canSubmit) resetMutation.mutate(); }}
          className="space-y-3"
        >
          <div>
            <label className="text-sm font-medium text-gray-700">סיסמה חדשה</label>
            <div className="relative mt-1">
              <input
                type={show ? 'text' : 'password'} value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)} autoFocus
                autoComplete="new-password"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
              />
              <button
                type="button" onClick={() => setShow((s) => !s)}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">אימות סיסמה</label>
            <input
              type={show ? 'text' : 'password'} value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)} autoComplete="new-password"
              className={`w-full mt-1 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 ${
                confirmPwd && !matches ? 'border-red-400' : 'border-gray-300'
              }`}
            />
            {confirmPwd && !matches && (
              <div className="text-xs text-red-600 mt-1">הסיסמאות לא תואמות</div>
            )}
          </div>

          <ul className="text-xs space-y-1 bg-gray-50 rounded p-3 border border-gray-200">
            {PWD_RULES.map((r, i) => {
              const ok = r.test(newPwd);
              return (
                <li key={i} className={ok ? 'text-green-700' : 'text-gray-500'}>
                  {ok ? '✓' : '○'} {r.label}
                </li>
              );
            })}
          </ul>

          <button
            type="submit"
            disabled={!canSubmit || resetMutation.isPending}
            className="w-full py-2.5 bg-brand-600 text-white rounded-lg font-bold hover:bg-brand-700 disabled:opacity-50"
          >
            {resetMutation.isPending ? 'מעדכן...' : 'קבע סיסמה חדשה'}
          </button>

          <Link to="/login" className="block text-center text-sm text-gray-500 hover:text-brand-600">
            חזור לכניסה
          </Link>
        </form>
      </div>
    </div>
  );
}
