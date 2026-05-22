/**
 * PickerTasksPage — Picker Task Inbox (2026-05-22).
 *
 * Route: /picker/tasks
 *
 * The picker (or a planner viewing on their behalf) chooses themself
 * from a dropdown, and sees only the waves currently assigned to them
 * in PENDING / IN_PROGRESS / PENDING_QC status. Tapping a wave card
 * routes to /picking/<waveId> (the existing PickingPage).
 *
 * MVP auth model: the dropdown selects an identity client-side and
 * persists it to localStorage so the same handheld remembers across
 * sessions. The backend gate is still `requireAuthBasic` — any
 * authenticated user can fetch any picker's queue. A future PIN-based
 * /api/picker/me/waves can live alongside this without changing the
 * page (just swap the source of pickerId).
 *
 * Mobile-first by design: big cards, big buttons, RTL, large fonts,
 * no hover-only affordances. Refetch every 20 s so the inbox reflects
 * new assignments without manual reload.
 */
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Warehouse, ChevronLeft, Loader2, AlertTriangle, Package, MapPin,
  Clock, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { pickableUsersApi, pickerTasksApi } from '../services/api.js';

const STORAGE_KEY = 'picker.tasks.selectedPickerId.v1';

function loadStoredPickerId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function saveStoredPickerId(pickerId) {
  try { localStorage.setItem(STORAGE_KEY, String(pickerId)); } catch {}
}

const STATUS_LABEL = {
  PENDING:     'ממתין',
  IN_PROGRESS: 'בתהליך',
  PENDING_QC:  'ממתין לבקרה',
};
const STATUS_CLASS = {
  PENDING:     'bg-gray-100 text-gray-700 border-gray-300',
  IN_PROGRESS: 'bg-amber-100 text-amber-800 border-amber-300',
  PENDING_QC:  'bg-purple-100 text-purple-800 border-purple-300',
};

