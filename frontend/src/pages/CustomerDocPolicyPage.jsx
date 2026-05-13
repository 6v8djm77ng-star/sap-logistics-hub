/**
 * Customer Document Policy editor.
 *
 * Lets the logistics manager decide, per customer, what document the system
 * should generate at the end of picking:
 *   - perOrderDeliveryNote   תעודת משלוח לכל הזמנה
 *   - perOrderInvoice         חשבונית לכל הזמנה
 *   - aggregateDeliveryNote   תעודת משלוח מרכזת לקו
 *   - aggregateInvoice        חשבונית מרכזת לקו
 *
 * Data flow: this page does NOT trigger document creation. It only writes
 * the policy fields onto customerDeliveryProfiles via PATCH /policy. The
 * actual document generation (feature C) will read these fields later.
 *
 * Editing is per-row, autosaves on blur — no Save All / Cancel All. Re-save
 * is the bulk fix.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { Search, FileText, AlertTriangle, Filter, X } from 'lucide-react';

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי'];

const POLICY_OPTIONS = [
  { value: '',    label: '—',  cls: 'text-gray-400' },
  { value: 'yes', label: 'כן', cls: 'text-emerald-700 bg-emerald-50' },
  { value: 'no',  label: 'לא', cls: 'text-gray-700' },
  { value: 'na',  label: 'ל"ר', cls: 'text-gray-500 italic' },
];

export default function CustomerDocPolicyPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ company: '', zone: '', day: '', status: '', q: '' });
  const [showFilters, setShowFilters] = useState(true);

  const { data: zonesData } = useQuery({
    queryKey: ['zones'],
    queryFn: () => api.get('/zones').then((r) => r.data.zones || []),
  });
  const zones = zonesData || [];

  const { data: stats } = useQuery({
    queryKey: ['customer-profile-stats'],
    queryFn: () => api.get('/customer-profiles/stats').then((r) => r.data),
  });

  // Pull everything once, filter client-side — 1,587 rows are fine in memory
  // and avoids re-fetching on every filter change.
  const { data: allProfiles = [], isLoading } = useQuery({
    queryKey: ['customer-profiles', 'all'],
    queryFn: () => api.get('/customer-profiles').then((r) => r.data.profiles || []),
  });

  const filtered = useMemo(() => {
    let rows = allProfiles;
    if (filters.company) rows = rows.filter((p) => p.Company === filters.company);
    if (filters.zone)    rows = rows.filter((p) => p.Zone === filters.zone);
    if (filters.day)     rows = rows.filter((p) => (p.DeliveryDays || []).includes(filters.day));
    if (filters.status)  rows = rows.filter((p) => (p.Status || 'ACTIVE') === filters.status);
    if (filters.q) {
      const needle = filters.q.toLowerCase();
      rows = rows.filter((p) =>
        String(p.CardCode).toLowerCase().includes(needle) ||
        (p.Name || '').toLowerCase().includes(needle) ||
        (p.City || '').toLowerCase().includes(needle)
      );
    }
    return rows;
  }, [allProfiles, filters]);

  const patchPolicy = useMutation({
    mutationFn: ({ cardCode, company, patch }) =>
      api.patch(`/customer-profiles/${encodeURIComponent(cardCode)}/policy`,
        patch, { params: { company } }).then((r) => r.data),
    onSuccess: (_data, vars) => {
      // Optimistic UI: PATCH already returned the full updated profile, but
      // simplest correct path is to refetch the list. List is in memory so
      // the network cost is bounded.
      queryClient.invalidateQueries({ queryKey: ['customer-profiles', 'all'] });
      // Show small toast only on the FIRST policy field set per customer
      if (vars.patch.perOrderDeliveryNote || vars.patch.perOrderInvoice) {
        toast.success(`${vars.cardCode} נשמר`, { duration: 1200 });
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בשמירה'),
  });

  const filledCount = useMemo(() =>
    allProfiles.filter((p) => {
      const dp = p.DocPolicy || {};
      return dp.perOrderDeliveryNote || dp.perOrderInvoice
        || dp.aggregateDeliveryNote || dp.aggregateInvoice;
    }).length, [allProfiles]);

  const clearFilters = () => setFilters({ company: '', zone: '', day: '', status: '', q: '' });
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FileText size={24} className="text-brand-600" />
            מדיניות מסמכים ללקוח
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            קובע לכל לקוח אילו מסמכים SAP יופקו בסיום ליקוט.
            לקוחות אילת: חשבונית מס חובה (אזור סחר חופשי).
          </p>
        </div>
        {stats && (
          <div className="text-xs text-gray-500 text-left bg-gray-50 border rounded-lg px-3 py-2">
            <div><strong>{stats.total}</strong> לקוחות סה"כ</div>
            <div><strong>{filledCount}</strong> עם החלטה</div>
            <div className="text-amber-700"><strong>{stats.withIssues}</strong> דורשים תיקון ב-SAP</div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white border rounded-xl p-3 mb-4">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700"
          >
            <Filter size={14} />
            סינון
            {activeFilterCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 bg-brand-600 text-white text-[10px] rounded-full">
                {activeFilterCount}
              </span>
            )}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="text-xs text-gray-500 hover:text-red-600 inline-flex items-center gap-1">
              <X size={12} /> נקה הכל
            </button>
          )}
        </div>
        {showFilters && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <select
              value={filters.company}
              onChange={(e) => setFilters({ ...filters, company: e.target.value })}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">כל החברות</option>
              <option value="OIG">OIG</option>
              <option value="UNICO">UNICO</option>
            </select>
            <select
              value={filters.zone}
              onChange={(e) => setFilters({ ...filters, zone: e.target.value })}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">כל האזורים</option>
              {zones.map((z) => (
                <option key={z.Code} value={z.Code}>{z.Name}</option>
              ))}
            </select>
            <select
              value={filters.day}
              onChange={(e) => setFilters({ ...filters, day: e.target.value })}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">כל ימי ההפצה</option>
              {HEBREW_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">כל הסטטוסים</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
            </select>
            <div className="relative">
              <Search size={13} className="absolute top-1/2 -translate-y-1/2 right-2 text-gray-400" />
              <input
                type="text"
                value={filters.q}
                onChange={(e) => setFilters({ ...filters, q: e.target.value })}
                placeholder="חפש קוד, שם או עיר..."
                className="w-full pr-7 pl-2 py-1.5 border border-gray-300 rounded-lg text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500 mb-2">
        מציג <strong>{filtered.length.toLocaleString('he-IL')}</strong> לקוחות
        {filtered.length !== allProfiles.length && (
          <> מתוך {allProfiles.length.toLocaleString('he-IL')}</>
        )}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-2 text-right font-medium">חברה</th>
                  <th className="px-2 py-2 text-right font-medium">קוד</th>
                  <th className="px-2 py-2 text-right font-medium">שם לקוח</th>
                  <th className="px-2 py-2 text-right font-medium">עיר</th>
                  <th className="px-2 py-2 text-right font-medium">אזור</th>
                  <th className="px-2 py-2 text-right font-medium">ימי הפצה</th>
                  <th className="px-2 py-2 text-center font-medium">תעודה<br/>לכל הזמנה</th>
                  <th className="px-2 py-2 text-center font-medium">חשבונית<br/>לכל הזמנה</th>
                  <th className="px-2 py-2 text-center font-medium">תעודה<br/>מרכזת</th>
                  <th className="px-2 py-2 text-center font-medium">חשבונית<br/>מרכזת</th>
                  <th className="px-2 py-2 text-right font-medium">סטטוס</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.slice(0, 500).map((p) => (
                  <PolicyRow
                    key={`${p.Company}-${p.CardCode}`}
                    profile={p}
                    zones={zones}
                    onChange={(patch) => patchPolicy.mutate({
                      cardCode: p.CardCode, company: p.Company, patch,
                    })}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > 500 && (
            <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-sm text-amber-900 text-center">
              מוצגים 500 הראשונים מתוך {filtered.length.toLocaleString('he-IL')} —
              צמצם סינון כדי לערוך לקוחות נוספים.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PolicyRow({ profile, zones, onChange }) {
  const dp = profile.DocPolicy || {};
  const zoneMeta = zones.find((z) => z.Code === profile.Zone);
  const isEilat = profile.Zone === 'EILAT';
  const isReview = profile.Status === 'NEEDS_REVIEW';

  return (
    <tr className={isReview ? 'bg-amber-50/30' : 'hover:bg-gray-50'}>
      <td className="px-2 py-1.5">
        <span className={`px-1.5 py-0.5 text-[10px] rounded ${
          profile.Company === 'OIG' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
        }`}>{profile.Company}</span>
      </td>
      <td className="px-2 py-1.5 font-mono text-xs text-gray-600">{profile.CardCode}</td>
      <td className="px-2 py-1.5">
        <div className="font-medium text-gray-900 truncate max-w-xs" title={profile.Name}>
          {profile.Name || '(ללא שם)'}
        </div>
        {profile.SubZone && (
          <div className="text-[10px] text-gray-500">תת-אזור: {profile.SubZone}</div>
        )}
      </td>
      <td className="px-2 py-1.5 text-gray-700">{profile.City || '—'}</td>
      <td className="px-2 py-1.5">
        {zoneMeta ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <span className="w-2 h-2 rounded-full" style={{ background: zoneMeta.ColorHex }} />
            {zoneMeta.Name}
            {isEilat && <span className="text-[9px] text-purple-700 font-bold">·סחר חופשי</span>}
          </span>
        ) : <span className="text-xs text-gray-400">—</span>}
      </td>
      <td className="px-2 py-1.5 text-xs">
        {(profile.DeliveryDays || []).join(', ') || <span className="text-gray-400">—</span>}
      </td>
      <td className="px-1 py-1.5"><PolicyCell value={dp.perOrderDeliveryNote || ''} onChange={(v) => onChange({ perOrderDeliveryNote: v })} /></td>
      <td className="px-1 py-1.5"><PolicyCell value={dp.perOrderInvoice || ''} onChange={(v) => onChange({ perOrderInvoice: v })} /></td>
      <td className="px-1 py-1.5"><PolicyCell value={dp.aggregateDeliveryNote || ''} onChange={(v) => onChange({ aggregateDeliveryNote: v })} /></td>
      <td className="px-1 py-1.5"><PolicyCell value={dp.aggregateInvoice || ''} onChange={(v) => onChange({ aggregateInvoice: v })} /></td>
      <td className="px-2 py-1.5">
        {isReview ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-900 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded" title={profile.StatusReason}>
            <AlertTriangle size={10} /> בדיקה
          </span>
        ) : (
          <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">פעיל</span>
        )}
      </td>
    </tr>
  );
}

function PolicyCell({ value, onChange }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v !== value) onChange(v);
      }}
      className={`w-16 px-1 py-0.5 border border-gray-200 rounded text-xs text-center bg-white focus:outline-none focus:border-brand-500 ${
        POLICY_OPTIONS.find((o) => o.value === (value || ''))?.cls || ''
      }`}
    >
      {POLICY_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
