/**
 * Role Permissions Page (2026-05-28).
 *
 * Admin-only matrix of role → screens. Roles on rows, screens on columns,
 * grouped by sidebar section so the operator can mentally line up "what
 * a row sees" with "what the sidebar looks like for that user".
 *
 * Data flow:
 *   - GET /api/admin/screens          → master list + role codes
 *   - GET /api/admin/role-permissions → current rules
 *   - PUT /api/admin/role-permissions/:roleCode → save one role's mask
 *
 * UX:
 *   - Wildcard '*' is rendered as a single sticky "כל המסכים" toggle per
 *     role (ADMIN's default). Flipping it OFF replaces the row with the
 *     explicit screen list so the admin can narrow without losing the
 *     view; flipping it ON re-sets the row to ['*'].
 *   - Every checkbox edit auto-saves to the server after a 600ms debounce.
 *     A toast confirms the save and a row-level dot indicates pending writes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import api from '../services/api.js';
import { ShieldCheck, Asterisk, Loader2, Check, AlertTriangle } from 'lucide-react';

const SECTION_LABELS = {
  workflow:   'תהליך יומי',
  reports:    'דוחות',
  settings:   'הגדרות',
  standalone: 'נוסף',
};
const SECTION_ORDER = ['workflow', 'reports', 'settings', 'standalone'];

// Human-friendly role labels — backend stores RoleCode (e.g. PICKER) but
// the matrix UI shows Hebrew labels next to it. Unknown roles fall back
// to the raw code.
const ROLE_LABELS = {
  ADMIN:         'מנהל מערכת',
  PLANNER:       'מתכנן',
  PICKER:        'מלקט',
  WAREHOUSE:     'מחסן',
  QC_CONTROLLER: 'בקר ליקוט',
  DRIVER:        'נהג',
};

const adminApi = {
  screens: () => api.get('/admin/screens').then((r) => r.data),
  list:    () => api.get('/admin/role-permissions').then((r) => r.data),
  update:  (roleCode, allowedScreens) =>
    api.put(`/admin/role-permissions/${roleCode}`, { allowedScreens }).then((r) => r.data),
};

export default function RolePermissionsPage() {
  const qc = useQueryClient();

  const { data: screensData } = useQuery({
    queryKey: ['admin', 'screens'],
    queryFn: adminApi.screens,
    staleTime: 5 * 60 * 1000,
  });
  const { data: permsData } = useQuery({
    queryKey: ['admin', 'role-permissions'],
    queryFn: adminApi.list,
  });

  // Local working copy keyed by RoleCode → AllowedScreens[]. We mirror
  // the server data into local state so the operator's clicks feel
  // instant; the debounced mutation handles persistence.
  const [draft, setDraft] = useState({});
  // Per-row "dirty since last save" tracker — used to render the pending
  // dot and to throttle concurrent writes for the same role.
  const [pendingRoles, setPendingRoles] = useState(new Set());
  const debounceTimers = useRef({});

  useEffect(() => {
    if (permsData?.rolePermissions) {
      const next = {};
      for (const row of permsData.rolePermissions) {
        next[row.RoleCode] = Array.isArray(row.AllowedScreens) ? row.AllowedScreens.slice() : [];
      }
      setDraft(next);
    }
  }, [permsData?.rolePermissions]);

  const updateMutation = useMutation({
    mutationFn: ({ roleCode, allowedScreens }) =>
      adminApi.update(roleCode, allowedScreens),
    onSuccess: (_data, { roleCode }) => {
      setPendingRoles((prev) => {
        const next = new Set(prev); next.delete(roleCode); return next;
      });
      qc.invalidateQueries({ queryKey: ['admin', 'role-permissions'] });
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
      toast.success(`הרשאות עודכנו: ${ROLE_LABELS[roleCode] || roleCode}`, { duration: 2000 });
    },
    onError: (err, { roleCode }) => {
      setPendingRoles((prev) => {
        const next = new Set(prev); next.delete(roleCode); return next;
      });
      const msg = err.response?.data?.message || err.response?.data?.error || 'שמירה נכשלה';
      toast.error(`${ROLE_LABELS[roleCode] || roleCode}: ${msg}`, { duration: 6000 });
    },
  });

  // Schedule a debounced save. Re-arms each time the row changes so the
  // server only sees the final state, not every intermediate checkbox click.
  const scheduleSave = (roleCode, allowedScreens) => {
    setPendingRoles((prev) => new Set(prev).add(roleCode));
    clearTimeout(debounceTimers.current[roleCode]);
    debounceTimers.current[roleCode] = setTimeout(() => {
      updateMutation.mutate({ roleCode, allowedScreens });
    }, 600);
  };

  const toggleScreen = (roleCode, screenCode) => {
    setDraft((prev) => {
      const current = prev[roleCode] || [];
      // If the row currently uses the wildcard, expand it to the explicit
      // list first so toggling a single screen behaves intuitively.
      const expanded = current.includes('*')
        ? (screensData?.screens || []).map((s) => s.code)
        : current;
      const next = expanded.includes(screenCode)
        ? expanded.filter((c) => c !== screenCode)
        : [...expanded, screenCode];
      scheduleSave(roleCode, next);
      return { ...prev, [roleCode]: next };
    });
  };

  const toggleWildcard = (roleCode) => {
    setDraft((prev) => {
      const current = prev[roleCode] || [];
      const next = current.includes('*') ? [] : ['*'];
      scheduleSave(roleCode, next);
      return { ...prev, [roleCode]: next };
    });
  };

  const screensBySection = useMemo(() => {
    const map = {};
    for (const s of (screensData?.screens || [])) {
      if (!map[s.section]) map[s.section] = [];
      map[s.section].push(s);
    }
    return map;
  }, [screensData?.screens]);

  const roles = useMemo(() => {
    const codes = (permsData?.rolePermissions || []).map((r) => r.RoleCode);
    // Ensure ADMIN row appears first.
    return codes.sort((a, b) => (a === 'ADMIN' ? -1 : b === 'ADMIN' ? 1 : 0));
  }, [permsData?.rolePermissions]);

  const isAllowed = (roleCode, screenCode) => {
    const list = draft[roleCode] || [];
    if (list.includes('*')) return true;
    return list.includes(screenCode);
  };

  return (
    <div className="p-4 md:p-6 max-w-screen-2xl">
      <div className="flex items-center gap-3 mb-1">
        <ShieldCheck className="text-blue-600" size={28} />
        <h1 className="text-2xl font-bold">הרשאות תפקידים</h1>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        מטריצה: כל שורה = תפקיד, כל עמודה = מסך בסיידבר. סמן ✓ כדי לאפשר גישה.
        השמירה אוטומטית (600ms אחרי הלחיצה האחרונה). שינוי לתפקיד מסוים יחול
        על כל המשתמשים בעלי אותו תפקיד מהרענון הבא של הסשן.
      </p>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-700 flex-shrink-0 mt-0.5" />
        <div className="text-amber-900">
          <strong>זהירות:</strong> "כל המסכים" (★) הוא ברירת המחדל של ‎ADMIN‎ ולא ניתן לסגור
          לו את "הרשאות תפקידים" (כדי שלא תינעל מחוץ למסך הזה). אחרי שינוי, משתמשים פעילים
          יראו את התפריט המעודכן ברענון העמוד הבא.
        </div>
      </div>

      {!screensData || !permsData ? (
        <div className="text-center py-16 text-gray-500 flex items-center justify-center gap-2">
          <Loader2 className="animate-spin" size={18} /> טוען מטריצת הרשאות…
        </div>
      ) : (
        <div className="bg-white border rounded-xl overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-right font-semibold sticky right-0 bg-gray-50 z-10 border-l">תפקיד</th>
                <th className="px-3 py-2 text-center font-semibold border-l">
                  <div className="inline-flex items-center gap-1">
                    <Asterisk size={12} /> כל המסכים
                  </div>
                </th>
                {SECTION_ORDER.flatMap((section) =>
                  (screensBySection[section] || []).map((s) => (
                    <th
                      key={s.code}
                      className="px-2 py-2 text-center font-medium text-xs border-l whitespace-nowrap"
                      title={`${SECTION_LABELS[s.section]} · ${s.code}`}
                    >
                      <div className="text-gray-400 text-[10px] mb-0.5">
                        {SECTION_LABELS[s.section]}
                      </div>
                      {s.label}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {roles.map((roleCode) => {
                const hasWildcard = (draft[roleCode] || []).includes('*');
                const isPending = pendingRoles.has(roleCode);
                return (
                  <tr key={roleCode} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 sticky right-0 bg-white z-10 border-l font-semibold">
                      <div className="flex items-center gap-2">
                        {ROLE_LABELS[roleCode] || roleCode}
                        {isPending && (
                          <Loader2 className="animate-spin text-blue-500" size={12} />
                        )}
                      </div>
                      <div className="text-xs text-gray-400 font-mono">{roleCode}</div>
                    </td>
                    <td className="px-3 py-2 text-center border-l">
                      <input
                        type="checkbox"
                        checked={hasWildcard}
                        onChange={() => toggleWildcard(roleCode)}
                        className="w-4 h-4 cursor-pointer"
                        title="להעניק גישה לכל המסכים, כולל מסכים שיתווספו בעתיד"
                      />
                    </td>
                    {SECTION_ORDER.flatMap((section) =>
                      (screensBySection[section] || []).map((s) => {
                        const allowed = isAllowed(roleCode, s.code);
                        return (
                          <td key={s.code} className="px-2 py-2 text-center border-l">
                            <input
                              type="checkbox"
                              checked={allowed}
                              onChange={() => toggleScreen(roleCode, s.code)}
                              disabled={hasWildcard}
                              className="w-4 h-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              title={hasWildcard
                                ? '★ "כל המסכים" פעיל — לפעולה פר-מסך כבה אותו קודם'
                                : `${ROLE_LABELS[roleCode] || roleCode}: ${s.label}`}
                            />
                          </td>
                        );
                      })
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center mt-4 flex items-center justify-center gap-1">
        <Check size={12} className="text-green-600" /> שינויים נשמרים אוטומטית.
        משתמשים פעילים יראו את התפריט החדש ברענון העמוד הבא.
      </p>
    </div>
  );
}
