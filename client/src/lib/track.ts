import { post } from './api';
import type { EventKey } from './eventKeys';

// Fire-and-forget usage tracking. Events queue in memory and flush in
// batches to POST /api/events/batch. Nothing here may throw into UI code.

interface QueuedEvent {
  event_key: EventKey;
  timestamp: string;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const BATCH_PATH = '/api/events/batch';
const MAX_QUEUE = 200;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;

const queue: QueuedEvent[] = [];
let flushing = false;

export function track(key: EventKey): void {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ event_key: key, timestamp: new Date().toISOString() });
  } catch {
    // never throw from the tracker
  }
}

// Sends the queue in batches of 50 via the post helper. A failed batch is dropped.
export async function flushNow(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const events = queue.splice(0, BATCH_SIZE);
      try {
        await post(BATCH_PATH, { events });
      } catch {
        // drop this batch silently
      }
    }
  } finally {
    flushing = false;
  }
}

// Page is going away: hand everything to the browser so it survives unload.
function flushOnExit(): void {
  try {
    const url = `${API_BASE}${BATCH_PATH}`;
    while (queue.length > 0) {
      const events = queue.splice(0, BATCH_SIZE);
      const body = JSON.stringify({ events });
      let sent = false;
      try {
        sent = typeof navigator.sendBeacon === 'function'
          && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } catch {
        sent = false;
      }
      if (!sent) {
        fetch(url, {
          method: 'POST',
          keepalive: true,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(() => {});
      }
    }
  } catch {
    // never throw from the tracker
  }
}

if (typeof window !== 'undefined') {
  setInterval(() => {
    if (queue.length > 0) void flushNow();
  }, FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnExit();
  });
  window.addEventListener('pagehide', flushOnExit);
}
