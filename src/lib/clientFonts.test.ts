import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { describe, it, expect } from 'vitest';

const clientDir = join(process.cwd(), 'client');
const fontsCssPath = join(clientDir, 'src', 'styles', 'fonts.css');

describe('client/index.html', () => {
  const html = readFileSync(join(clientDir, 'index.html'), 'utf-8');

  it('does not load fonts from Google', () => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });
});

describe('client/src/styles/fonts.css', () => {
  const css = readFileSync(fontsCssPath, 'utf-8');

  it("declares the 'Fraunces' and 'DM Mono' families", () => {
    expect(css).toMatch(/font-family:\s*'Fraunces';/);
    expect(css).toMatch(/font-family:\s*'DM Mono';/);
  });

  it('references only font files that exist on disk', () => {
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(existsSync(resolve(dirname(fontsCssPath), url)), url).toBe(true);
    }
  });
});

describe('client/src/main.tsx', () => {
  const main = readFileSync(join(clientDir, 'src', 'main.tsx'), 'utf-8');

  it('imports styles/fonts.css', () => {
    expect(main).toMatch(/import\s+['"]\.\/styles\/fonts\.css['"]/);
  });
});
