/**
 * Event bus contract (JSDoc — Node has no TS interfaces).
 *
 * Implementations in the same directory:
 *   - eventBusNoop.js  — default, accepts and discards
 *   - eventBusHttp.js  — POST to remote receiver
 *   - (future) eventBusRedisStreams.js
 *   - (future) eventBusKafka.js
 *
 * @typedef {Object} PublishResult
 * @property {boolean} ok
 * @property {string} driver
 * @property {number} durationMs
 * @property {string} [error]
 * @property {boolean} [suppressed]
 *
 * @typedef {Object} EventBus
 * @property {string} driver
 * @property {(event: object) => Promise<PublishResult>} publish
 */

// Marker export so static analyzers can verify implementation conformance.
export const EVENT_BUS_CONTRACT = {
  publish: 'function (IntelligenceEvent) -> Promise<PublishResult>',
};
