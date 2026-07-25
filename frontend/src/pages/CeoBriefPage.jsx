/**
 * CEO Daily Brief — reads ceo_brief agent runs (v2 verified-metrics schema).
 *
 * Numbers shown in the KPI cards come from verified_metrics (computed
 * deterministically in code); the Hebrew narrative is the LLM layer on top.
 * ADMIN-only on the backend (/api/agents/*), so non-admins get a 403 toast.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import {
  Sparkles, AlertTriangle, AlertOctagon, AlertCircle, ShieldCheck,
  RefreshCw, TrendingUp, TrendingDown,
} from 'lucide-react';

const SEV_COLOR = {
  high: 'bg-red-50 border-red-300 text-red-900',
  medium: 'bg-amber-50 border-amber-300 text-amber-900',
  low: 'bg-blue-50 border-blue-300 text-blue-900',
};
const SEV_ICON = { high: AlertOctagon, medium: AlertTriangle, low: AlertCircle };
const CONF_LABEL = { high: 'גבוהה', medium: 'בינונית', low: 'נמוכה' };
const CONF_COLOR = {
  high: 'bg-green-100 text-green-800',
  medium: 'bg-amber-100 text-amber-800',
  low: 'bg-red-100 text-red-800',
};

const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const fmtMetric = (m) => {
  if (!m || m.value === null || m.value === undefined) return 'אין נתונים';
  if (typeof m.value === 'string') return m.value;
  if (m.unit === 'ILS') return `₪${nf.format(m.value)}`;
  if (m.unit === 'pct') return `${nf.format(m.value)}%`;
  return nf.format(m.value);
};

const KPI_IDS = [
  'revenue_yesterday_ils', 'revenue_last7_ils', 'revenue_wow_delta_pct',
  'revenue_mtd_ils', 'revenue_mtd_delta_pct',
  'revenue_last7_company_a_ils', 'revenue_last7_company_b_ils',
];

export default function CeoBriefPage() {
  const qc = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState(null);

  const { data: runsData, isLoading: runsLoading, error: runsError } = useQuery({
    queryKey: ['ceo-brief-runs'],
    queryFn: () => api.get('/agents/runs', { params: { agentName: 'ceo_brief', limit: 20 } }).then((r) => r.data),
    refetchInterval: 60_000,
  });

  const runs = runsData?.runs || [];
  const latestCompleted = runs.find((r) => r.Status === 'completed');
  const activeRunId = selectedRunId || latestCompleted?.RunId || null;

  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: ['ceo-brief-run', activeRunId],
    queryFn: () => api.get(`/agents/runs/${activeRunId}`).then((r) => r.data),
    enabled: !!activeRunId,
  });

  const runNow = useMutation({
    // A full brief takes ~30-60s (SAP queries + LLM) — override the 30s default
    mutationFn: () => api.post('/agents/ceo-brief/run', {}, { timeout: 180_000 }).then((r) => r.data),
    onSuccess: (result) => {
      setSelectedRunId(result.runId);
      qc.invalidateQueries({ queryKey: ['ceo-brief-runs'] });
      qc.invalidateQueries({ queryKey: ['ceo-brief-run'] });
    },
  });

  const brief = run?.Status === 'completed' ? run.Output : null;
  const isV2 = brief?.schema_version === 2;
  const notConfigured = runsError?.response?.status === 503;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="text-brand-600" /> תקציר מנכ"ל יומי
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            המספרים מחושבים דטרמיניסטית מ-SAP; הניתוח המילולי נכתב על ידי סוכן AI ונבדק מולם
          </p>
        </div>
        <button
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending || notConfigured}
          className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
        >
          <RefreshCw size={16} className={runNow.isPending ? 'animate-spin' : ''} />
          {runNow.isPending ? 'מפיק תקציר...' : 'הפק תקציר עכשיו'}
        </button>
      </div>

      {notConfigured ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-amber-800">
          סוכני ה-AI אינם מוגדרים — יש להגדיר ANTHROPIC_API_KEY בשרת.
        </div>
      ) : runsLoading || runLoading ? (
        <div className="text-center py-12 text-gray-500">טוען תקציר...</div>
      ) : !brief ? (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-12 text-center text-gray-600">
          אין עדיין תקציר. לחצו על "הפק תקציר עכשיו" כדי להריץ ראשון.
        </div>
      ) : !isV2 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 text-sm">
          ריצה זו נוצרה בגרסה ישנה של הסוכן (לפני ארכיטקטורת המספרים המאומתים) — הציגו ריצה חדשה יותר או הפיקו תקציר חדש.
        </div>
      ) : (
        <BriefView brief={brief} />
      )}

      {runs.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-bold text-gray-600 mb-2">ריצות אחרונות</h3>
          <div className="flex flex-wrap gap-2">
            {runs.map((r) => (
              <button
                key={r.RunId}
                onClick={() => setSelectedRunId(r.RunId)}
                className={`px-3 py-1.5 rounded-lg border text-xs ${
                  r.RunId === activeRunId
                    ? 'bg-brand-50 border-brand-300 text-brand-700 font-bold'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                } ${r.Status === 'failed' ? 'line-through opacity-60' : ''}`}
                title={r.Status}
              >
                #{r.RunId} · {new Date(r.StartedAt).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BriefView({ brief }) {
  const n = brief.narrative || {};
  const conf = brief.confidence?.overall || 'low';
  const metricById = new Map((brief.verified_metrics || []).map((m) => [m.id, m]));
  const anomalyById = new Map((brief.verified_anomalies || []).map((a) => [a.id, a]));
  const integrityIssues =
    (brief.integrity?.unverified_numbers_in_text?.length || 0) +
    (brief.integrity?.unknown_metric_ids?.length || 0) +
    (brief.integrity?.unknown_anomaly_ids?.length || 0);

  return (
    <div className="space-y-5">
      {/* Header card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <span className="text-lg font-bold">{brief.anchor_date}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${CONF_COLOR[conf]}`}>
            ודאות {CONF_LABEL[conf] || conf}
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <ShieldCheck size={14} className={integrityIssues === 0 ? 'text-green-600' : 'text-amber-600'} />
            {integrityIssues === 0
              ? 'הנרטיב עבר בדיקת אמינות — אפס מספרים לא-מאומתים'
              : `${integrityIssues} ממצאי אמינות בנרטיב`}
          </span>
        </div>
        {n.executive_summary && (
          <p className="text-[15px] leading-relaxed text-gray-800">{n.executive_summary}</p>
        )}
        {n.prioritization_note && (
          <div className="mt-3 bg-amber-50 border-r-4 border-amber-400 px-4 py-2 text-sm text-amber-900 rounded">
            {n.prioritization_note}
          </div>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {KPI_IDS.map((id) => {
          const m = metricById.get(id);
          if (!m) return null;
          const isDelta = m.unit === 'pct' && typeof m.value === 'number';
          return (
            <div key={id} className="bg-white border border-gray-200 rounded-xl p-3">
              <div className="text-xs text-gray-500">{m.label_he}</div>
              <div className="text-xl font-bold mt-0.5 flex items-center gap-1" dir="ltr">
                {isDelta && (m.value >= 0
                  ? <TrendingUp size={16} className="text-green-600" />
                  : <TrendingDown size={16} className="text-red-600" />)}
                <span className={isDelta ? (m.value >= 0 ? 'text-green-700' : 'text-red-700') : ''}>
                  {fmtMetric(m)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Anomalies */}
      {(n.anomaly_interpretations || []).length > 0 && (
        <Section title="חריגות">
          {n.anomaly_interpretations.map((ai, i) => {
            const a = anomalyById.get(ai.anomaly_id);
            const sev = a?.severity || 'low';
            const Icon = SEV_ICON[sev];
            return (
              <div key={i} className={`border-2 rounded-xl p-3 ${SEV_COLOR[sev]}`}>
                <div className="flex items-start gap-2">
                  <Icon size={18} className="shrink-0 mt-0.5" />
                  <div className="text-sm">{ai.business_meaning}</div>
                </div>
              </div>
            );
          })}
        </Section>
      )}

      {/* Risks + actions side by side */}
      <div className="grid md:grid-cols-2 gap-4">
        {(n.risks || []).length > 0 && (
          <Section title="סיכונים">
            {n.risks.map((r, i) => (
              <div key={i} className={`border rounded-lg p-3 text-sm ${SEV_COLOR[r.severity] || SEV_COLOR.low}`}>
                {r.description}
              </div>
            ))}
          </Section>
        )}
        {(n.recommended_actions || []).length > 0 && (
          <Section title="פעולות מומלצות">
            {n.recommended_actions.map((a, i) => (
              <div key={i} className="border border-gray-200 bg-white rounded-lg p-3 text-sm">
                <div className="font-bold">{a.action}</div>
                {a.rationale && <div className="text-gray-500 text-xs mt-0.5">{a.rationale}</div>}
              </div>
            ))}
          </Section>
        )}
      </div>

      <div className="text-xs text-gray-400">
        שלמות מקורות: {Math.round((brief.integrity?.sources_completeness ?? 0) * 100)}% ·
        ציון אמינות: {brief.integrity?.integrity_score ?? '—'} ·
        חושב ב-{new Date(brief.computed_at).toLocaleString('he-IL')}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-gray-600 mb-2">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
