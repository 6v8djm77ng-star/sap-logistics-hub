/**
 * Move a stop to a different run.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../services/api.js';
import { runsApi } from '../services/api.js';
import { toast } from 'sonner';
import { X, ArrowLeft, Truck, MapPin } from 'lucide-react';
import { format } from 'date-fns';

export default function MoveStopDialog({ stop, currentRun, onClose }) {
  const queryClient = useQueryClient();

  // Show runs from same date
  const { data: runs } = useQuery({
    queryKey: ['runs', currentRun.RunDate],
    queryFn: () => runsApi.list({ runDate: currentRun.RunDate }),
  });

  const mutation = useMutation({
    mutationFn: (targetRunId) =>
      api.post(`/stops/${stop.StopId}/move-to-run`, { targetRunId }).then((r) => r.data),
    onSuccess: () => {
      toast.success('העצירה הועברה למסלול אחר');
      queryClient.invalidateQueries({ queryKey: ['run'] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'שגיאה'),
  });

  const otherRuns = (runs || []).filter((r) =>
    r.RunId !== currentRun.RunId && !['COMPLETED', 'CANCELLED'].includes(r.Status)
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">העבר עצירה למסלול אחר</h2>
            <div className="text-xs text-gray-500 mt-1">
              {stop.Street} {stop.BuildingNumber}, {stop.City} ({stop.BranchName})
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <p className="text-sm text-gray-600 mb-3">בחר מסלול יעד (תאריך {format(new Date(currentRun.RunDate), 'dd/MM/yyyy')}):</p>

          {otherRuns.length === 0 ? (
            <div className="text-center py-6 text-gray-500 text-sm">
              אין מסלולים אחרות זמינות באותו תאריך. צור מסלול חדש קודם.
            </div>
          ) : (
            <div className="space-y-2">
              {otherRuns.map((r) => (
                <button
                  key={r.RunId}
                  onClick={() => mutation.mutate(r.RunId)}
                  disabled={mutation.isPending}
                  className="w-full text-right p-3 border border-gray-200 rounded-lg hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5">
                        <ArrowLeft size={18} className="text-brand-600" />
                      </div>
                      <div>
                        <div className="font-semibold">{r.RunNumber}</div>
                        <div className="text-sm text-gray-600 mt-0.5 flex items-center gap-2">
                          <span className="inline-flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: r.ZoneColor }} />
                            {r.ZoneName}
                          </span>
                          <span>·</span>
                          <span>{r.DriverName || 'ללא נהג'}</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          <MapPin size={10} className="inline ml-0.5" />
                          {r.StopCount} עצירות · סטטוס: {r.Status}
                        </div>
                      </div>
                    </div>
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
