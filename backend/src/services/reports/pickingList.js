/**
 * Picking List Excel export.
 * Given a Wave, produces a warehouse-ready checklist sorted by bin location.
 */
import ExcelJS from 'exceljs';
import * as db from '../../db/logisticsDb.js';

export async function generatePickingListExcel(waveId) {
  const wave = await db.queryOne(
    `SELECT w.*, r.RunNumber, r.RunDate,
            z.Name AS ZoneName, d.FullName AS DriverName
     FROM dbo.PickingWaves w
     INNER JOIN dbo.DeliveryRuns r ON r.RunId = w.RunId
     LEFT JOIN dbo.Zones z ON z.ZoneId = r.ZoneId
     LEFT JOIN dbo.Drivers d ON d.DriverId = r.DriverId
     WHERE w.WaveId = @id`,
    { id: waveId }
  );
  if (!wave) throw new Error(`Wave ${waveId} not found`);

  const lines = await db.query(
    `SELECT l.*,
       (SELECT STRING_AGG(
          CONCAT(c.Code, ':#', ro.SapDocNum, '(', CAST(pa.Quantity AS VARCHAR), ')'),
          ' | ')
        FROM dbo.PickingAllocations pa
        INNER JOIN dbo.RunOrders ro ON ro.RunOrderId = pa.RunOrderId
        INNER JOIN dbo.Companies c ON c.CompanyId = ro.CompanyId
        WHERE pa.WaveLineId = l.WaveLineId) AS Breakdown
     FROM dbo.PickingWaveLines l
     WHERE l.WaveId = @id
     ORDER BY l.BinLocation, l.SapItemCode`,
    { id: waveId }
  );

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SAP Logistics Hub';
  wb.created = new Date();

  const ws = wb.addWorksheet('רשימת ליקוט', {
    views: [{ rightToLeft: true }],
  });

  // Title rows
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = `רשימת ליקוט - ${wave.WaveNumber}`;
  ws.getCell('A1').font = { size: 16, bold: true };
  ws.getCell('A1').alignment = { horizontal: 'right' };

  ws.getCell('A2').value = `מסלול: ${wave.RunNumber}`;
  ws.getCell('C2').value = `אזור: ${wave.ZoneName || '-'}`;
  ws.getCell('E2').value = `נהג: ${wave.DriverName || '-'}`;

  // Headers
  ws.getRow(4).values = [
    'V', 'מיקום במחסן', 'קוד פריט', 'שם פריט', 'כמות', 'פירוט הזמנות', 'הערות',
  ];
  ws.getRow(4).font = { bold: true };
  ws.getRow(4).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' },
  };

  ws.columns = [
    { key: 'check', width: 4 },
    { key: 'bin', width: 15 },
    { key: 'code', width: 15 },
    { key: 'name', width: 35 },
    { key: 'qty', width: 10 },
    { key: 'breakdown', width: 40 },
    { key: 'notes', width: 20 },
  ];

  for (const line of lines) {
    ws.addRow({
      check: '☐',
      bin: line.BinLocation || '',
      code: line.SapItemCode,
      name: line.SapItemName || '',
      qty: Number(line.TotalQuantity),
      breakdown: line.Breakdown || '',
      notes: line.Status === 'SHORTAGE' ? 'חוסר במלאי' : '',
    });
  }

  // Totals
  ws.addRow({});
  const totalRow = ws.addRow({
    code: 'סה"כ פריטים:',
    qty: lines.length,
  });
  totalRow.font = { bold: true };

  // Borders
  const lastRow = ws.lastRow.number;
  for (let r = 4; r <= lastRow; r++) {
    for (let c = 1; c <= 7; c++) {
      ws.getCell(r, c).border = {
        top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      };
    }
  }

  return wb;
}
