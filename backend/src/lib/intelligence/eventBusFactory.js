/**
 * Event bus factory — selects implementation based on feature flags.
 * Cached for the process lifetime; tests can call resetEventBusCache().
 */
import { intelligenceFlags } from '../featureFlags.js';
import { NoopEventBus } from './eventBusNoop.js';
import { HttpEventBus } from './eventBusHttp.js';

let cached = null;

export function getEventBus() {
  if (cached) return cached;
  cached = buildBus();
  return cached;
}

function buildBus() {
  if (!intelligenceFlags.ENABLE_EVENT_BUS) {
    return new NoopEventBus();
  }

  switch (intelligenceFlags.EVENT_BUS_DRIVER) {
    case 'http':
      if (!intelligenceFlags.INTEL_BUS_URL) {
        // eslint-disable-next-line no-console
        console.warn(
          '[event-bus] EVENT_BUS_DRIVER=http but INTEL_BUS_URL is empty — falling back to noop'
        );
        return new NoopEventBus();
      }
      return new HttpEventBus({
        url: intelligenceFlags.INTEL_BUS_URL,
        authToken: intelligenceFlags.INTEL_BUS_RECEIVER_TOKEN || undefined,
      });

    case 'redis-streams':
    case 'kafka':
      // eslint-disable-next-line no-console
      console.warn(
        `[event-bus] driver "${intelligenceFlags.EVENT_BUS_DRIVER}" not yet implemented — using noop`
      );
      return new NoopEventBus();

    case 'noop':
    default:
      return new NoopEventBus();
  }
}

export function resetEventBusCache() {
  cached = null;
}
