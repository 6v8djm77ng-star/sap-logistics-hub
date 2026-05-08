import clsx from 'clsx';

const STATUS_LABELS = {
  OPEN: 'פתוח',
  PLANNED: 'מתוכנן',
  PICKING: 'בליקוט',
  LOADED: 'הועמס',
  IN_TRANSIT: 'בדרך',
  COMPLETED: 'הושלם',
  CANCELLED: 'מבוטל',
  PENDING: 'ממתין',
  ARRIVED: 'הגיע',
  DELIVERED: 'נמסר',
  PARTIAL: 'חלקי',
  FAILED: 'נכשל',
  SKIPPED: 'דולג',
  ASSIGNED: 'משויך',
  PICKED_UP: 'נאסף',
};

export default function StatusPill({ status, size = 'md' }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center rounded-full border font-medium',
        `status-${status}`,
        size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1'
      )}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}
