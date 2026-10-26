import { describe, it, expect } from 'vitest';
import { collectPackages, formatNotices, type Lockfile } from './thirdPartyNotices';

const installedAll = { isInstalled: () => true };
const installedNone = { isInstalled: () => false };

describe('collectPackages', () => {
  it('excludes dev entries and the root entry', () => {
    const lock: Lockfile = {
      packages: {
        '': { version: '1.0.0' },
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '2.0.0', license: 'MIT', dev: true },
      },
    };
    expect(collectPackages(lock, installedAll).map((e) => e.name)).toEqual(['a']);
  });

  it('includes optional packages only when installed', () => {
    const lock: Lockfile = {
      packages: { 'node_modules/opt': { version: '1.0.0', license: 'MIT', optional: true } },
    };
    expect(collectPackages(lock, installedAll)).toHaveLength(1);
    expect(collectPackages(lock, installedNone)).toHaveLength(0);
  });

  it('treats devOptional like optional', () => {
    const lock: Lockfile = {
      packages: { 'node_modules/dopt': { version: '1.0.0', license: 'MIT', devOptional: true } },
    };
    expect(collectPackages(lock, installedAll)).toHaveLength(1);
    expect(collectPackages(lock, installedNone)).toHaveLength(0);
  });

  it('keeps scoped names, including nested ones', () => {
    const lock: Lockfile = {
      packages: {
        'node_modules/@scope/pkg': { version: '1.0.0', license: 'MIT' },
        'node_modules/x/node_modules/@scope/y': { version: '2.0.0', license: 'ISC' },
      },
    };
    const entries = collectPackages(lock, installedAll);
    expect(entries.map((e) => e.name)).toEqual(['@scope/pkg', '@scope/y']);
    expect(entries[1].path).toBe('node_modules/x/node_modules/@scope/y');
  });

  it('dedupes the same name@version, keeping the first path', () => {
    const lock: Lockfile = {
      packages: {
        'node_modules/dup': { version: '1.0.0', license: 'MIT' },
        'node_modules/x/node_modules/dup': { version: '1.0.0', license: 'MIT' },
        'node_modules/y/node_modules/dup': { version: '2.0.0', license: 'MIT' },
      },
    };
    const entries = collectPackages(lock, installedAll);
    expect(entries).toHaveLength(2);
    expect(entries[0].path).toBe('node_modules/dup');
  });

  it('skips linked workspace entries and defaults missing license', () => {
    const lock: Lockfile = {
      packages: {
        'node_modules/ws': { link: true },
        'node_modules/nolic': { version: '1.0.0' },
      },
    };
    const entries = collectPackages(lock, installedAll);
    expect(entries).toHaveLength(1);
    expect(entries[0].license).toBe('UNKNOWN');
  });
});

describe('formatNotices', () => {
  const entry = (name: string, version: string, license = 'MIT') => ({
    name,
    version,
    license,
    path: `node_modules/${name}@${version}`,
  });

  it('writes the header and ends with a single newline', () => {
    const out = formatNotices([entry('a', '1.0.0')], () => 'text  \n\n');
    expect(out.startsWith('Third-party software notices for Vernal\n\n')).toBe(true);
    expect(out.endsWith('text\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('sorts by name then version', () => {
    const out = formatNotices(
      [entry('b', '1.0.0'), entry('a', '2.0.0'), entry('a', '1.0.0')],
      () => 'x',
    );
    const headers = out.split('\n').filter((l) => l.includes(' — '));
    expect(headers).toEqual(['a@1.0.0 — MIT', 'a@2.0.0 — MIT', 'b@1.0.0 — MIT']);
  });

  it('uses the fallback line when license text is missing or empty', () => {
    const out = formatNotices([entry('a', '1.0.0'), entry('b', '1.0.0')], (p) =>
      p.includes('a@') ? null : '  \n',
    );
    expect(out.match(/No license file is included in this package\./g)).toHaveLength(2);
  });

  it('separates packages with exactly 60 equals signs', () => {
    const out = formatNotices([entry('a', '1.0.0'), entry('b', '1.0.0')], () => 'x');
    const sep = '='.repeat(60);
    expect(out).toContain(`x\n\n${sep}\n\nb@1.0.0 — MIT`);
    expect(out.split('\n').filter((l) => /^=+$/.test(l))).toEqual([sep]);
  });

  it('appends extra sections after the packages', () => {
    const out = formatNotices([entry('a', '1.0.0')], () => 'x', [
      { title: 'Some Font', text: 'font license\n' },
    ]);
    const sep = '='.repeat(60);
    expect(out).toContain(`x\n\n${sep}\n\nSome Font\n\nfont license\n`);
    expect(out.indexOf('Some Font')).toBeGreaterThan(out.indexOf('a@1.0.0'));
  });
});
