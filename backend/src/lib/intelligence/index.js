/**
 * Intelligence layer — public API barrel.
 *
 * Import from here:
 *   import { getEventBus, storeEvent, validateEvent } from '../lib/intelligence/index.js';
 *
 * Do NOT import concrete adapters from business code — only via getEventBus().
 */

export {
  IntelligenceEventSchema,
  EventTypeSchema,
  SourceSchema,
  EntityTypeSchema,
  BrandSchema,
  SeveritySchema,
  SentimentSchema,
  IntentSchema,
  SCHEMA_VERSION,
  validateEvent,
  safeValidateEvent,
} from './eventSchema.js';

export { getEventBus, resetEventBusCache } from './eventBusFactory.js';
export { storeEvent } from './eventStore.js';

export {
  selectModel,
  recordUsage,
  checkBackpressure,
  getBudgetSummary,
} from './aiCostGuard.js';

export {
  computeAlertKey,
  shouldFireAlert,
  recordAlert,
} from './alertGuard.js';

export { intelligenceFlags, intelligenceReadiness } from '../featureFlags.js';
