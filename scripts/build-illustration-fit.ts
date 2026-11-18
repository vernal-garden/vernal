import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export interface FitEntry {
  /** Centre of the opaque bounding box, as a fraction of the 120-unit viewBox width. */
  cx: number;
  /** Centre of the opaque bounding box, as a fraction of the viewBox height. */
  cy: number;
  /** Radius from that centre to the farthest opaque pixel, as a fraction of half the viewBox. */
  r: number;
  /** SHA-256 hex of the SVG file bytes, so stale entries can be detected. */
  sha256: string;
}

const SIZE = 240;
// Every illustration has viewBox="0 0 120 120" and no width/height; 144 dpi renders it at 240 px.
const DENSITY = 144;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export async function buildIllustrationFit(dir: string): Promise<Record<string, FitEntry>> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort();
  const out: Record<string, FitEntry> = {};
  for (const file of files) {
    const buf = fs.readFileSync(path.join(dir, file));
    const { data, info } = await sharp(buf, { density: DENSITY })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== SIZE || info.height !== SIZE || info.channels !== 4) {
      throw new Error(`${file}: rendered ${info.width}x${info.height}x${info.channels}, expected ${SIZE}x${SIZE}x4`);
    }

    // Opaque means alpha > 127, which drops the faint soil shadow.
    const opaque: Array<[number, number]> = [];
    let minX = SIZE;
    let maxX = -1;
    let minY = SIZE;
    let maxY = -1;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (data[(y * SIZE + x) * 4 + 3] > 127) {
          opaque.push([x, y]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (opaque.length === 0) {
      console.warn(`${file}: no opaque pixels, skipping`);
      continue;
    }

    const cxp = (minX + maxX) / 2;
    const cyp = (minY + maxY) / 2;
    let rp = 0;
    for (const [x, y] of opaque) {
      rp = Math.max(rp, Math.sqrt((x - cxp) ** 2 + (y - cyp) ** 2));
    }
    out[file.replace(/\.svg$/, '')] = {
      cx: round3(cxp / SIZE),
      cy: round3(cyp / SIZE),
      r: round3(rp / (SIZE / 2)),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  }
  return out;
}

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'client', 'public', 'illustrations');
  buildIllustrationFit(dir)
    .then((fit) => {
      const target = path.join(__dirname, '..', 'client', 'src', 'lib', 'illustrationFit.generated.json');
      fs.writeFileSync(target, JSON.stringify(fit, null, 2) + '\n');
      console.log(`Wrote ${Object.keys(fit).length} entries`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
