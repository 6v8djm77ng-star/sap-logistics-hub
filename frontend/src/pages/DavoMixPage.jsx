/**
 * DAVO Mix Dashboard — Q1 2026 60/40 rebalancing tracker.
 * Read-only view of product mix, attach rate, and category breakdown.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import {
  Target, TrendingUp, Package, Link2, Users, AlertCircle,
} from 'lucide-react';

const TARGET_NON_MIXER_SHARE = 0.60;
const TARGET_ATTACH_RATE = 0.22;

function formatNis(n, opts = {}) {
  const { compact = false } = opts;
  const v = Number(n || 0);
  if (compact && Math.abs(v) >= 1_000_000) return `₪${(v / 1_000_000).toFixed(1)}M`;
  if (compact && Math.abs(v) >= 1_000) return `₪${Math.round(v / 1_000)}k`;
  return v.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
}

function formatPct(n, digits = 1) {
  return `${(Number(n || 0) * 100).toFixed(digits)}%`;
}

function StatCard({ label, value, sub, accent = false, status }) {
  const accentClass = accent
    ? 'border-amber-300 bg-gradient-to-br from-amber-50 to-white'
    : 'border-gray-200 bg-white';
  const statusClass = status === 'good' ? 'text-emerald-600'
    : status === 'warn' ? 'text-amber-600'
    : status === 'bad' ? 'text-rose-600'
    : 'text-gray-900';
  return (
    <div className={`rounded-xl border p-5 ${accentClass}`}>
      <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-2">{label}</div>
      <div className={`text-3xl font-bold tabular-nums ${statusClass}`} dir="ltr" style={{ textAlign: 'right' }}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-2">{sub}</div>}
    </div>
  );
}

function ProgressBar({ current, target, label, gold = false }) {
  const pct = Math.min(100, (current / target) * 100);
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{label}</span>
        <span className="tabular-nums" dir="ltr">
          {formatPct(current, 1)} / {formatPct(target, 0)}
        </span>
      </div>
      <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${gold ? 'bg-gradient-to-r from-amber-400 to-amber-600' : 'bg-gradient-to-r from-emerald-400 to-emerald-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function DavoMixPage() {
  const [days, setDays] = useState(90);

  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['davo-mix-summary', days],
    queryFn: () => api.get('/davo-mix/summary', { params: { days } }).then(r => r.data),
    staleTime: 5 * 60_000,
  });
  const { data: cats } = useQuery({
    queryKey: ['davo-mix-cats', days],
    queryFn: () => api.get('/davo-mix/categories', { params: { days } }).then(r => r.data),
    staleTime: 5 * 60_000,
  });
  const { data: attach } = useQuery({
    queryKey: ['davo-mix-attach', days],
    queryFn: () => api.get('/davo-mix/attach', { params: { days } }).then(r => r.data),
    staleTime: 5 * 60_000,
  });
  const { data: topAttach } = useQuery({
    queryKey: ['davo-mix-top-attach', days],
    queryFn: () => api.get('/davo-mix/attach/top-items', { params: { days, limit: 10 } }).then(r => r.data),
    staleTime: 5 * 60_000,
  });
  const { data: buyers } = useQuery({
    queryKey: ['davo-mix-buyers', days],
    queryFn: () => api.get('/davo-mix/buyers', { params: { days, limit: 10 } }).then(r => r.data),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2 text-gray-900">
            <Target className="text-amber-600" /> DAVO Mix Tracker
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            יוזמת רה-בלאנס תמהיל DAVO ל-60% מגוון / 40% מיקסרים — Q1 2026
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value={30}>30 ימים</option>
          <option value={60}>60 ימים</option>
          <option value={90}>90 ימים</option>
          <option value={180}>חצי שנה</option>
        </select>
      </div>

      {loadingSummary && <div className="text-center text-gray-500 py-12">טוען נתונים מ-SAP…</div>}

      {summary && (
        <>
          {/* Headline KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <StatCard
              label="מחזור DAVO (תקופה)"
              value={formatNis(summary.revenue.total, { compact: true })}
              sub={`${summary.units.mixer + summary.units.nonMixer} יח' · ${summary.skuCount.mixer + summary.skuCount.nonMixer} SKUs`}
              accent
            />
            <StatCard
              label="מיקסרים"
              value={formatPct(summary.mixerShare, 1)}
              sub={`${formatNis(summary.revenue.mixer, { compact: true })} · ${summary.units.mixer} יח'`}
              status={summary.mixerShare > 0.5 ? 'warn' : 'good'}
            />
            <StatCard
              label="בלי-מיקסר"
              value={formatPct(summary.nonMixerShare, 1)}
              sub={`${formatNis(summary.revenue.nonMixer, { compact: true })} · יעד: ${formatPct(TARGET_NON_MIXER_SHARE, 0)}`}
              status={summary.nonMixerShare >= TARGET_NON_MIXER_SHARE ? 'good' : 'bad'}
            />
            <StatCard
              label="non-mixer חודשי"
              value={formatNis(summary.monthly.nonMixer, { compact: true })}
              sub={summary.target.gapMultiplier
                ? `יעד ×${summary.target.gapMultiplier.toFixed(1)} = ${formatNis(summary.target.monthlyNonMixer, { compact: true })}/חודש`
                : '—'}
            />
          </div>

          {/* Mix progress */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <TrendingUp className="text-amber-600 w-4 h-4" /> התקדמות אל יעד 60/40
            </h2>
            <div className="space-y-3">
              <ProgressBar current={summary.nonMixerShare} target={TARGET_NON_MIXER_SHARE} label="חלק ה-non-mixer מתוך DAVO" gold />
              {attach && (
                <ProgressBar current={attach.attachRate} target={TARGET_ATTACH_RATE} label="Attach rate (יעד 22%)" />
              )}
            </div>
          </div>

          {/* Two columns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Category breakdown */}
            {cats && (
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Package className="text-gray-600 w-4 h-4" /> פילוח לפי קטגוריה
                </h2>
                <div className="space-y-2.5">
                  {cats.categories.map((c) => (
                    <div key={c.category} className="flex items-center gap-3 text-sm">
                      <div className="w-32 text-gray-700 truncate">{c.category}</div>
                      <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden relative">
                        <div
                          className={`h-full ${c.category === 'מיקסרים' ? 'bg-amber-500' : 'bg-emerald-400'}`}
                          style={{ width: `${(c.share * 100).toFixed(1)}%` }}
                        />
                      </div>
                      <div className="w-28 text-left tabular-nums text-gray-600 text-xs" dir="ltr">
                        {formatNis(c.revenue, { compact: true })} · {formatPct(c.share, 1)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Attach analysis */}
            {attach && (
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <h2 className="text-base font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Link2 className="text-gray-600 w-4 h-4" /> ניתוח Attach
                </h2>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="rounded-lg border border-gray-200 p-3">
                    <div className="text-xs text-gray-500">מיקסר בלבד</div>
                    <div className="text-lg font-bold text-gray-900 tabular-nums" dir="ltr">{formatNis(attach.aov.mixerOnly)}</div>
                    <div className="text-xs text-gray-500 mt-1">AOV · {attach.invoiceCount.mixerOnly} עסקאות</div>
                  </div>
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <div className="text-xs text-amber-700 font-medium">מיקסר + attach</div>
                    <div className="text-lg font-bold text-amber-900 tabular-nums" dir="ltr">{formatNis(attach.aov.mixerWithAttach)}</div>
                    <div className="text-xs text-amber-700 mt-1">AOV · {attach.invoiceCount.mixerWithAttach} עסקאות</div>
                  </div>
                </div>
                <div className="text-sm text-gray-700 leading-relaxed">
                  כל עסקת mixer+attach מוסיפה בממוצע{' '}
                  <strong className="text-amber-700 tabular-nums" dir="ltr">{formatNis(attach.aov.attachPortion)}</strong>{' '}
                  של פריטי DAVO נוספים.
                </div>
                {attach.attachRate < TARGET_ATTACH_RATE && (
                  <div className="mt-3 flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2.5">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>
                      Attach rate נוכחי {formatPct(attach.attachRate, 1)} — מתחת ליעד {formatPct(TARGET_ATTACH_RATE, 0)}.
                      פוטנציאל הגדלת ה-attach: ידית הצמיחה הראשית של non-mixer.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Top attach items + Top buyers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {topAttach && (
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="p-4 border-b border-gray-200">
                  <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                    <TrendingUp className="text-emerald-600 w-4 h-4" /> Top פריטים נצמדים
                  </h2>
                  <p className="text-xs text-gray-500 mt-1">פריטי non-mixer שנצמדים הכי הרבה לעסקאות מיקסר</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600 text-xs">
                    <tr>
                      <th className="text-right p-3 font-medium">פריט</th>
                      <th className="text-left p-3 font-medium" dir="ltr">attaches</th>
                      <th className="text-left p-3 font-medium" dir="ltr">יח'</th>
                      <th className="text-left p-3 font-medium" dir="ltr">הכנסה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topAttach.items.map((item) => (
                      <tr key={item.itemCode} className="border-b border-gray-100 last:border-0">
                        <td className="p-3">
                          <div className="font-medium text-gray-900 truncate max-w-xs">{item.itemName}</div>
                          <div className="text-xs text-gray-500" dir="ltr">{item.itemCode}</div>
                        </td>
                        <td className="text-left p-3 tabular-nums" dir="ltr">{item.attaches}</td>
                        <td className="text-left p-3 tabular-nums text-gray-600" dir="ltr">{item.qty}</td>
                        <td className="text-left p-3 tabular-nums" dir="ltr">{formatNis(item.revenue, { compact: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {buyers && (
              <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
                <div className="p-4 border-b border-gray-200">
                  <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                    <Users className="text-blue-600 w-4 h-4" /> Top לקוחות DAVO
                  </h2>
                  <p className="text-xs text-gray-500 mt-1">10 הלקוחות עם הכי הרבה הכנסה מ-DAVO</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600 text-xs">
                    <tr>
                      <th className="text-right p-3 font-medium">לקוח</th>
                      <th className="text-left p-3 font-medium" dir="ltr">הזמנות</th>
                      <th className="text-left p-3 font-medium" dir="ltr">הכנסה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buyers.buyers.map((b) => (
                      <tr key={b.CardCode} className="border-b border-gray-100 last:border-0">
                        <td className="p-3">
                          <div className="font-medium text-gray-900 truncate max-w-xs">{b.CardName}</div>
                          <div className="text-xs text-gray-500" dir="ltr">{b.CardCode}</div>
                        </td>
                        <td className="text-left p-3 tabular-nums" dir="ltr">{b.OrderCount}</td>
                        <td className="text-left p-3 tabular-nums" dir="ltr">{formatNis(b.DavoRevenue, { compact: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
