/**
 * HTTP event bus — POST events to a remote receiver.
 *
 * Phase 1 behavior: log-only failure handling.
 * Future: wrapped by RetryingBus / DeadLetterBus decorators.
 *
 * Note: sap-hub PRODUCES events too (sap.sale_anomaly, intel.insight_created).
 * This bus is symmetric — fb-agent consumes events from sap-hub via the same
 * wire format, in the rare cases that's needed.
 */
export class HttpEventBus {
  constructor({ url, authToken, timeoutMs = 5000, logFailures = true }) {
    if (!url) throw new Error('HttpEventBus: `url` is required');
    this.driver = 'http';
    this.url = url;
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
    this.logFailures = logFailures;
  }

  async publish(event) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Event-Schema-Version': String(event.schemaVersion),
        'X-Event-Source': event.source,
      };
      if (this.authToken) {
        headers.Authorization = `Bearer ${this.authToken}`;
      }

      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      const durationMs = Date.now() - start;

      if (!res.ok) {
        const errMsg = `HTTP ${res.status} ${res.statusText}`;
        if (this.logFailures) {
          // eslint-disable-next-line no-console
          console.warn(`[event-bus:http] failed eventId=${event.eventId}: ${errMsg}`);
        }
        return { ok: false, driver: 'http', durationMs, error: errMsg };
      }

      return { ok: true, driver: 'http', durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err.message || 'unknown';
      if (this.logFailures) {
        // eslint-disable-next-line no-console
        console.warn(`[event-bus:http] threw eventId=${event.eventId}: ${errMsg}`);
      }
      return { ok: false, driver: 'http', durationMs, error: errMsg };
    } finally {
      clearTimeout(timer);
    }
  }
}
