import { db } from './db';
import { logger } from './logger';
import type { EventKey } from './eventKeys';

// Records one usage_events row. Instrumentation must never break the action
// it describes, so failures are logged and swallowed.
export async function recordUsageEvent(
  key: EventKey,
  sessionId: string,
  userId: number | null,
): Promise<void> {
  try {
    await db.query(
      'INSERT INTO usage_events (user_id, session_id, event_key) VALUES ($1, $2, $3)',
      [userId, sessionId, key],
    );
  } catch (err) {
    logger.warn('Failed to record usage event', {
      eventKey: key,
      errMsg: err instanceof Error ? err.message : String(err),
    });
  }
}
