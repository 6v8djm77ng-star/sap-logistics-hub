/**
 * Documents Page - Delivery Notes + Invoices, separated per company.
 * The user can:
 *   - See all generated documents (filtered by date/company/status)
 *   - Export per-company Excel for SAP entry
 *   - Mark as confirmed when manually entered in SAP
 *   - Generate invoices from delivery notes
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api, { downloadFile } from '../services/api.js';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  FileText, Receipt, Download, Building2, CheckCircle, Clock,
  AlertTriangle, ExternalLink, FilePlus2, Filter, RefreshCw,
} from 'lucide-react';
import SapWriteAuditBanner from '../components/SapWriteAuditBanner.jsx';

const docsApi = {
  listDeliveryNotes: (params) => api.get('/delivery-notes', { params }).then((r) => r.data.deliveryNotes),
  listInvoices: (params) => api.get('/invoices', { params }).then((r) => r.data.invoices),
  stats: (params) => api.get('/documents/stats', { params }).then((r) => r.data),
  generateInvoice: (dnId) => api.post(`/delivery-notes/${dnId}/generate-invoice`).then((r) => r.data),
  generateInvoicesForRun: (runId) => api.post(`/runs/${runId}/generate-invoices`).then((r) => r.data),
  confirmSap: (type, id, sapDocEntry, sapDocNum) =>
    api.post(`/documents/${type}/${id}/confirm-sap`, { sapDocEntry, sapDocNum }).then((r) => r.data),
  // DEV.13: revert a suspicious SAP confirmation back to PENDING_EXPORT.
  // Local-only; does not touch SAP. Backend rejects if not suspicious.
  revertConfirm: (type, id, reason) =>
    api.post(`/documents/${type}/${id}/revert-confirm`, { reason }).then((r) => r.data),
  // DEV.15: preview the SAP payload that WOULD be sent for an invoice.
  // Read-only — does not touch SAP, does not require SAP_WRITE_ENABLED.
  previewInvoiceExport: (invoiceId) =>
    api.post(`/admin/sap-write/invoices/${invoiceId}/preview`, {}).then((r) => r.data),
  // DEV.15: LIVE export of a single PENDING_EXPORT invoice to SAP TEST.
  // Requires SAP_WRITE_ENABLED=true on the backend AND admin role on the
  // caller. The magic phrase is hard-coded here — the UI gate is the dialog
  // the user clicks through, not a free-text field.
  exportInvoiceToSap: (invoiceId) =>
    api.post(`/admin/sap-write/invoices/${invoiceId}/export-test`, {
      confirm: 'I-UNDERSTAND-THIS-WRITES-TO-SAP',
    }).then((r) => r.data),
};

const STATUS_LABELS = {
  PENDING_EXPORT: { text: 'ממתין ליצוא', color: 'bg-amber-100 text-amber-700', icon: Clock },
  EXPORTED: { text: 'יוצא', color: 'bg-blue-100 text-blue-700', icon: Download },
  SENT_TO_SAP: { text: 'נשלח ל-SAP', color: 'bg-purple-100 text-purple-700', icon: Clock },
  SAP_CONFIRMED: { text: 'מאושר ב-SAP', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  FAILED: { text: 'נכשל', color: 'bg-red-100 text-red-700', icon: AlertTriangle },
  CANCELLED: { text: 'בוטל', color: 'bg-gray-100 text-gray-500', icon: AlertTriangle },
};

function StatusBadge({ status }) {
  const meta = STATUS_LABELS[status] || { text: status, color: 'bg-gray-100' };
  const Icon = meta.icon || Clock;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${meta.color}`}>
      <Icon size={11} />
      {meta.text}
    </span>
  );
}

// Matches backend `CONFIRM_SAP_MIN_DOCENTRY` in persistentStore.js (DEV.10).
// Hardcoded — exporting the constant from a backend module into a frontend
// bundle would couple the build pipeline to the server. If the backend floor
// changes, update here too; a UI test below would catch the divergence.
const CONFIRM_SAP_MIN_DOCENTRY = 100;

function ConfirmSapDialog({ doc, type, onClose }) {
  const [docEntry, setDocEntry] = useState('');
  const [docNum, setDocNum] = useState('');
  const queryClient = useQueryClient();

  // DEV.11: client-side check mirrors the backend safeguard so the operator
  // sees an inline reason before submit (instead of a silent 400). The
  // backend remains the source of truth — this is UX, not enforcement.
  const numEntry = Number(docEntry);
  const docEntryInvalid = docEntry === '' || !Number.isInteger(numEntry) || numEntry < CONFIRM_SAP_MIN_DOCENTRY;

  const mutation = useMutation({
    mutationFn: () => docsApi.confirmSap(type, type === 'invoice' ? doc.InvoiceId : doc.DeliveryNoteId, docEntry, docNum),
    onSuccess: () => {
      toast.success('עודכן בהצלחה');
      queryClient.invalidateQueries();
      onClose();
    },
    // DEV.11: surface backend rejections (DEV.10 INVALID_SAP_DOC_ENTRY /
    // INVALID_SAP_DOC_NUM → 400) instead of leaving the dialog silently
    // stuck. The backend `message` is operator-friendly Hebrew/explanation;
    // fall back to a generic line if the shape differs.
    onError: (err) => {
      const msg = err?.response?.data?.message
        || err?.response?.data?.error
        || err?.message
        || 'אישור SAP נכשל';
      toast.error(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5">
        <h2 className="font-bold text-lg mb-1">אישור יצירה ב-SAP</h2>
        <p className="text-sm text-gray-500 mb-4">
          {type === 'invoice' ? 'חשבונית' : 'תעודת משלוח'} {doc.DocNumber} - {doc.SapCardName}
        </p>

        <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-sm">
          <strong>איך לעשות:</strong>
          <ol className="text-xs mt-1 space-y-0.5 list-decimal pr-4">
            <li>פתח את SAP Business One</li>
            <li>צור {type === 'invoice' ? 'חשבונית A/R חדשה' : 'תעודת משלוח חדשה'} בחברת {doc.CompanyName}</li>
            <li>בחר לקוח {doc.SapCardCode}</li>
            <li>אחרי שמירה, חזור והכנס פה את ה-DocEntry וה-DocNum</li>
          </ol>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">SAP DocEntry</label>
            <input
              type="number"
              min={CONFIRM_SAP_MIN_DOCENTRY}
              value={docEntry}
              onChange={(e) => setDocEntry(e.target.value)}
              placeholder="42203"
              className={`w-full px-3 py-2 border rounded-lg ${
                docEntry !== '' && docEntryInvalid ? 'border-red-400 bg-red-50' : ''
              }`}
            />
            {/* DEV.11 helper — explains the backend safeguard inline so the
                operator doesn't waste a submit on a placeholder. */}
            <p className={`text-xs mt-1 ${
              docEntry !== '' && docEntryInvalid ? 'text-red-600' : 'text-gray-500'
            }`}>
              DocEntry אמיתי מ-SAP חייב להיות {CONFIRM_SAP_MIN_DOCENTRY} ומעלה.
              ערכים כמו 1 הם placeholders ולא יאושרו.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">SAP DocNum</label>
            <input
              type="number"
              value={docNum}
              onChange={(e) => setDocNum(e.target.value)}
              placeholder="42203"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={docEntryInvalid || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            title={docEntryInvalid ? `יש להזין DocEntry ≥ ${CONFIRM_SAP_MIN_DOCENTRY}` : undefined}
          >
            אשר
          </button>
        </div>
      </div>
    </div>
  );
}

