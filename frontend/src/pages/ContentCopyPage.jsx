/**
 * Content & Copy Agent — UI page.
 *
 * Wraps POST /api/agents/content-copy/run. Auth + ADMIN role enforced server-side.
 * The form mirrors the input schema in backend/src/agents/contentCopy/schema.js.
 */
import { useState } from 'react';
import { Sparkles, Copy, Check, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { contentCopyApi } from '../services/api.js';

const BRANDS = [
  'DAVO', 'NOVO', 'Tineco', 'Hurom', 'Ritter',
  'Blendtec', 'Ankarsrum', 'Ascaso', 'OIG', 'Unico',
];

const CONTENT_TYPES = [
  { v: 'facebook_post', l: 'פוסט פייסבוק' },
  { v: 'linkedin_post', l: 'פוסט לינקדאין' },
  { v: 'google_ad', l: 'מודעת גוגל' },
  { v: 'sms', l: 'SMS' },
  { v: 'whatsapp_message', l: 'הודעת ווטסאפ' },
  { v: 'newsletter', l: 'ניוזלטר' },
  { v: 'radio_script', l: 'תסריט רדיו' },
  { v: 'video_script', l: 'תסריט וידאו' },
  { v: 'retail_copy', l: 'קופי לחנויות / רשתות' },
  { v: 'customer_reply', l: 'מענה ללקוח' },
  { v: 'supplier_email', l: 'מייל לספק' },
  { v: 'press_release', l: 'הודעה לעיתונות' },
];

const LANGUAGES = [
  { v: 'hebrew', l: 'עברית' },
  { v: 'english', l: 'אנגלית' },
];

const GOALS = [
  { v: 'awareness', l: 'מודעות' },
  { v: 'sales', l: 'מכירות' },
  { v: 'launch', l: 'השקה' },
  { v: 'retention', l: 'שימור לקוחות' },
  { v: 'retail_support', l: 'תמיכה לרשתות' },
  { v: 'service', l: 'שירות לקוחות' },
  { v: 'supplier_response', l: 'תגובה לספק' },
  { v: 'pr', l: 'יחסי ציבור' },
];

const TONES = [
  { v: 'premium', l: 'פרימיום' },
  { v: 'direct', l: 'ישיר' },
  { v: 'emotional', l: 'רגשי' },
  { v: 'professional', l: 'מקצועי' },
  { v: 'authoritative', l: 'סמכותי' },
  { v: 'diplomatic', l: 'דיפלומטי' },
  { v: 'aggressive_but_polite', l: 'תקיף אך מנומס' },
];

function linesToArray(text) {
  return (text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      toast.success('הועתק');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('העתקה נכשלה');
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs flex items-center gap-1 px-2 py-1 rounded border border-gray-300 hover:bg-gray-100"
      aria-label="העתק"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'הועתק' : 'העתק'}
    </button>
  );
}

