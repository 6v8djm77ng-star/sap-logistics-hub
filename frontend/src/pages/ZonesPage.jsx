/**
 * Zones management - full CRUD with colors + drag-and-drop city assignment.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { zonesApi } from '../services/api.js';
import api from '../services/api.js';
import { toast } from 'sonner';
import { MapPin, Plus, Edit2, Trash2, X, GripVertical, Search, ChevronsLeftRight } from 'lucide-react';

const extendedZonesApi = {
  list: () => api.get('/zones').then((r) => r.data.zones),
  create: (data) => api.post('/zones', data).then((r) => r.data),
  update: (id, data) => api.patch(`/zones/${id}`, data).then((r) => r.data),
  delete: (id) => api.delete(`/zones/${id}`).then((r) => r.data),
  cities: () => api.get('/zones/cities').then((r) => r.data.cities),
  setCityZone: (city, zoneCode) =>
    api.patch(`/zones/cities/${encodeURIComponent(city)}`, { zoneCode }).then((r) => r.data),
};

const COLOR_PALETTE = [
  '#2563eb', '#0891b2', '#059669', '#ca8a04', '#dc2626',
  '#9333ea', '#db2777', '#f59e0b', '#14b8a6', '#6366f1',
  '#ef4444', '#10b981', '#f97316', '#8b5cf6', '#06b6d4',
];

// ---------------------------------------------------------------------------
// Zone create / edit dialog
// ---------------------------------------------------------------------------
function ZoneFormDialog({ zone, onClose }) {
  const isEdit = !!zone;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    code: zone?.Code || '',
    name: zone?.Name || '',
    description: zone?.Description || '',
    colorHex: zone?.ColorHex || COLOR_PALETTE[0],
    sortOrder: zone?.SortOrder || 0,
    isActive: zone?.IsActive ?? true,
  });

  const mutation = useMutation({
    mutationFn: () => isEdit
      ? extendedZonesApi.update(zone.ZoneId, form)
      : extendedZonesApi.create(form),
    onSuccess: () => {
      toast.success(isEdit ? 'אזור עודכן' : 'אזור נוסף');
      queryClient.invalidateQueries({ queryKey: ['zones'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">
            {isEdit ? `עריכה: ${zone.Name}` : 'אזור חדש'}
          </h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">שם אזור *</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="למשל: מרכז"
                className="w-full px-3 py-2 border rounded-lg"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">קוד *</label>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="CENTER"
                className="w-24 px-3 py-2 border rounded-lg font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">תיאור</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="למשל: תל אביב, רמת גן, גבעתיים"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">צבע סימון במפה</label>
            <div className="flex flex-wrap gap-2">
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, colorHex: c })}
                  className={`w-9 h-9 rounded-full transition-all ${
                    form.colorHex === c ? 'ring-2 ring-offset-2 ring-gray-400 scale-110' : ''
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">סדר הצגה</label>
              <input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                <span className="text-sm">אזור פעיל</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex gap-2 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">
            ביטול
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={!form.name || !form.code || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            {mutation.isPending ? 'שומר...' : 'שמור'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single city item - draggable
// ---------------------------------------------------------------------------
function CityItem({ city, onMove, allZones }) {
  const [showMenu, setShowMenu] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', city.city);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded text-xs cursor-grab active:cursor-grabbing hover:border-brand-300 hover:bg-brand-50 transition-colors"
      title="גרור לאזור אחר, או לחץ למעבר ידני"
    >
      <GripVertical size={10} className="text-gray-300 group-hover:text-gray-500" />
      <span className="font-medium">{city.city}</span>
      {city.isOverride && (
        <span className="text-[9px] text-amber-600" title="הוגדר ידנית">●</span>
      )}
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-gray-200 rounded"
        title="העבר לאזור אחר"
      >
        <ChevronsLeftRight size={11} />
      </button>
      {showMenu && (
        <div className="absolute mt-6 bg-white border border-gray-200 rounded-lg shadow-lg p-1 z-30 min-w-[140px]">
          {allZones.map((z) => (
            <button
              key={z.ZoneId}
              onClick={() => { onMove(city.city, z.Code); setShowMenu(false); }}
              className="w-full text-right px-2 py-1.5 text-xs hover:bg-gray-100 rounded flex items-center gap-1.5"
            >
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: z.ColorHex || '#9ca3af' }}
              />
              {z.Name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone card with droppable city container
// ---------------------------------------------------------------------------
function ZoneCard({ zone, cities, onEdit, onDelete, onCityMove, allZones, filter }) {
  const [over, setOver] = useState(false);
  const filtered = useMemo(() => {
    if (!filter) return cities;
    const f = filter.toLowerCase();
    return cities.filter((c) => c.city.toLowerCase().includes(f));
  }, [cities, filter]);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const city = e.dataTransfer.getData('text/plain');
        if (city) onCityMove(city, zone.Code);
      }}
      className={`bg-white border-2 rounded-xl p-4 transition-all ${
        over ? 'border-brand-500 bg-brand-50 scale-[1.01] shadow-lg' :
        !zone.IsActive ? 'opacity-50 border-gray-200' :
        'border-gray-200 hover:border-gray-300'
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <span
            className="w-5 h-5 rounded-full shrink-0"
            style={{ backgroundColor: zone.ColorHex || '#9ca3af' }}
          />
          <div>
            <h3 className="font-semibold">{zone.Name}</h3>
            <div className="text-xs text-gray-500 font-mono">
              {zone.Code} · {cities.length} ערים
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onEdit(zone)}
            className="p-1.5 hover:bg-gray-100 rounded"
            title="ערוך אזור"
          >
            <Edit2 size={14} />
          </button>
          <button
            onClick={() => onDelete(zone)}
            className="p-1.5 hover:bg-red-50 text-red-600 rounded"
            title="מחק אזור"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {zone.Description && (
        <p className="text-xs text-gray-500 mb-2 italic">{zone.Description}</p>
      )}

      <div className="flex flex-wrap gap-1 min-h-[40px] py-1">
        {filtered.length === 0 ? (
          <div className="text-xs text-gray-400 italic w-full text-center py-3">
            {filter ? 'אין ערים תואמות' : 'גרור לכאן ערים מאזור אחר'}
          </div>
        ) : (
          filtered.map((c) => (
            <CityItem
              key={c.city}
              city={c}
              onMove={onCityMove}
              allZones={allZones}
            />
          ))
        )}
      </div>

      {!zone.IsActive && (
        <div className="mt-2 text-xs text-amber-600">⚠ לא פעיל</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ZonesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');

  const { data: zones, isLoading } = useQuery({
    queryKey: ['zones'],
    queryFn: zonesApi.list,
  });

  const { data: cities, isLoading: citiesLoading } = useQuery({
    queryKey: ['zones', 'cities'],
    queryFn: extendedZonesApi.cities,
  });

  const moveCityMutation = useMutation({
    mutationFn: ({ city, zoneCode }) => extendedZonesApi.setCityZone(city, zoneCode),
    onSuccess: (_data, vars) => {
      toast.success(`"${vars.city}" הועבר`);
      queryClient.invalidateQueries({ queryKey: ['zones', 'cities'] });
    },
    onError: () => toast.error('שגיאה בהעברה'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => extendedZonesApi.delete(id),
    onSuccess: () => {
      toast.success('אזור נמחק');
      queryClient.invalidateQueries({ queryKey: ['zones'] });
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  const handleMove = (city, zoneCode) => {
    moveCityMutation.mutate({ city, zoneCode });
  };

  // Group cities by zone
  const citiesByZone = useMemo(() => {
    const map = new Map();
    if (cities) {
      for (const c of cities) {
        const k = c.zoneCode || '__none__';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(c);
      }
      // Sort cities alphabetically inside each zone
      for (const [k, arr] of map) {
        arr.sort((a, b) => a.city.localeCompare(b.city, 'he'));
      }
    }
    return map;
  }, [cities]);

  const totalCities = cities?.length || 0;
  const overrides = cities?.filter((c) => c.isOverride).length || 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin /> אזורי הפצה
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {zones?.length ? `${zones.length} אזורים · ${totalCities} ערים` : 'ניהול אזורי הפצה + שיוך כתובות'}
            {overrides > 0 && (
              <span className="text-amber-600 mr-2">· {overrides} שינויים ידניים</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="חפש עיר..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pr-7 pl-3 py-2 border border-gray-300 rounded-lg text-sm w-44"
            />
          </div>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
          >
            <Plus size={16} /> אזור חדש
          </button>
        </div>
      </div>

      {/* Help banner */}
      <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900 flex items-start gap-2">
        <GripVertical size={16} className="mt-0.5 shrink-0" />
        <div>
          <strong>איך מעבירים עיר בין אזורים:</strong>{' '}
          גרור עיר מאזור אחד לאזור אחר. או לחץ על העיר ובחר ידנית.
          {' '}<span className="text-amber-700">●</span> מציין שינוי ידני.
        </div>
      </div>

      {(isLoading || citiesLoading) ? (
        <div className="text-center py-12 text-gray-500">טוען...</div>
      ) : !zones?.length ? (
        <div className="bg-white rounded-xl border p-12 text-center">
          <MapPin className="mx-auto text-gray-400 mb-3" size={40} />
          <p className="text-gray-500 mb-4">אין אזורים מוגדרים</p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm"
          >
            <Plus size={16} /> הוסף אזור ראשון
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {zones.map((z) => (
            <ZoneCard
              key={z.ZoneId}
              zone={z}
              cities={citiesByZone.get(z.Code) || []}
              onEdit={setEditing}
              onDelete={(zone) => {
                if (confirm(`למחוק את האזור "${zone.Name}"?`)) {
                  deleteMutation.mutate(zone.ZoneId);
                }
              }}
              onCityMove={handleMove}
              allZones={zones}
              filter={filter}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ZoneFormDialog
          zone={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
}