export default function PickerTasksPage() {
  const navigate = useNavigate();

  // ── Pickable users (dropdown source) ─────────────────────────────────
  // /api/pickable-users returns the 4 real pickers from store.pickers
  // (after the source-correction fix). Cached 60 s — list rarely changes.
  const usersQuery = useQuery({
    queryKey: ['pickable-users'],
    queryFn:  pickableUsersApi.list,
    staleTime: 60_000,
  });
  const pickers = usersQuery.data || [];

  // ── Selected picker ──────────────────────────────────────────────────
  const [pickerId, setPickerId] = useState(loadStoredPickerId);

  // If localStorage had a stale id, prune it once the user list loads.
  useEffect(() => {
    if (pickerId && pickers.length > 0 && !pickers.find((p) => p.userId === pickerId)) {
      setPickerId(null);
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  }, [pickerId, pickers]);

  function handlePick(e) {
    const v = Number(e.target.value);
    if (Number.isInteger(v) && v > 0) {
      setPickerId(v);
      saveStoredPickerId(v);
    } else {
      setPickerId(null);
    }
  }

  // ── Assigned waves for the chosen picker ─────────────────────────────
  const wavesQuery = useQuery({
    queryKey: ['picker-tasks', pickerId],
    queryFn:  () => pickerTasksApi.listAssignedWaves(pickerId),
    enabled:  !!pickerId,
    refetchInterval: 20_000,
  });
  const waves = wavesQuery.data || [];

  const pickerName = pickers.find((p) => p.userId === pickerId)?.fullName || '';

  return (
    <div className="min-h-screen bg-gray-50" dir="rtl">
      {/* Mobile-first header — sticks to the top so the picker always
          knows who they are and can swap accounts in one tap. */}
      <header className="bg-white border-b sticky top-0 z-10">
        <div className="px-4 py-3 max-w-3xl mx-auto">
          <div className="flex items-center gap-2 mb-2">
            <Warehouse className="text-emerald-600" size={22} />
            <h1 className="text-lg font-bold">הליקוטים שלי</h1>
          </div>
          <label className="block text-xs text-gray-600 mb-1">בחר מלקט:</label>
          <select
            value={pickerId || ''}
            onChange={handlePick}
            disabled={usersQuery.isLoading}
            className="w-full px-3 py-3 text-base border-2 border-gray-300 rounded-lg bg-white disabled:opacity-60"
            aria-label="בחר מלקט"
          >
            <option value="">{usersQuery.isLoading ? 'טוען מלקטים…' : '— בחר מלקט —'}</option>
            {pickers.map((p) => (
              <option key={p.userId} value={p.userId}>{p.fullName}</option>
            ))}
          </select>
          {usersQuery.error && (
            <div className="mt-2 text-xs text-red-700">
              שגיאה בטעינת רשימת המלקטים. נסה לרענן.
            </div>
          )}
        </div>
      </header>

      {/* Body */}
      <main className="px-4 py-4 max-w-3xl mx-auto space-y-3">
        {!pickerId && !usersQuery.isLoading && (
          <EmptyHint
            icon={<Warehouse size={48} className="text-gray-300" />}
            title="בחר מלקט מהרשימה למעלה"
            sub="לאחר הבחירה יוצגו הליקוטים שהוקצו לאותו מלקט."
          />
        )}

        {pickerId && wavesQuery.isLoading && (
          <div className="text-center py-12 text-gray-500">
            <Loader2 size={32} className="animate-spin mx-auto mb-3" />
            <div className="text-sm">טוען ליקוטים…</div>
          </div>
        )}

        {pickerId && wavesQuery.error && (
          <ErrorCard
            error={wavesQuery.error}
            onRetry={() => wavesQuery.refetch()}
          />
        )}

        {pickerId && !wavesQuery.isLoading && !wavesQuery.error && (
          <>
            <div className="text-sm text-gray-700 mb-2">
              שלום <span className="font-semibold">{pickerName}</span> ·
              {' '}
              {waves.length > 0
                ? `${waves.length} ${waves.length === 1 ? 'ליקוט פתוח' : 'ליקוטים פתוחים'}`
                : 'אין ליקוטים פתוחים כרגע'}
            </div>

            {waves.length === 0 ? (
              <EmptyHint
                icon={<CheckCircle2 size={48} className="text-emerald-300" />}
                title="אין ליקוטים פתוחים כרגע"
                sub="ברגע שמנהל לוגיסטיקה ישלח אליך ליקוט, הוא יופיע כאן אוטומטית."
              />
            ) : (
              waves.map((w) => (
                <WaveCard
                  key={w.waveId}
                  wave={w}
                  onOpen={() => navigate(`/picking/${w.waveId}`)}
                />
              ))
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────

function WaveCard({ wave, onOpen }) {
  const {
    waveNumber, runNumber, zoneName, zoneCode, zoneColor,
    status, orderCount, lineCount, completedLineCount, shortageCount,
  } = wave;
  const pct = lineCount > 0 ? Math.round((completedLineCount / lineCount) * 100) : 0;
  const statusCls = STATUS_CLASS[status] || 'bg-gray-100 text-gray-700 border-gray-300';
  const statusLabel = STATUS_LABEL[status] || status;

  return (
    <div className="bg-white border-2 border-gray-200 rounded-xl p-4 shadow-sm">
      {/* Zone badge + status */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <MapPin size={18} style={{ color: zoneColor || '#666' }} />
          <div>
            <div className="font-bold text-base">{zoneName || '—'}</div>
            <div className="text-xs text-gray-500 font-mono">{zoneCode || ''}</div>
          </div>
        </div>
        <span className={`px-2.5 py-1 text-xs font-medium rounded-full border ${statusCls}`}>
          {statusLabel}
        </span>
      </div>

      {/* Meta */}
      <div className="text-xs text-gray-600 font-mono mb-2">
        {waveNumber}
        <span className="text-gray-400"> · </span>
        {runNumber}
      </div>

      {/* Counters */}
      <div className="grid grid-cols-3 gap-2 mb-3 text-center">
        <Counter label="הזמנות" value={orderCount} icon={<Package size={14} />} />
        <Counter label="שורות"   value={lineCount} icon={<Clock size={14} />} />
        <Counter
          label="הושלמו"
          value={`${completedLineCount}/${lineCount}`}
          icon={<CheckCircle2 size={14} className="text-emerald-600" />}
        />
      </div>

      {/* Progress bar */}
      {lineCount > 0 && (
        <div className="mb-3">
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1 text-[11px] text-gray-500">
            <span>{pct}% הושלמו</span>
            {shortageCount > 0 && (
              <span className="text-red-700 inline-flex items-center gap-1">
                <AlertCircle size={11} /> {shortageCount} חוסרים
              </span>
            )}
          </div>
        </div>
      )}

      {/* CTA — large, full width, easy to tap on a handheld. */}
      <button
        onClick={onOpen}
        className="w-full px-4 py-3 text-base font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 active:bg-emerald-800 inline-flex items-center justify-center gap-2"
      >
        פתח ליקוט <ChevronLeft size={18} />
      </button>
    </div>
  );
}

function Counter({ label, value, icon }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg py-2">
      <div className="flex items-center justify-center gap-1 text-gray-600 text-[11px] mb-0.5">
        {icon} {label}
      </div>
      <div className="text-base font-semibold">{value}</div>
    </div>
  );
}

function EmptyHint({ icon, title, sub }) {
  return (
    <div className="bg-white border-2 border-dashed border-gray-200 rounded-xl px-6 py-10 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <div className="text-base font-medium text-gray-700">{title}</div>
      {sub && <div className="text-sm text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

function ErrorCard({ error, onRetry }) {
  const code = error?.response?.data?.code;
  const msg  = error?.response?.data?.error || error?.message || 'שגיאה לא ידועה';
  return (
    <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm flex-1">
          <div className="font-bold text-red-900">לא ניתן לטעון את הליקוטים</div>
          <div className="text-red-700 text-xs mt-1">
            {msg}
            {code && <span className="ml-2 font-mono">({code})</span>}
          </div>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 w-full px-3 py-2 text-sm border border-red-300 rounded-lg hover:bg-white"
        >
          נסה שוב
        </button>
      )}
    </div>
  );
}