// DEV.13: helper to detect a suspicious SAP confirmation in either DN or INV
// shape. Centralizes the (Status + DocEntry < floor) check so the row-action
// button and the dialog headline agree on what "suspicious" means.
function isSuspiciousConfirm(doc, type) {
  if (!doc || doc.Status !== 'SAP_CONFIRMED') return false;
  const de = Number(type === 'invoice' ? doc.SapInvoiceDocEntry : doc.SapDeliveryDocEntry);
  return Number.isInteger(de) && de >= 1 && de < CONFIRM_SAP_MIN_DOCENTRY;
}

function RevertConfirmDialog({ doc, type, onClose }) {
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const id = type === 'invoice' ? doc.InvoiceId : doc.DeliveryNoteId;
  const currentDE = type === 'invoice' ? doc.SapInvoiceDocEntry : doc.SapDeliveryDocEntry;

  const mutation = useMutation({
    mutationFn: () => docsApi.revertConfirm(type, id, reason.trim() || undefined),
    onSuccess: () => {
      toast.success('האישור בוטל. הסטטוס חזר ל-PENDING_EXPORT');
      queryClient.invalidateQueries();
      onClose();
    },
    onError: (err) => {
      const msg = err?.response?.data?.message
        || err?.response?.data?.error
        || err?.message
        || 'ביטול האישור נכשל';
      toast.error(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-5">
        <h2 className="font-bold text-lg mb-1 text-red-700 flex items-center gap-2">
          <AlertTriangle size={18} /> ביטול אישור SAP חשוד
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          {type === 'invoice' ? 'חשבונית' : 'תעודת משלוח'} {doc.DocNumber} - {doc.SapCardName}
        </p>

        <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-3 text-xs space-y-1">
          <div className="flex justify-between"><span>מצב כיום:</span><span className="font-semibold">SAP_CONFIRMED</span></div>
          <div className="flex justify-between">
            <span>SapDocEntry:</span>
            <span className="font-mono text-red-700 font-semibold">{currentDE} (placeholder)</span>
          </div>
          <div className="flex justify-between">
            <span>ConfirmedAt:</span>
            <span className="font-mono text-gray-600">{doc.ConfirmedAt || '—'}</span>
          </div>
        </div>

        <div className="bg-green-50 border border-green-200 rounded p-3 mb-3 text-xs space-y-1">
          <div className="flex justify-between"><span>אחרי ביטול:</span><span className="font-semibold">PENDING_EXPORT</span></div>
          <div className="flex justify-between"><span>SapDocEntry:</span><span className="text-gray-500">(יתאפס)</span></div>
          <div className="flex justify-between"><span>ConfirmedAt:</span><span className="text-gray-500">(יתאפס)</span></div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-4 text-xs">
          ⚠️ פעולה זו <strong>אינה משפיעה על SAP</strong>. היא רק מאפסת את הסימון המקומי
          של "אושר ב-SAP". אם המסמך באמת קיים ב-SAP — עדכן את ה-DocEntry האמיתי
          דרך "אשר ב-SAP".
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-1">סיבה (אופציונלי, לאודיט)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="למשל: placeholder שהוקלד בטעות במאי"
            maxLength={500}
            rows={2}
            className="w-full px-3 py-2 border rounded-lg text-sm"
          />
        </div>

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 border rounded-lg">ביטול</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="flex-1 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? 'מבטל…' : 'אשר ביטול אישור'}
          </button>
        </div>
      </div>
    </div>
  );
}

// DEV.15: dialog for LIVE export of an invoice to SAP TEST. Wraps the new
// DEV.14 endpoints: GET preview (auto-fetched on open) + POST export. The
// dialog is the ONLY way to send the magic phrase from the UI — no free-text
// input, so the operator can't typo their way into a corrupted call.
//
// Flow:
//   1. Open dialog → useQuery fires preview endpoint immediately
//   2. Show: target CompanyDB, guard verdict, payload that would be sent
//   3. If canExport=false → block the "אשר ושלח" button, show the reason
//   4. If canExport=true → enable button; click runs export mutation
//   5. On success → toast with DocEntry/DocNum, invalidate queries, close
//   6. On error → toast with backend message (e.g. negative inventory),
//      keep dialog open so operator can re-check & decide
function SapExportDialog({ invoice, onClose }) {
  const queryClient = useQueryClient();
  const invoiceId = invoice.InvoiceId;

  const previewQuery = useQuery({
    queryKey: ['sap-export-preview', invoiceId],
    queryFn: () => docsApi.previewInvoiceExport(invoiceId),
    staleTime: 0,
  });

  const exportMutation = useMutation({
    mutationFn: () => docsApi.exportInvoiceToSap(invoiceId),
    onSuccess: (data) => {
      toast.success(`חשבונית נוצרה ב-SAP! DocEntry=${data.sapDocEntry}, DocNum=${data.sapDocNum}`);
      queryClient.invalidateQueries();
      onClose();
    },
    onError: (err) => {
      const data = err?.response?.data;
      const msg = data?.error || data?.message || err?.message || 'שליחה ל-SAP נכשלה';
      // Surface useful structured fields when present so the operator sees
      // exactly what blocked them (e.g. LIVE_WRITE_DISABLED → arm needed).
      const extra = data?.code ? ` [${data.code}]` : '';
      toast.error(`${msg}${extra}`);
    },
  });

  const preview = previewQuery.data;
  const canExport = preview?.canExport === true;
  const isProductionDb = preview?.productionDbBlocked === true;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-5">
        <h2 className="font-bold text-lg mb-1 text-brand-700 flex items-center gap-2">
          <Send size={18} /> שליחת חשבונית ל-SAP TEST
        </h2>
        <p className="text-sm text-gray-500 mb-3">
          חשבונית {invoice.DocNumber} - {invoice.SapCardName}
        </p>

        {previewQuery.isLoading ? (
          <div className="py-6 text-center text-gray-500">טוען תצוגה מקדימה...</div>
        ) : previewQuery.isError ? (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
            כשל בטעינת תצוגה: {previewQuery.error?.response?.data?.error || previewQuery.error?.message}
          </div>
        ) : preview ? (
          <>
            {/* Target — most-important info, red if accidentally production */}
            <div className={`rounded p-3 mb-3 text-sm border ${
              isProductionDb ? 'bg-red-50 border-red-300' : 'bg-blue-50 border-blue-200'
            }`}>
              <div className="flex justify-between">
                <span>חברה ב-SAP:</span>
                <span className="font-mono font-semibold">{preview.targetCompanyDb || '(לא הוגדר)'}</span>
              </div>
              {isProductionDb && (
                <div className="text-red-700 font-semibold mt-1">⛔ זוהי חברת production — חסום</div>
              )}
            </div>

            {/* Guard verdict */}
            {!canExport && (
              <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-3 text-sm">
                <strong>לא ניתן לייצא:</strong>{' '}
                {preview.guard?.error || (isProductionDb ? 'production DB blocked' : 'unknown')}
                {preview.guard?.current && <span> (נוכחי: {preview.guard.current})</span>}
              </div>
            )}

            {/* Payload preview — exactly what SAP would receive */}
            <div className="bg-gray-50 border border-gray-200 rounded p-3 mb-3 text-xs">
              <div className="font-semibold mb-1">Payload שייצא:</div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-gray-700">
{JSON.stringify(preview.payloadThatWouldBeSent, null, 2)}
              </pre>
              <div className="text-xs text-gray-500 mt-1">
                Shape: {preview.payloadShape || 'unknown'}
              </div>
            </div>

            {/* DEV.15 inline warning so the operator knows the costs */}
            <div className="bg-yellow-50 border border-yellow-200 rounded p-3 mb-3 text-xs">
              ⚠️ פעולה זו תיצור חשבונית <strong>אמיתית ב-SAP</strong> ({preview.targetCompanyDb}).
              ביטול דורש Credit Memo ידני ב-SAP B1 Client. דורש <code>SAP_WRITE_ENABLED=true</code> בשרת.
            </div>
          </>
        ) : null}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 border rounded-lg"
            disabled={exportMutation.isPending}
          >
            ביטול
          </button>
          <button
            onClick={() => exportMutation.mutate()}
            disabled={!canExport || exportMutation.isPending || previewQuery.isLoading}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              !canExport
                ? 'תצוגה מקדימה חוסמת — ראה למעלה'
                : 'שלח את החשבונית ל-SAP TEST (פעולה אמיתית)'
            }
          >
            {exportMutation.isPending ? 'שולח…' : '↗ אשר ושלח ל-SAP'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('deliveryNotes'); // 'deliveryNotes' | 'invoices'
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [companyFilter, setCompanyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [confirmingDoc, setConfirmingDoc] = useState(null);
  // DEV.13: separate state for the revert dialog so confirm and revert can't
  // clash. revertingDoc = { doc, type } or null.
  const [revertingDoc, setRevertingDoc] = useState(null);
  // DEV.15: state for the SAP export dialog. exportingInvoice = invoice obj or null.
  const [exportingInvoice, setExportingInvoice] = useState(null);

  const params = {
    runDate: date,
    companyCode: companyFilter || undefined,
    status: statusFilter || undefined,
  };

  const { data: stats } = useQuery({
    queryKey: ['doc-stats', date],
    queryFn: () => docsApi.stats({ runDate: date }),
    refetchInterval: 30_000,
  });

  const { data: dns, isLoading: dnsLoading } = useQuery({
    queryKey: ['delivery-notes', params],
    queryFn: () => docsApi.listDeliveryNotes(params),
    enabled: tab === 'deliveryNotes',
  });

  const { data: invoices, isLoading: invoicesLoading } = useQuery({
    queryKey: ['invoices', params],
    queryFn: () => docsApi.listInvoices(params),
    enabled: tab === 'invoices',
  });

  // DEV.12: Audit queries — fetched only when the "ביקורת" tab is active.
  // No date filter: the audit must surface stale rows that fell outside
  // today's view (e.g. PENDING_EXPORT items waiting weeks). Status filter
  // is server-side (store.listDeliveryNotes / listInvoices honor it).
  // Suspicious-SAP-confirm detection runs client-side because the
  // SAP_CONFIRMED set is typically tiny (< 20 rows). If it grows past a
  // few hundred, add a dedicated `/api/documents/audit/suspicious` route.
  const auditEnabled = tab === 'audit';
  const { data: auditPendingDN, isLoading: lpDN } = useQuery({
    queryKey: ['audit', 'pending', 'deliveryNote'],
    queryFn: () => docsApi.listDeliveryNotes({ status: 'PENDING_EXPORT' }),
    enabled: auditEnabled,
  });
  const { data: auditPendingINV, isLoading: lpINV } = useQuery({
    queryKey: ['audit', 'pending', 'invoice'],
    queryFn: () => docsApi.listInvoices({ status: 'PENDING_EXPORT' }),
    enabled: auditEnabled,
  });
  const { data: auditConfirmedDN, isLoading: lcDN } = useQuery({
    queryKey: ['audit', 'confirmed', 'deliveryNote'],
    queryFn: () => docsApi.listDeliveryNotes({ status: 'SAP_CONFIRMED' }),
    enabled: auditEnabled,
  });
  const { data: auditConfirmedINV, isLoading: lcINV } = useQuery({
    queryKey: ['audit', 'confirmed', 'invoice'],
    queryFn: () => docsApi.listInvoices({ status: 'SAP_CONFIRMED' }),
    enabled: auditEnabled,
  });
  const auditLoading = auditEnabled && (lpDN || lpINV || lcDN || lcINV);

  // Combine DN + INV into a single list per section, tagging each row with
  // `_type` so the renderer picks the right icon/id. _sapDocEntry/_sapDocNum
  // unify the differing field names (SapDeliveryDocEntry vs SapInvoiceDocEntry).
  const auditPending = [
    ...((auditPendingDN || []).map((d) => ({ ...d, _type: 'deliveryNote' }))),
    ...((auditPendingINV || []).map((i) => ({ ...i, _type: 'invoice' }))),
  ];
  const auditSuspicious = [
    ...((auditConfirmedDN || [])
      .filter((d) => Number(d.SapDeliveryDocEntry) < CONFIRM_SAP_MIN_DOCENTRY)
      .map((d) => ({ ...d, _type: 'deliveryNote',
        _sapDocEntry: d.SapDeliveryDocEntry, _sapDocNum: d.SapDeliveryDocNum }))),
    ...((auditConfirmedINV || [])
      .filter((i) => Number(i.SapInvoiceDocEntry) < CONFIRM_SAP_MIN_DOCENTRY)
      .map((i) => ({ ...i, _type: 'invoice',
        _sapDocEntry: i.SapInvoiceDocEntry, _sapDocNum: i.SapInvoiceDocNum }))),
  ];
  const auditCount = auditPending.length + auditSuspicious.length;

  const generateInvoiceMutation = useMutation({
    mutationFn: (dnId) => docsApi.generateInvoice(dnId),
    onSuccess: () => {
      toast.success('חשבונית נוצרה');
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['doc-stats'] });
    },
  });

  const dnStats = stats?.deliveryNotes || {};
  const invStats = stats?.invoices || {};

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="text-brand-600" /> מסמכים (תעודות משלוח + חשבוניות)
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            כל מסמך נפרד לפי חברה - SAP_OIG (חברה א) ו-SAP_Unico (חברה ב)
          </p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="px-3 py-1.5 border rounded-lg text-sm"
        />
      </div>

      {/* A2f — SAP write mode + audit summary banner. Reads `audit` from
          the existing /api/documents/stats query and writer mode from a
          separate hook. Purely presentational. */}
      <SapWriteAuditBanner stats={stats} />

      {/* Stats - separated per company */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Delivery Notes */}
        <div className="bg-white border rounded-xl p-4">
          <h3 className="font-semibold flex items-center gap-2 mb-3">
            <FileText className="text-blue-500" size={18} />
            תעודות משלוח
          </h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-blue-50 rounded p-2 text-center">
              <div className="text-2xl font-bold text-blue-700">{dnStats.byCompany?.A || 0}</div>
              <div className="text-xs text-blue-600">OIG (א)</div>
            </div>
            <div className="bg-green-50 rounded p-2 text-center">
              <div className="text-2xl font-bold text-green-700">{dnStats.byCompany?.B || 0}</div>
              <div className="text-xs text-green-600">Unico (ב)</div>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <div className="text-2xl font-bold">{dnStats.total || 0}</div>
              <div className="text-xs text-gray-600">סה"כ</div>
            </div>
          </div>
          <div className="text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-amber-600">⏳ ממתין ליצוא:</span>
              <span className="font-medium">{dnStats.byStatus?.pendingExport || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-blue-600">📦 יוצא:</span>
              <span className="font-medium">{dnStats.byStatus?.exported || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-green-600">✓ אושר ב-SAP:</span>
              <span className="font-medium">{dnStats.byStatus?.confirmed || 0}</span>
            </div>
            <div className="border-t pt-1 mt-2 flex justify-between font-medium">
              <span>סכום כולל:</span>
              <span>₪{Number(dnStats.totalAmount || 0).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Invoices */}
        <div className="bg-white border rounded-xl p-4">
          <h3 className="font-semibold flex items-center gap-2 mb-3">
            <Receipt className="text-purple-500" size={18} />
            חשבוניות
          </h3>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-blue-50 rounded p-2 text-center">
              <div className="text-2xl font-bold text-blue-700">{invStats.byCompany?.A || 0}</div>
              <div className="text-xs text-blue-600">OIG (א)</div>
            </div>
            <div className="bg-green-50 rounded p-2 text-center">
              <div className="text-2xl font-bold text-green-700">{invStats.byCompany?.B || 0}</div>
              <div className="text-xs text-green-600">Unico (ב)</div>
            </div>
            <div className="bg-gray-50 rounded p-2 text-center">
              <div className="text-2xl font-bold">{invStats.total || 0}</div>
              <div className="text-xs text-gray-600">סה"כ</div>
            </div>
          </div>
          <div className="text-xs space-y-1">
            <div className="flex justify-between">
              <span>סכום נטו:</span>
              <span className="font-medium">₪{Number(invStats.totalAmount || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span>מע"מ (17%):</span>
              <span className="font-medium">₪{Number(invStats.vatAmount || 0).toLocaleString()}</span>
            </div>
            <div className="border-t pt-1 mt-2 flex justify-between font-medium">
              <span>סכום ברוטו:</span>
              <span>₪{Number(invStats.grossAmount || 0).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border rounded-xl overflow-hidden mb-4">
        <div className="flex border-b">
          <button
            onClick={() => setTab('deliveryNotes')}
            className={`flex-1 py-3 text-sm font-medium ${
              tab === 'deliveryNotes' ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600' : 'text-gray-500'
            }`}
          >
            <FileText size={14} className="inline ml-1.5" />
            תעודות משלוח ({dns?.length || 0})
          </button>
          <button
            onClick={() => setTab('invoices')}
            className={`flex-1 py-3 text-sm font-medium ${
              tab === 'invoices' ? 'bg-brand-50 text-brand-700 border-b-2 border-brand-600' : 'text-gray-500'
            }`}
          >
            <Receipt size={14} className="inline ml-1.5" />
            חשבוניות ({invoices?.length || 0})
          </button>
          {/* DEV.12 audit tab. Count is pending+suspicious. Red-tinted when
              suspicious > 0 — the operator should investigate fake SAP
              confirmations before they pile up. Counts here come from the
              audit queries (cross-date, status-scoped), which are
              fetched only when this tab is active. */}
          <button
            onClick={() => setTab('audit')}
            className={`flex-1 py-3 text-sm font-medium ${
              tab === 'audit'
                ? (auditSuspicious.length > 0
                    ? 'bg-red-50 text-red-700 border-b-2 border-red-600'
                    : 'bg-brand-50 text-brand-700 border-b-2 border-brand-600')
                : (auditSuspicious.length > 0 ? 'text-red-600' : 'text-gray-500')
            }`}
            title="ממתינים ליצוא + אישורי SAP חשודים (כל התאריכים)"
          >
            <AlertTriangle size={14} className="inline ml-1.5" />
            🔍 ביקורת ({auditCount})
          </button>
        </div>

        {/* DEV.12: filters bar + main table are hidden in the audit tab,
            which renders its own read-only view below. */}
        {tab !== 'audit' && (<>
        {/* Filters + Export */}
        <div className="p-3 border-b bg-gray-50 flex items-center gap-2 flex-wrap">
          <Filter size={14} className="text-gray-400" />
          <select
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="">כל החברות</option>
            <option value="A">OIG (א)</option>
            <option value="B">Unico (ב)</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1 border rounded text-sm"
          >
            <option value="">כל הסטטוסים</option>
            <option value="PENDING_EXPORT">ממתין ליצוא</option>
            <option value="EXPORTED">יוצא</option>
            <option value="SAP_CONFIRMED">אושר ב-SAP</option>
          </select>

          <div className="flex-1" />

          {/* Per-company export. URL path identical to the old <a>; we now
              route through downloadFile so the Bearer token attaches. */}
          <button
            type="button"
            onClick={() => {
              const resource = tab === 'deliveryNotes' ? 'delivery-notes' : 'invoices';
              downloadFile(
                `/reports/${resource}.xlsx?runDate=${date}&company=A`,
                `${resource}-${date}-A.csv`,
              ).catch((err) => toast.error(err.response?.data?.error || 'הורדה נכשלה'));
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            <Download size={14} /> Excel - OIG
          </button>
          <button
            type="button"
            onClick={() => {
              const resource = tab === 'deliveryNotes' ? 'delivery-notes' : 'invoices';
              downloadFile(
                `/reports/${resource}.xlsx?runDate=${date}&company=B`,
                `${resource}-${date}-B.csv`,
              ).catch((err) => toast.error(err.response?.data?.error || 'הורדה נכשלה'));
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            <Download size={14} /> Excel - Unico
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="p-3 text-right">מסמך</th>
                <th className="p-3 text-right">חברה</th>
                <th className="p-3 text-right">לקוח</th>
                <th className="p-3 text-right">מקור</th>
                <th className="p-3 text-center">פריטים</th>
                <th className="p-3 text-left">סכום</th>
                <th className="p-3 text-center">סטטוס</th>
                <th className="p-3 text-center">SAP DocEntry</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {tab === 'deliveryNotes' ? (
                dnsLoading ? (
                  <tr><td colSpan={9} className="p-8 text-center text-gray-500">טוען...</td></tr>
                ) : !dns?.length ? (
                  <tr><td colSpan={9} className="p-8 text-center text-gray-500">
                    אין תעודות משלוח לתאריך זה. תיווצרנה אוטומטית כשנהג מסיים עצירה.
                  </td></tr>
                ) : dns.map((dn) => (
                  <tr key={dn.DeliveryNoteId} className="hover:bg-gray-50">
                    <td className="p-3 font-mono text-xs">{dn.DocNumber}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${
                        dn.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {dn.CompanyName}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{dn.SapCardName}</div>
                      <div className="text-xs text-gray-500 font-mono">{dn.SapCardCode}</div>
                    </td>
                    <td className="p-3 text-xs">
                      {(dn.SourceOrders || []).map((s) => `#${s.SapDocNum}`).join(', ')}
                    </td>
                    <td className="p-3 text-center">{dn.LineCount}</td>
                    <td className="p-3 text-left font-mono">₪{Number(dn.TotalAmount).toLocaleString()}</td>
                    <td className="p-3 text-center"><StatusBadge status={dn.Status} /></td>
                    <td className="p-3 text-center text-xs font-mono">
                      {dn.SapDeliveryDocEntry || '—'}
                    </td>
                    <td className="p-3 text-left whitespace-nowrap">
                      {dn.Status !== 'SAP_CONFIRMED' && (
                        <button
                          onClick={() => setConfirmingDoc({ doc: dn, type: 'deliveryNote' })}
                          className="text-xs text-brand-600 hover:underline mr-2"
                        >
                          אשר ב-SAP
                        </button>
                      )}
                      {/* DEV.13: revert appears ONLY when this row is a
                          suspicious SAP_CONFIRMED (placeholder DocEntry).
                          For real confirmations, the button is hidden — no
                          undo path through the UI. */}
                      {isSuspiciousConfirm(dn, 'deliveryNote') && (
                        <button
                          onClick={() => setRevertingDoc({ doc: dn, type: 'deliveryNote' })}
                          className="text-xs text-red-600 hover:underline mr-2"
                          title="בטל את האישור החשוד והחזר ל-PENDING_EXPORT (לא נוגע ב-SAP)"
                        >
                          ↩ בטל אישור חשוד
                        </button>
                      )}
                      <button
                        onClick={() => generateInvoiceMutation.mutate(dn.DeliveryNoteId)}
                        className="text-xs text-purple-600 hover:underline"
                        title="צור חשבונית"
                      >
                        <Receipt size={13} className="inline" />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                invoicesLoading ? (
                  <tr><td colSpan={9} className="p-8 text-center text-gray-500">טוען...</td></tr>
                ) : !invoices?.length ? (
                  <tr><td colSpan={9} className="p-8 text-center text-gray-500">
                    אין חשבוניות. ניתן ליצור חשבוניות מתעודות המשלוח.
                  </td></tr>
                ) : invoices.map((inv) => (
                  <tr key={inv.InvoiceId} className="hover:bg-gray-50">
                    <td className="p-3 font-mono text-xs">{inv.DocNumber}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 text-xs rounded ${
                        inv.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                      }`}>
                        {inv.CompanyName}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{inv.SapCardName}</div>
                      <div className="text-xs text-gray-500 font-mono">{inv.SapCardCode}</div>
                    </td>
                    <td className="p-3 text-xs">DN-{inv.DeliveryNoteId}</td>
                    <td className="p-3 text-center">{inv.LineCount}</td>
                    <td className="p-3 text-left font-mono">
                      <div>נטו: ₪{Number(inv.TotalAmount).toLocaleString()}</div>
                      <div className="text-xs text-gray-500">ברוטו: ₪{Number(inv.GrossAmount).toLocaleString()}</div>
                    </td>
                    <td className="p-3 text-center"><StatusBadge status={inv.Status} /></td>
                    <td className="p-3 text-center text-xs font-mono">
                      {inv.SapInvoiceDocEntry || '—'}
                    </td>
                    <td className="p-3 text-left whitespace-nowrap">
                      {/* DEV.15: send-to-SAP button. Only on PENDING_EXPORT
                          (canExport precondition); the dialog enforces the
                          rest. The 6 retries we did in the LIVE.5/6 sessions
                          collapse into one click here. */}
                      {inv.Status === 'PENDING_EXPORT' && (
                        <button
                          onClick={() => setExportingInvoice(inv)}
                          className="text-xs text-brand-600 hover:underline mr-2 font-medium"
                          title="שלח את החשבונית ל-SAP TEST (פותח תצוגה מקדימה תחילה)"
                        >
                          ↗ שלח ל-SAP
                        </button>
                      )}
                      {inv.Status !== 'SAP_CONFIRMED' && (
                        <button
                          onClick={() => setConfirmingDoc({ doc: inv, type: 'invoice' })}
                          className="text-xs text-brand-600 hover:underline mr-2"
                        >
                          אשר ב-SAP
                        </button>
                      )}
                      {/* DEV.13: future-proof — currently no INV is
                          suspicious, but the same guard applies if one
                          ever is. */}
                      {isSuspiciousConfirm(inv, 'invoice') && (
                        <button
                          onClick={() => setRevertingDoc({ doc: inv, type: 'invoice' })}
                          className="text-xs text-red-600 hover:underline"
                          title="בטל את האישור החשוד והחזר ל-PENDING_EXPORT (לא נוגע ב-SAP)"
                        >
                          ↩ בטל אישור חשוד
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </>)}

        {/* DEV.12 audit view — read-only. Two sections, each with its own
            empty state. No action buttons by design: this view is for
            visibility only; corrections happen in the regular tabs. */}
        {tab === 'audit' && (
          <div className="p-4 space-y-6">
            {auditLoading ? (
              <div className="text-center text-gray-500 py-8">טוען...</div>
            ) : (
              <>
                {/* Section A — PENDING_EXPORT, all dates */}
                <section>
                  <h3 className="font-semibold flex items-center gap-2 mb-2 text-amber-700">
                    <Clock size={16} /> ממתינים ליצוא
                    <span className="text-xs font-normal text-gray-500">({auditPending.length})</span>
                  </h3>
                  {auditPending.length === 0 ? (
                    <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                      ✓ אין רשומות חריגות להצגה
                    </div>
                  ) : (
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr>
                            <th className="p-2 text-right">סוג מסמך</th>
                            <th className="p-2 text-right">DocNumber</th>
                            <th className="p-2 text-right">חברה</th>
                            <th className="p-2 text-right">לקוח</th>
                            <th className="p-2 text-center">סטטוס</th>
                            <th className="p-2 text-left">סכום</th>
                            <th className="p-2 text-right">CreatedAt</th>
                            <th className="p-2 text-center">ממתין</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {auditPending.map((item) => {
                            const id = item._type === 'invoice' ? item.InvoiceId : item.DeliveryNoteId;
                            const createdRaw = item.CreatedAt || item.IssuedAt || null;
                            const createdMs = createdRaw ? new Date(createdRaw).getTime() : NaN;
                            const ageDays = !Number.isNaN(createdMs)
                              ? Math.floor((Date.now() - createdMs) / 86400000)
                              : null;
                            return (
                              <tr key={`${item._type}-${id}`} className="hover:bg-gray-50">
                                <td className="p-2">
                                  {item._type === 'invoice' ? (
                                    <span className="inline-flex items-center gap-1 text-purple-700">
                                      <Receipt size={12} /> חשבונית
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-blue-700">
                                      <FileText size={12} /> תעודת משלוח
                                    </span>
                                  )}
                                </td>
                                <td className="p-2 font-mono text-xs">{item.DocNumber}</td>
                                <td className="p-2">
                                  <span className={`px-1.5 py-0.5 text-xs rounded ${
                                    item.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                                  }`}>{item.CompanyName}</span>
                                </td>
                                <td className="p-2">
                                  <div className="font-medium">{item.SapCardName}</div>
                                  <div className="text-xs text-gray-500 font-mono">{item.SapCardCode}</div>
                                </td>
                                <td className="p-2 text-center"><StatusBadge status={item.Status} /></td>
                                <td className="p-2 text-left font-mono">
                                  ₪{Number(item.TotalAmount || 0).toLocaleString()}
                                </td>
                                <td className="p-2 text-xs text-gray-600">
                                  {createdRaw && !Number.isNaN(createdMs)
                                    ? format(new Date(createdMs), 'yyyy-MM-dd HH:mm')
                                    : '—'}
                                </td>
                                <td className="p-2 text-center text-xs">
                                  {ageDays != null
                                    ? <span className={ageDays >= 7 ? 'text-amber-700 font-medium' : ''}>
                                        {`${ageDays} ימים`}
                                      </span>
                                    : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* Section B — SAP_CONFIRMED with SapDocEntry below the floor */}
                <section>
                  <h3 className="font-semibold flex items-center gap-2 mb-1 text-red-700">
                    <AlertTriangle size={16} /> אישורי SAP חשודים
                    <span className="text-xs font-normal text-gray-500">({auditSuspicious.length})</span>
                  </h3>
                  <p className="text-xs text-gray-500 mb-2">
                    SapDocEntry קטן מ-{CONFIRM_SAP_MIN_DOCENTRY} נראה כמו placeholder ולא אישור SAP אמיתי.
                  </p>
                  {auditSuspicious.length === 0 ? (
                    <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                      ✓ אין רשומות חריגות להצגה
                    </div>
                  ) : (
                    <div className="overflow-x-auto border rounded-lg">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr>
                            <th className="p-2 text-right">סוג מסמך</th>
                            <th className="p-2 text-right">DocNumber</th>
                            <th className="p-2 text-right">חברה</th>
                            <th className="p-2 text-center">SapDocEntry</th>
                            <th className="p-2 text-center">SapDocNum</th>
                            <th className="p-2 text-right">ConfirmedAt</th>
                            <th className="p-2 text-right">הסבר</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {auditSuspicious.map((item) => {
                            const id = item._type === 'invoice' ? item.InvoiceId : item.DeliveryNoteId;
                            const confirmedMs = item.ConfirmedAt ? new Date(item.ConfirmedAt).getTime() : NaN;
                            return (
                              <tr key={`${item._type}-${id}`} className="hover:bg-gray-50">
                                <td className="p-2">
                                  {item._type === 'invoice' ? (
                                    <span className="inline-flex items-center gap-1 text-purple-700">
                                      <Receipt size={12} /> חשבונית
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-blue-700">
                                      <FileText size={12} /> תעודת משלוח
                                    </span>
                                  )}
                                </td>
                                <td className="p-2 font-mono text-xs">{item.DocNumber}</td>
                                <td className="p-2">
                                  <span className={`px-1.5 py-0.5 text-xs rounded ${
                                    item.CompanyCode === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
                                  }`}>{item.CompanyName}</span>
                                </td>
                                <td className="p-2 text-center font-mono text-red-700 font-semibold">
                                  {item._sapDocEntry ?? '—'}
                                </td>
                                <td className="p-2 text-center font-mono text-xs">
                                  {item._sapDocNum ?? '—'}
                                </td>
                                <td className="p-2 text-xs text-gray-600">
                                  {item.ConfirmedAt && !Number.isNaN(confirmedMs)
                                    ? format(new Date(confirmedMs), 'yyyy-MM-dd HH:mm')
                                    : '—'}
                                </td>
                                <td className="p-2 text-xs text-red-600">
                                  placeholder, לא DocEntry אמיתי
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        )}
      </div>

      {/* Workflow tip */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 rounded-xl p-4">
        <h3 className="font-semibold mb-2 flex items-center gap-2">
          💡 איך לעבוד עם המסמכים
        </h3>
        <ol className="text-sm space-y-1 list-decimal pr-5">
          <li>נהג מסיים עצירה → תעודות משלוח <strong>נוצרות אוטומטית</strong> (אחת לכל חברה)</li>
          <li>אחרי הליקוט/מסירה - לחץ "Excel - OIG" ו-"Excel - Unico" להורדת רשימה לפי חברה</li>
          <li>פתח את SAP - הזן את התעודות ידנית מהרשימה (חברה אחר חברה)</li>
          <li>חזור ולחץ "אשר ב-SAP" - הזן את ה-DocEntry שקיבלת מ-SAP</li>
          <li>לחץ על אייקון <Receipt size={11} className="inline" /> ליצירת חשבונית מתעודת משלוח</li>
        </ol>
      </div>

      {confirmingDoc && (
        <ConfirmSapDialog
          doc={confirmingDoc.doc}
          type={confirmingDoc.type}
          onClose={() => setConfirmingDoc(null)}
        />
      )}

      {/* DEV.13 revert dialog. Opens only when a suspicious-row button is
          clicked. Backend rejects non-suspicious docs even if the button
          somehow opens for them (defense-in-depth). */}
      {revertingDoc && (
        <RevertConfirmDialog
          doc={revertingDoc.doc}
          type={revertingDoc.type}
          onClose={() => setRevertingDoc(null)}
        />
      )}

      {/* DEV.15 SAP export dialog. Opens with auto-loaded preview from the
          DEV.14 preview endpoint. The dialog handles both the inspection +
          the actual send-to-SAP click. Magic phrase is never visible to the
          user — sent automatically by the apiClient method. */}
      {exportingInvoice && (
        <SapExportDialog
          invoice={exportingInvoice}
          onClose={() => setExportingInvoice(null)}
        />
      )}
    </div>
  );
}
