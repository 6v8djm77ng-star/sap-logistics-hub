import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { driverApi } from '../../services/api.js';
import { sendOrQueue, getQueueSize, flushQueue } from '../../services/offlineQueue.js';
import { useGpsTracking } from '../../hooks/useGpsTracking.js';
import { useGeofence } from '../../hooks/useGeofence.js';
import StatusPill from '../../components/StatusPill.jsx';
import SignaturePad from '../../components/SignaturePad.jsx';
import PodCapture from '../../components/PodCapture.jsx';
import VoiceCommandButton from '../../components/VoiceCommandButton.jsx';
import NavigateButton from '../../components/NavigateButton.jsx';
import FailureReportDialog from '../../components/FailureReportDialog.jsx';
import { toast } from 'sonner';
import { ChevronRight, MapPin, Phone, Check, X, Navigation, CloudOff, PenLine, Crosshair } from 'lucide-react';

export default function DriverManifestPage() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [signingStopId, setSigningStopId] = useState(null);
  const [podForStop, setPodForStop] = useState(null); // full stop object for POD dialog
  const [failureStop, setFailureStop] = useState(null); // { stopId, customerName }
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queueSize, setQueueSize] = useState(getQueueSize());

  useEffect(() => {
    const online = () => { setIsOnline(true); flushQueue().then(() => setQueueSize(getQueueSize())); };
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    const interval = setInterval(() => setQueueSize(getQueueSize()), 5000);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      clearInterval(interval);
    };
  }, []);

  const { data: run, isLoading } = useQuery({
    queryKey: ['manifest', id],
    queryFn: () => driverApi.manifest(id),
    refetchInterval: isOnline ? 30_000 : false,
  });

  // Live GPS reporting - enabled when run is in progress
  const runInProgress = run && !['COMPLETED', 'CANCELLED'].includes(run.Status);
  const { position: gpsPos } = useGpsTracking({
    enabled: runInProgress,
    runId: Number(id),
  });

  const updateStopMutation = useMutation({
    mutationFn: ({ stopId, status, notes }) =>
      sendOrQueue('PATCH', `/driver/stops/${stopId}/status`, { status, notes }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['manifest', id] });
      setQueueSize(getQueueSize());
      if (result.queued) {
        toast.info('נשמר בתור - יישלח כשתחזור חיבור');
      }
    },
  });

  const completeStopMutation = useMutation({
    mutationFn: ({ stopId, ...payload }) =>
      sendOrQueue('POST', `/driver/stops/${stopId}/complete`, payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['manifest', id] });
      setQueueSize(getQueueSize());
      if (result.queued) {
        toast.info('נשמר בתור - יישלח כשתחזור חיבור');
      } else {
        toast.success('עצירה הושלמה ותעודת משלוח נוצרה ב-SAP');
      }
    },
  });

  const handleSignatureCapture = (stopId) => (dataUrl) => {
    completeStopMutation.mutate({ stopId, signatureDataUrl: dataUrl });
    setSigningStopId(null);
  };

  const handlePodComplete = async (stopId, payload) => {
    await completeStopMutation.mutateAsync({ stopId, ...payload });
    setPodForStop(null);
  };

  // The "current" stop = first non-delivered stop (what the driver is doing now)
  const currentStop = (run?.stops || []).find(
    (s) => !['DELIVERED', 'CANCELLED', 'FAILED'].includes(s.Status)
  );

  // Geofence: auto-mark "Arrived" when the driver enters the 80m radius
  // around any pending stop. Vibrates the phone + shows a toast.
  const [geofenceEnabled, setGeofenceEnabled] = useState(true);
  useGeofence(run?.stops || [], {
    enabled: geofenceEnabled && !!run,
    radiusM: 80,
    onEnter: (stop) => {
      if (stop.Status === 'PENDING' || stop.Status === 'OPEN' || stop.Status === 'PLANNED') {
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
        toast.success(`📍 הגעת ל-${stop.BranchName || stop.City}!`, { duration: 4000 });
        updateStatusMutation.mutate({ stopId: stop.StopId, status: 'ARRIVED' });
      }
    },
  });

  const handleVoiceCommand = (action) => {
    if (!currentStop) {
      toast.error('אין עצירה פעילה');
      return;
    }
    switch (action) {
      case 'navigate': {
        const addr = encodeURIComponent(`${currentStop.Street} ${currentStop.BuildingNumber}, ${currentStop.City}`);
        window.open(`https://www.google.com/maps/search/?api=1&query=${addr}`, '_blank');
        break;
      }
      case 'arrive':
        updateStatusMutation.mutate({ stopId: currentStop.StopId, status: 'ARRIVED' });
        break;
      case 'complete':
        if (currentStop.Status !== 'ARRIVED') {
          updateStatusMutation.mutate({ stopId: currentStop.StopId, status: 'ARRIVED' });
        }
        setPodForStop(currentStop);
        break;
      case 'call': {
        const phone = currentStop.ContactPhone || currentStop.orders?.[0]?.CustomerPhone;
        if (phone) window.location.href = `tel:${phone}`;
        else toast.error('אין מספר טלפון');
        break;
      }
      case 'failure':
        setFailureStop({
          stopId: currentStop.StopId,
          customerName: currentStop.orders?.[0]?.SapCardName || `${currentStop.Street}`,
        });
        break;
      case 'next':
      case 'prev': {
        const stops = run?.stops || [];
        const idx = stops.findIndex((s) => s.StopId === currentStop.StopId);
        const target = stops[idx + (action === 'next' ? 1 : -1)];
        if (target) {
          document.getElementById(`stop-${target.StopId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        break;
      }
    }
  };

  if (isLoading) return <div className="p-6 text-center">טוען...</div>;
  if (!run) return <div className="p-6">לא נמצא</div>;

  return (
    <div className="min-h-screen bg-gray-100 pb-20">
      <header className="bg-brand-600 text-white sticky top-0 z-10">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <Link to="/driver" className="inline-flex items-center gap-1 text-sm opacity-90 mb-1">
              <ChevronRight size={14} /> חזרה
            </Link>
            <div className="flex items-center gap-1.5">
              {gpsPos && (
                <div className="inline-flex items-center gap-1 text-xs bg-green-500 px-2 py-0.5 rounded-full">
                  <Crosshair size={12} />
                  GPS
                </div>
              )}
              {(!isOnline || queueSize > 0) && (
                <div className="inline-flex items-center gap-1 text-xs bg-amber-500 px-2 py-0.5 rounded-full">
                  <CloudOff size={12} />
                  {!isOnline ? 'ללא חיבור' : `${queueSize} בתור`}
                </div>
              )}
            </div>
          </div>
          <div className="font-semibold text-lg">{run.RunNumber}</div>
          <div className="text-sm opacity-90">{run.ZoneName}</div>
        </div>
      </header>

      <div className="p-4 space-y-3">
        {run.stops?.map((stop, idx) => {
          const isDone = stop.Status === 'DELIVERED' || stop.Status === 'PARTIAL';
          const isActive = stop.Status === 'ARRIVED';
          const allOrdersDelivered = stop.orders?.every((o) => o.Status === 'DELIVERED');

          return (
            <div
              key={stop.StopId}
              id={`stop-${stop.StopId}`}
              className={`bg-white rounded-2xl p-4 shadow-sm ${isDone ? 'opacity-60' : ''}`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold text-lg
                    ${isDone ? 'bg-green-100 text-green-700' : isActive ? 'bg-amber-100 text-amber-700' : 'bg-brand-100 text-brand-700'}`}>
                    {stop.StopOrder || idx + 1}
                  </div>
                  <div className="flex-1">
                    <div className="font-semibold">{stop.Street} {stop.BuildingNumber}</div>
                    <div className="text-sm text-gray-600">{stop.City}</div>
                    {stop.BranchName && <div className="text-xs text-gray-500 mt-0.5">{stop.BranchName}</div>}
                    {(stop.DeliveryWindowStart && stop.DeliveryWindowEnd) && (
                      <div className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded mt-1">
                        🕐 קבלה: {String(stop.DeliveryWindowStart).slice(0, 5)}-{String(stop.DeliveryWindowEnd).slice(0, 5)}
                      </div>
                    )}
                    {stop.ContactPhone && (
                      <a
                        href={`tel:${stop.ContactPhone}`}
                        className="inline-flex items-center gap-1 text-xs text-brand-700 mt-1 mr-2"
                      >
                        📞 {stop.ContactPhone}
                      </a>
                    )}
                    {stop.DeliveryNotes && (
                      <div className="text-xs text-gray-700 bg-blue-50 border border-blue-200 rounded p-1.5 mt-1">
                        💡 {stop.DeliveryNotes}
                      </div>
                    )}
                  </div>
                </div>
                <StatusPill status={stop.Status} size="sm" />
              </div>

              {/* Quick actions */}
              <div className="flex gap-2 mb-3">
                <NavigateButton
                  stop={{ ...stop, Lat: stop.Latitude || stop.Lat, Lng: stop.Longitude || stop.Lng }}
                  className="flex-1 justify-center"
                />
                {stop.Status === 'PENDING' && (
                  <button
                    onClick={() => updateStopMutation.mutate({ stopId: stop.StopId, status: 'ARRIVED' })}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-2 bg-amber-500 text-white rounded-lg text-sm active:bg-amber-600"
                  >
                    <MapPin size={14} /> הגעתי
                  </button>
                )}
              </div>

              {/* Orders */}
              <div className="space-y-2">
                {stop.orders?.map((o) => (
                  <div key={o.RunOrderId} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 text-xs rounded ${o.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                          חברה {o.CompanyCode}
                        </span>
                        <span className="font-medium text-sm">{o.SapCardName}</span>
                        <span className="text-xs text-gray-500">#{o.SapDocNum}</span>
                      </div>
                      <span className="text-xs text-gray-500">{o.LinesCount} שורות</span>
                    </div>
                    {o.Status === 'DELIVERED' && (
                      <div className="text-xs text-green-700 mt-1">
                        <Check size={12} className="inline ml-0.5" /> נמסר
                        {o.SapDeliveryDocEntry && ` · מסמך SAP #${o.SapDeliveryDocEntry}`}
                      </div>
                    )}
                  </div>
                ))}

                {stop.returns?.map((r) => (
                  <div key={r.ReturnId} className="border border-amber-200 bg-amber-50 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="px-1.5 py-0.5 text-xs rounded bg-amber-200 text-amber-800">חזרה</span>
                      <span className="font-medium text-sm">{r.SapCardName}</span>
                    </div>
                    <div className="text-xs text-gray-600">{r.Reason}</div>
                  </div>
                ))}
              </div>

              {/* Stop completion */}
              {stop.Status === 'ARRIVED' && (
                <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                  <button
                    onClick={() => setPodForStop(stop)}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium active:bg-green-700"
                  >
                    <PenLine size={16} /> סיים מסירה (POD)
                  </button>
                  <button
                    onClick={() => setFailureStop({
                      stopId: stop.StopId,
                      customerName: stop.orders?.[0]?.SapCardName || `${stop.Street} ${stop.BuildingNumber}`,
                    })}
                    className="px-3 py-2 border border-red-300 text-red-700 rounded-lg text-sm active:bg-red-50"
                    title="דווח על כשל"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}

              {(stop.SignatureUrl || stop.PhotoUrl || stop.PodGps) && (
                <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                  {stop.PhotoUrl && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">📸 תמונת מסירה:</div>
                      <img src={stop.PhotoUrl} alt="POD" className="max-h-32 rounded border" />
                    </div>
                  )}
                  {stop.SignatureUrl && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1">✍️ חתימת לקוח:</div>
                      <img src={stop.SignatureUrl} alt="Signature" className="max-h-24 border rounded bg-gray-50" />
                    </div>
                  )}
                  {stop.PodGps && (
                    <div className="text-[10px] text-gray-400">
                      📍 GPS: {stop.PodGps.lat.toFixed(5)}, {stop.PodGps.lng.toFixed(5)} (±{Math.round(stop.PodGps.accuracy)}מ׳)
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Signature capture modal (legacy fallback) */}
      {signingStopId && (
        <SignaturePad
          onCapture={handleSignatureCapture(signingStopId)}
          onCancel={() => setSigningStopId(null)}
        />
      )}

      {/* POD capture - photo + signature + GPS */}
      {podForStop && (
        <PodCapture
          stop={podForStop}
          onComplete={(payload) => handlePodComplete(podForStop.StopId, payload)}
          onClose={() => setPodForStop(null)}
        />
      )}

      {/* Voice commands - hands-free for the driver */}
      <VoiceCommandButton onCommand={handleVoiceCommand} />

      {/* Failure reporting dialog */}
      {failureStop && (
        <FailureReportDialog
          stopId={failureStop.stopId}
          customerName={failureStop.customerName}
          onClose={() => setFailureStop(null)}
          onReported={() => queryClient.invalidateQueries({ queryKey: ['manifest', id] })}
        />
      )}
    </div>
  );
}
