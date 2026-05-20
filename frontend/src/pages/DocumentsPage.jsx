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
import api from '../services/api.js';
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

function ConfirmSapDialog({ doc, type, onClose }) {
  const [docEntry, setDocEntry] = useState('');
  const [docNum, setDocNum] = useState('');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => docsApi.confirmSap(type, type === 'invoice' ? doc.InvoiceId : doc.DeliveryNoteId, docEntry, docNum),
    onSuccess: () => {
      toast.success('עודכן בהצלחה');
      queryClient.invalidateQueries();
      onClose();
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
              value={docEntry}
              onChange={(e) => setDocEntry(e.target.value)}
              placeholder="42203"
              className="w-full px-3 py-2 border rounded-lg"
            />
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
            disabled={!docEntry || mutation.isPending}
            className="flex-1 py-2 bg-brand-600 text-white rounded-lg disabled:opacity-50"
          >
            אשר
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
        </div>

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

          <a
            href={`/api/reports/${tab === 'deliveryNotes' ? 'delivery-notes' : 'invoices'}.xlsx?runDate=${date}&company=A`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
          >
            <Download size={14} /> Excel - OIG
          </a>
          <a
            href={`/api/reports/${tab === 'deliveryNotes' ? 'delivery-notes' : 'invoices'}.xlsx?runDate=${date}&company=B`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            <Download size={14} /> Excel - Unico
          </a>
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
                    <td className="p-3 text-left">
                      {inv.Status !== 'SAP_CONFIRMED' && (
                        <button
                          onClick={() => setConfirmingDoc({ doc: inv, type: 'invoice' })}
                          className="text-xs text-brand-600 hover:underline"
                        >
                          אשר ב-SAP
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
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
    </div>
  );
}
