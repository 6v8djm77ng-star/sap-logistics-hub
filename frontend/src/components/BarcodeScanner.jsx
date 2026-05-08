/**
 * Barcode Scanner with multiple fallbacks:
 *  1. Camera scanning via html5-qrcode (requires HTTPS or localhost)
 *  2. Manual barcode entry (always works)
 *  3. USB barcode reader support (just types into text input)
 */
import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, X, Zap, ZapOff, Keyboard, AlertTriangle, Check } from 'lucide-react';

export default function BarcodeScanner({ onScan, onClose, hint = 'כוון את הברקוד לתוך הריבוע' }) {
  const containerId = 'barcode-scanner-' + Math.random().toString(36).slice(2, 8);
  const scannerRef = useRef(null);
  const inputRef = useRef(null);
  const [error, setError] = useState(null);
  const [cameras, setCameras] = useState([]);
  const [cameraIdx, setCameraIdx] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [mode, setMode] = useState('detecting'); // 'detecting' | 'camera' | 'manual'
  const [manualValue, setManualValue] = useState('');

  // Detect camera support and HTTPS requirement
  useEffect(() => {
    const isSecure = window.isSecureContext || window.location.hostname === 'localhost';
    const hasMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

    if (!hasMedia) {
      setError('הדפדפן לא תומך בגישה למצלמה');
      setMode('manual');
      return;
    }

    if (!isSecure) {
      setError(
        `הגישה למצלמה דורשת HTTPS או localhost. ` +
        `הדפדפן חוסם מצלמה כשמתחברים דרך כתובת IP. ` +
        `אפשר להזין ברקוד ידנית או דרך סורק USB.`
      );
      setMode('manual');
      return;
    }

    Html5Qrcode.getCameras()
      .then((devices) => {
        if (!devices || devices.length === 0) {
          setError('לא נמצאה מצלמה במכשיר');
          setMode('manual');
          return;
        }
        setCameras(devices);
        const backIdx = devices.findIndex((d) => /back|rear|environment/i.test(d.label || ''));
        if (backIdx >= 0) setCameraIdx(backIdx);
        setMode('camera');
      })
      .catch((err) => {
        const msg = err?.message || String(err);
        if (/permission/i.test(msg) || /denied/i.test(msg)) {
          setError('אין הרשאה למצלמה. אישר בדפדפן ונסה שוב, או השתמש בקלט ידני.');
        } else {
          setError(msg || 'שגיאה בגישה למצלמה');
        }
        setMode('manual');
      });
  }, []);

  // Start scanner when in camera mode
  useEffect(() => {
    if (mode !== 'camera' || !cameras.length) return;

    const scanner = new Html5Qrcode(containerId);
    scannerRef.current = scanner;

    const config = {
      fps: 10,
      qrbox: { width: 280, height: 140 },
      aspectRatio: 1.777,
    };

    scanner.start(
      cameras[cameraIdx].id,
      config,
      (decodedText) => onScan(decodedText),
      () => {}
    ).catch((err) => {
      const msg = err?.message || String(err);
      setError(msg);
      setMode('manual');
    });

    return () => {
      scanner.stop().catch(() => {}).then(() => scanner.clear());
    };
  }, [mode, cameras, cameraIdx, containerId, onScan]);

  // Auto-focus manual input when in manual mode
  useEffect(() => {
    if (mode === 'manual' && inputRef.current) {
      inputRef.current.focus();
    }
  }, [mode]);

  const toggleTorch = async () => {
    try {
      const scanner = scannerRef.current;
      if (!scanner) return;
      const track = scanner.getRunningTrackCameraCapabilities?.();
      if (track?.torchFeature?.()?.isSupported?.()) {
        await track.torchFeature().apply(!torchOn);
        setTorchOn(!torchOn);
      }
    } catch {}
  };

  const switchCamera = () => {
    setCameraIdx((i) => (i + 1) % cameras.length);
  };

  const handleManualSubmit = (e) => {
    e?.preventDefault();
    if (!manualValue.trim()) return;
    onScan(manualValue.trim());
    setManualValue('');
    // Keep focus for next scan from USB reader
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-black/80 text-white">
        <div className="flex items-center gap-2">
          {mode === 'camera' ? <Camera size={18} /> : <Keyboard size={18} />}
          <span className="font-medium">
            {mode === 'camera' ? 'סריקת ברקוד' : 'הזנת ברקוד ידנית'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Toggle modes */}
          {!error && cameras.length > 0 && (
            <button
              onClick={() => setMode(mode === 'camera' ? 'manual' : 'camera')}
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-sm flex items-center gap-1.5"
              title={mode === 'camera' ? 'מעבר לקלט ידני' : 'מעבר לסורק'}
            >
              {mode === 'camera' ? <Keyboard size={14} /> : <Camera size={14} />}
              {mode === 'camera' ? 'ידני' : 'מצלמה'}
            </button>
          )}
          {mode === 'camera' && cameras.length > 1 && (
            <button onClick={switchCamera} className="p-2 hover:bg-white/10 rounded-lg">
              <Camera size={18} />
            </button>
          )}
          {mode === 'camera' && (
            <button onClick={toggleTorch} className="p-2 hover:bg-white/10 rounded-lg">
              {torchOn ? <ZapOff size={18} /> : <Zap size={18} />}
            </button>
          )}
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
        {mode === 'detecting' && (
          <div className="text-white text-center p-6">
            <div className="animate-pulse mb-2">🎥</div>
            <p>בודק זמינות מצלמה...</p>
          </div>
        )}

        {mode === 'camera' && (
          <>
            <div id={containerId} className="w-full h-full" />
          </>
        )}

        {mode === 'manual' && (
          <div className="w-full max-w-md p-6">
            {error && (
              <div className="bg-amber-500/20 border border-amber-500/50 rounded-lg p-3 mb-4 text-amber-100 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium mb-1">המצלמה לא זמינה</div>
                    <div className="text-xs opacity-90">{error}</div>
                  </div>
                </div>
              </div>
            )}

            <form onSubmit={handleManualSubmit}>
              <div className="bg-white rounded-2xl p-4 shadow-xl">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  הזן ברקוד או סרוק עם סורק USB:
                </label>
                <div className="flex gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={manualValue}
                    onChange={(e) => setManualValue(e.target.value)}
                    placeholder="7290019173793"
                    className="flex-1 px-4 py-3 border-2 border-gray-300 rounded-lg text-lg font-mono focus:border-brand-500 outline-none"
                    autoComplete="off"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!manualValue.trim()}
                    className="px-6 py-3 bg-brand-600 text-white rounded-lg font-medium disabled:opacity-50"
                  >
                    <Check size={20} />
                  </button>
                </div>
                <div className="mt-3 text-xs text-gray-500 space-y-1">
                  <div>💡 <strong>סורק USB:</strong> פשוט סרוק - הברקוד יוקלד ויאושר אוטומטית</div>
                  <div>⌨️ <strong>הקלדה ידנית:</strong> הקלד את הברקוד ולחץ Enter</div>
                </div>
              </div>

              {/* Try camera anyway button */}
              {cameras.length > 0 && error && (
                <button
                  type="button"
                  onClick={() => { setError(null); setMode('camera'); }}
                  className="mt-3 w-full py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 text-sm"
                >
                  נסה שוב עם מצלמה
                </button>
              )}
            </form>
          </div>
        )}
      </div>

      {/* Footer hint */}
      {mode === 'camera' && (
        <div className="p-4 bg-black/80 text-white text-center text-sm">
          {hint}
        </div>
      )}
    </div>
  );
}
