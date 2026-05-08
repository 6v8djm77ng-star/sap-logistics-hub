/**
 * Touch-friendly signature capture canvas.
 * Returns a PNG data URL via onCapture(dataUrl).
 */
import { useEffect, useRef, useState } from 'react';
import { Eraser, Check } from 'lucide-react';

export default function SignaturePad({ onCapture, onCancel, title = 'חתימת לקוח' }) {
  const canvasRef = useRef(null);
  const [isEmpty, setIsEmpty] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    // High-DPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#000';

    let drawing = false;

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const start = (e) => {
      e.preventDefault();
      drawing = true;
      setIsEmpty(false);
      const { x, y } = getPos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
    };

    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = getPos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    };

    const end = () => {
      drawing = false;
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start);
    canvas.addEventListener('touchmove', move);
    canvas.addEventListener('touchend', end);

    return () => {
      canvas.removeEventListener('mousedown', start);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseup', end);
      canvas.removeEventListener('mouseleave', end);
      canvas.removeEventListener('touchstart', start);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', end);
    };
  }, []);

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setIsEmpty(true);
  };

  const handleAccept = () => {
    if (isEmpty) return;
    const dataUrl = canvasRef.current.toDataURL('image/png');
    onCapture(dataUrl);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-4">
        <h2 className="text-lg font-bold mb-3 text-center">{title}</h2>
        <canvas
          ref={canvasRef}
          className="w-full bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg touch-none"
          style={{ height: 200 }}
        />
        <p className="text-xs text-gray-500 text-center mt-2">
          חתום כאן באמצעות האצבע
        </p>

        <div className="flex gap-2 mt-4">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 border border-gray-300 rounded-lg font-medium"
          >
            ביטול
          </button>
          <button
            onClick={handleClear}
            disabled={isEmpty}
            className="py-2.5 px-3 border border-gray-300 rounded-lg disabled:opacity-50"
          >
            <Eraser size={18} />
          </button>
          <button
            onClick={handleAccept}
            disabled={isEmpty}
            className="flex-1 py-2.5 bg-green-600 text-white rounded-lg font-medium disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Check size={18} /> אישור
          </button>
        </div>
      </div>
    </div>
  );
}
