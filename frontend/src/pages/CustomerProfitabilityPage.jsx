/**
 * Customer profitability analysis - which customers actually make us money
 * after delivery costs are factored in.
 */
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { TrendingUp, TrendingDown, DollarSign, Search, Filter } from 'lucide-react';

const RANK_COLOR = {
  A: 'bg-green-100 text-green-700 border-green-300',
  B: 'bg-blue-100 text-blue-700 border-blue-300',
  C: 'bg-amber-100 text-amber-700 border-amber-300',
  D: 'bg-orange-100 text-orange-700 border-orange-300',
  F: 'bg-red-100 text-red-700 border-red-300',
};
const RANK_LABEL = {
  A: 'מצוין', B: 'טוב', C: 'בינוני', D: 'גבולי', F: 'מפסיד',
};

export default function CustomerProfitabilityPage() {
  const [days, setDays] = useState(90);
  const [filter, setFilter] = useState('');
  const [rankFilter, setRankFilter] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['profitability', days],
    queryFn: () => api.get('/analytics/customer-profitability', { params: { days } }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const list = useMemo(() => {
    let arr = data?.customers || [];
    if (rankFilter !== 'all') arr = arr.filter((c) => c.rank === rankFilter);
    if (filter) {
      const f = filter.toLowerCase();
      arr = arr.filter((c) => c.parentName.toLowerCase().includes(f));
    }
    return arr;
  }, [data, filter, rankFilter]);

  const formatNis = (n) =>
    Number(n || 0).toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="text-green-600" /> רווחיות לקוחות
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            הכנסה פחות עלות הפצה משוערת לכל לקוח
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value={7}>7 ימים אחרונים</option>
          <option value={30}>30 ימים</option>
          <option value={90}>90 ימים</option>
          <option value={180}>חצי שנה</option>
        </select>
      </div>

      {/* Totals */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
            <div className="text-xs text-blue-700">סה״כ הכנסה</div>
            <div className="text-2xl font-bold text-blue-900 mt-1">{formatNis(data.totalRevenue)}</div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="text-xs text-amber-700">סה״כ עלות הפצה</div>
            <div className="text-2xl font-bold text-amber-900 mt-1">{formatNis(data.totalCost)}</div>
          </div>
          <div className={`border rounded-xl p-4 ${data.totalMargin >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <div className={`text-xs ${data.totalMargin >= 0 ? 'text-green-700' : 'text-red-700'}`}>רווח גולמי</div>
            <div className={`text-2xl font-bold mt-1 ${data.totalMargin >= 0 ? 'text-green-900' : 'text-red-900'}`}>
              {formatNis(data.totalMargin)}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white border border-gray-200 rounded-xl p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="חפש לקוח..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pr-7 pl-3 py-2 border border-gray-300 rounded-lg text-sm w-56"
          />
        </div>
        <select
          value={rankFilter}
          onChange={(e) => setRankFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="all">כל הרמות</option>
          <option value="A">A - מצוין</option>
          <option value="B">B - טוב</option>
          <option value="C">C - בינוני</option>
          <option value="D">D - גבולי</option>
          <option value="F">F - מפסיד</option>
        </select>
        <span className="mr-auto text-xs text-gray-500">
          הנחות חישוב: עלות {data?.assumptions?.costPerStop || 48}₪ לעצירה
        </span>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : data?.warning ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">
          ⚠️ {data.warning}
        </div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-xl border p-12 text-center text-gray-500">
          אין לקוחות לתוצאות הסינון
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-3 py-2 text-right">דירוג</th>
                <th className="px-3 py-2 text-right">לקוח</th>
                <th className="px-3 py-2 text-center">חברות</th>
                <th className="px-3 py-2 text-center">הזמנות</th>
                <th className="px-3 py-2 text-right">הכנסה</th>
                <th className="px-3 py-2 text-right">עלות</th>
                <th className="px-3 py-2 text-right">רווח</th>
                <th className="px-3 py-2 text-center">מרג׳ין</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map((c) => (
                <tr key={c.parentName} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-bold ${RANK_COLOR[c.rank]}`}>
                      {c.rank} - {RANK_LABEL[c.rank]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.parentName}</div>
                    <div className="text-[10px] text-gray-500">{c.citiesCount} ערים · ממוצע {formatNis(c.avgOrderValue)}</div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex justify-center gap-0.5">
                      {c.companies.includes('A') && <span className="px-1 py-0.5 text-[10px] bg-blue-100 text-blue-700 rounded">OIG</span>}
                      {c.companies.includes('B') && <span className="px-1 py-0.5 text-[10px] bg-green-100 text-green-700 rounded">U</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center font-mono">{c.orderCount}</td>
                  <td className="px-3 py-2 text-blue-700 font-medium">{formatNis(c.revenue)}</td>
                  <td className="px-3 py-2 text-amber-700">{formatNis(c.cost)}</td>
                  <td className={`px-3 py-2 font-bold ${c.margin >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {c.margin >= 0 ? <TrendingUp size={11} className="inline -mt-0.5 ml-1" /> : <TrendingDown size={11} className="inline -mt-0.5 ml-1" />}
                    {formatNis(c.margin)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`font-bold ${c.marginPct >= 0.4 ? 'text-green-700' : c.marginPct >= 0 ? 'text-amber-700' : 'text-red-700'}`}>
                      {Math.round(c.marginPct * 100)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-3">
        💡 <strong>איך מחושב:</strong> רווח = הכנסה - (מספר הזמנות × {data?.assumptions?.costPerStop || 48}₪).
        עלות לעצירה כוללת זמן נהג (~33₪), דלק (~10₪) ואריזה (~5₪).
        ניתן לשנות את ההנחה בקוד backend (COST_PER_STOP).
      </div>
    </div>
  );
}
