import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const publicDir = join(process.cwd(), 'client', 'public');

describe('site.webmanifest', () => {
  const manifest = JSON.parse(readFileSync(join(publicDir, 'site.webmanifest'), 'utf-8'));

  it('has the required top-level fields', () => {
    expect(manifest.id).toBeDefined();
    expect(manifest.name).toBeDefined();
    expect(manifest.short_name).toBeDefined();
    expect(manifest.start_url).toBeDefined();
    expect(manifest.scope).toBeDefined();
    expect(manifest.display).toBeDefined();
  });

  it('has exactly 3 icon entries', () => {
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons).toHaveLength(3);
  });

  it('has the locked theme and background colors', () => {
    expect(manifest.theme_color).toBe('#FDFCF9');
    expect(manifest.background_color).toBe('#F5F1EB');
  });

  it('has exactly one maskable icon entry', () => {
    const maskable = manifest.icons.filter((icon: { purpose?: string }) => icon.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
  });
});

describe('offline.html', () => {
  it('exists and contains the offline message', () => {
    const path = join(publicDir, 'offline.html');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain("You're offline");
  });
});

describe('icons', () => {
  it.each(['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'])(
    '%s exists',
    (fileName) => {
      expect(existsSync(join(publicDir, 'icons', fileName))).toBe(true);
    },
  );
});
