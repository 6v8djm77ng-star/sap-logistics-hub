/**
 * Offline queue for mobile driver actions.
 *
 * Problem: drivers sometimes lose signal between stops.
 * Solution: queue API calls in localStorage, retry when online.
 *
 * Usage:
 *   await enqueue('POST', '/driver/stops/123/complete', { signatureDataUrl });
 *   (if offline, saved to queue; if online, sent immediately)
 */
import api from './api.js';

const QUEUE_KEY = 'driver-offline-queue';

function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getQueueSize() {
  return loadQueue().length;
}

/**
 * Try to send an API call; if network fails, queue it.
 * Returns { sent: boolean, queued: boolean }
 */
export async function sendOrQueue(method, url, data) {
  try {
    const res = await api.request({ method, url, data });
    return { sent: true, queued: false, response: res.data };
  } catch (err) {
    // Only queue on network error, not on 4xx/5xx (those are real errors)
    if (!err.response) {
      const queue = loadQueue();
      queue.push({
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method, url, data,
        queuedAt: Date.now(),
      });
      saveQueue(queue);
      return { sent: false, queued: true };
    }
    throw err;
  }
}

/**
 * Flush the queue - try sending each pending request.
 * Safe to call periodically.
 */
export async function flushQueue() {
  const queue = loadQueue();
  if (queue.length === 0) return { processed: 0, remaining: 0 };

  const remaining = [];
  let processed = 0;

  for (const item of queue) {
    try {
      await api.request({ method: item.method, url: item.url, data: item.data });
      processed++;
    } catch (err) {
      if (!err.response) {
        // Still offline - keep in queue
        remaining.push(item);
      } else {
        // 4xx/5xx - drop it (data may be stale) but log
        console.warn('[offline-queue] dropping failed request', item, err.response?.data);
      }
    }
  }

  saveQueue(remaining);
  return { processed, remaining: remaining.length };
}

/**
 * Auto-flush when connection returns.
 */
export function initAutoFlush() {
  window.addEventListener('online', () => flushQueue());

  // Also try every 60s while online
  setInterval(() => {
    if (navigator.onLine && loadQueue().length > 0) {
      flushQueue();
    }
  }, 60_000);
}
