/**
 * Mobile install link dialog - generates a short URL + QR for the
 * currently logged-in user. Opens via the "מובייל" button in the header.
 */
import { useEffect, useState } from 'react';
import api from '../services/api.js';
import { toast } from 'sonner';
import { X, Smartphone, Copy, Check, Loader2, RefreshCw } from 'lucide-react';

export default function MobileLinkDialog({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/auth/mobile-link');
      setData(data);
    } catch (err) {
      setError(err.response?.data?.error || 'שגיאה ביצירת קישור');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    generate();
  }, []);

  const copy = async () => {
    if (!data?.shortUrl) return;
    try {
      await navigator.clipboard.writeText(data.shortUrl);
      setCopied(true);
      toast.success('הקישור הועתק!');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('לא הצלחנו להעתיק');
    }
  };

  const sendWhatsapp = () => {
    if (!data?.shortUrl) return;
    const text = encodeURIComponent(
      `קישור התקנה למובייל - SAP Logistics:\n${data.shortUrl}\n\n(תקף 30 ימים, חייב להיות באותה רשת)`
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  return (
    // Backdrop scrolls on tiny viewports (laptop with devtools open, mobile
    // landscape, browser zoom > 125%) so the dialog is reachable even when
    // it's taller than the viewport.
    <div
      className="fixed inset-0 z-50 bg-black/50 overflow-y-auto p-4"
      onClick={onClose}
    >
      {/* min-h-full + flex centering keeps the dialog vertically centered
          when content fits, and lets it stack from top with margin when it
          doesn't — no more clipped QR codes / headers. */}
      <div className="min-h-full flex items-center justify-center">
        <div
          className="bg-white rounded-2xl max-w-md w-full max-h-[calc(100vh-2rem)] shadow-2xl flex flex-col my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b shrink-0">
            <h2 className="font-bold text-lg flex items-center gap-2">
              <Smartphone className="text-purple-600" />
              קישור התקנה במובייל
            </h2>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X size={18} />
            </button>
          </div>

          <div className="p-5 overflow-y-auto">
          {loading ? (
            <div className="text-center py-12">
              <Loader2 size={32} className="animate-spin mx-auto text-purple-500" />
              <p className="text-gray-600 mt-3 text-sm">יוצר קישור…</p>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-red-600 mb-4">{error}</p>
              <button
                onClick={generate}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700"
              >
                <RefreshCw size={14} /> נסה שוב
              </button>
            </div>
          ) : data ? (
            <>
              {/* QR */}
              <div className="text-center mb-4">
                <p className="text-sm text-gray-600 mb-2">סרוק עם מצלמת הטלפון:</p>
                <div className="inline-block p-3 bg-white border-2 border-purple-200 rounded-xl">
                  <img src={data.qr} alt="QR" className="w-48 h-48" />
                </div>
              </div>

              {/* Short URL */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                <div className="text-[11px] text-gray-500 mb-1">או העתק את הקישור:</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={data.shortUrl}
                    className="flex-1 px-2 py-2 bg-white border border-gray-200 rounded font-mono text-xs text-gray-700"
                    onClick={(e) => e.target.select()}
                  />
                  <button
                    onClick={copy}
                    className="px-3 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700"
                    title="העתק"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              </div>

              <button
                onClick={sendWhatsapp}
                className="w-full mt-3 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.521.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.095 3.2 5.076 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                שלח לי בוואטסאפ
              </button>

              <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 space-y-1">
                <div><strong>👤 משתמש:</strong> {data.user.name}</div>
                <div><strong>⏱ תוקף:</strong> {data.expiresIn}</div>
                <div className="text-blue-700 mt-2">
                  💡 בטלפון: לחץ על הקישור פעם אחת → תפריט הדפדפן → "הוסף למסך הבית"
                </div>
              </div>

              <button
                onClick={generate}
                className="w-full mt-2 text-xs text-gray-500 hover:text-gray-700"
              >
                <RefreshCw size={11} className="inline ml-1" />
                צור קישור חדש
              </button>
            </>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
