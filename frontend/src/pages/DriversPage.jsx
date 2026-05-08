/**
 * Drivers management - full CRUD with persistence.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { Phone, Truck, Plus, Edit2, Trash2, X, UserCheck, UserX, Smartphone, Copy, Check } from 'lucide-react';

const driversApi = {
  list: () => api.get('/drivers').then((r) => r.data.drivers),
  create: (data) => api.post('/drivers', data).then((r) => r.data),
  update: (id, data) => api.patch(`/drivers/${id}`, data).then((r) => r.data),
  delete: (id) => api.delete(`/drivers/${id}`).then((r) => r.data),
};

function DriverFormDialog({ driver, onClose }) {
  const queryClient = useQueryClient();
  const isEdit = !!driver;
  const [form, setForm] = useState({
    code: driver?.Code || '',
    fullName: driver?.FullName || '',
    phone: driver?.Phone || '',
    email: driver?.Email || '',
    vehiclePlate: driver?.VehiclePlate || '',
    vehicleCapacity: driver?.VehicleCapacity || 30,
    zones: driver?.Zones || '',
    isActive: driver?.IsActive ?? true,
  });

  const mutation = useMutation({
    mutationFn: () => isEdit ? driversApi.update(driver.DriverId, form) : driversApi.create(form),
    onSuccess: () => {
      toast.success(isEdit ? 'הנהג עודכן' : 'נהג נוסף');
      queryClient.invalidateQueries({ queryKey: ['drivers'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">
            {isEdit ? `עריכת נהג: ${driver.FullName}` : 'נהג חדש'}
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">קוד נהג</label>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="DRV-03"
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">רכב (מספר רישוי)</label>
              <input
                type="text"
                value={form.vehiclePlate}
                onChange={(e) => setForm({ ...form, vehiclePlate: e.target.value })}
                placeholder="12-345-67"
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">שם מלא *</label>
            <input
              type="text"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
              placeholder="דוד כהן"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">טלפון</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="050-1234567"
                className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">אימייל</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">קיבולת (עצירות)</label>
              <input
                type="number"
                value={form.vehicleCapacity}
                onChange={(e) => setForm({ ...form, vehicleCapacity: Number(e.target.value) })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">אזורים (מופרדים בפסיק)</label>
              <input
                type="text"
                value={form.zones}
                onChange={(e) => setForm({ ...form, zones: e.target.value })}
                placeholder="NORTH,CENTER"
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 mt-2">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            />
            <span className="text-sm">נהג פעיל</span>
          </label>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !form.fullName}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'שומר...' : 'שמור'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DriversPage() {
  const queryClient = useQueryClient();
  const [editingDriver, setEditingDriver] = useState(null);
  const [creating, setCreating] = useState(false);

  const { data: drivers, isLoading } = useQuery({
    queryKey: ['drivers'],
    queryFn: driversApi.list,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => driversApi.delete(id),
    onSuccess: () => {
      toast.success('הנהג נמחק');
      queryClient.invalidateQueries({ queryKey: ['drivers'] });
    },
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">נהגים</h1>
          <p className="text-sm text-gray-500 mt-1">
            {drivers?.length ? `${drivers.length} נהגים` : 'ניהול נהגי הפצה'}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
        >
          <Plus size={16} /> נהג חדש
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !drivers?.length ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <Truck className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-4">אין נהגים רשומים</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm"
          >
            <Plus size={16} /> הוסף נהג ראשון
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {drivers.map((d) => (
            <div key={d.DriverId} className={`bg-white border rounded-xl p-5 ${!d.IsActive ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-lg">{d.FullName || '(ללא שם)'}</h3>
                  <p className="text-sm text-gray-500 font-mono">{d.Code}</p>
                </div>
                <div className="flex items-center gap-1">
                  {d.IsActive ? (
                    <UserCheck className="text-green-500" size={18} title="פעיל" />
                  ) : (
                    <UserX className="text-gray-400" size={18} title="לא פעיל" />
                  )}
                </div>
              </div>

              <div className="mt-3 space-y-1 text-sm">
                {d.Phone && (
                  <div className="flex items-center gap-2 text-gray-700">
                    <Phone size={14} className="text-gray-400" />
                    <a href={`tel:${d.Phone}`} className="hover:underline">{d.Phone}</a>
                  </div>
                )}
                {d.VehiclePlate && (
                  <div className="flex items-center gap-2 text-gray-700">
                    <Truck size={14} className="text-gray-400" />
                    {d.VehiclePlate}
                    {d.VehicleCapacity && <span className="text-xs text-gray-500">· קיבולת {d.VehicleCapacity}</span>}
                  </div>
                )}
                {d.Zones && (
                  <div className="text-gray-600 text-xs">
                    אזורים: <span className="font-mono">{d.Zones}</span>
                  </div>
                )}
                {d.Email && (
                  <div className="text-gray-500 text-xs truncate">{d.Email}</div>
                )}
              </div>

              <MobileLinkBlock driverCode={d.Code} />

              <div className="flex gap-2 mt-3 pt-3 border-t">
                <button
                  onClick={() => setEditingDriver(d)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 text-sm border rounded-lg hover:bg-gray-50"
                >
                  <Edit2 size={13} /> ערוך
                </button>
                <button
                  onClick={() => {
                    if (confirm(`למחוק את ${d.FullName}?`)) {
                      deleteMutation.mutate(d.DriverId);
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

      {(creating || editingDriver) && (
        <DriverFormDialog
          driver={editingDriver}
          onClose={() => { setCreating(false); setEditingDriver(null); }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Mobile auto-login link block - shown per driver
// ----------------------------------------------------------------------------
function MobileLinkBlock({ driverCode }) {
  const [copied, setCopied] = useState(false);
  // Build link from current host so it works whether running on localhost,
  // 192.168.0.14, or any future deployment URL.
  const url = `${window.location.protocol}//${window.location.host}/m/${driverCode}`;

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
    <div className="mt-3 p-2 bg-gradient-to-l from-brand-50 to-blue-50 border border-brand-200 rounded-lg">
      <div className="flex items-center gap-1.5 text-xs font-medium text-brand-900 mb-1.5">
        <Smartphone size={12} />
        קישור התקנה למובייל (ללא סיסמה):
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
          className="flex items-center gap-1 px-2 py-1 bg-brand-600 text-white rounded text-xs hover:bg-brand-700"
          title="העתק קישור"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="text-[10px] text-gray-500 mt-1.5">
        שלח לנהג ב-WhatsApp - הוא לוחץ פעם אחת ומתחבר אוטומטית.
      </div>
    </div>
  );
}
