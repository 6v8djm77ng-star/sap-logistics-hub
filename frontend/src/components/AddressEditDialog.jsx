/**
 * Edit an address's time windows, contact info, and delivery preferences.
 * Opened from Run Details when clicking an address.
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { addressesApi, zonesApi } from '../services/api.js';
import { toast } from 'sonner';
import { X, Clock, Phone, Mail, MapPin } from 'lucide-react';

const DAYS = [
  { code: 'SUN', label: 'א' },
  { code: 'MON', label: 'ב' },
  { code: 'TUE', label: 'ג' },
  { code: 'WED', label: 'ד' },
  { code: 'THU', label: 'ה' },
  { code: 'FRI', label: 'ו' },
  { code: 'SAT', label: 'ש' },
];

export default function AddressEditDialog({ addressId, onClose }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['address', addressId],
    queryFn: () => addressesApi.get(addressId),
    enabled: !!addressId,
  });

  const { data: zones } = useQuery({
    queryKey: ['zones'],
    queryFn: zonesApi.list,
  });

  useEffect(() => {
    if (data?.address) {
      const a = data.address;
      setForm({
        zoneId: a.ZoneId,
        branchName: a.BranchName || '',
        contactName: a.ContactName || '',
        contactPhone: a.ContactPhone || '',
        contactEmail: a.ContactEmail || '',
        smsOptIn: a.SmsOptIn ?? true,
        emailOptIn: a.EmailOptIn ?? true,
        deliveryWindowStart: a.DeliveryWindowStart ? String(a.DeliveryWindowStart).slice(0, 5) : '',
        deliveryWindowEnd: a.DeliveryWindowEnd ? String(a.DeliveryWindowEnd).slice(0, 5) : '',
        deliveryDays: a.DeliveryDays ? a.DeliveryDays.split(',') : [],
        deliveryNotes: a.DeliveryNotes || '',
      });
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => addressesApi.update(addressId, {
      zoneId: form.zoneId || null,
      branchName: form.branchName || null,
      contactName: form.contactName || null,
      contactPhone: form.contactPhone || null,
      contactEmail: form.contactEmail || null,
      smsOptIn: form.smsOptIn,
      emailOptIn: form.emailOptIn,
      deliveryWindowStart: form.deliveryWindowStart || null,
      deliveryWindowEnd: form.deliveryWindowEnd || null,
      deliveryDays: form.deliveryDays.length > 0 ? form.deliveryDays.join(',') : null,
      deliveryNotes: form.deliveryNotes || null,
    }),
    onSuccess: () => {
      toast.success('הכתובת עודכנה');
      queryClient.invalidateQueries({ queryKey: ['address', addressId] });
      queryClient.invalidateQueries({ queryKey: ['run'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה בשמירה'),
  });

  const toggleDay = (code) => {
    setForm((f) => ({
      ...f,
      deliveryDays: f.deliveryDays.includes(code)
        ? f.deliveryDays.filter((d) => d !== code)
        : [...f.deliveryDays, code],
    }));
  };

  if (isLoading || !form || !data) {
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl p-8">טוען...</div>
      </div>
    );
  }

  const a = data.address;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">
              {a.Street} {a.BuildingNumber}, {a.City}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {data.links?.length || 0} לקוחות מקושרים
              {data.links?.map((l) => (
                <span key={l.SapCardCode} className="mr-2 inline-flex items-center gap-1">
                  · <span className={`px-1 text-xs rounded ${l.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                    {l.CompanyCode}
                  </span> <span className="font-mono">{l.SapCardCode}</span>
                </span>
              ))}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Branch + zone */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">שם סניף</label>
              <input
                type="text"
                value={form.branchName}
                onChange={(e) => setForm({ ...form, branchName: e.target.value })}
                placeholder="למשל: שופרסל רמת גן"
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">אזור הפצה</label>
              <select
                value={form.zoneId || ''}
                onChange={(e) => setForm({ ...form, zoneId: Number(e.target.value) || null })}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              >
                <option value="">-- לא משויך --</option>
                {zones?.map((z) => (
                  <option key={z.ZoneId} value={z.ZoneId}>{z.Name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Contact */}
          <div className="border rounded-xl p-4 bg-gray-50">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Phone size={16} /> פרטי קשר
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">איש קשר</label>
                <input
                  type="text"
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">טלפון (ל-SMS)</label>
                <input
                  type="tel"
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                  placeholder="050-1234567"
                  className="w-full px-2 py-1.5 border rounded text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">אימייל (ל-PoD)</label>
                <input
                  type="email"
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
            <div className="flex gap-4 mt-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.smsOptIn}
                  onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })}
                />
                שלח SMS לפני הגעה
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={form.emailOptIn}
                  onChange={(e) => setForm({ ...form, emailOptIn: e.target.checked })}
                />
                שלח אישור מסירה למייל
              </label>
            </div>
          </div>

          {/* Time window */}
          <div className="border rounded-xl p-4 bg-amber-50 border-amber-200">
            <h3 className="font-semibold mb-1 flex items-center gap-2">
              <Clock size={16} /> חלון קבלת סחורה
            </h3>
            <p className="text-xs text-gray-600 mb-3">
              השאר ריק לשעות גמישות. קריטי לרשתות קמעונאיות!
            </p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">משעה</label>
                <input
                  type="time"
                  value={form.deliveryWindowStart}
                  onChange={(e) => setForm({ ...form, deliveryWindowStart: e.target.value })}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">עד שעה</label>
                <input
                  type="time"
                  value={form.deliveryWindowEnd}
                  onChange={(e) => setForm({ ...form, deliveryWindowEnd: e.target.value })}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1.5">ימי קבלה</label>
              <div className="flex gap-1">
                {DAYS.map((d) => (
                  <button
                    key={d.code}
                    type="button"
                    onClick={() => toggleDay(d.code)}
                    className={`w-9 h-9 rounded-full text-sm font-medium ${
                      form.deliveryDays.includes(d.code)
                        ? 'bg-amber-500 text-white'
                        : 'bg-white border border-gray-300 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
                {form.deliveryDays.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, deliveryDays: [] })}
                    className="px-2 text-xs text-gray-500 hover:text-red-600"
                  >
                    נקה
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">לא נבחר ימים = כל הימים</p>
            </div>
          </div>

          {/* Delivery notes */}
          <div>
            <label className="block text-sm font-medium mb-1">הוראות מסירה מיוחדות</label>
            <textarea
              value={form.deliveryNotes}
              onChange={(e) => setForm({ ...form, deliveryNotes: e.target.value })}
              rows={2}
              placeholder="למשל: להיכנס מהחנייה מאחור, לצלצל בפעמון, לעבור דרך מחסן..."
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
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
