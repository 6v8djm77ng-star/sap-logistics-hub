/**
 * Forgot-password page — public, rate-limited via the backend.
 *
 * The form always shows the same success message, never indicating
 * whether the email was actually in the system (anti-enumeration). The
 * backend logs the lookup attempt either way.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, ArrowRight } from 'lucide-react';
import api from '../services/api.js';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  const forgotMutation = useMutation({
    mutationFn: () => api.post('/auth/forgot-password', { email }).then((r) => r.data),
    onSuccess: () => {
      setSent(true);
      toast.success('אם הכתובת קיימת במערכת, נשלח אליה קישור איפוס');
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'שגיאה — נסה/י שוב בעוד דקה');
    },
  });

  return (
    <div dir="rtl" className="min-h-screen bg-gradient-to-br from-brand-50 to-brand-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">איפוס סיסמה</h1>
        <p className="text-sm text-gray-500 mb-6">
          הזן/י את כתובת המייל שלך. אם היא רשומה במערכת, נשלח קישור איפוס תקף ל-30 דקות.
        </p>

        {sent ? (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-300 rounded-lg p-4">
              <div className="font-bold text-green-900">הבקשה נשלחה</div>
              <div className="text-sm text-green-800 mt-1">
                אם הכתובת קיימת במערכת, יישלח אליה קישור איפוס תוך כמה רגעים.
                בדוק/י את תיבת הדואר (כולל ספאם). הקישור תקף ל-30 דקות וניתן לשימוש פעם אחת.
              </div>
            </div>
            <Link
              to="/login"
              className="block w-full text-center py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700"
            >
              חזור לכניסה
            </Link>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); forgotMutation.mutate(); }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">כתובת מייל</label>
              <div className="relative">
                <Mail size={18} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full pr-10 pl-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500"
                  required autoFocus
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={!email || forgotMutation.isPending}
              className="w-full py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {forgotMutation.isPending ? 'שולח...' : 'שלח קישור איפוס'}
            </button>
            <Link to="/login" className="block text-center text-sm text-gray-600 hover:text-brand-600">
              <ArrowRight size={14} className="inline ml-1" /> חזור לכניסה
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
