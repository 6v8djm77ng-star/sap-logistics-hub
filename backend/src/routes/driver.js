/**
 * Routes used by the driver mobile PWA.
 * Drivers log in with a separate token (DRIVER role).
 */
import { Router } from 'express';
import { z } from 'zod';
import * as db from '../db/logisticsDb.js';
import * as runs from '../services/deliveryRuns.js';
import * as ret from '../services/returnRequests.js';
import * as deliveries from '../services/deliveryNotes.js';
import { saveDataUrl } from '../services/fileStorage.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth, requireRole('DRIVER', 'ADMIN'));

/**
 * Today's runs for the current driver.
 */
router.get(
  '/my-runs',
  asyncHandler(async (req, res) => {
    // DRIVER role: token's driverId is the only allowed scope.
    // ADMIN role: may explicitly target a driver via ?driverId= for support.
    let driverId;
    if (req.user.role === 'DRIVER') {
      driverId = req.user.driverId;
    } else if (req.user.role === 'ADMIN') {
      driverId = req.query.driverId ? Number(req.query.driverId) : req.user.driverId;
    }
    if (!driverId) return res.status(400).json({ error: 'No driver context' });

    const list = await runs.listRuns({ driverId, status: undefined });
    const today = new Date().toISOString().slice(0, 10);
    const todayRuns = list.filter((r) => r.RunDate.toISOString().slice(0, 10) === today);
    res.json({ runs: todayRuns });
  })
);

/**
 * Full manifest for a run (stops, orders, returns).
 */
router.get(
  '/runs/:id/manifest',
  asyncHandler(async (req, res) => {
    const run = await runs.getRunDetails(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  })
);

/**
 * Update stop status from mobile (arrived, delivered, failed).
 * Handles signature/photo base64 uploads.
 */
router.patch(
  '/stops/:stopId/status',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      status: z.enum(['PENDING', 'ARRIVED', 'DELIVERED', 'PARTIAL', 'FAILED', 'SKIPPED']),
      notes: z.string().optional(),
      signatureDataUrl: z.string().optional(), // base64 data URL from canvas
      photoDataUrl: z.string().optional(),     // base64 data URL from camera
    });
    const data = schema.parse(req.body);
    const stopId = Number(req.params.stopId);

    // Save files if provided
    let signatureUrl = null;
    let photoUrl = null;
    if (data.signatureDataUrl) {
      signatureUrl = await saveDataUrl(data.signatureDataUrl, {
        prefix: `sig-${stopId}`, category: 'signatures',
      });
    }
    if (data.photoDataUrl) {
      photoUrl = await saveDataUrl(data.photoDataUrl, {
        prefix: `photo-${stopId}`, category: 'photos',
      });
    }

    const timestampField =
      data.status === 'ARRIVED' ? 'ArrivedAt = SYSUTCDATETIME()' :
      (data.status === 'DELIVERED' || data.status === 'PARTIAL' || data.status === 'FAILED')
        ? 'CompletedAt = SYSUTCDATETIME()' : '';

    await db.execute(
      `UPDATE dbo.DeliveryStops
       SET Status = @status,
           Notes = COALESCE(@notes, Notes),
           SignatureUrl = COALESCE(@sig, SignatureUrl),
           PhotoUrl = COALESCE(@photo, PhotoUrl)
           ${timestampField ? `, ${timestampField}` : ''}
       WHERE StopId = @id`,
      {
        id: stopId,
        status: data.status,
        notes: data.notes || null,
        sig: signatureUrl,
        photo: photoUrl,
      }
    );

    const io = req.app.get('io');
    io?.emit('stop:status-changed', { stopId, status: data.status });

    res.json({ ok: true, stopId, status: data.status, signatureUrl, photoUrl });
  })
);

/**
 * Complete a whole stop - creates SAP Delivery Notes for all orders at once.
 * This is the main "תעודות משלוח בטוחות" button on mobile.
 */
router.post(
  '/stops/:stopId/complete',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      signatureDataUrl: z.string().optional(),
      photoDataUrl: z.string().optional(),
      notes: z.string().optional(),
    });
    const data = schema.parse(req.body);
    const stopId = Number(req.params.stopId);

    const signatureUrl = data.signatureDataUrl
      ? await saveDataUrl(data.signatureDataUrl, { prefix: `sig-${stopId}`, category: 'signatures' })
      : null;
    const photoUrl = data.photoDataUrl
      ? await saveDataUrl(data.photoDataUrl, { prefix: `photo-${stopId}`, category: 'photos' })
      : null;

    const result = await deliveries.deliverStop(stopId, {
      signatureUrl,
      photoUrl,
      notes: data.notes,
    });

    const io = req.app.get('io');
    io?.emit('stop:completed', { stopId, ...result });
    res.json(result);
  })
);

/**
 * Mark a single order as delivered (creates SAP Delivery Note).
 */
router.post(
  '/orders/:runOrderId/deliver',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      actualQuantities: z.array(z.object({
        lineNum: z.number(),
        quantity: z.number().nonnegative(),
      })).optional(),
    });
    const { actualQuantities } = schema.parse(req.body ?? {});

    const result = await deliveries.createDeliveryNoteForOrder(
      Number(req.params.runOrderId),
      { actualQuantities }
    );

    const io = req.app.get('io');
    io?.emit('order:delivered', result);
    res.json(result);
  })
);

export default router;
