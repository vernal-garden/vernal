const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The listed keys nobody references and that are old enough to be safe to
 * remove (a fresh upload may not have its row saved yet). A key with no
 * last-modified date counts as too new. Returned sorted.
 */
export function findOrphans(
  listed: { key: string; lastModified: Date | null }[],
  referenced: Set<string>,
  now: Date,
  minAgeMs = DAY_MS,
): string[] {
  return listed
    .filter(
      (o) =>
        !referenced.has(o.key) &&
        o.lastModified !== null &&
        now.getTime() - o.lastModified.getTime() > minAgeMs,
    )
    .map((o) => o.key)
    .sort();
}
