/**
 * Modal dialog to create a new customer Return Request.
 * Uses customer typeahead search + auto-loads addresses + recent items.
 */
import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { returnsApi, customersApi } from '../services/api.js';
import CustomerSearchInput from './CustomerSearchInput.jsx';
import { toast } from 'sonner';
import { X, Plus, Trash2, Package } from 'lucide-react';
import { format } from 'date-fns';

const REASON_CODES = [
  { code: 'DAMAGED', label: 'פגום' },
  { code: 'WRONG_ITEM', label: 'פריט לא נכון' },
  { code: 'EXPIRED', label: 'פג תוקף' },
  { code: 'CUSTOMER_REFUSED', label: 'לקוח סירב' },
  { code: 'OTHER', label: 'אחר' },
];

export default function NewReturnDialog({ onClose }) {
  const queryClient = useQueryClient();
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerDetails, setCustomerDetails] = useState(null);
  const [selectedAddressIdx, setSelectedAddressIdx] = useState(0);
  const [recentItems, setRecentItems] = useState([]);
  const [form, setForm] = useState({
    requestedDate: format(new Date(), 'yyyy-MM-dd'),
    reason: '',
    notes: '',
    lines: [{ itemCode: '', itemName: '', quantity: 1, reasonCode: 'DAMAGED', reasonText: '' }],
  });

  // When customer selected, auto-load addresses + recent items
  useEffect(() => {
    if (!selectedCustomer) return;
    (async () => {
      try {
        const [details, items] = await Promise.all([
          customersApi.get(selectedCustomer.CompanyCode, selectedCustomer.CardCode),
          customersApi.recentItems(selectedCustomer.CompanyCode, selectedCustomer.CardCode),
        ]);
        setCustomerDetails(details);
        setRecentItems(items);
      } catch (err) {
        toast.error('שגיאה בטעינת פרטי לקוח');
      }
    })();
  }, [selectedCustomer]);

  const createMutation = useMutation({
    mutationFn: async () => {
      // Ensure address is normalized before creating
      const address = customerDetails?.addresses[selectedAddressIdx];
      if (!address) throw new Error('בחר כתובת');

      let addressId = address.normalizedAddressId;
      if (!addressId) {
        const result = await customersApi.ensureAddress(
          selectedCustomer.CompanyCode,
          selectedCustomer.CardCode,
          address.sapAddress
        );
        addressId = result.addressId;
      }

      return returnsApi.create({
        companyCode: selectedCustomer.CompanyCode,
        cardCode: selectedCustomer.CardCode,
        cardName: selectedCustomer.CardName,
        addressId,
        requestedDate: form.requestedDate,
        reason: form.reason,
        notes: form.notes,
        lines: form.lines
          .filter((l) => l.itemCode && l.quantity > 0)
          .map((l) => ({ ...l, quantity: Number(l.quantity) })),
      });
    },
    onSuccess: () => {
      toast.success('בקשת החזרה נוצרה');
      queryClient.invalidateQueries({ queryKey: ['returns'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה ביצירת החזרה'),
  });

  const updateLine = (idx, patch) => {
    setForm((f) => {
      const lines = [...f.lines];
      lines[idx] = { ...lines[idx], ...patch };
      return { ...f, lines };
    });
  };

  const addLineFromHistory = (item) => {
    const emptyIdx = form.lines.findIndex((l) => !l.itemCode);
    if (emptyIdx >= 0) {
      updateLine(emptyIdx, { itemCode: item.ItemCode, itemName: item.ItemName });
    } else {
      setForm((f) => ({
        ...f,
        lines: [...f.lines, {
          itemCode: item.ItemCode, itemName: item.ItemName,
          quantity: 1, reasonCode: 'DAMAGED', reasonText: '',
        }],
      }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold">בקשת החזרה חדשה</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Customer search */}
          <div>
            <label className="block text-sm font-medium mb-1">לקוח</label>
            <CustomerSearchInput onSelect={setSelectedCustomer} />
            {selectedCustomer && (
              <div className="mt-2 p-3 bg-brand-50 rounded-lg text-sm">
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 text-xs rounded ${selectedCustomer.CompanyCode === 'A' ? 'bg-blue-200 text-blue-800' : 'bg-green-200 text-green-800'}`}>
                    חברה {selectedCustomer.CompanyCode}
                  </span>
                  <span className="font-medium">{selectedCustomer.CardName}</span>
                  <span className="font-mono text-xs text-gray-600">{selectedCustomer.CardCode}</span>
                </div>
              </div>
            )}
          </div>

          {/* Addresses */}
          {customerDetails && customerDetails.addresses.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-1">כתובת איסוף</label>
              <div className="space-y-1">
                {customerDetails.addresses.map((addr, idx) => (
                  <label
                    key={idx}
                    className={`flex items-start gap-2 p-2 border rounded-lg cursor-pointer ${selectedAddressIdx === idx ? 'border-brand-500 bg-brand-50' : 'border-gray-200'}`}
                  >
                    <input
                      type="radio"
                      name="address"
                      checked={selectedAddressIdx === idx}
                      onChange={() => setSelectedAddressIdx(idx)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 text-sm">
                      <div>{addr.street} {addr.buildingNumber}</div>
                      <div className="text-xs text-gray-500">{addr.city}</div>
                      {addr.sapAddress && (
                        <div className="text-xs text-gray-400 mt-0.5">{addr.sapAddress}</div>
                      )}
                      {!addr.normalizedAddressId && (
                        <div className="text-xs text-amber-600 mt-1">
                          כתובת חדשה - תיווצר אוטומטית
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">תאריך איסוף מבוקש</label>
              <input
                type="date"
                value={form.requestedDate}
                onChange={(e) => setForm({ ...form, requestedDate: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">סיבת בקשה</label>
            <textarea
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
              rows={2}
              placeholder="למשל: פריטים פגומים מהמשלוח מיום 20/4"
            />
          </div>

          {/* Recent items - quick add */}
          {recentItems.length > 0 && (
            <div>
              <label className="block text-sm font-medium mb-2">
                <Package size={14} className="inline ml-1" />
                פריטים שהלקוח קנה לאחרונה (לחץ להוספה)
              </label>
              <div className="flex flex-wrap gap-2">
                {recentItems.slice(0, 10).map((item) => (
                  <button
                    key={item.ItemCode}
                    type="button"
                    onClick={() => addLineFromHistory(item)}
                    className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
                    title={item.ItemName}
                  >
                    <span className="font-mono">{item.ItemCode}</span>
                    <span className="mr-1 text-gray-500 truncate inline-block max-w-[150px] align-bottom">
                      {item.ItemName}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium">פריטים להחזרה</label>
              <button
                type="button"
                onClick={() => setForm((f) => ({
                  ...f,
                  lines: [...f.lines, { itemCode: '', itemName: '', quantity: 1, reasonCode: 'DAMAGED', reasonText: '' }],
                }))}
                className="inline-flex items-center gap-1 text-sm text-brand-600"
              >
                <Plus size={14} /> הוסף שורה
              </button>
            </div>

            <div className="space-y-2">
              {form.lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-[auto_1fr_2fr_80px_120px] gap-2 items-start">
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({
                      ...f,
                      lines: f.lines.filter((_, i) => i !== idx),
                    }))}
                    className="p-1.5 text-red-500 hover:bg-red-50 rounded"
                    disabled={form.lines.length === 1}
                  >
                    <Trash2 size={14} />
                  </button>
                  <input
                    type="text"
                    value={line.itemCode}
                    onChange={(e) => updateLine(idx, { itemCode: e.target.value })}
                    placeholder="קוד פריט"
                    className="px-2 py-1.5 border rounded text-sm font-mono"
                  />
                  <input
                    type="text"
                    value={line.itemName}
                    onChange={(e) => updateLine(idx, { itemName: e.target.value })}
                    placeholder="שם פריט"
                    className="px-2 py-1.5 border rounded text-sm"
                  />
                  <input
                    type="number"
                    min="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                    className="px-2 py-1.5 border rounded text-sm"
                  />
                  <select
                    value={line.reasonCode}
                    onChange={(e) => updateLine(idx, { reasonCode: e.target.value })}
                    className="px-2 py-1.5 border rounded text-sm"
                  >
                    {REASON_CODES.map((r) => (
                      <option key={r.code} value={r.code}>{r.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 border border-gray-300 rounded-lg"
          >
            ביטול
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !selectedCustomer}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {createMutation.isPending ? 'יוצר...' : 'יצירת בקשה'}
          </button>
        </div>
      </div>
    </div>
  );
}