function ResultSection({ title, items, ordered = false, isParagraph = false }) {
  if (!items || (Array.isArray(items) && items.length === 0)) return null;
  const arr = Array.isArray(items) ? items : [items];
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-gray-900 text-sm">{title}</h3>
        {arr.length === 1 && <CopyButton text={arr[0]} />}
      </div>
      {ordered ? (
        <ol className="space-y-2 list-decimal pr-5">
          {arr.map((it, i) => (
            <li key={i} className="text-sm text-gray-800 leading-relaxed">
              <div className="flex items-start gap-2">
                <span className="flex-1 whitespace-pre-wrap">{it}</span>
                <CopyButton text={it} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className={isParagraph ? 'text-gray-900 whitespace-pre-wrap leading-relaxed' : 'space-y-2'}>
          {isParagraph ? arr[0] : arr.map((it, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-gray-800">
              <span className="flex-1 whitespace-pre-wrap">• {it}</span>
              <CopyButton text={it} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ContentCopyPage() {
  const [form, setForm] = useState({
    brand: 'DAVO',
    product: '',
    content_type: 'facebook_post',
    language: 'hebrew',
    target_audience: '',
    goal: 'awareness',
    tone: 'premium',
    key_points: '',
    constraints: '',
    source_text: '',
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [durationMs, setDurationMs] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setDurationMs(null);

    if (!form.target_audience.trim()) {
      toast.error('נא למלא קהל יעד');
      return;
    }

    const payload = {
      brand: form.brand,
      content_type: form.content_type,
      language: form.language,
      target_audience: form.target_audience.trim(),
      goal: form.goal,
      tone: form.tone,
      key_points: linesToArray(form.key_points),
      constraints: linesToArray(form.constraints),
    };
    if (form.product.trim()) payload.product = form.product.trim();
    if (form.source_text.trim()) payload.source_text = form.source_text.trim();

    setLoading(true);
    const t0 = Date.now();
    try {
      const data = await contentCopyApi.run(payload);
      setResult(data);
      setDurationMs(Date.now() - t0);
    } catch (err) {
      const code = err?.response?.data?.error || err.message || 'unknown';
      const detail = err?.response?.data?.details
        ? ' — ' + JSON.stringify(err.response.data.details).slice(0, 200)
        : '';
      setError(code + detail);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto" dir="rtl">
      <div className="flex items-center gap-2 mb-4">
        <Sparkles className="text-brand-600" size={22} />
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">יצירת תוכן שיווקי</h1>
      </div>
      <p className="text-sm text-gray-600 mb-6">
        סוכן AI למותגי OIG / Unico. תומך ב-{BRANDS.length} מותגים, {CONTENT_TYPES.length} סוגי תוכן, עברית ואנגלית.
      </p>

      <form onSubmit={onSubmit} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Form column */}
        <div className="lg:col-span-1 bg-white border border-gray-200 rounded-lg p-4 space-y-4 h-fit sticky top-16">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">מותג *</label>
            <select value={form.brand} onChange={set('brand')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              {BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">מוצר ספציפי (אופציונלי)</label>
            <input value={form.product} onChange={set('product')} type="text" placeholder='לדוגמה: DAVO DSM 5740' className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <p className="text-xs text-gray-500 mt-1">השאר ריק לקופי כללי על המותג</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">סוג תוכן *</label>
              <select value={form.content_type} onChange={set('content_type')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                {CONTENT_TYPES.map((c) => <option key={c.v} value={c.v}>{c.l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">שפה *</label>
              <select value={form.language} onChange={set('language')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                {LANGUAGES.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">מטרה *</label>
              <select value={form.goal} onChange={set('goal')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                {GOALS.map((g) => <option key={g.v} value={g.v}>{g.l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">טון *</label>
              <select value={form.tone} onChange={set('tone')} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                {TONES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">קהל יעד *</label>
            <input value={form.target_audience} onChange={set('target_audience')} type="text" placeholder='לדוגמה: חובבי קולינריה ביתיים בגילאי 30-55' className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" required />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">נקודות מפתח (שורה לכל אחת)</label>
            <textarea value={form.key_points} onChange={set('key_points')} rows={4} placeholder={'יבואן רשמי\nשירות מקומי\nאחריות יצרן'} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">אילוצים (שורה לכל אחד)</label>
            <textarea value={form.constraints} onChange={set('constraints')} rows={3} placeholder={'בלי מחירים\nבלי הבטחות אחריות'} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">טקסט מקור (אופציונלי)</label>
            <textarea value={form.source_text} onChange={set('source_text')} rows={3} placeholder="טקסט קיים שצריך לשכתב / ליישר" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-gray-400 text-white font-medium px-4 py-2.5 rounded-lg flex items-center justify-center gap-2"
          >
            {loading ? <><Loader2 className="animate-spin" size={18} />יוצר... (עד 40 שניות)</> : <><Sparkles size={18} />צור תוכן</>}
          </button>
        </div>

        {/* Result column */}
        <div className="lg:col-span-2 space-y-4">
          {!result && !error && !loading && (
            <div className="border border-dashed border-gray-300 rounded-lg p-8 text-center text-gray-500 bg-white">
              <Sparkles className="mx-auto mb-2 text-gray-400" size={32} />
              <p className="text-sm">מלא את הטופס ולחץ "צור תוכן" — התוצאה תופיע כאן</p>
            </div>
          )}

          {loading && (
            <div className="border border-gray-200 rounded-lg p-8 text-center bg-white">
              <Loader2 className="animate-spin mx-auto mb-3 text-brand-600" size={32} />
              <p className="text-sm text-gray-700">מייצר קופי באיכות גבוהה...</p>
              <p className="text-xs text-gray-500 mt-1">לוקח 20-40 שניות בדרך כלל</p>
            </div>
          )}

          {error && (
            <div className="border border-red-200 bg-red-50 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={20} />
              <div className="flex-1">
                <h3 className="font-semibold text-red-900 text-sm">שגיאה</h3>
                <p className="text-sm text-red-800 mt-1 break-all">{error}</p>
              </div>
            </div>
          )}

          {result && (
            <>
              {durationMs != null && (
                <div className="text-xs text-gray-500 text-left">
                  הופק ב-{(durationMs / 1000).toFixed(1)} שניות
                </div>
              )}
              <ResultSection title="📝 הקופי הראשי" items={result.main_copy} isParagraph />
              <ResultSection title="🔄 גרסאות חלופיות" items={result.alternative_versions} ordered />
              <ResultSection title="🏷️ אפשרויות כותרת" items={result.headline_options} ordered />
              <ResultSection title="🎯 קריאות לפעולה (CTA)" items={result.cta_options} ordered />
              {result.cialdini_principles_used?.length > 0 && (
                <div className="border border-gray-200 rounded-lg p-4 bg-white">
                  <h3 className="font-semibold text-gray-900 text-sm mb-2">🧠 עקרונות Cialdini שיושמו</h3>
                  <div className="flex flex-wrap gap-2">
                    {result.cialdini_principles_used.map((p, i) => (
                      <span key={i} className="text-xs px-2 py-1 bg-brand-50 text-brand-700 rounded">{p}</span>
                    ))}
                  </div>
                </div>
              )}
              {result.risk_notes?.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
                  <h3 className="font-semibold text-amber-900 text-sm mb-2">⚠️ נקודות לבדיקה</h3>
                  <ul className="space-y-1 text-sm text-amber-900 list-disc pr-5">
                    {result.risk_notes.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              )}
              {result.missing_information?.length > 0 && (
                <div className="border border-blue-200 bg-blue-50 rounded-lg p-4">
                  <h3 className="font-semibold text-blue-900 text-sm mb-2">❓ מידע חסר שיכול לשפר את התוצאה</h3>
                  <ul className="space-y-1 text-sm text-blue-900 list-disc pr-5">
                    {result.missing_information.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
