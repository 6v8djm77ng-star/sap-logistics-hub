import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { returnsApi } from '../services/api.js';
import StatusPill from '../components/StatusPill.jsx';
import NewReturnDialog from '../components/NewReturnDialog.jsx';
import { format } from 'date-fns';
import { Plus } from 'lucide-react';

export default function ReturnsPage() {
  const [showNew, setShowNew] = useState(false);
  const { data: returns, isLoading } = useQuery({
    queryKey: ['returns'],
    queryFn: () => returnsApi.list({}),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">חזרות מלקוחות</h1>
        <button
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
        >
          <Plus size={16} /> בקשה חדשה
        </button>
      </div>

      {showNew && <NewReturnDialog onClose={() => setShowNew(false)} />}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-3 text-right">מספר</th>
              <th className="px-4 py-3 text-right">חברה</th>
              <th className="px-4 py-3 text-right">לקוח</th>
              <th className="px-4 py-3 text-right">כתובת</th>
              <th className="px-4 py-3 text-center">שורות</th>
              <th className="px-4 py-3 text-center">תאריך</th>
              <th className="px-4 py-3 text-center">סטטוס</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">טוען...</td></tr>
            ) : !returns?.length ? (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">אין חזרות ממתינות</td></tr>
            ) : returns.map((r) => (
              <tr key={r.ReturnId} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">{r.ReturnNumber}</td>
                <td className="px-4 py-3">
                  <span className={`px-1.5 py-0.5 text-xs rounded ${r.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                    חברה {r.CompanyCode}
                  </span>
                </td>
                <td className="px-4 py-3">{r.SapCardName}</td>
                <td className="px-4 py-3 text-gray-700">{r.Street} {r.BuildingNumber}, {r.City}</td>
                <td className="px-4 py-3 text-center">{r.LinesCount}</td>
                <td className="px-4 py-3 text-center text-gray-500">{format(new Date(r.RequestedDate), 'dd/MM/yyyy')}</td>
                <td className="px-4 py-3 text-center"><StatusPill status={r.Status} size="sm" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
