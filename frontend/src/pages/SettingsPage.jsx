/**
 * Settings + SAP Connection Wizard.
 *
 * Main page for administrators to:
 *   - Test SAP connection health (SQL + Service Layer for both companies)
 *   - View sample data from each company
 *   - Configure runtime settings (warehouse codes, notifications, etc.)
 *   - Troubleshoot connection issues with actionable hints
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sapApi, settingsApi } from '../services/api.js';
import api from '../services/api.js';
import { useAuthStore } from '../stores/auth.js';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  Database, Server, CheckCircle, XCircle, AlertCircle, RefreshCw,
  Settings as SettingsIcon, Building2, Eye, ChevronDown, ChevronUp, Package, User, ShoppingCart,
  KeyRound, UserCircle,
} from 'lucide-react';

// Phase 4a — self-service account section. Lives at the top of Settings so
// any user (not just admin) sees it. Two cards: change password, edit
// profile. Both write through /api/users/me/* with the user's own token.
function AccountSection() {
  const { user, setAuth, logout } = useAuthStore();
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [fullName, setFullName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [phone, setPhone] = useState(user?.phone || '');

  const changePwd = useMutation({
    mutationFn: () => api.post('/users/me/change-password', {
      oldPassword: oldPwd, newPassword: newPwd,
    }).then((r) => r.data),
    onSuccess: () => {
      toast.success('הסיסמה הוחלפה. התחבר/י מחדש.');
      setTimeout(() => { logout(); window.location.href = '/login'; }, 800);
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בהחלפת הסיסמה'),
  });

  const updateProfile = useMutation({
    mutationFn: () => api.patch('/users/me/profile', { fullName, email, phone }).then((r) => r.data),
    onSuccess: (data) => {
      toast.success('הפרטים עודכנו');
      setAuth({ user: { ...user, ...data.user }, token: localStorage.getItem('token') });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בעדכון הפרטים'),
  });

  const PWD_RULES = [
    { test: (p) => p.length >= 10, label: '10+ תווים' },
    { test: (p) => /[A-Za-z֐-׿]/.test(p), label: 'אות' },
    { test: (p) => /\d/.test(p), label: 'ספרה' },
    { test: (p) => /[^A-Za-z0-9֐-׿]/.test(p), label: 'תו מיוחד' },
  ];
  const pwdValid = PWD_RULES.every((r) => r.test(newPwd)) && newPwd === confirmPwd && newPwd !== oldPwd;

  return (
    <div className="grid md:grid-cols-2 gap-4 mb-6">
      <div className="border-2 border-gray-200 rounded-2xl p-5 bg-white">
        <div className="flex items-center gap-2 mb-3">
          <KeyRound size={20} className="text-brand-600" />
          <h3 className="font-bold">החלפת סיסמה</h3>
        </div>
        <div className="space-y-2">
          <input
            type="password" placeholder="סיסמה נוכחית" value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)} autoComplete="current-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="password" placeholder="סיסמה חדשה" value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)} autoComplete="new-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <input
            type="password" placeholder="אימות סיסמה חדשה" value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)} autoComplete="new-password"
            className={`w-full px-3 py-2 border rounded-lg text-sm ${
              confirmPwd && confirmPwd !== newPwd ? 'border-red-400' : 'border-gray-300'
            }`}
          />
          <ul className="text-[10px] flex flex-wrap gap-x-2 gap-y-0.5 text-gray-500">
            {PWD_RULES.map((r, i) => (
              <li key={i} className={r.test(newPwd) ? 'text-green-700' : ''}>
                {r.test(newPwd) ? '✓' : '○'} {r.label}
              </li>
            ))}
          </ul>
          <button
            onClick={() => changePwd.mutate()}
            disabled={!oldPwd || !pwdValid || changePwd.isPending}
            className="w-full mt-2 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-bold disabled:opacity-50"
          >
            {changePwd.isPending ? 'מעדכן...' : 'החלף סיסמה'}
          </button>
        </div>
      </div>

      <div className="border-2 border-gray-200 rounded-2xl p-5 bg-white">
        <div className="flex items-center gap-2 mb-3">
          <UserCircle size={20} className="text-brand-600" />
          <h3 className="font-bold">פרטים אישיים</h3>
        </div>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-gray-500">שם מלא</label>
            <input
              type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">מייל</label>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500">טלפון נייד</label>
            <input
              type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <button
            onClick={() => updateProfile.mutate()}
            disabled={updateProfile.isPending}
            className="w-full mt-2 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-bold disabled:opacity-50"
          >
            {updateProfile.isPending ? 'מעדכן...' : 'שמור פרטים'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CheckCard({ title, check, icon: Icon, onRetry }) {
  const [expanded, setExpanded] = useState(false);

  const ok = check?.ok;
  const stepLabels = {
    tcp: 'חיבור רשת',
    auth: 'אימות',
    schema: 'בדיקת סכמה',
    config: 'הגדרות',
    ok: 'תקין',
  };

  return (
    <div className={`border rounded-xl overflow-hidden ${ok ? 'border-green-300 bg-green-50' : check ? 'border-red-300 bg-red-50' : 'border-gray-300 bg-gray-50'}`}>
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${ok ? 'bg-green-100 text-green-600' : check ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500'}`}>
              <Icon size={18} />
            </div>
            <div>
              <div className="font-semibold">{title}</div>
              {check && (
                <div className="text-xs text-gray-500 mt-0.5">
                  {check.dbName && <span className="font-mono">{check.dbName}</span>}
                  {check.latencyMs != null && <span className="mr-2">· {check.latencyMs}ms</span>}
                </div>
              )}
            </div>
          </div>
          <div>
            {ok ? (
              <CheckCircle className="text-green-500" size={22} />
            ) : check ? (
              <XCircle className="text-red-500" size={22} />
            ) : (
              <RefreshCw className="text-gray-400 animate-spin" size={20} />
            )}
          </div>
        </div>

        {check && !ok && (
          <div className="mt-3 p-3 bg-white/70 rounded-lg border border-red-200">
            <div className="text-xs text-gray-500 mb-1">{stepLabels[check.step] || check.step}</div>
            <div className="text-sm text-red-700 font-medium break-words">{check.error}</div>
            {check.hint && (
              <div className="text-sm mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-amber-800">
                💡 {check.hint}
              </div>
            )}
          </div>
        )}

        {check && ok && check.stats && (
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            <div className="bg-white/70 rounded p-2">
              <div className="text-lg font-bold">{check.stats.Customers || 0}</div>
              <div className="text-[10px] text-gray-500">לקוחות</div>
            </div>
            <div className="bg-white/70 rounded p-2">
              <div className="text-lg font-bold">{check.stats.Items || 0}</div>
              <div className="text-[10px] text-gray-500">פריטים</div>
            </div>
            <div className="bg-white/70 rounded p-2">
              <div className="text-lg font-bold">{check.stats.TotalOrders || 0}</div>
              <div className="text-[10px] text-gray-500">סה"כ הזמנות</div>
            </div>
            <div className="bg-white/70 rounded p-2">
              <div className="text-lg font-bold text-brand-600">{check.stats.OpenOrders || 0}</div>
              <div className="text-[10px] text-gray-500">פתוחות</div>
            </div>
          </div>
        )}

        {check && ok && check.sessionTimeoutMinutes != null && (
          <div className="mt-3 text-xs text-gray-600">
            Session מאושר - פג תוקף בעוד {check.sessionTimeoutMinutes} דקות
          </div>
        )}
      </div>
    </div>
  );
}

function SamplePreview({ companyCode, companyName }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sap-sample', companyCode],
    queryFn: () => sapApi.sample(companyCode),
    enabled: expanded,
  });

  return (
    <div className="border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
            <Eye size={18} />
          </div>
          <div className="text-right">
            <div className="font-semibold">תצוגה מקדימה - {companyName}</div>
            <div className="text-xs text-gray-500">דוגמאות לקוחות, פריטים והזמנות מ-SAP</div>
          </div>
        </div>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded && (
        <div className="border-t p-4 bg-gray-50">
          {isLoading ? (
            <div className="text-center py-6 text-gray-500 text-sm">טוען דוגמאות...</div>
          ) : error ? (
            <div className="text-center py-6">
              <p className="text-red-600 text-sm mb-2">שגיאה בטעינת דוגמאות</p>
              <button onClick={() => refetch()} className="text-xs text-brand-600 hover:underline">
                נסה שוב
              </button>
            </div>
          ) : data && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Customers */}
              <div className="bg-white rounded-lg p-3">
                <h4 className="font-medium text-sm mb-2 flex items-center gap-1">
                  <User size={14} /> לקוחות ({data.customers.length})
                </h4>
                <div className="space-y-1 max-h-40 overflow-auto">
                  {data.customers.map((c) => (
                    <div key={c.CardCode} className="text-xs border-b py-1 last:border-0">
                      <div className="font-medium">{c.CardName}</div>
                      <div className="text-gray-500 font-mono">{c.CardCode}</div>
                      {c.City && <div className="text-gray-400">{c.City}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Items */}
              <div className="bg-white rounded-lg p-3">
                <h4 className="font-medium text-sm mb-2 flex items-center gap-1">
                  <Package size={14} /> פריטים ({data.items.length})
                </h4>
                <div className="space-y-1 max-h-40 overflow-auto">
                  {data.items.map((i) => (
                    <div key={i.ItemCode} className="text-xs border-b py-1 last:border-0">
                      <div className="font-medium truncate" title={i.ItemName}>{i.ItemName}</div>
                      <div className="text-gray-500 font-mono">{i.ItemCode}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Orders */}
              <div className="bg-white rounded-lg p-3">
                <h4 className="font-medium text-sm mb-2 flex items-center gap-1">
                  <ShoppingCart size={14} /> הזמנות פתוחות ({data.recentOrders.length})
                </h4>
                <div className="space-y-1 max-h-40 overflow-auto">
                  {data.recentOrders.length === 0 ? (
                    <div className="text-xs text-gray-400">אין הזמנות פתוחות</div>
                  ) : data.recentOrders.map((o) => (
                    <div key={o.DocEntry} className="text-xs border-b py-1 last:border-0">
                      <div className="flex items-center justify-between">
                        <span className="font-mono">#{o.DocNum}</span>
                        <span className="text-gray-500">{o.LineCount} שורות</span>
                      </div>
                      <div className="text-gray-600 truncate">{o.CardName}</div>
                      <div className="text-gray-400">
                        {format(new Date(o.DocDueDate), 'dd/MM/yyyy')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsEditor({ category, title }) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings', category],
    queryFn: () => settingsApi.list(category),
  });

  const mutation = useMutation({
    mutationFn: ({ key, value }) => settingsApi.update(key, value),
    onSuccess: () => {
      toast.success('נשמר');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (!settings?.length) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="font-semibold text-lg mb-4">{title}</h3>
      <div className="space-y-3">
        {settings.map((s) => (
          <SettingEditor key={s.key} setting={s} onSave={(value) => mutation.mutate({ key: s.key, value })} />
        ))}
      </div>
    </div>
  );
}

function SettingEditor({ setting, onSave }) {
  const [value, setValue] = useState(setting.value ?? '');
  const [dirty, setDirty] = useState(false);

  return (
    <div className="grid grid-cols-3 gap-3 items-start pb-3 border-b border-gray-100 last:border-0">
      <div className="col-span-1">
        <div className="text-sm font-medium">{setting.description || setting.key}</div>
        <div className="text-xs text-gray-500 font-mono">{setting.key}</div>
      </div>
      <div className="col-span-2 flex items-center gap-2">
        {setting.dataType === 'BOOLEAN' ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => { setValue(e.target.checked); setDirty(true); }}
            />
            {value ? 'פעיל' : 'כבוי'}
          </label>
        ) : (
          <input
            type="text"
            value={value || ''}
            onChange={(e) => { setValue(e.target.value); setDirty(true); }}
            className="flex-1 px-3 py-1.5 border rounded text-sm"
          />
        )}
        {dirty && (
          <button
            onClick={() => { onSave(value); setDirty(false); }}
            className="px-3 py-1.5 bg-brand-600 text-white rounded text-sm"
          >
            שמור
          </button>
        )}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const { data: diag, isLoading: diagLoading, refetch: refetchDiag } = useQuery({
    queryKey: ['sap-diagnose'],
    queryFn: () => sapApi.diagnose(),
  });

  const runDiagnostic = useMutation({
    mutationFn: () => sapApi.diagnose(),
    onSuccess: (result) => {
      queryClient.setQueryData(['sap-diagnose'], result);
      if (result.status === 'fully-connected') {
        toast.success('כל החיבורים תקינים ✓');
      } else {
        toast.warning(`${result.summary.ok}/${result.summary.total} חיבורים תקינים`);
      }
    },
  });

  const status = diag?.status || 'unknown';
  const statusColor = status === 'fully-connected' ? 'green' : status === 'partial' ? 'amber' : 'red';
  const statusLabel = status === 'fully-connected' ? 'מחובר לחלוטין' : status === 'partial' ? 'חלקי' : 'מנותק';

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
        <SettingsIcon /> הגדרות מערכת
      </h1>
      <p className="text-sm text-gray-500 mb-6">חשבון, חיבור SAP, הגדרות כלליות וטרבלשוטינג</p>

      {/* Phase 4a — self-service account section. Shown to every signed-in user. */}
      <AccountSection />

      {/* SAP Connection Status */}
      <div className={`border-2 rounded-2xl p-5 mb-6 bg-${statusColor}-50 border-${statusColor}-300`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Database size={28} className={`text-${statusColor}-600`} />
            <div>
              <h2 className="text-lg font-bold">חיבור SAP Business One</h2>
              <p className="text-sm text-gray-600">
                סטטוס: <span className={`font-semibold text-${statusColor}-700`}>{statusLabel}</span>
                {diag && <span className="text-gray-500"> · נבדק {format(new Date(diag.checkedAt), 'HH:mm:ss')}</span>}
              </p>
            </div>
          </div>
          <button
            onClick={() => runDiagnostic.mutate()}
            disabled={runDiagnostic.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={runDiagnostic.isPending ? 'animate-spin' : ''} />
            בדוק חיבור
          </button>
        </div>

        {diagLoading ? (
          <div className="text-center py-6 text-gray-500">בודק חיבורים...</div>
        ) : !diag ? (
          <div className="text-center py-6 text-gray-500">לחץ "בדוק חיבור" כדי להתחיל</div>
        ) : (
          <>
            <h3 className="font-semibold text-sm mb-3 mt-2">SQL Server (קריאה)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <CheckCard
                title="חברה א - SQL"
                check={diag.checks.sqlCompanyA}
                icon={Building2}
              />
              <CheckCard
                title="חברה ב - SQL"
                check={diag.checks.sqlCompanyB}
                icon={Building2}
              />
            </div>

            <h3 className="font-semibold text-sm mb-3">Service Layer (כתיבה)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CheckCard
                title="חברה א - Service Layer"
                check={diag.checks.serviceLayerCompanyA}
                icon={Server}
              />
              <CheckCard
                title="חברה ב - Service Layer"
                check={diag.checks.serviceLayerCompanyB}
                icon={Server}
              />
            </div>

            {diag.status === 'fully-connected' && (
              <div className="mt-5 p-4 bg-white/70 rounded-lg border border-green-200 flex items-start gap-2">
                <CheckCircle className="text-green-500 shrink-0 mt-0.5" size={18} />
                <div>
                  <div className="font-medium text-sm">החיבור עובד בצורה מלאה!</div>
                  <div className="text-xs text-gray-600 mt-1">
                    כעת תוכל להשתמש בכל הפיצ'רים של המערכת: קריאת הזמנות, יצירת תעודות משלוח, ניהול חזרות וכו'.
                  </div>
                </div>
              </div>
            )}

            {diag.status !== 'fully-connected' && (
              <div className="mt-5 p-4 bg-white/70 rounded-lg border border-amber-200">
                <div className="font-medium text-sm mb-2">📖 להתחברות מלאה:</div>
                <ol className="text-xs text-gray-600 space-y-1 pr-5 list-decimal">
                  <li>ערוך את הקובץ <code className="bg-gray-100 px-1 rounded">backend/.env</code></li>
                  <li>הזן פרטי חיבור נכונים לפי ההוראות למעלה</li>
                  <li>הפעל מחדש את שרת ה-Backend</li>
                  <li>חזור לדף זה ולחץ "בדוק חיבור"</li>
                </ol>
              </div>
            )}
          </>
        )}
      </div>

      {/* Sample data preview - only show for connected companies */}
      {diag?.checks?.sqlCompanyA?.ok && (
        <div className="mb-6">
          <SamplePreview companyCode="A" companyName="חברה א" />
        </div>
      )}
      {diag?.checks?.sqlCompanyB?.ok && (
        <div className="mb-6">
          <SamplePreview companyCode="B" companyName="חברה ב" />
        </div>
      )}

      {/* Runtime settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <SettingsEditor category="WAREHOUSE" title="🏭 מחסן" />
        <SettingsEditor category="NOTIFICATIONS" title="📧 התראות" />
      </div>
      <div className="mb-6">
        <SettingsEditor category="GENERAL" title="⚙️ כללי" />
      </div>
    </div>
  );
}
