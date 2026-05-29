/**
 * Screen registry — single source of truth for which screens the system
 * has and which sidebar section they belong to.
 *
 * Used by:
 *   - Role permissions API (demoServer.js /api/admin/screens)
 *   - Default-seed builder for `rolePermissions` when no rules exist yet
 *
 * Mirror in frontend: `frontend/src/constants/screens.js`. Keep in sync
 * whenever a new page is added to the sidebar.
 *
 * The `code` value is the route path WITHOUT a leading slash where the
 * stored AllowedScreens use this as the key. E.g. code='/warehouse'
 * means a row in AllowedScreens like '/warehouse' is a match.
 *
 * The wildcard sentinel '*' (used by ADMIN by default) means "every
 * screen, present and future" and short-circuits the membership check.
 */
'use strict';

const SCREENS = [
  // ---- workflow section (daily flow) ----
  { code: '/',           label: 'דשבורד',              section: 'workflow' },
  { code: '/orders',     label: 'הזמנות SAP',          section: 'workflow' },
  { code: '/runs',       label: 'מסלולי הפצה',         section: 'workflow' },
  { code: '/warehouse',  label: 'ליקוט מחסן',          section: 'workflow' },
  { code: '/qc-control', label: 'בקרה אחרי ליקוט',     section: 'workflow' },
  { code: '/documents',  label: 'תעודות וחשבוניות',    section: 'workflow' },
  { code: '/live',       label: 'מעקב חי',             section: 'workflow' },
  { code: '/returns',    label: 'חזרות',               section: 'workflow' },
  { code: '/exceptions', label: 'חריגים',              section: 'workflow' },
  { code: '/closure',    label: 'סגירת יום',           section: 'workflow' },

  // ---- reports section ----
  { code: '/analytics',   label: 'ניתוח ביצועים',  section: 'reports' },
  { code: '/weekly',      label: 'דוח שבועי',      section: 'reports' },
  { code: '/leaderboard', label: 'ביצועי נהגים',   section: 'reports' },
  { code: '/failures',    label: 'ניהול כשלים',    section: 'reports' },
  { code: '/map',         label: 'מפת נהגים',      section: 'reports' },
  { code: '/cod',         label: 'תשלום במזומן',   section: 'reports' },

  // ---- settings section ----
  { code: '/customer-policy',     label: 'מדיניות לקוחות',   section: 'settings' },
  { code: '/customer-doc-policy', label: 'מדיניות מסמכים',   section: 'settings' },
  { code: '/zones',               label: 'אזורי הפצה',       section: 'settings' },
  { code: '/drivers',             label: 'נהגים',            section: 'settings' },
  { code: '/pickers',             label: 'מלקטים',           section: 'settings' },
  { code: '/users',               label: 'משתמשים',          section: 'settings' },
  { code: '/role-permissions',    label: 'הרשאות תפקידים',   section: 'settings' },
  { code: '/settings',            label: 'הגדרות + SAP',     section: 'settings' },

  // ---- standalone ----
  { code: '/wallboard', label: 'מסך גדול', section: 'standalone' },
];

// All known role codes. A new role code should be added here AND given
// a default-seed entry in DEFAULT_ROLE_PERMISSIONS below.
const ROLE_CODES = ['ADMIN', 'PLANNER', 'PICKER', 'WAREHOUSE', 'QC_CONTROLLER', 'DRIVER'];

// Default permissions used to seed `rolePermissions` on first run (or
// for any role missing from the persisted array). ADMIN is the wildcard.
// Other roles get the screens they actually need for their job — narrow
// by default; the admin can widen via the UI.
const DEFAULT_ROLE_PERMISSIONS = {
  ADMIN:         ['*'],
  PLANNER:       ['/', '/orders', '/runs', '/documents', '/live', '/returns', '/exceptions', '/closure',
                  '/analytics', '/weekly', '/leaderboard', '/failures', '/map', '/cod',
                  '/customer-policy', '/customer-doc-policy', '/zones'],
  WAREHOUSE:     ['/', '/warehouse'],
  PICKER:        ['/warehouse'],
  QC_CONTROLLER: ['/', '/warehouse', '/qc-control'],
  // DRIVER uses a separate mobile-first UI (/driver/*) that lives outside
  // the dashboard layout — they don't see the sidebar at all. Listed for
  // completeness so the matrix UI can render their row even if their
  // tile is greyed out / read-only.
  DRIVER:        [],
};

function isScreenAllowedForList(allowedScreens, code) {
  if (!Array.isArray(allowedScreens)) return false;
  if (allowedScreens.includes('*')) return true;
  return allowedScreens.includes(code);
}

export { SCREENS, ROLE_CODES, DEFAULT_ROLE_PERMISSIONS, isScreenAllowedForList };
