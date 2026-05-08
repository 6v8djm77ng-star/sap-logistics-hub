import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Wifi, WifiOff, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import MobileLinkDialog from './MobileLinkDialog.jsx';

/**
 * Global "Refresh everything" button.
 * - Invalidates every cached query (pulls fresh data from the server / SAP).
 * - Shows the time since the last refresh.
 * - Displays online / offline status.
 */
export default function RefreshButton() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(() => Date.now());
  const [, setTick] = useState(0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [mobileLinkOpen, setMobileLinkOpen] = useState(false);

  // Re-render every 15s so the "X ago" label stays accurate.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  // Track online / offline transitions.
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      toast.success('הרשת חזרה - מסנכרן נתונים…');
      handleRefresh();
    };
    const goOffline = () => {
      setOnline(false);
      toast.error('אין חיבור לרשת');
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries();
      await queryClient.refetchQueries({ type: 'active' });
      setLastRefresh(Date.now());
      toast.success('הנתונים סונכרנו ✓', { duration: 1500 });
    } catch (err) {
      toast.error('שגיאה בסנכרון: ' + (err?.message || 'לא ידוע'));
    } finally {
      // small delay so the spin animation is noticeable
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  const ago = formatAgo(Date.now() - lastRefresh);

  return (
    <div className="flex items-center gap-2">
      {/* Online indicator - icon only on mobile */}
      <span
        className={clsx(
          'flex items-center gap-1 text-xs px-2 py-1 rounded-full',
          online ? 'text-green-700 bg-green-50' : 'text-red-700 bg-red-50'
        )}
        title={online ? 'מחובר לשרת' : 'לא מחובר לרשת'}
      >
        {online ? <Wifi size={12} /> : <WifiOff size={12} />}
        <span className="hidden sm:inline">{online ? 'מחובר' : 'לא מחובר'}</span>
      </span>

      {/* Last refresh timestamp - desktop only */}
      <span className="hidden md:inline text-xs text-gray-500">עודכן {ago}</span>

      {/* Mobile install link */}
      <button
        onClick={() => setMobileLinkOpen(true)}
        className="flex items-center gap-1 px-2 sm:px-3 py-2 rounded-lg text-sm font-medium bg-purple-600 text-white border-2 border-purple-700 hover:bg-purple-700 shadow-sm"
        title="צור קישור התקנה במובייל"
      >
        <Smartphone size={16} />
        <span className="hidden sm:inline">מובייל</span>
      </button>
      {mobileLinkOpen && <MobileLinkDialog onClose={() => setMobileLinkOpen(false)} />}

      {/* Refresh button */}
      <button
        onClick={handleRefresh}
        disabled={refreshing || !online}
        className={clsx(
          'flex items-center gap-2 px-2 sm:px-4 py-2 rounded-lg text-sm font-bold shadow-sm transition-colors',
          'border-2',
          refreshing
            ? 'bg-brand-100 text-brand-700 border-brand-300'
            : 'bg-brand-600 text-white border-brand-700 hover:bg-brand-700',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
        title="רענן את כל הנתונים מ-SAP ומהשרת"
      >
        <RefreshCw size={18} className={clsx(refreshing && 'animate-spin')} />
        <span className="hidden sm:inline">רענן</span>
      </button>
    </div>
  );
}

function formatAgo(ms) {
  if (ms < 10_000) return 'עכשיו';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `לפני ${sec} שנ׳`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `לפני ${min} דק׳`;
  const hr = Math.floor(min / 60);
  return `לפני ${hr} שע׳`;
}
