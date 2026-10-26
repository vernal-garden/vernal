import fs from 'fs';
import path from 'path';
import {
  collectPackages,
  formatNotices,
  type ExtraSection,
  type Lockfile,
  type NoticeEntry,
} from '../src/lib/thirdPartyNotices';

const root = path.resolve(__dirname, '..');
const lockDirs = [root, path.join(root, 'client')];
const outFile = path.join(root, 'client', 'public', 'third-party-notices.txt');

const LICENSE_RE = /^(licen[cs]e|copying)(\..*)?$/i;
const NOTICE_RE = /^notice(\..*)?$/i;

function isDir(p: string): boolean {
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function readFirstMatch(dir: string, files: string[], re: RegExp): string | null {
  const match = files.find((f) => re.test(f) && fs.statSync(path.join(dir, f)).isFile());
  return match ? fs.readFileSync(path.join(dir, match), 'utf8') : null;
}

function readLicenseIn(dir: string): string | null {
  if (!isDir(dir)) return null;
  const files = fs.readdirSync(dir).sort();
  const license = readFirstMatch(dir, files, LICENSE_RE);
  const notice = readFirstMatch(dir, files, NOTICE_RE);
  if (license !== null && notice !== null) return `${license.trimEnd()}\n\n${notice}`;
  return license ?? notice;
}

const entries: NoticeEntry[] = [];
const dirOf = new Map<NoticeEntry, string>();
const seen = new Set<string>();

for (const lockDir of lockDirs) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(lockDir, 'package-lock.json'), 'utf8'),
  ) as Lockfile;
  const collected = collectPackages(lock, {
    isInstalled: (p) => isDir(path.join(lockDir, p)),
  });
  for (const entry of collected) {
    const id = `${entry.name}@${entry.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
    dirOf.set(entry, lockDir);
  }
}

const fontsDir = path.join(root, 'client', 'src', 'assets', 'fonts');
const extraSections: ExtraSection[] = [
  { title: 'DM Mono (font)', text: fs.readFileSync(path.join(fontsDir, 'LICENSE-DMMono.txt'), 'utf8') },
  { title: 'Fraunces (font)', text: fs.readFileSync(path.join(fontsDir, 'LICENSE-Fraunces.txt'), 'utf8') },
];

// Paths repeat across the two lockfiles, so qualify them with their lockfile dir.
const qualified = entries.map((e) => ({ ...e, path: path.join(dirOf.get(e) as string, e.path) }));

const output = formatNotices(qualified, readLicenseIn, extraSections);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output, 'utf8');
console.log(`Wrote client/public/third-party-notices.txt (${entries.length} packages)`);
