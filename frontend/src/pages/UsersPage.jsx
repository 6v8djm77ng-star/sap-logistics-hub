/**
 * User management for admin - create, edit, deactivate, reset passwords,
 * manage alert subscriptions.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Users, Plus, Edit2, Key, UserCheck, UserX, Mail, Phone, Bell, X, Trash2 } from 'lucide-react';

const ROLE_LABELS = {
  ADMIN: 'מנהל מערכת',
  PLANNER: 'מתכנן',
  WAREHOUSE: 'מחסנאי',
  DRIVER: 'נהג',
  VIEWER: 'צפייה בלבד',
};

const ALERT_EVENTS = [
  { key: 'STOP_FAILED',      label: 'כשל במסירה (כל חומרה)' },
  { key: 'STOP_FAILED_HIGH', label: 'כשל קריטי בלבד' },
  { key: 'DAILY_DIGEST',     label: 'סיכום יומי (07:00 בבוקר)' },
];

const usersApi = {
  list: () => api.get('/users').then((r) => r.data.users),
  create: (data) => api.post('/users', data).then((r) => r.data),
  update: (id, data) => api.patch(`/users/${id}`, data).then((r) => r.data),
  delete: (id) => api.delete(`/users/${id}`).then((r) => r.data),
  resetPassword: (id, password) => api.post(`/users/${id}/reset-password`, { password }).then((r) => r.data),
  mySubs: () => api.get('/users/me/subscriptions').then((r) => r.data.subscriptions),
  updateMySubs: (subscriptions) => api.put('/users/me/subscriptions', { subscriptions }).then((r) => r.data),
};

function UserFormDialog({ user, onClose }) {
  const isEdit = !!user;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    username: user?.Username || '',
    fullName: user?.FullName || '',
    email: user?.Email || '',
    phone: user?.Phone || '',
    password: '',
    role: user?.Role || 'PLANNER',
    preferredLanguage: user?.PreferredLanguage || 'he',
    isActive: user?.IsActive ?? true,
  });

  const mutation = useMutation({
    mutationFn: () => isEdit
      ? usersApi.update(user.UserId, {
          username: form.username,
          fullName: form.fullName, email: form.email || null, phone: form.phone || null,
          role: form.role, isActive: form.isActive, preferredLanguage: form.preferredLanguage,
        })
      : usersApi.create(form),
    onSuccess: () => {
      toast.success(isEdit ? 'עודכן' : 'משתמש נוצר');
      queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold">{isEdit ? `עריכה: ${user.FullName}` : 'משתמש חדש'}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              שם משתמש {isEdit && <span className="text-xs text-amber-600">(ניתן לשנות!)</span>}
            </label>
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.trim() })}
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              placeholder="לדוגמה: yossi"
            />
          </div>
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium mb-1">סיסמה</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="לפחות 4 תווים"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">שם מלא</label>
            <input
              type="text"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              אימייל <span className="text-xs text-gray-500">(לשם קבלת התראות)</span>
            </label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              טלפון <span className="text-xs text-gray-500">(לשם קבלת SMS)</span>
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">תפקיד</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            >
              {Object.entries(ROLE_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
          {isEdit && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              <span className="text-sm">משתמש פעיל</span>
            </label>
          )}
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'שומר...' : 'שמור'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordDialog({ user, onClose }) {
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => usersApi.resetPassword(user.UserId, password),
    onSuccess: () => {
      toast.success('סיסמה אופסה');
      onClose();
    },
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-sm w-full p-5">
        <h2 className="font-bold mb-1">איפוס סיסמה</h2>
        <p className="text-sm text-gray-500 mb-4">עבור: {user.FullName}</p>
        <input
          type="password"
          placeholder="סיסמה חדשה (לפחות 6 תווים)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 border rounded-lg mb-4"
          autoFocus
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={password.length < 6 || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            איפוס
          </button>
        </div>
      </div>
    </div>
  );
}

function MySubscriptionsDialog({ onClose }) {
  const queryClient = useQueryClient();
  const { data: subs } = useQuery({ queryKey: ['my-subs'], queryFn: usersApi.mySubs });

  const [local, setLocal] = useState(null);
  const current = local || (subs || []);

  const getSubState = (eventType, channel) => {
    const s = current.find((x) => x.EventType === eventType && x.Channel === channel);
    return s?.IsActive ?? false;
  };

  const toggle = (eventType, channel) => {
    const next = [...current.filter((s) => !(s.EventType === eventType && s.Channel === channel))];
    if (!getSubState(eventType, channel)) {
      next.push({ EventType: eventType, Channel: channel, IsActive: true });
    }
    setLocal(next);
  };

  const mutation = useMutation({
    mutationFn: () => usersApi.updateMySubs(
      current.map((s) => ({ eventType: s.EventType, channel: s.Channel, isActive: s.IsActive ?? true }))
    ),
    onSuccess: () => {
      toast.success('הגדרות התראות נשמרו');
      queryClient.invalidateQueries({ queryKey: ['my-subs'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={20} className="text-brand-600" />
          <h2 className="font-bold">הגדרות התראות שלי</h2>
        </div>

        <p className="text-xs text-gray-500 mb-4">
          בחר אילו התראות תקבל ובאיזה ערוץ
        </p>

        <div className="space-y-2">
          {ALERT_EVENTS.map((evt) => (
            <div key={evt.key} className="border rounded-lg p-3">
              <div className="font-medium text-sm mb-2">{evt.label}</div>
              <div className="flex gap-2">
                <label className={`flex-1 flex items-center gap-1.5 p-2 border rounded cursor-pointer text-sm ${getSubState(evt.key, 'EMAIL') ? 'bg-brand-50 border-brand-400' : 'border-gray-200'}`}>
                  <input
                    type="checkbox"
                    checked={getSubState(evt.key, 'EMAIL')}
                    onChange={() => toggle(evt.key, 'EMAIL')}
                  />
                  <Mail size={14} /> אימייל
                </label>
                <label className={`flex-1 flex items-center gap-1.5 p-2 border rounded cursor-pointer text-sm ${getSubState(evt.key, 'SMS') ? 'bg-brand-50 border-brand-400' : 'border-gray-200'}`}>
                  <input
                    type="checkbox"
                    checked={getSubState(evt.key, 'SMS')}
                    onChange={() => toggle(evt.key, 'SMS')}
                  />
                  <Phone size={14} /> SMS
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            שמור
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const [editingUser, setEditingUser] = useState(null);
  const [resettingUser, setResettingUser] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showSubs, setShowSubs] = useState(false);

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => usersApi.delete(id),
    onSuccess: () => {
      toast.success('המשתמש נמחק');
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה במחיקה'),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users /> משתמשים
          </h1>
          <p className="text-sm text-gray-500 mt-1">ניהול גישה והתראות</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSubs(true)}
            className="inline-flex items-center gap-2 px-3 py-2 border rounded-lg text-sm hover:bg-gray-50"
          >
            <Bell size={14} /> התראות שלי
          </button>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-3 py-2 bg-brand-600 text-white rounded-lg text-sm"
          >
            <Plus size={14} /> משתמש חדש
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-4 py-3 text-right">שם / משתמש</th>
              <th className="px-4 py-3 text-right">תפקיד</th>
              <th className="px-4 py-3 text-right">אימייל</th>
              <th className="px-4 py-3 text-right">טלפון</th>
              <th className="px-4 py-3 text-center">סטטוס</th>
              <th className="px-4 py-3 text-center">התחברות אחרונה</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading ? (
              <tr><td colSpan={7} className="py-10 text-center text-gray-500">טוען...</td></tr>
            ) : users?.map((u) => (
              <tr key={u.UserId} className={!u.IsActive ? 'opacity-50 bg-gray-50' : 'hover:bg-gray-50'}>
                <td className="px-4 py-3">
                  <div className="font-medium">{u.FullName}</div>
                  <div className="text-xs text-gray-500 font-mono">{u.Username}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs px-2 py-1 bg-gray-100 rounded-full">
                    {ROLE_LABELS[u.Role] || u.Role}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{u.Email || '—'}</td>
                <td className="px-4 py-3 text-gray-600 font-mono">{u.Phone || '—'}</td>
                <td className="px-4 py-3 text-center">
                  {u.IsActive
                    ? <UserCheck className="inline text-green-500" size={16} />
                    : <UserX className="inline text-gray-400" size={16} />}
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-500">
                  {u.LastLoginAt ? format(new Date(u.LastLoginAt), 'dd/MM HH:mm') : 'מעולם לא'}
                </td>
                <td className="px-4 py-3 text-left whitespace-nowrap">
                  <button
                    onClick={() => setEditingUser(u)}
                    className="p-1.5 hover:bg-gray-200 rounded"
                    title="ערוך (כולל שם משתמש)"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => setResettingUser(u)}
                    className="p-1.5 hover:bg-gray-200 rounded mr-1"
                    title="אפס סיסמה"
                  >
                    <Key size={14} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`למחוק את המשתמש ${u.FullName} (${u.Username})?`)) {
                        deleteMutation.mutate(u.UserId);
                      }
                    }}
                    className="p-1.5 hover:bg-red-100 text-red-600 rounded mr-1"
                    title="מחק משתמש"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editingUser) && (
        <UserFormDialog
          user={editingUser}
          onClose={() => { setCreating(false); setEditingUser(null); }}
        />
      )}
      {resettingUser && (
        <ResetPasswordDialog
          user={resettingUser}
          onClose={() => setResettingUser(null)}
        />
      )}
      {showSubs && <MySubscriptionsDialog onClose={() => setShowSubs(false)} />}
    </div>
  );
}
