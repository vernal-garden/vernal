import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import manifest from '../../client/src/lib/illustrationFit.generated.json';
import { FIT_TARGETS, fitViewBox, viewBoxFor } from '../../client/src/lib/illustrationFit';

const ART_DIR = path.resolve(__dirname, '../../client/public/illustrations');
const files = fs.readdirSync(ART_DIR).filter(f => f.endsWith('.svg'));
const entries = manifest as Record<string, { sha256: string }>;

describe('illustration fit manifest', () => {
  it('every SVG has a fresh fit entry', () => {
    for (const file of files) {
      const key = file.replace(/\.svg$/, '');
      const entry = Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ART_DIR, file))).digest('hex');
      expect(entry?.sha256 === sha, `${file} has no fresh fit entry; run npm run art:fit`).toBe(true);
    }
  });

  it('no entry without a file', () => {
    const names = new Set(files.map(f => f.replace(/\.svg$/, '')));
    for (const key of Object.keys(entries)) {
      expect(names.has(key), `${key} has a fit entry but no SVG; run npm run art:fit`).toBe(true);
    }
  });
});

describe('fitViewBox', () => {
  it('targets rise by stage', () => {
    for (const stage of [2, 3, 4, 5] as const) {
      expect(FIT_TARGETS[stage]).toBeGreaterThan(FIT_TARGETS[(stage - 1) as 1 | 2 | 3 | 4]);
    }
  });

  it('centres the content and sizes it to the stage', () => {
    const [x, y, w, h] = viewBoxFor({ cx: 0.5, cy: 0.75, r: 0.25 }, 1).split(' ').map(Number);
    expect(x + w / 2).toBeCloseTo(60, 2);
    expect(y + h / 2).toBeCloseTo(90, 2);
    expect(w).toBeCloseTo((2 * 15) / 0.55, 2);
    expect(w).toBeCloseTo(h, 3);
  });

  it('is null for an unknown key, including "toString"', () => {
    expect(fitViewBox('no-such-art', 3)).toBeNull();
    expect(fitViewBox('toString', 3)).toBeNull();
  });
});
