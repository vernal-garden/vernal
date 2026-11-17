import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ILLUSTRATIONS, catalogueArtUrl, cropClass, illustrationUrl } from '../../client/src/lib/illustrations';
import { stageLabel, type GrowthStage } from '../../client/src/lib/growthStages';

const ART_DIR = path.resolve(__dirname, '../../client/public/illustrations');
const STAGES: GrowthStage[] = [1, 2, 3, 4, 5];

// Style guide section 07 palette.
const PALETTE = new Set([
  '#7FAD6E', '#5A8050', '#3D6035', '#A8C99A', '#6A8F5C', '#4A6B40', '#9A7A58', '#7A5C3E',
  '#BEA080', '#D96040', '#C0432A', '#8E2E1A', '#8DB870', '#E6B85C', '#F5F1EB', '#C8902A',
  '#D8D0E8', '#A88EC4', '#E89A5C', '#D2783A', '#A0532A', '#8A6A94', '#644872', '#43304F',
  '#B5627C', '#8C3A56', '#5E2439', '#D4AE72', '#A07A46', '#DCD2BE', '#A2B8A0', '#74917E',
  '#4F6B5A',
]);
const STROKE_WIDTHS = new Set([1.5, 0.75]);
const OPACITIES = new Set([0.2, 0.3, 0.5, 0.65, 0.9]);
const MAX_BYTES = 6144;

const svgFiles = fs.readdirSync(ART_DIR).filter(f => f.endsWith('.svg')).sort();
const sources = new Map(svgFiles.map(f => [f, fs.readFileSync(path.join(ART_DIR, f), 'utf8')]));

interface Prop { name: string; value: string }

// Every attribute in the file, plus each declaration inside style="" as if it
// were an attribute, so fill/stroke/opacity checks cover both forms.
function props(svg: string): Prop[] {
  const out: Prop[] = [];
  const attr = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of svg.matchAll(attr)) {
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3]).trim();
    if (name === 'style') {
      for (const decl of value.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        out.push({ name: decl.slice(0, i).trim().toLowerCase(), value: decl.slice(i + 1).trim() });
      }
    } else {
      out.push({ name, value });
    }
  }
  return out;
}

function rootTag(svg: string): string | null {
  const m = /<svg\b[^>]*>/i.exec(svg);
  return m ? m[0] : null;
}

function rootAttrs(svg: string): Map<string, string> {
  const tag = rootTag(svg) ?? '';
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out.set(m[1], m[2] ?? m[3]);
  }
  return out;
}

const isHex = (v: string) => /^#[0-9a-f]+$/i.test(v);

// 6-digit hex must be in the palette; 3-digit hex passes only when it
// expands (#abc -> #aabbcc) to a palette colour; any other length fails.
function hexInPalette(hex: string): boolean {
  const digits = hex.slice(1).toUpperCase();
  if (digits.length === 6) return PALETTE.has(`#${digits}`);
  if (digits.length === 3) return PALETTE.has(`#${[...digits].map(d => d + d).join('')}`);
  return false;
}

// Collects "file: detail" strings for every file the check rejects.
function failures(check: (svg: string, file: string) => string[]): string[] {
  const out: string[] = [];
  for (const [file, svg] of sources) {
    for (const detail of check(svg, file)) out.push(`${file}: ${detail}`);
  }
  return out;
}

