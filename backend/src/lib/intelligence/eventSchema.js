/**
 * Unified Intelligence Event Schema (sap-hub side, JS).
 * Mirrors fb-agent/src/lib/intelligence/event-schema.ts.
 * Bump SCHEMA_VERSION here AND there at the same time.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const EventTypeSchema = z.enum([
  'mention.created',
  'mention.classified',
  'mention.replied',
  'price.changed',
  'price.dropped',
  'price.competitor_undercut',
  'sap.sale_anomaly',
  'sap.stockout_risk',
  'intel.insight_created',
  'intel.crisis_detected',
  'alert.triggered',
]);

export const SourceSchema = z.enum([
  'fb-agent',
  'sap-hub',
  'price-monitor',
  'social-listening-hub',
]);

export const EntityTypeSchema = z.enum([
  'SocialItem',
  'PriceChange',
  'ScanResult',
  'Insight',
  'Alert',
  'Conversation',
  'SapOrder',
]);

export const BrandSchema = z.enum(['OIG', 'DAVO', 'Tineco', 'Hurom', 'Novo', 'Unico']);

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const SentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export const IntentSchema = z.enum([
  'complaint',
  'buying_intent',
  'recommendation_request',
  'competitor_comparison',
  'service_issue',
  'general',
]);

export const IntelligenceEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: EventTypeSchema,
  source: SourceSchema,
  timestamp: z.string().datetime(),
  schemaVersion: z.literal(SCHEMA_VERSION),

  entityType: EntityTypeSchema,
  entityId: z.string().min(1).max(128),
  entityName: z.string().max(512).optional(),

  brand: BrandSchema.optional(),
  competitor: z.string().max(64).optional(),
  severity: SeveritySchema,
  sentiment: SentimentSchema.optional(),
  intent: IntentSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),

  payload: z.record(z.unknown()),
});

export function validateEvent(raw) {
  return IntelligenceEventSchema.parse(raw);
}

export function safeValidateEvent(raw) {
  const result = IntelligenceEventSchema.safeParse(raw);
  if (result.success) return { ok: true, event: result.data };
  return {
    ok: false,
    error: result.error.errors
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('; '),
  };
}
