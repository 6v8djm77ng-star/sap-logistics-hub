/**
 * POST /api/intelligence/events    — receive events from any source
 * GET  /api/intelligence/events/health — readiness probe
 *
 * IMPORTANT: This router is NOT mounted in server.js by Phase 1.
 * It exists so the receiver code is reviewable and unit-testable now,
 * but no traffic reaches it until you append a single mount line:
 *
 *     // backend/src/server.js (Phase 4 or whenever ready)
 *     import intelligenceEventsRouter from './routes/intelligenceEvents.js';
 *     app.use('/api/intelligence', intelligenceEventsRouter);
 *
 * Until then, this file is dead code from the production runtime's
 * perspective — zero risk.
 */
import { Router } from 'express';
import { safeValidateEvent } from '../lib/intelligence/eventSchema.js';
import { storeEvent } from '../lib/intelligence/eventStore.js';
import { intelligenceFlags, intelligenceReadiness } from '../lib/featureFlags.js';

const router = Router();

/**
 * Service-to-service auth — distinct from user JWT.
 * Token is shared via env, NOT issued per request.
 * Mounting this without configuring INTEL_BUS_RECEIVER_TOKEN returns 503.
 */
function requireServiceToken(req, res, next) {
  const expected = intelligenceFlags.INTEL_BUS_RECEIVER_TOKEN;
  if (!expected) {
    return res.status(503).json({
      error: 'event_bus_receiver_not_configured',
      detail: 'Set INTEL_BUS_RECEIVER_TOKEN in .env',
    });
  }
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'invalid_service_token' });
  }
  next();
}

router.post('/events', requireServiceToken, async (req, res) => {
  const validation = safeValidateEvent(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      error: 'schema_validation_failed',
      detail: validation.error,
    });
  }

  try {
    const stored = await storeEvent(validation.event);
    return res.json({
      ok: true,
      eventId: validation.event.eventId,
      stored: stored.stored,
      reason: stored.reason,
      retainUntil: stored.retainUntil,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'store_failed',
      detail: err.message,
    });
  }
});

router.get('/events/health', (_req, res) => {
  res.json({
    ok: true,
    schemaVersion: 1,
    ...intelligenceReadiness(),
    note: 'Phase 1: receiver route exists but writes nothing until migration 009 is applied.',
  });
});

export default router;
