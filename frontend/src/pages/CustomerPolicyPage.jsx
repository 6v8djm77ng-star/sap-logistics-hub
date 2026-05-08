/**
 * Customer Document Policy - decide per chain whether picking creates a
 * delivery note (DN) or an invoice (INV).
 *
 * Branches of the same chain (e.g. "א.ל.מ סחר 2000 בע"מ-עפולה" /
 * "א.ל.מ סחר 2000 בע"מ-הוד השרון") collapse into a single row.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { FileText, Receipt, Search, Building2, ChevronDown, ChevronUp, Filter, AlertCircle, Clock } from 'lucide-react';
import CustomerHoursDialog from '../components/CustomerHoursDialog.jsx';

const policyApi = {
  list: (includeIndividuals = false) =>
    api.get('/customers/policies', { params: { includeIndividuals } }).then((r) => r.data),
  set: (parentName, docType) =>
    api.patch(`/customers/policies/${encodeURIComponent(parentName)}`, { docType }).then((r) => r.data),
  bulk: (updates) =>
    api.post('/customers/policies/bulk', { updates }).then((r) => r.data),
};

export default function CustomerPolicyPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [docTypeFilter, setDocTypeFilter] = useState('all'); // all / DELIVERY_NOTE / INVOICE
  const [companyFilter, setCompanyFilter] = useState('all'); // all / A / B
  const [includeIndividuals, setIncludeIndividuals] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [hoursForName, setHoursForName] = useState(null); // open dialog for this parent

  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-policies', includeIndividuals],
    queryFn: () => policyApi.list(includeIndividuals),
    staleTime: 60_000,
  });

  const setMutation = useMutation({
    mutationFn: ({ parentName, docType }) => policyApi.set(parentName, docType),
    onSuccess: (_d, vars) => {
      const label = vars.docType === 'DELIVERY_NOTE' ? 'תעודת משלוח' : 'חשבונית';
      toast.success(`"${vars.parentName}" → ${label}`);
      queryClient.invalidateQueries({ queryKey: ['customer-policies'] });
    },
    onError: () => toast.error('שגיאה בשמירה'),
  });

  const bulkMutation = useMutation({
    mutationFn: (updates) => policyApi.bulk(updates),
    onSuccess: (res) => {
      toast.success(`עודכנו ${res.updated} לקוחות`);
      queryClient.invalidateQueries({ queryKey: ['customer-policies'] });
    },
  });

  const filteredGroups = useMemo(() => {
    const groups = data?.groups || [];
    return groups.filter((g) => {
      if (docTypeFilter !== 'all' && g.docType !== docTypeFilter) return false;
      if (companyFilter !== 'all' && !g.companies.includes(companyFilter)) return false;
      if (filter) {
        const f = filter.toLowerCase();
        if (!g.parentName.toLowerCase().includes(f) &&
            !g.branches.some((b) => b.cardName?.toLowerCase().includes(f) || b.cardCode?.toLowerCase().includes(f))) {
          return false;
        }
      }
      return true;
    });
  }, [data, filter, docTypeFilter, companyFilter]);

  const stats = useMemo(() => {
    const groups = data?.groups || [];
    return {
      total: groups.length,
      dn: groups.filter((g) => g.docType === 'DELIVERY_NOTE').length,
      inv: groups.filter((g) => g.docType === 'INVOICE').length,
      explicit: groups.filter((g) => g.isExplicit).length,
    };
  }, [data]);

  const toggleExpanded = (parentName) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(parentName) ? next.delete(parentName) : next.add(parentName);
      return next;
    });
  };

  const setDocType = (parentName, docType) => {
    setMutation.mutate({ parentName, docType });
  };

  const setBulk = (docType) => {
    if (!confirm(`להגדיר ${filteredGroups.length} לקוחות מסוננים כ-${docType === 'DELIVERY_NOTE' ? 'תעודת משלוח' : 'חשבונית'}?`)) return;
    bulkMutation.mutate(filteredGroups.map((g) => ({ parentName: g.parentName, docType })));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 /> מדיניות מסמכים ללקוחות
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            רק רשתות שיווק מוצגות (1 שורה ראשית לכל רשת). לקוחות פרטיים → חשבונית אוטומטית.
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard title="רשתות שיווק" value={data?.counts?.chains || 0} color="gray" icon={<Building2 size={14} />} />
        <StatCard title="לקוחות פרטיים (אוטו'-חשבונית)" value={data?.counts?.individuals || 0} color="purple" icon={<Receipt size={14} />} />
        <StatCard title="תעודת משלוח" value={stats.dn} color="blue" icon={<FileText size={14} />} />
        <StatCard title="חשבונית (ברשתות)" value={stats.inv} color="purple" icon={<Receipt size={14} />} />
        <StatCard title="הוגדר ידנית" value={stats.explicit} color="amber" />
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="חפש לקוח / קוד..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pr-7 pl-3 py-2 border border-gray-300 rounded-lg text-sm w-56"
          />
        </div>

        <select
          value={docTypeFilter}
          onChange={(e) => setDocTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">כל המסמכים</option>
          <option value="DELIVERY_NOTE">תעודת משלוח</option>
          <option value="INVOICE">חשבונית</option>
        </select>

        <select
          value={companyFilter}
          onChange={(e) => setCompanyFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">כל החברות</option>
          <option value="A">OIG</option>
          <option value="B">Unico</option>
        </select>

        <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeIndividuals}
            onChange={(e) => setIncludeIndividuals(e.target.checked)}
          />
          הצג גם לקוחות פרטיים
        </label>

        <div className="mr-auto flex gap-2 items-center">
          <span className="text-xs text-gray-500">מיון מסומנים:</span>
          <button
            onClick={() => setBulk('DELIVERY_NOTE')}
            disabled={bulkMutation.isPending}
            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100"
            title="קבע את כל המסוננים כתעודת משלוח"
          >
            <FileText size={12} className="inline -mt-0.5 ml-1" />
            הכל לתעודת משלוח
          </button>
          <button
            onClick={() => setBulk('INVOICE')}
            disabled={bulkMutation.isPending}
            className="px-3 py-1.5 text-xs bg-purple-50 text-purple-700 border border-purple-200 rounded-lg hover:bg-purple-100"
          >
            <Receipt size={12} className="inline -mt-0.5 ml-1" />
            הכל לחשבונית
          </button>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען לקוחות מ-SAP...</div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 flex gap-2">
          <AlertCircle size={18} />
          {error.response?.data?.error || 'שגיאה בטעינה'}
        </div>
      ) : data?.warning ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 flex gap-2">
          <AlertCircle size={18} />
          {data.warning}
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-right font-medium w-10"></th>
                  <th className="px-3 py-2 text-right font-medium">שם הלקוח / רשת</th>
                  <th className="px-3 py-2 text-center font-medium">סניפים</th>
                  <th className="px-3 py-2 text-center font-medium">חברות</th>
                  <th className="px-3 py-2 text-center font-medium">הזמנות פתוחות</th>
                  <th className="px-3 py-2 text-center font-medium">מסמך אוטומטי בליקוט</th>
                  <th className="px-3 py-2 text-center font-medium">שעות פעילות</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredGroups.map((g) => (
                  <PolicyRow
                    key={g.parentName}
                    group={g}
                    isExpanded={expanded.has(g.parentName)}
                    onToggle={() => toggleExpanded(g.parentName)}
                    onSetDocType={(dt) => setDocType(g.parentName, dt)}
                    onEditHours={() => setHoursForName(g.parentName)}
                    pending={setMutation.isPending}
                    defaultDocType={data.defaultDocType}
                  />
                ))}
                {filteredGroups.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-12 text-gray-500">
                      אין תוצאות מתאימות לסינון
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 bg-gray-50 border-t text-xs text-gray-600">
            ברירת מחדל למי שלא הוגדר ידנית: <strong>{data?.defaultDocType === 'INVOICE' ? 'חשבונית' : 'תעודת משלוח'}</strong>
          </div>
        </div>
      )}

      {hoursForName && (
        <CustomerHoursDialog
          parentName={hoursForName}
          onClose={() => setHoursForName(null)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------------
function PolicyRow({ group, isExpanded, onToggle, onSetDocType, onEditHours, pending }) {
  const isDN = group.docType === 'DELIVERY_NOTE';
  return (
    <>
      <tr className={`hover:bg-gray-50 ${group.isExplicit ? '' : 'opacity-90'}`}>
        <td className="px-3 py-2">
          {group.branchCount > 1 && (
            <button
              onClick={onToggle}
              className="p-1 hover:bg-gray-200 rounded"
              title="הצג סניפים"
            >
              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="font-medium">{group.parentName}</div>
          {!group.isExplicit && (
            <div className="text-[10px] text-gray-400">ברירת מחדל</div>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {group.branchCount > 1 ? (
            <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs font-medium">
              {group.branchCount} סניפים
            </span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          <div className="flex justify-center gap-1">
            {group.companies.includes('A') && (
              <span className="px-1.5 py-0.5 text-[10px] bg-blue-100 text-blue-700 rounded">OIG</span>
            )}
            {group.companies.includes('B') && (
              <span className="px-1.5 py-0.5 text-[10px] bg-green-100 text-green-700 rounded">Unico</span>
            )}
          </div>
        </td>
        <td className="px-3 py-2 text-center">
          {group.totalOpenOrders > 0 ? (
            <span className="font-medium text-amber-700">{group.totalOpenOrders}</span>
          ) : (
            <span className="text-gray-400">0</span>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          <div className="inline-flex gap-1">
            <button
              onClick={() => onSetDocType('DELIVERY_NOTE')}
              disabled={pending}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                isDN
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-blue-50'
              }`}
            >
              <FileText size={12} />
              ת.משלוח
            </button>
            <button
              onClick={() => onSetDocType('INVOICE')}
              disabled={pending}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                !isDN
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-purple-50'
              }`}
            >
              <Receipt size={12} />
              חשבונית
            </button>
          </div>
        </td>
        <td className="px-3 py-2 text-center">
          <button
            onClick={onEditHours}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white text-gray-700 border border-gray-200 rounded-lg text-xs hover:border-blue-400 hover:text-blue-700"
            title="ערוך שעות פעילות"
          >
            <Clock size={12} />
            ערוך
          </button>
        </td>
      </tr>
      {isExpanded && group.branches.map((b) => (
        <tr key={`${b.companyCode}-${b.cardCode}`} className="bg-gray-50/60">
          <td></td>
          <td className="px-3 py-1.5 text-xs text-gray-600 pr-8">
            <span className="font-mono ml-2">#{b.cardCode}</span>
            {b.cardName}
            {b.city && <span className="text-gray-400"> · {b.city}</span>}
          </td>
          <td></td>
          <td className="px-3 py-1.5 text-center">
            <span className={`px-1.5 py-0.5 text-[10px] rounded ${
              b.companyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
            }`}>
              {b.companyName}
            </span>
          </td>
          <td className="px-3 py-1.5 text-center text-xs text-gray-500">
            {b.openOrders > 0 ? b.openOrders : '—'}
          </td>
          <td className="text-center text-[10px] text-gray-400">יורש מהראשי</td>
          <td className="text-center text-[10px] text-gray-400">יורש מהראשי</td>
        </tr>
      ))}
    </>
  );
}

function StatCard({ title, value, color, icon }) {
  const colors = {
    gray: 'bg-gray-50 border-gray-200 text-gray-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
  };
  return (
    <div className={`rounded-xl border p-3 ${colors[color]}`}>
      <div className="flex items-center gap-1 text-xs opacity-80">
        {icon}{title}
      </div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString('he-IL')}</div>
    </div>
  );
}
