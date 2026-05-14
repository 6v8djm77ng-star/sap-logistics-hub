/**
 * "Next page" button — appears at the bottom of every workflow-flow page.
 * Uses the current route to find the next stop in the daily workflow order
 * and renders a "הבא: <next page name>" CTA. Returns null on:
 *   - non-workflow routes (reports, settings, wallboard, /runs/:id, etc.)
 *   - the last workflow page (/closure) — there's no "next"
 *
 * Order mirrors the sidebar's workflowSection in DashboardLayout.jsx. If
 * you change the workflow order in one place, update both.
 */
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// Workflow order — matches the sidebar's top section. Keep in sync.
const WORKFLOW_ORDER = [
  { to: '/',           label: 'דשבורד' },
  { to: '/orders',     label: 'הזמנות SAP' },
  { to: '/planner',    label: 'תכנון יומי' },
  { to: '/runs',       label: 'מסלולי הפצה' },
  { to: '/warehouse',  label: 'ליקוט מחסן' },
  { to: '/documents',  label: 'תעודות וחשבוניות' },
  { to: '/map',        label: 'מפת נהגים' },
  { to: '/live',       label: 'מעקב חי' },
  { to: '/returns',    label: 'חזרות' },
  { to: '/exceptions', label: 'חריגים' },
  { to: '/anomalies',  label: 'זיהוי חריגים' },
  { to: '/cod',        label: 'תשלום במזומן' },
  { to: '/closure',    label: 'סגירת יום' }, // last — no "next"
];

export default function NextPageButton() {
  const location = useLocation();
  const currentIdx = WORKFLOW_ORDER.findIndex((item) => item.to === location.pathname);

  // Hide on:
  //  - routes not in the workflow (reports/settings/wallboard/sub-routes)
  //  - the last page in the workflow (no "next")
  if (currentIdx < 0 || currentIdx >= WORKFLOW_ORDER.length - 1) return null;

  const next = WORKFLOW_ORDER[currentIdx + 1];

  return (
    <div className="px-4 sm:px-6 py-5 flex justify-end border-t border-gray-100 mt-6">
      <Link
        to={next.to}
        className="inline-flex items-center gap-2 px-4 py-2.5 bg-brand-600 text-white rounded-lg hover:bg-brand-700 text-sm font-medium shadow-sm transition-colors"
      >
        <span>הבא: {next.label}</span>
        {/* RTL: arrow-left visually points "forward" (text flows right→left) */}
        <ArrowLeft size={16} />
      </Link>
    </div>
  );
}

// Exported for tests + sidebar consistency check
export { WORKFLOW_ORDER };
