/**
 * Order anomalies - flags unusual orders that may need attention.
 */
import { useQuery } from '@tanstack/react-query';
import api from '../services/api.js';
import { AlertTriangle, Eye, AlertOctagon, AlertCircle } from 'lucide-react';

const SEV_COLOR = {
  high: 'bg-red-50 border-red-300 text-red-900',
  medium: 'bg-amber-50 border-amber-300 text-amber-900',
  low: 'bg-blue-50 border-blue-300 text-blue-900',
};
const SEV_ICON = { high: AlertOctagon, medium: AlertTriangle, low: AlertCircle };
const SEV_LABEL = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };

export default function AnomaliesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['anomalies'],
    queryFn: () => api.get('/analytics/anomalies').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const anomalies = data?.anomalies || [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Eye className="text-purple-600" /> זיהוי חריגים בהזמנות
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            הזמנות חריגות שדורשות בדיקה (סכומים גבוהים מהרגיל, חוסר כתובת, וכו')
          </p>
        </div>
      </div>

      {/* Severity summary */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <SevCard label="סה״כ חריגים" value={data.summary.total} color="bg-gray-50 border-gray-200 text-gray-700" />
          <SevCard label="חומרה גבוהה" value={data.summary.high} color="bg-red-50 border-red-300 text-red-700" />
          <SevCard label="חומרה בינונית" value={data.summary.medium} color="bg-amber-50 border-amber-300 text-amber-700" />
          <SevCard label="חומרה נמוכה" value={data.summary.low} color="bg-blue-50 border-blue-300 text-blue-700" />
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">סורק הזמנות...</div>
      ) : data?.warning ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800">
          ⚠️ {data.warning}
        </div>
      ) : anomalies.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-12 text-center">
          <Eye className="mx-auto text-green-500 mb-3" size={40} />
          <p className="text-green-700 font-bold">כל ההזמנות נראות תקינות 👍</p>
          <p className="text-xs text-gray-500 mt-1">לא זוהו חריגות לפי הקריטריונים</p>
        </div>
      ) : (
        <div className="space-y-2">
          {anomalies.map((a) => (
            <AnomalyCard key={`${a.companyCode}-${a.docEntry}`} anomaly={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function SevCard({ label, value, color }) {
  return (
    <div className={`border rounded-xl p-3 ${color}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-2xl font-bold mt-0.5">{value}</div>
    </div>
  );
}

function AnomalyCard({ anomaly }) {
  const Icon = SEV_ICON[anomaly.maxSeverity];
  return (
    <div className={`border-2 rounded-xl p-3 ${SEV_COLOR[anomaly.maxSeverity]}`}>
      <div className="flex items-start gap-3">
        <Icon size={20} className="shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-bold">{anomaly.cardName}</span>
            <span className={`px-2 py-0.5 text-[10px] rounded-full ${
              anomaly.companyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
            }`}>
              {anomaly.companyCode === 'A' ? 'OIG' : 'Unico'}
            </span>
            <span className="font-mono text-xs text-gray-600">#{anomaly.docNum}</span>
            {anomaly.city && <span className="text-xs text-gray-600">· {anomaly.city}</span>}
            <span className="font-bold text-base">
              {Number(anomaly.docTotal).toLocaleString('he-IL')}₪
            </span>
            {anomaly.linesCount > 0 && (
              <span className="text-xs text-gray-500">{anomaly.linesCount} שורות</span>
            )}
          </div>
          <ul className="space-y-0.5 mt-1">
            {anomaly.reasons.map((r, i) => (
              <li key={i} className="text-sm flex items-start gap-1">
                <span>•</span>
                <span>{r.msg}</span>
                <span className="text-[10px] opacity-60 mr-1">({SEV_LABEL[r.severity]})</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
