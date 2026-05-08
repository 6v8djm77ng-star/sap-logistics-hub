/**
 * No-op event bus — accepts events and discards them.
 * Default when ENABLE_EVENT_BUS=false or no driver configured.
 */
export class NoopEventBus {
  constructor() {
    this.driver = 'noop';
  }

  async publish(_event) {
    return { ok: true, driver: 'noop', durationMs: 0, suppressed: true };
  }
}
