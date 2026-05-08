# Offline Queue

Note: the offline queue lives on the **frontend** (`frontend/src/services/offlineQueue.js`).
This README is here for searchability from the backend side.

## Why backend still matters

- The backend exposes **idempotent** endpoints so that when the queue flushes,
  it's safe to retry. For example:
  - `POST /driver/orders/:runOrderId/deliver` - checks if a Delivery Note
    already exists before creating one (see `deliveryNotes.js::createDeliveryNoteForOrder`).
  - `POST /driver/stops/:stopId/complete` - tolerates being called twice.

- If the queue contains a call that the server has already processed
  (driver had connectivity → call went through → then driver went offline and
  the client never got the response), re-sending must not duplicate work.

## Key design choices

- Signatures are stored as **base64 data URLs** in localStorage, since the
  device can't reach the file upload endpoint while offline. When sent later,
  the backend decodes them and saves to disk.
- We dropsilent 4xx/5xx responses (data is stale and retrying won't help).
- We retain on network errors (no response received).
