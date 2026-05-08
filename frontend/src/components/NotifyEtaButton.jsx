/**
 * One-click "Notify customer" button - generates WhatsApp + SMS deep links
 * with a personalized ETA + tracking URL message.
 */
import { useState } from 'react';
import api from '../services/api.js';
import { toast } from 'sonner';
import { MessageCircle, X, Copy, Check, Send, Loader2, Smartphone } from 'lucide-react';

export default function NotifyEtaButton({ stopId, branchName, compact = false }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchEta = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/notify/eta/${stopId}`);
      setData(data);
      setOpen(true);
    } catch (err) {
      toast.error('שגיאה בחישוב ETA');
    } finally {
      setLoading(false);
    }
  };

  const copyMessage = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.message);
      setCopied(true);
      toast.success('הודעה הועתקה!');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('לא הצלחנו להעתיק');
    }
  };

  return (
    <>
      <button
        onClick={fetchEta}
        disabled={loading}
        className={
          compact
            ? 'inline-flex items-center gap-1 px-2 py-1 bg-green-50 text-green-700 border border-green-200 rounded-lg text-xs hover:bg-green-100'
            : 'inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700 disabled:opacity-50'
        }
        title="שלח ללקוח עדכון ETA"
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <MessageCircle size={12} />}
        {compact ? '' : 'עדכן לקוח'}
      </button>

      {open && data && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-t-2xl md:rounded-2xl max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="font-bold text-lg flex items-center gap-2">
                <MessageCircle className="text-green-600" /> עדכון ללקוח
              </h2>
              <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X size={18} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {branchName && (
                <div className="text-sm text-gray-600">
                  לקוח: <span className="font-medium">{branchName}</span>
                </div>
              )}

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                <div className="font-bold text-blue-900 mb-1">ETA: {data.eta.label}</div>
                {data.eta.estimatedAt && (
                  <div className="text-xs text-blue-700">
                    הערכה: {new Date(data.eta.estimatedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">ההודעה שתישלח:</div>
                <pre className="bg-gray-50 border border-gray-200 rounded p-2 text-sm whitespace-pre-wrap font-sans">
                  {data.message}
                </pre>
              </div>

              {data.whatsappUrl ? (
                <a
                  href={data.whatsappUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full inline-flex items-center justify-center gap-2 py-3 bg-green-600 text-white rounded-lg font-bold hover:bg-green-700"
                  onClick={() => setOpen(false)}
                >
                  <Send size={16} /> שלח ב-WhatsApp ({data.phone})
                </a>
              ) : (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                  ⚠️ לא נמצא טלפון בלקוח - לא ניתן לשלוח אוטומטית
                </div>
              )}

              {data.smsUrl && (
                <a
                  href={data.smsUrl}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
                  onClick={() => setOpen(false)}
                >
                  <Smartphone size={14} /> שלח ב-SMS
                </a>
              )}

              <button
                onClick={copyMessage}
                className="w-full inline-flex items-center justify-center gap-2 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                העתק הודעה
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
