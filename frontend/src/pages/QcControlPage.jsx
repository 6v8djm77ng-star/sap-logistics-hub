/**
 * QC Control Page — Post-Picking Quality Control.
 *
 * P1 placeholder (2026-05-26): visible only to ADMIN + QC_CONTROLLER. The
 * actual functionality is delivered in later phases:
 *   - P3: backend endpoints GET /api/qc/pending, POST /api/qc/approve-order,
 *         POST /api/qc/reject-order, POST /api/qc/edit-quantity,
 *         POST /api/qc/approve-wave
 *   - P4: this page replaces the placeholder with a real waves+orders list
 *         with filters (date / picker / zone / status)
 *   - P5: approve / reject actions integrate per-order DN/INV generation
 *   - P6: edit-quantity flow
 *
 * Until then, the page exists so the sidebar item links somewhere instead of
 * 404, and the route is gated by RequireAuth roles={['QC_CONTROLLER','ADMIN']}.
 * Backend middleware qcControllerOnly (demoServer.js) mirrors the same gate.
 */
import { ShieldCheck } from 'lucide-react';

export default function QcControlPage() {
  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-4">
        <ShieldCheck className="text-blue-600" size={28} />
        <h1 className="text-2xl font-bold">בקרה אחרי ליקוט</h1>
      </div>
      <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-5 text-sm leading-relaxed">
        <p className="font-semibold text-blue-900 mb-2">המסך הזה בהקמה</p>
        <p className="text-blue-800">
          במסך הזה תוכל לסקור גלי ליקוט שהוגשו לבקרה, ולאשר/לדחות הזמנות
          ‏ברמת ההזמנה הבודדת לפני יצירת תעודות משלוח וחשבוניות.
        </p>
        <ul className="mt-3 list-disc list-inside text-blue-800 space-y-1">
          <li>‏P1 (פעיל)‏: role ‏`QC_CONTROLLER`‏ + middleware + סרגל ניווט</li>
          <li>‏P3‏: ‏API‏ endpoints ל-‏QC‏</li>
          <li>‏P4‏: רשימת waves ‏+‏ פילטרים (תאריך / מלקט / אזור)</li>
          <li>‏P5‏: אישור / דחייה per-order ‏+‏ יצירת ‏DN/INV‏</li>
          <li>‏P6‏: עריכת כמויות</li>
        </ul>
      </div>
    </div>
  );
}