describe('ILLUSTRATIONS manifest', () => {
  it('the palette has all 33 style guide colours', () => {
    expect(PALETTE.size).toBe(33);
  });

  it('finds SVGs in client/public/illustrations', () => {
    expect(svgFiles.length).toBeGreaterThan(0);
  });

  it('every file named in ILLUSTRATIONS exists on disk', () => {
    const missing: string[] = [];
    for (const [key, stages] of Object.entries(ILLUSTRATIONS)) {
      for (const stage of STAGES) {
        if (!sources.has(stages[stage])) missing.push(`${key} stage ${stage}: ${stages[stage]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every SVG on disk is named in ILLUSTRATIONS (no orphans)', () => {
    const named = new Set(Object.values(ILLUSTRATIONS).flatMap(s => STAGES.map(st => s[st])));
    expect(svgFiles.filter(f => !named.has(f))).toEqual([]);
  });

  it('each entry names files for its own key and stage', () => {
    const wrong: string[] = [];
    for (const [key, stages] of Object.entries(ILLUSTRATIONS)) {
      for (const stage of STAGES) {
        if (!stages[stage].startsWith(`${key}-${stage}-`)) wrong.push(`${key} stage ${stage}: ${stages[stage]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('each stage 4 file ends -4-flowering, -4-sizing or -4-heading', () => {
    const wrong = Object.entries(ILLUSTRATIONS)
      .filter(([, s]) => !/-4-(flowering|sizing|heading)\.svg$/.test(s[4]))
      .map(([key, s]) => `${key}: ${s[4]}`);
    expect(wrong).toEqual([]);
  });
});

describe('SVG style guide (section 07)', () => {
  it('root has viewBox="0 0 120 120" and the SVG namespace, no width or height', () => {
    expect(failures(svg => {
      const attrs = rootAttrs(svg);
      if (!rootTag(svg)) return ['no <svg> root'];
      const out: string[] = [];
      if (attrs.get('viewBox') !== '0 0 120 120') out.push(`viewBox=${JSON.stringify(attrs.get('viewBox') ?? null)}`);
      if (attrs.get('xmlns') !== 'http://www.w3.org/2000/svg') out.push(`xmlns=${JSON.stringify(attrs.get('xmlns') ?? null)}`);
      if (attrs.has('width')) out.push(`width="${attrs.get('width')}"`);
      if (attrs.has('height')) out.push(`height="${attrs.get('height')}"`);
      return out;
    })).toEqual([]);
  });

  it('every hex colour is in the palette', () => {
    expect(failures(svg => {
      const hexes = svg.match(/#[0-9a-fA-F]+(?![\w-])/g) ?? [];
      return [...new Set(hexes.filter(h => !hexInPalette(h)))];
    })).toEqual([]);
  });

  it('fill and stroke are a hex colour or none (no rgb(), hsl(), named colours or url())', () => {
    expect(failures(svg => props(svg)
      .filter(p => (p.name === 'fill' || p.name === 'stroke') && p.value !== 'none' && !isHex(p.value))
      .map(p => `${p.name}="${p.value}"`))).toEqual([]);
  });

  it('stroke-width is only 1.5 or .75', () => {
    expect(failures(svg => [...new Set(props(svg)
      .filter(p => p.name === 'stroke-width' && !STROKE_WIDTHS.has(Number(p.value)))
      .map(p => `stroke-width="${p.value}"`))])).toEqual([]);
  });

  it('no miter, bevel, square or butt anywhere', () => {
    expect(failures(svg => [...new Set(
      (svg.match(/\b(miter|bevel|square|butt)\b/gi) ?? []).map(w => `"${w}"`),
    )])).toEqual([]);
  });

  it('every stroked element has stroke-linejoin="round" on itself or an enclosing <g>/<svg>', () => {
    expect(failures(svg => {
      const out: string[] = [];
      // Linejoin inherited from enclosing <g>/<svg> tags; other parents pass nothing down.
      const stack: { tag: string; join: string | null }[] = [];
      for (const m of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
        const [, closing, tag, rest] = m;
        if (closing) {
          const i = stack.map(e => e.tag).lastIndexOf(tag);
          if (i >= 0) stack.length = i;
          continue;
        }
        const own = props(rest);
        const ownJoin = own.filter(p => p.name === 'stroke-linejoin').pop()?.value ?? null;
        const inherited = stack.length ? stack[stack.length - 1].join : null;
        const join = ownJoin ?? inherited;
        const stroke = own.filter(p => p.name === 'stroke').pop()?.value;
        if (stroke !== undefined && stroke !== 'none' && join !== 'round') {
          out.push(`<${tag}> stroke="${stroke}" has stroke-linejoin=${JSON.stringify(join)}`);
        }
        if (!rest.trimEnd().endsWith('/')) {
          const passesDown = tag === 'g' || tag === 'svg';
          stack.push({ tag, join: passesDown ? join : inherited });
        }
      }
      return [...new Set(out)];
    })).toEqual([]);
  });

  it('no <style> elements (CSS would bypass the attribute checks)', () => {
    expect(failures(svg => (/<\s*style\b/i.test(svg) ? ['contains a <style> element'] : []))).toEqual([]);
  });

  it('opacity, fill-opacity and stroke-opacity are only .2 .3 .5 .65 .9', () => {
    const names = new Set(['opacity', 'fill-opacity', 'stroke-opacity']);
    expect(failures(svg => [...new Set(props(svg)
      .filter(p => names.has(p.name) && !OPACITIES.has(Number(p.value)))
      .map(p => `${p.name}="${p.value}"`))])).toEqual([]);
  });

  it('no gradients, filters or clip paths', () => {
    expect(failures(svg => {
      const elements = (svg.match(/<\s*(linearGradient|radialGradient|filter|clipPath)\b/gi) ?? [])
        .map(m => `<${m.replace(/^<\s*/, '')}>`);
      const attrs = props(svg).filter(p => p.name === 'filter' || p.name === 'clip-path')
        .map(p => `${p.name}="${p.value}"`);
      return [...new Set([...elements, ...attrs])];
    })).toEqual([]);
  });

  it('no id attributes', () => {
    expect(failures(svg => props(svg).filter(p => p.name === 'id').map(p => `id="${p.value}"`))).toEqual([]);
  });

  it(`each file is under ${MAX_BYTES} bytes`, () => {
    expect(failures((_svg, file) => {
      const size = fs.statSync(path.join(ART_DIR, file)).size;
      return size >= MAX_BYTES ? [`${size} bytes`] : [];
    })).toEqual([]);
  });

  it('no C2PA content credentials', () => {
    expect(failures(svg => (/c2pa/i.test(svg) ? ['contains "c2pa"'] : []))).toEqual([]);
  });
});

describe('cropClass', () => {
  it('tomato is a flowering crop (F)', () => {
    expect(cropClass('tomato')).toBe('F');
  });

  it('carrot is a sizing crop (L)', () => {
    expect(cropClass('carrot')).toBe('L');
  });

  it('returns null for an unknown key, a prototype key and null', () => {
    expect(cropClass('no-such-crop')).toBeNull();
    expect(cropClass('toString')).toBeNull();
    expect(cropClass(null)).toBeNull();
  });
});

describe('illustrationUrl', () => {
  it('builds /illustrations/ URLs for each tomato stage', () => {
    expect(illustrationUrl('tomato', 1)).toBe('/illustrations/tomato-1-seed.svg');
    expect(illustrationUrl('tomato', 4)).toBe('/illustrations/tomato-4-flowering.svg');
    expect(illustrationUrl('tomato', 5)).toBe('/illustrations/tomato-5-harvest.svg');
  });

  it('builds the carrot stage 4 URL', () => {
    expect(illustrationUrl('carrot', 4)).toBe('/illustrations/carrot-4-sizing.svg');
  });

  it('returns null for an unknown key, a prototype key and null', () => {
    expect(illustrationUrl('no-such-crop', 3)).toBeNull();
    expect(illustrationUrl('toString', 3)).toBeNull();
    expect(illustrationUrl(null, 3)).toBeNull();
  });
});

describe('catalogueArtUrl', () => {
  it('returns the stage 5 file for tomato', () => {
    expect(catalogueArtUrl('tomato')).toBe('/illustrations/tomato-5-harvest.svg');
  });

  it('returns a -5-harvest.svg URL for every key in ILLUSTRATIONS', () => {
    for (const key of Object.keys(ILLUSTRATIONS)) {
      expect(catalogueArtUrl(key)).toMatch(/-5-harvest\.svg$/);
    }
  });

  it('returns null for an unknown key', () => {
    expect(catalogueArtUrl('not-a-plant')).toBeNull();
  });

  it('returns paths and https URLs unchanged', () => {
    expect(catalogueArtUrl('/some/path.svg')).toBe('/some/path.svg');
    expect(catalogueArtUrl('https://example.com/a.svg')).toBe('https://example.com/a.svg');
  });

  it('returns null for null', () => {
    expect(catalogueArtUrl(null)).toBeNull();
  });
});

describe('stageLabel', () => {
  it.each([
    [1, 'Seed'],
    [2, 'Seedling'],
    [3, 'Leafing out'],
    [5, 'Ready to harvest'],
  ] as const)('stage %i reads "%s" for every class', (stage, label) => {
    for (const cls of ['F', 'L', 'B', null] as const) {
      expect(stageLabel(stage, cls)).toBe(label);
    }
  });

  it.each([
    ['F', 'Flowering'],
    ['L', 'Sizing up'],
    ['B', 'Heading up'],
    [null, 'Maturing'],
  ] as const)('stage 4 with class %s reads "%s"', (cls, label) => {
    expect(stageLabel(4, cls)).toBe(label);
  });
});
