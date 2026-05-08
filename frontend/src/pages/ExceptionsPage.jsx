/**
 * Exceptions Report - things needing manual intervention.
 */
import { useQuery } from '@tanstack/react-query';
import { reportsApi } from '../services/api.js';
import { AlertTriangle, MapPin, XCircle, RefreshCw, Send } from 'lucide-react';

export default function ExceptionsPage() {
  const { data: report, isLoading } = useQuery({
    queryKey: ['exceptions'],
    queryFn: () => reportsApi.exceptions(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <div className="p-6">טוען...</div>;

  const sections = [
    {
      key: 'addressesWithoutZone',
      title: 'כתובות ללא אזור הפצה',
      icon: MapPin,
      color: 'amber',
      description: 'יש לשייך ידנית לאזור - עבור ל"אזורי הפצה"',
      items: report?.exceptions?.addressesWithoutZone || [],
      renderRow: (item) => (
        <>
          <td className="px-3 py-2">{item.Street} {item.BuildingNumber}</td>
          <td className="px-3 py-2">{item.City}</td>
          <td className="px-3 py-2 text-gray-500">{item.BranchName || '—'}</td>
          <td className="px-3 py-2 text-center text-gray-500">{item.CustomerLinks} לקוחות</td>
        </>
      ),
      headers: ['כתובת', 'עיר', 'סניף', 'לקוחות'],
    },
    {
      key: 'failedStops',
      title: 'עצירות שנכשלו',
      icon: XCircle,
      color: 'red',
      description: 'עצירות שהנהג סימן ככשל - יש לבדוק ולתכנן מחדש',
      items: report?.exceptions?.failedStops || [],
      renderRow: (item) => (
        <>
          <td className="px-3 py-2">{item.RunNumber}</td>
          <td className="px-3 py-2">{item.Street} {item.BuildingNumber}, {item.City}</td>
          <td className="px-3 py-2 text-gray-600">{item.Notes || '—'}</td>
        </>
      ),
      headers: ['מסלול', 'כתובת', 'סיבה'],
    },
    {
      key: 'unassignedReturns',
      title: 'חזרות לא משויכות למסלול',
      icon: RefreshCw,
      color: 'blue',
      description: 'חזרות ממתינות לשיוך למסלול הפצה',
      items: report?.exceptions?.unassignedReturns || [],
      renderRow: (item) => (
        <>
          <td className="px-3 py-2">{item.ReturnNumber}</td>
          <td className="px-3 py-2">חברה {item.CompanyCode}</td>
          <td className="px-3 py-2">{item.SapCardName}</td>
          <td className="px-3 py-2 text-gray-500">{item.Street} {item.BuildingNumber}, {item.City}</td>
        </>
      ),
      headers: ['מספר', 'חברה', 'לקוח', 'כתובת'],
    },
    {
      key: 'failedDeliveryNotes',
      title: 'תעודות משלוח שלא נוצרו ב-SAP',
      icon: Send,
      color: 'purple',
      description: 'הזמנות נמסרו בפועל אך תעודת SAP לא נוצרה - יש להריץ סנכרון',
      items: report?.exceptions?.failedDeliveryNotes || [],
      renderRow: (item) => (
        <>
          <td className="px-3 py-2">{item.RunNumber}</td>
          <td className="px-3 py-2">חברה {item.CompanyCode}</td>
          <td className="px-3 py-2 font-mono">#{item.SapDocNum}</td>
          <td className="px-3 py-2">{item.SapCardName}</td>
        </>
      ),
      headers: ['מסלול', 'חברה', 'הזמנה', 'לקוח'],
    },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">דוח חריגים</h1>
          <p className="text-sm text-gray-500 mt-1">
            {report?.summary?.total === 0
              ? 'הכל תקין ✓'
              : `${report?.summary?.total} פריטים דורשים טיפול`}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
        {sections.map((s) => (
          <div
            key={s.key}
            className={`bg-white border border-${s.color}-200 rounded-xl p-4`}
          >
            <div className="flex items-center gap-2 mb-1">
              <s.icon className={`text-${s.color}-500`} size={18} />
              <span className="text-sm font-medium">{s.title}</span>
            </div>
            <div className="text-2xl font-bold">{s.items.length}</div>
          </div>
        ))}
      </div>

      {/* Detailed sections */}
      <div className="space-y-5">
        {sections.map((s) => (
          <div key={s.key} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <s.icon className={`text-${s.color}-500`} size={16} />
                <h3 className="font-semibold">{s.title}</h3>
                <span className="text-sm text-gray-500">({s.items.length})</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">{s.description}</p>
            </div>
            {s.items.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">אין פריטים</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-gray-500 text-xs">
                  <tr>
                    {s.headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {s.items.slice(0, 20).map((item, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      {s.renderRow(item)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {s.items.length > 20 && (
              <div className="px-4 py-2 text-xs text-gray-500 text-center bg-gray-50">
                מוצגים 20 מתוך {s.items.length}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
