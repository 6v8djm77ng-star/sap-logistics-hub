/**
 * Assign or change the driver for a run.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { driversApi } from '../services/api.js';
import { toast } from 'sonner';
import { X, User, Truck, CheckCircle } from 'lucide-react';

export default function AssignDriverDialog({ run, onClose }) {
  const queryClient = useQueryClient();
  const { data: drivers } = useQuery({ queryKey: ['drivers'], queryFn: driversApi.list });

  const mutation = useMutation({
    mutationFn: (driverId) => api.patch(`/runs/${run.RunId}`, { driverId }).then((r) => r.data),
    onSuccess: () => {
      toast.success('הנהג שויך למסלול');
      queryClient.invalidateQueries({ queryKey: ['run', String(run.RunId)] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  const activeDrivers = (drivers || []).filter((d) => d.IsActive);
  const currentDriverId = run.DriverId;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold">שיוך נהג - {run.RunNumber}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="p-4">
          <p className="text-sm text-gray-600 mb-3">בחר נהג למסלול באזור {run.ZoneName}:</p>

          {activeDrivers.length === 0 ? (
            <div className="text-center py-6 text-gray-500 text-sm">
              אין נהגים פעילים. הוסף נהגים בדף "נהגים".
            </div>
          ) : (
            <div className="space-y-2">
              {/* Option to remove driver */}
              <button
                onClick={() => mutation.mutate(null)}
                disabled={mutation.isPending}
                className={`w-full text-right p-3 border rounded-lg hover:border-red-400 hover:bg-red-50 disabled:opacity-50 ${
                  currentDriverId == null ? 'border-gray-400 bg-gray-50' : 'border-gray-200'
                }`}
              >
                <div className="flex items-center gap-2 text-gray-500">
                  <X size={14} /> ללא נהג
                </div>
              </button>

              {activeDrivers.map((d) => (
                <button
                  key={d.DriverId}
                  onClick={() => mutation.mutate(d.DriverId)}
                  disabled={mutation.isPending}
                  className={`w-full text-right p-3 border rounded-lg hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50 transition-colors ${
                    currentDriverId === d.DriverId ? 'border-brand-500 bg-brand-50' : 'border-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center">
                        <User size={16} />
                      </div>
                      <div>
                        <div className="font-medium">{d.FullName}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                          <span className="font-mono">{d.Code}</span>
                          {d.VehiclePlate && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-1">
                                <Truck size={11} /> {d.VehiclePlate}
                              </span>
                            </>
                          )}
                          {d.Phone && (
                            <>
                              <span>·</span>
                              <span>{d.Phone}</span>
                            </>
                          )}
                        </div>
                        {d.Zones && (
                          <div className="text-xs text-gray-400 mt-0.5">
                            אזורים: {d.Zones}
                          </div>
                        )}
                      </div>
                    </div>
                    {currentDriverId === d.DriverId && (
                      <CheckCircle size={18} className="text-brand-600" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
