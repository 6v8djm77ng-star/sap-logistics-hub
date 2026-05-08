/**
 * Driver Manifest PDF - the printable document the driver can carry.
 *
 * Contents (per the RFP):
 *   - Deliveries: customer, address, items per stop
 *   - Pickups (returns): items to collect + reason
 *   - Stop order (route sequence)
 *   - Clear separation between deliveries and pickups
 *
 * Uses PDFKit for direct PDF generation (no browser/puppeteer needed).
 * Hebrew/RTL support via bidi reordering.
 */
import PDFDocument from 'pdfkit';
import { format } from 'date-fns';
import * as runs from '../deliveryRuns.js';

/**
 * Reverse Hebrew words for PDFKit (which doesn't do proper RTL).
 * For simple cases - mixed LTR content is tricky.
 */
function rtl(text) {
  if (!text) return '';
  // Split by whitespace, reverse word order, preserve numbers/english left-to-right
  return String(text).split('').reverse().join('');
}

/**
 * Generate PDF stream for a run manifest.
 * Returns a Readable stream suitable for res.pipe().
 */
export async function generateDriverManifestPdf(runId) {
  const run = await runs.getRunDetails(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title: `Driver Manifest ${run.RunNumber}`,
      Author: 'SAP Logistics Hub',
    },
  });

  // ---- Header ----
  doc.fontSize(20).fillColor('#1e3a8a').text(rtl('דף נהג'), { align: 'right' });
  doc.fontSize(12).fillColor('#666')
    .text(`${run.RunNumber}    |    ${format(new Date(run.RunDate), 'dd/MM/yyyy')}`, { align: 'right' });

  doc.moveDown(0.5);

  // ---- Run info ----
  doc.fontSize(10).fillColor('#000');
  const driver = run.DriverName || '---';
  const zone = run.ZoneName || '---';
  doc.text(`${rtl('אזור')}: ${rtl(zone)}`, { align: 'right' });
  doc.text(`${rtl('נהג')}: ${rtl(driver)}`, { align: 'right' });
  if (run.VehiclePlate) doc.text(`${rtl('רכב')}: ${run.VehiclePlate}`, { align: 'right' });

  doc.moveDown();

  // ---- Summary ----
  const totalStops = run.stops?.length || 0;
  const totalOrders = run.stops?.reduce((s, st) => s + (st.orders?.length || 0), 0) || 0;
  const totalReturns = run.stops?.reduce((s, st) => s + (st.returns?.length || 0), 0) || 0;

  doc.fontSize(11).fillColor('#2563eb')
    .text(`${rtl('סה"כ')}: ${totalStops} ${rtl('עצירות')}, ${totalOrders} ${rtl('הזמנות')}, ${totalReturns} ${rtl('חזרות')}`, { align: 'right' });

  doc.moveDown(1);
  drawHorizontalLine(doc);
  doc.moveDown(0.5);

  // ---- Stops ----
  for (const stop of run.stops || []) {
    if (doc.y > 700) {
      doc.addPage();
    }

    // Stop header with number badge
    const stopY = doc.y;
    doc.circle(520, stopY + 8, 12).fillColor('#2563eb').fill();
    doc.fontSize(10).fillColor('white').text(String(stop.StopOrder || ''), 514, stopY + 3);
    doc.fillColor('#000');

    doc.fontSize(13).fillColor('#000')
      .text(`${rtl(stop.Street || '')} ${stop.BuildingNumber || ''}`, 40, stopY, {
        width: 460, align: 'right',
      });
    doc.fontSize(10).fillColor('#666')
      .text(rtl(stop.City || ''), 40, doc.y, { width: 460, align: 'right' });
    if (stop.BranchName) {
      doc.fontSize(9).fillColor('#999')
        .text(rtl(stop.BranchName), 40, doc.y, { width: 460, align: 'right' });
    }

    doc.moveDown(0.5);

    // Deliveries
    if (stop.orders?.length) {
      doc.fontSize(10).fillColor('#2563eb').text(rtl('משלוחים:'), { align: 'right' });
      for (const order of stop.orders) {
        doc.fontSize(9).fillColor('#000')
          .text(
            `${rtl('חברה')} ${order.CompanyCode} | ${rtl(order.SapCardName || '')} | #${order.SapDocNum} | ${order.LinesCount || 0} ${rtl('שורות')}  ☐`,
            { align: 'right' }
          );
      }
    }

    // Returns
    if (stop.returns?.length) {
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor('#d97706').text(rtl('איסופים (חזרות):'), { align: 'right' });
      for (const ret of stop.returns) {
        doc.fontSize(9).fillColor('#000')
          .text(
            `${rtl('חברה')} ${ret.CompanyCode} | ${rtl(ret.SapCardName || '')} | ${rtl(ret.Reason || '')}  ☐`,
            { align: 'right' }
          );
      }
    }

    // Signature placeholder
    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#666')
      .text(rtl('חתימת לקוח: _______________________'), { align: 'right' });

    doc.moveDown(0.5);
    drawHorizontalLine(doc, '#e5e7eb');
    doc.moveDown(0.5);
  }

  // ---- Footer ----
  doc.fontSize(8).fillColor('#999')
    .text(
      `${rtl('הופק ב')} ${format(new Date(), 'dd/MM/yyyy HH:mm')}  |  SAP Logistics Hub`,
      40, 800, { width: 515, align: 'center' }
    );

  doc.end();
  return doc;
}

function drawHorizontalLine(doc, color = '#2563eb') {
  const y = doc.y;
  doc.moveTo(40, y).lineTo(555, y).strokeColor(color).stroke();
  doc.moveDown(0.3);
}
