/**
 * Failure Inbox - the logistics manager's command center for failed stops.
 *
 * Shows all open failures grouped by severity, with one-click actions:
 *   - Reschedule to another run
 *   - Contact customer (opens phone/email)
 *   - Mark as resolved (customer no longer needs delivery)
 *   - Cancel (close without reschedule)
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { runsApi } from '../services/api.js';
import api from '../services/api.js';
import { getSocket } from '../services/socket.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertTriangle, AlertCircle, Clock, Phone, MapPin, Package,
  Calendar, CheckCircle, X, RefreshCw, ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react';

const SEVERITY_STYLE = {
  HIGH:   { label: 'קריטי', bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700', icon: 'text-red-500' },
  MEDIUM: { label: 'בינוני', bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-700', icon: 'text-amber-500' },
  LOW:    { label: 'נמוך',  bg: 'bg-gray-50', border: 'border-gray-300', text: 'text-gray-700', icon: 'text-gray-500' },
};

const failuresApi = {
  list: (includeResolved = false) =>
    api.get('/failures', { params: { includeResolved } }).then((r) => r.data.failures),
  reasons: () => api.get('/failures/reasons').then((r) => r.data.reasons),
  reschedule: (id, targetRunId, notes) =>
    api.post(`/failures/${id}/reschedule`, { targetRunId, notes }).then((r) => r.data),
  resolve: (id, status, notes) =>
    api.post(`/failures/${id}/resolve`, { status, notes }).then((r) => r.data),
};

function RescheduleDialog({ failure, onClose, onDone }) {
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [notes, setNotes] = useState('');
  const [includeDate, setIncludeDate] = useState(format(new Date(Date.now() + 86400000), 'yyyy-MM-dd'));

  const { data: availableRuns } = useQuery({
    queryKey: ['runs-for-reschedule', includeDate],
    queryFn: () => runsApi.list({ runDate: includeDate }),
  });

  const mutation = useMutation({
    mutationFn: () => failuresApi.reschedule(failure.FailureId, selectedRunId, notes),
    onSuccess: () => {
      toast.success('כשל תוזמן מחדש');
      onDone();
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  // Filter runs in same zone as failed stop
  const sameZoneRuns = (availableRuns || []).filter(
    (r) => r.ZoneName === failure.ZoneName && !['COMPLETED', 'CANCELLED'].includes(r.Status)
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5">
        <h3 className="text-lg font-bold mb-1">תזמן מחדש</h3>
        <p className="text-sm text-gray-500 mb-4">
          העבר את העצירה של {failure.CustomerName} למסלול אחר
        </p>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">תאריך יעד</label>
          <input
            type="date"
            value={includeDate}
            onChange={(e) => setIncludeDate(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm font-medium mb-1">
            בחר מסלול (באזור {failure.ZoneName})
          </label>
          {sameZoneRuns.length === 0 ? (
            <p className="text-sm text-amber-600 bg-amber-50 p-2 rounded">
              אין מסלולים פנויות ב-{failure.ZoneName} בתאריך זה. צור מסלול חדש קודם.
            </p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-auto border rounded-lg">
              {sameZoneRuns.map((r) => (
                <label
                  key={r.RunId}
                  className={`flex items-center gap-2 p-2 cursor-pointer border-b last:border-0 ${selectedRunId === r.RunId ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
                >
                  <input
                    type="radio"
                    name="run"
                    checked={selectedRunId === r.RunId}
                    onChange={() => setSelectedRunId(r.RunId)}
                  />
                  <div className="flex-1 text-sm">
                    <div className="font-medium">{r.RunNumber}</div>
                    <div className="text-xs text-gray-500">
                      {r.DriverName || 'ללא נהג'} · {r.StopCount} עצירות · {r.Status}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">הערות (אופציונלי)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm"
            rows={2}
            placeholder="למשל: הלקוח אישר תיאום חדש ליום ה' ב-10:00"
          />
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!selectedRunId || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'מתזמן...' : 'תזמן'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FailureCard({ failure, onReschedule, onResolve }) {
  const [expanded, setExpanded] = useState(false);
  const style = SEVERITY_STYLE[failure.Severity] || SEVERITY_STYLE.LOW;

  const resolveMutation = useMutation({
    mutationFn: (status) => failuresApi.resolve(failure.FailureId, status),
    onSuccess: () => {
      toast.success('נסגר');
      onResolve();
    },
  });

  const minutesAgo = Math.floor((Date.now() - new Date(failure.CreatedAt).getTime()) / 60000);
  const timeDisplay = minutesAgo < 60
    ? `לפני ${minutesAgo} דק'`
    : minutesAgo < 1440
      ? `לפני ${Math.floor(minutesAgo / 60)} שעות`
      : format(new Date(failure.CreatedAt), 'dd/MM HH:mm');

  return (
    <div className={`border rounded-xl overflow-hidden ${style.border} ${style.bg}`}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <AlertTriangle className={style.icon} size={20} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full ${style.bg} ${style.text} border ${style.border}`}>
                  {style.label}
                </span>
                <span className="font-semibold">{failure.ReasonName}</span>
                {failure.CompanyCode && (
                  <span className={`text-xs px-1.5 py-0.5 rounded ${failure.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                    חברה {failure.CompanyCode}
                  </span>
                )}
              </div>
              <div className="font-medium mt-1">{failure.CustomerName || '—'}</div>
              <div className="text-sm text-gray-600 mt-0.5 flex items-center gap-1 flex-wrap">
                <MapPin size={12} />
                {failure.Street} {failure.BuildingNumber}, {failure.City}
                {failure.BranchName && <span className="text-gray-500">· {failure.BranchName}</span>}
              </div>
            </div>
          </div>

          <div className="text-xs text-gray-500 whitespace-nowrap flex items-center gap-1">
            <Clock size={12} />
            {timeDisplay}
          </div>
        </div>

        {failure.Notes && (
          <div className="mt-3 p-2 bg-white/60 rounded border text-sm">
            <div className="text-xs text-gray-500 mb-0.5">דיווח הנהג:</div>
            {failure.Notes}
          </div>
        )}

        <div className="flex items-center gap-3 mt-3 text-xs text-gray-600">
          <span><Package size={12} className="inline ml-1" />{failure.OrdersCount} הזמנות</span>
          <span>·</span>
          <span>{failure.DriverName}</span>
          <span>·</span>
          <Link to={`/runs/${failure.RunId}`} className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
            {failure.RunNumber} <ExternalLink size={10} />
          </Link>
        </div>

        {failure.PhotoUrl && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs text-brand-600 hover:underline inline-flex items-center gap-1"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'הסתר תמונה' : 'הצג תמונה'}
          </button>
        )}
        {expanded && failure.PhotoUrl && (
          <img src={failure.PhotoUrl} alt="Failure evidence" className="mt-2 max-h-48 rounded border" />
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-1 px-3 py-2 bg-white/70 border-t border-inherit">
        <button
          onClick={() => onReschedule(failure)}
          className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 text-xs bg-brand-600 text-white rounded hover:bg-brand-700"
        >
          <Calendar size={12} /> תזמן מחדש
        </button>
        {failure.CardCode && (
          <a
            href={`tel:${failure.CustomerPhone || ''}`}
            className="inline-flex items-center justify-center gap-1 py-1.5 px-2 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
            title="התקשר ללקוח"
          >
            <Phone size={12} />
          </a>
        )}
        <button
          onClick={() => {
            if (confirm('לסמן ככשל שטופל (מסירה לא תתבצע)?')) {
              resolveMutation.mutate('RESOLVED');
            }
          }}
          className="inline-flex items-center gap-1 py-1.5 px-2 text-xs bg-white border border-gray-300 rounded hover:bg-gray-50"
          title="סמן כטופל"
        >
          <CheckCircle size={12} />
        </button>
        <button
          onClick={() => {
            if (confirm('לבטל את ההזמנות בעצירה זו?')) {
              resolveMutation.mutate('CANCELLED');
            }
          }}
          className="inline-flex items-center gap-1 py-1.5 px-2 text-xs bg-white border border-red-300 text-red-600 rounded hover:bg-red-50"
          title="בטל"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

export default function FailuresPage() {
  const queryClient = useQueryClient();
  const [rescheduleFailure, setRescheduleFailure] = useState(null);
  const [includeResolved, setIncludeResolved] = useState(false);

  const { data: failures, isLoading, refetch } = useQuery({
    queryKey: ['failures', includeResolved],
    queryFn: () => failuresApi.list(includeResolved),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const socket = getSocket();
    const handlers = [
      ['failure:reported', () => { queryClient.invalidateQueries({ queryKey: ['failures'] }); toast.error('🚨 כשל חדש דווח'); }],
      ['failure:rescheduled', () => queryClient.invalidateQueries({ queryKey: ['failures'] })],
      ['failure:resolved', () => queryClient.invalidateQueries({ queryKey: ['failures'] })],
    ];
    handlers.forEach(([evt, h]) => socket.on(evt, h));
    return () => handlers.forEach(([evt, h]) => socket.off(evt, h));
  }, [queryClient]);

  const byCat = (failures || []).reduce((acc, f) => {
    (acc[f.Severity] ||= []).push(f);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <AlertTriangle className="text-red-500" />
            ניהול כשלים
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            כשלים פתוחים הדורשים טיפול • מתעדכן אוטומטית
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => setIncludeResolved(e.target.checked)}
            />
            הצג גם שנפתרו
          </label>
          <button
            onClick={() => refetch()}
            className="p-2 hover:bg-gray-100 rounded-lg"
            title="רענן"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !failures?.length ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <CheckCircle className="mx-auto text-green-500 mb-3" size={40} />
          <p className="text-gray-700">הכל תקין ✓</p>
          <p className="text-sm text-gray-500 mt-1">אין כשלים פתוחים כרגע</p>
        </div>
      ) : (
        <div className="space-y-6">
          {['HIGH', 'MEDIUM', 'LOW'].map((severity) => {
            const list = byCat[severity];
            if (!list?.length) return null;
            return (
              <div key={severity}>
                <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <AlertCircle className={SEVERITY_STYLE[severity].icon} size={14} />
                  {SEVERITY_STYLE[severity].label} ({list.length})
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {list.map((f) => (
                    <FailureCard
                      key={f.FailureId}
                      failure={f}
                      onReschedule={setRescheduleFailure}
                      onResolve={() => queryClient.invalidateQueries({ queryKey: ['failures'] })}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rescheduleFailure && (
        <RescheduleDialog
          failure={rescheduleFailure}
          onClose={() => setRescheduleFailure(null)}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['failures'] })}
        />
      )}
    </div>
  );
}
