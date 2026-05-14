/**
 * Pickers management - similar to drivers but for warehouse handhelds.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import {
  Phone, Plus, Edit2, Trash2, X, UserCheck, UserX,
  Smartphone, Copy, Check, Warehouse,
} from 'lucide-react';

const pickersApi = {
  list: () => api.get('/pickers').then((r) => r.data.pickers),
  create: (data) => api.post('/pickers', data).then((r) => r.data),
  update: (id, data) => api.patch(`/pickers/${id}`, data).then((r) => r.data),
  delete: (id) => api.delete(`/pickers/${id}`).then((r) => r.data),
};

function PickerFormDialog({ picker, onClose }) {
  const isEdit = !!picker;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    code: picker?.Code || '',
    fullName: picker?.FullName || '',
    phone: picker?.Phone || '',
    isActive: picker?.IsActive ?? true,
  });

  const mutation = useMutation({
    mutationFn: () => isEdit
      ? pickersApi.update(picker.PickerId, form)
      : pickersApi.create(form),
    onSuccess: () => {
      toast.success(isEdit ? 'מלקט עודכן' : 'מלקט נוסף');
      queryClient.invalidateQueries({ queryKey: ['pickers'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">
            {isEdit ? `עריכה: ${picker.FullName}` : 'מלקט חדש'}
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">שם מלא *</label>
            <input
              type="text"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              placeholder="למשל: יוסי המחסנאי"
              className="w-full px-3 py-2 border rounded-lg"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">קוד</label>
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="PICK-01 (אוטומטי אם תשאיר ריק)"
              className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">טלפון</label>
            <input
              type="text"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="050-..."
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
              />
              <span className="text-sm">מלקט פעיל</span>
            </label>
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!form.fullName || mutation.isPending}
            className="flex-1 py-2 bg-amber-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'שומר...' : 'שמור'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MobileLinkBlock({ pickerCode }) {
  const [copied, setCopied] = useState(false);
  // When the planner opens this page on localhost (operator's laptop), naively
  // building the link from window.location.host produces http://localhost:4000/...
  // which is unreachable from a picker's mobile phone. Ask the backend for its
  // live public base — it reads the active cloudflared tunnel URL from the log.
  const { data: publicBase } = useQuery({
    queryKey: ['public-base'],
    queryFn: () => api.get('/system/public-base').then((r) => r.data.base).catch(() => null),
    staleTime: 60_000,
  });
  const isLocal = /^localhost(:|$)|^127\.|^192\.168\./.test(window.location.host);
  const base = (isLocal && publicBase) ? publicBase
    : `${window.location.protocol}//${window.location.host}`;
  const url = `${base}/pick/${pickerCode}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('הקישור הועתק!');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('לא הצלחנו להעתיק - העתק ידנית');
    }
  };

  return (
    <div className="mt-3 p-2 bg-gradient-to-l from-amber-50 to-orange-50 border border-amber-200 rounded-lg">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 mb-1.5">
        <Smartphone size={12} />
        קישור התקנה למסופון (ללא סיסמה):
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 px-2 py-1 bg-white border border-gray-200 rounded font-mono text-[10px] text-gray-700 truncate"
          onClick={(e) => e.target.select()}
        />
        <button
          onClick={copy}
          className="flex items-center gap-1 px-2 py-1 bg-amber-600 text-white rounded text-xs hover:bg-amber-700"
          title="העתק קישור"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="text-[10px] text-gray-500 mt-1.5">
        פתח במסופון פעם אחת והוסף למסך הבית.
      </div>
    </div>
  );
}

export default function PickersPage() {
  const queryClient = useQueryClient();
  const [editingPicker, setEditingPicker] = useState(null);
  const [creating, setCreating] = useState(false);

  const { data: pickers, isLoading } = useQuery({
    queryKey: ['pickers'],
    queryFn: pickersApi.list,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => pickersApi.delete(id),
    onSuccess: () => {
      toast.success('המלקט נמחק');
      queryClient.invalidateQueries({ queryKey: ['pickers'] });
    },
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Warehouse /> מלקטים
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {pickers?.length ? `${pickers.length} מלקטים` : 'ניהול מלקטי המחסן + קישור התקנה למסופון'}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700"
        >
          <Plus size={16} /> מלקט חדש
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !pickers?.length ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Warehouse className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-4">אין מלקטים רשומים</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg text-sm"
          >
            <Plus size={16} /> הוסף מלקט ראשון
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pickers.map((p) => (
            <div key={p.PickerId} className={`bg-white border rounded-xl p-5 ${!p.IsActive ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-lg">{p.FullName || '(ללא שם)'}</h3>
                  <p className="text-sm text-gray-500 font-mono">{p.Code}</p>
                </div>
                <div>
                  {p.IsActive ? (
                    <UserCheck className="text-green-500" size={18} title="פעיל" />
                  ) : (
                    <UserX className="text-gray-400" size={18} title="לא פעיל" />
                  )}
                </div>
              </div>

              {p.Phone && (
                <div className="mt-3 flex items-center gap-2 text-sm text-gray-700">
                  <Phone size={14} className="text-gray-400" />
                  <a href={`tel:${p.Phone}`} className="hover:underline">{p.Phone}</a>
                </div>
              )}

              <MobileLinkBlock pickerCode={p.Code} />

              <div className="flex gap-2 mt-3 pt-3 border-t">
                <button
                  onClick={() => setEditingPicker(p)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-sm border rounded-lg hover:bg-gray-50"
                >
                  <Edit2 size={13} /> ערוך
                </button>
                <button
                  onClick={() => {
                    if (confirm(`למחוק את ${p.FullName}?`)) {
                      deleteMutation.mutate(p.PickerId);
                    }
                  }}
                  className="inline-flex items-center justify-center px-3 py-1.5 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editingPicker) && (
        <PickerFormDialog
          picker={editingPicker}
          onClose={() => { setCreating(false); setEditingPicker(null); }}
        />
      )}
    </div>
  );
}
