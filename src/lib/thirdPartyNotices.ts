export interface LockPackage {
  version?: string;
  license?: string;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  link?: boolean;
}

export interface Lockfile {
  packages?: Record<string, LockPackage>;
}

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  path: string;
}

export interface ExtraSection {
  title: string;
  text: string;
}

const SEPARATOR = '='.repeat(60);
const NO_LICENSE_TEXT = 'No license file is included in this package.';

function nameFromPath(key: string): string {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  return idx === -1 ? key : key.slice(idx + marker.length);
}

// Production packages only. Optional packages count only when actually installed.
export function collectPackages(
  lock: Lockfile,
  opts: { isInstalled: (path: string) => boolean },
): NoticeEntry[] {
  const seen = new Set<string>();
  const entries: NoticeEntry[] = [];

  for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
    if (key === '' || pkg.dev === true || pkg.link === true) continue;
    if ((pkg.optional === true || pkg.devOptional === true) && !opts.isInstalled(key)) continue;

    const name = nameFromPath(key);
    const version = pkg.version ?? '';
    const id = `${name}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);

    entries.push({ name, version, license: pkg.license ?? 'UNKNOWN', path: key });
  }

  return entries;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatNotices(
  entries: NoticeEntry[],
  readLicenseText: (path: string) => string | null,
  extraSections: ExtraSection[] = [],
): string {
  const sorted = [...entries].sort(
    (a, b) => compare(a.name, b.name) || compare(a.version, b.version),
  );

  const blocks = sorted.map((e) => {
    const text = readLicenseText(e.path)?.trimEnd();
    return `${e.name}@${e.version} — ${e.license}\n\n${text ? text : NO_LICENSE_TEXT}`;
  });

  for (const s of extraSections) {
    blocks.push(`${s.title}\n\n${s.text.trimEnd()}`);
  }

  const body = blocks.join(`\n\n${SEPARATOR}\n\n`);
  const header = 'Third-party software notices for Vernal';
  // The first block follows the header directly; the separator joins later blocks.
  return `${header}\n\n${body}\n`;
}
