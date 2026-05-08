/**
 * Add Stop Dialog - pick an open SAP order to add as a new stop,
 * or enter manual address.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { toast } from 'sonner';
import { X, Search, Plus, MapPin, Package, Keyboard, Target } from 'lucide-react';
import { format } from 'date-fns';

const ordersApi = {
  openOrders: (params) => api.get('/orders/open', { params }).then((r) => r.data),
};

const zonesApi = {
  suggest: (city) => api.get('/zones/suggest', { params: { city } }).then((r) => r.data.zone),
};

/** Shows the suggested zone based on the city. */
function SuggestedZone({ city }) {
  const { data: zone } = useQuery({
    queryKey: ['zone-suggest', city],
    queryFn: () => zonesApi.suggest(city),
    enabled: !!city && city.length > 1,
    staleTime: 60_000,
  });
  if (!zone) return null;
  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-gray-700 bg-gray-50 border border-gray-200 px-2 py-1 rounded mt-1">
      <Target size={11} className="text-gray-500" />
      <span className="text-gray-500">אזור מוצע:</span>
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: zone.ColorHex }} />
      <strong>{zone.Name}</strong>
    </div>
  );
}

export default function AddStopDialog({ runId, onClose }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('order'); // 'order' or 'manual'
  const [search, setSearch] = useState('');
  const [selectedCompany, setSelectedCompany] = useState('');

  // Manual form
  const [manual, setManual] = useState({
    branchName: '',
    street: '',
    buildingNumber: '',
    city: '',
    contactName: '',
    contactPhone: '',
    deliveryNotes: '',
  });

  const { data: ordersData, isLoading } = useQuery({
    queryKey: ['open-orders-for-stop', search, selectedCompany],
    queryFn: () => ordersApi.openOrders({
      search: search || undefined,
      company: selectedCompany || undefined,
      limit: 50,
    }),
    enabled: tab === 'order',
  });

  const addStopFromOrder = useMutation({
    mutationFn: async (order) => {
      // 1. Create the stop (parsing the SAP ShipToAddress into street/city)
      const [street, city] = (order.ShipToAddress || '')
        .split(/\r?\n|\r/)
        .map((p) => p.trim())
        .filter(Boolean);

      const stopResp = await api.post(`/runs/${runId}/stops`, {
        street: street || order.CardName,
        buildingNumber: '',
        city: city || order.CustCity || '',
        branchName: order.CardName,
        contactPhone: order.CustPhone,
        notes: null,
      });
      const newStop = stopResp.data;
      // 2. Add the order to the stop
      await api.post(`/stops/${newStop.StopId}/orders`, {
        companyCode: order.CompanyCode,
        docEntry: order.DocEntry,
        docNum: order.DocNum,
        cardCode: order.CardCode,
        cardName: order.CardName,
        total: order.DocTotal,
        linesCount: order.LinesCount,
      });
      return newStop;
    },
    onSuccess: () => {
      toast.success('עצירה נוספה');
      queryClient.invalidateQueries({ queryKey: ['run', String(runId)] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  const addManualStop = useMutation({
    mutationFn: () => api.post(`/runs/${runId}/stops`, manual).then((r) => r.data),
    onSuccess: () => {
      toast.success('עצירה ידנית נוספה');
      queryClient.invalidateQueries({ queryKey: ['run', String(runId)] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold">הוסף עצירה למסלול</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            onClick={() => setTab('order')}
            className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
              tab === 'order' ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            <Package size={14} /> בחר מהזמנות פתוחות ב-SAP
          </button>
          <button
            onClick={() => setTab('manual')}
            className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 ${
              tab === 'manual' ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            <Keyboard size={14} /> הקלדה ידנית
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {tab === 'order' ? (
            <>
              {/* Search */}
              <div className="flex gap-2 mb-3">
                <div className="relative flex-1">
                  <Search size={14} className="absolute top-1/2 -translate-y-1/2 right-3 text-gray-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="חפש שם לקוח או מספר הזמנה..."
                    className="w-full pr-9 pl-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <select
                  value={selectedCompany}
                  onChange={(e) => setSelectedCompany(e.target.value)}
                  className="px-2 py-2 border rounded-lg text-sm"
                >
                  <option value="">כל החברות</option>
                  <option value="A">OIG</option>
                  <option value="B">Unico</option>
                </select>
              </div>

              {/* Orders list */}
              {isLoading ? (
                <div className="text-center py-8 text-gray-500">טוען הזמנות...</div>
              ) : !ordersData?.orders?.length ? (
                <div className="text-center py-8 text-gray-500">
                  {search ? `לא נמצאו הזמנות עבור "${search}"` : 'אין הזמנות פתוחות'}
                </div>
              ) : (
                <div className="space-y-1">
                  {ordersData.orders.map((order) => (
                    <button
                      key={`${order.CompanyCode}-${order.DocEntry}`}
                      onClick={() => addStopFromOrder.mutate(order)}
                      disabled={addStopFromOrder.isPending}
                      className="w-full text-right p-3 border rounded-lg hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-1.5 py-0.5 text-xs rounded ${
                              order.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                            }`}>
                              {order.CompanyName}
                            </span>
                            <span className="text-xs font-mono text-gray-500">#{order.DocNum}</span>
                            <span className="text-xs text-gray-400">
                              {order.DocDueDate ? format(new Date(order.DocDueDate), 'dd/MM') : ''}
                            </span>
                          </div>
                          <div className="font-medium truncate">{order.CardName}</div>
                          <div className="text-xs text-gray-500 truncate mt-0.5">
                            <MapPin size={10} className="inline ml-1" />
                            {order.ShipToAddress || order.CustCity || 'אין כתובת'}
                          </div>
                          <div className="text-xs text-gray-600 mt-1">
                            {order.LinesCount} שורות · ₪{Number(order.DocTotal || 0).toLocaleString()}
                          </div>
                          {order.CustCity && <SuggestedZone city={order.CustCity} />}
                        </div>
                        <Plus size={18} className="text-brand-600 shrink-0 mr-2" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            /* Manual tab */
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">שם סניף / לקוח *</label>
                <input
                  type="text"
                  value={manual.branchName}
                  onChange={(e) => setManual({ ...manual, branchName: e.target.value })}
                  placeholder="למשל: שופרסל רעננה"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div className="grid grid-cols-[2fr_1fr] gap-2">
                <div>
                  <label className="block text-sm font-medium mb-1">רחוב *</label>
                  <input
                    type="text"
                    value={manual.street}
                    onChange={(e) => setManual({ ...manual, street: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">מספר</label>
                  <input
                    type="text"
                    value={manual.buildingNumber}
                    onChange={(e) => setManual({ ...manual, buildingNumber: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">עיר *</label>
                <input
                  type="text"
                  value={manual.city}
                  onChange={(e) => setManual({ ...manual, city: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                {manual.city.length > 1 && <SuggestedZone city={manual.city} />}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm font-medium mb-1">איש קשר</label>
                  <input
                    type="text"
                    value={manual.contactName}
                    onChange={(e) => setManual({ ...manual, contactName: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">טלפון</label>
                  <input
                    type="tel"
                    value={manual.contactPhone}
                    onChange={(e) => setManual({ ...manual, contactPhone: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">הוראות מסירה</label>
                <textarea
                  value={manual.deliveryNotes}
                  onChange={(e) => setManual({ ...manual, deliveryNotes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
            </div>
          )}
        </div>

        {tab === 'manual' && (
          <div className="p-4 border-t bg-gray-50 flex gap-2">
            <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
              ביטול
            </button>
            <button
              onClick={() => addManualStop.mutate()}
              disabled={!manual.branchName || !manual.street || !manual.city || addManualStop.isPending}
              className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
            >
              {addManualStop.isPending ? 'מוסיף...' : 'הוסף עצירה'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
