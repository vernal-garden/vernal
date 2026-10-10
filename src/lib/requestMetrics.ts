import type { Request, Response, NextFunction } from 'express';

// In-memory API request timing for the admin System Health page. Per-process
// and reset on restart — this is a rough health signal, not an APM.

const BUCKET_BOUNDS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];
const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURS = 24;

interface HourBucket {
  hourStart: number; // ms epoch, start of the UTC hour
  count: number;
  errors5xx: number;
  maxMs: number;
  histogram: number[];
}

let since = Date.now();
const buckets = new Map<number, HourBucket>();

function hourStartOf(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function prune(currentHourStart: number) {
  const oldest = currentHourStart - (MAX_HOURS - 1) * HOUR_MS;
  for (const key of buckets.keys()) {
    if (key < oldest) buckets.delete(key);
  }
}

function record(durationMs: number, status: number) {
  const now = Date.now();
  const hourStart = hourStartOf(now);
  let bucket = buckets.get(hourStart);
  if (!bucket) {
    prune(hourStart);
    bucket = {
      hourStart,
      count: 0,
      errors5xx: 0,
      maxMs: 0,
      histogram: BUCKET_BOUNDS_MS.map(() => 0),
    };
    buckets.set(hourStart, bucket);
  }
  bucket.count += 1;
  if (status >= 500) bucket.errors5xx += 1;
  if (durationMs > bucket.maxMs) bucket.maxMs = durationMs;
  const idx = BUCKET_BOUNDS_MS.findIndex((bound) => durationMs <= bound);
  bucket.histogram[idx] += 1;
}

export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    record(durationMs, res.statusCode);
  });
  next();
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

// Upper bound of the histogram bucket holding the p-th percentile; the
// open-ended last bucket reports the observed max instead of Infinity.
function percentile(bucket: HourBucket, p: number): number | null {
  if (bucket.count === 0) return null;
  const target = Math.ceil(p * bucket.count);
  let cumulative = 0;
  for (let i = 0; i < bucket.histogram.length; i++) {
    cumulative += bucket.histogram[i];
    if (cumulative >= target) {
      const bound = BUCKET_BOUNDS_MS[i];
      return bound === Infinity ? round(bucket.maxMs) : bound;
    }
  }
  return round(bucket.maxMs);
}

function emptyBucket(hourStart: number): HourBucket {
  return { hourStart, count: 0, errors5xx: 0, maxMs: 0, histogram: BUCKET_BOUNDS_MS.map(() => 0) };
}

export function getRequestMetrics() {
  const currentHourStart = hourStartOf(Date.now());
  prune(currentHourStart);

  // One entry per hour from when recording started (or 24h back) to now,
  // zero-filled, so the UI can chart it without gap handling.
  const firstHour = Math.max(hourStartOf(since), currentHourStart - (MAX_HOURS - 1) * HOUR_MS);
  const hours = [];
  for (let h = firstHour; h <= currentHourStart; h += HOUR_MS) {
    const b = buckets.get(h) ?? emptyBucket(h);
    hours.push({
      hourStart: new Date(h).toISOString(),
      count: b.count,
      errors5xx: b.errors5xx,
      p50Ms: percentile(b, 0.5),
      p95Ms: percentile(b, 0.95),
      maxMs: round(b.maxMs),
    });
  }

  // The hour before the current one has completed — if recording was
  // running before it ended.
  const lastHourStart = currentHourStart - HOUR_MS;
  let lastFullHour = null;
  if (since < currentHourStart) {
    const b = buckets.get(lastHourStart) ?? emptyBucket(lastHourStart);
    lastFullHour = {
      count: b.count,
      errorRate: b.count === 0 ? 0 : b.errors5xx / b.count,
      p50Ms: percentile(b, 0.5),
      p95Ms: percentile(b, 0.95),
    };
  }

  return { since: new Date(since).toISOString(), hours, lastFullHour };
}

export function resetRequestMetrics(): void {
  buckets.clear();
  since = Date.now();
}
