/**
 * Stock prediction - shows items at risk of stockout based on current orders.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { PackageX, Package, AlertTriangle, TrendingDown, Search } from 'lucide-react';

const LEVEL_INFO = {
  shortage: { label: 'חוסר', color: 'bg-red-50 border-red-300 text-red-900', icon: PackageX, sortRank: 4 },
  critical: { label: 'קריטי', color: 'bg-orange-50 border-orange-300 text-orange-900', icon: AlertTriangle, sortRank: 3 },
  warn:     { label: 'נמוך',  color: 'bg-amber-50 border-amber-300 text-amber-900', icon: TrendingDown, sortRank: 2 },
  ok:       { label: 'תקין',  color: 'bg-green-50 border-green-300 text-green-900', icon: Package, sortRank: 1 },
};

export default function StockPredictionPage() {
  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['stock-prediction'],
    queryFn: () => api.get('/analytics/stock-prediction').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const list = useMemo(() => {
    let arr = data?.items || [];
    if (levelFilter !== 'all') arr = arr.filter((i) => i.level === levelFilter);
    if (filter) {
      const f = filter.toLowerCase();
      arr = arr.filter((i) => i.itemCode.toLowerCase().includes(f) || (i.itemName || '').toLowerCase().includes(f));
    }
    return arr;
  }, [data, filter, levelFilter]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <PackageX className="text-red-600" /> חיזוי מלאי
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            פריטים שעלולים להיגמר על סמך ההזמנות הפתוחות מול המלאי הנוכחי
          </p>
        </div>
      </div>

      {/* Summary cards */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {Object.entries(LEVEL_INFO).map(([level, info]) => {
            const count = data.summary[level === 'ok' ? 'ok' : level] || 0;
            const Icon = info.icon;
            return (
              <button
                key={level}
                onClick={() => setLevelFilter(levelFilter === level ? 'all' : level)}
                className={`border rounded-xl p-3 text-right ${info.color} ${levelFilter === level ? 'ring-2 ring-offset-1' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs opacity-80">{info.label}</div>
                    <div className="text-2xl font-bold mt-0.5">{count}</div>
                  </div>
                  <Icon size={24} className="opacity-50" />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="חפש פריט..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pr-7 pl-3 py-2 border border-gray-300 rounded-lg text-sm w-56"
          />
        </div>
        {levelFilter !== 'all' && (
          <button
            onClick={() => setLevelFilter('all')}
            className="text-xs px-2 py-1 bg-gray-100 rounded"
          >
            נקה סינון רמה
          </button>
        )}
        <span className="mr-auto text-xs text-gray-500">
          {list.length} מתוך {data?.items?.length || 0} פריטים
        </span>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">סורק מלאי...</div>
      ) : data?.warning ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">
          ⚠️ {data.warning}
        </div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center text-gray-500">
          אין פריטים להציג
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-right">רמה</th>
                <th className="px-3 py-2 text-right">חברה</th>
                <th className="px-3 py-2 text-right">פריט</th>
                <th className="px-3 py-2 text-center">דרישה פתוחה</th>
                <th className="px-3 py-2 text-center">מלאי כעת</th>
                <th className="px-3 py-2 text-center">חוסר</th>
                <th className="px-3 py-2 text-center">לקוחות מחכים</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.slice(0, 200).map((it) => {
                const info = LEVEL_INFO[it.level];
                return (
                  <tr key={`${it.companyCode}-${it.itemCode}`} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-bold ${info.color}`}>
                        {info.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 text-[10px] rounded ${
                        it.companyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {it.companyCode === 'A' ? 'OIG' : 'Unico'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{it.itemName}</div>
                      <div className="text-[10px] text-gray-500 font-mono">{it.itemCode}</div>
                    </td>
                    <td className="px-3 py-2 text-center font-semibold">{it.openDemand.toLocaleString('he-IL')}</td>
                    <td className="px-3 py-2 text-center">{it.currentStock.toLocaleString('he-IL')}</td>
                    <td className="px-3 py-2 text-center">
                      {it.shortage > 0 ? (
                        <span className="font-bold text-red-600">{it.shortage.toLocaleString('he-IL')}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">{it.customerCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length > 200 && (
            <div className="px-3 py-2 bg-gray-50 border-t text-xs text-gray-500 text-center">
              מוצגים 200 הראשונים מתוך {list.length}. צמצם בעזרת חיפוש.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
