// Fits growth-stage art to the canvas marker disc. The generated manifest
// (npm run art:fit) holds each file's content circle as fractions of its
// viewBox; the viewBox computed here recentres that circle and scales it so
// the art fills a stage-dependent share of the disc.
import manifest from './illustrationFit.generated.json';

type Stage = 1 | 2 | 3 | 4 | 5;

interface FitEntry {
  cx: number;
  cy: number;
  r: number;
}

// Share of the disc radius each stage fills.
export const FIT_TARGETS: Record<Stage, number> = { 1: 0.55, 2: 0.70, 3: 0.82, 4: 0.88, 5: 0.92 };

// The art viewBoxes are 120 units square.
const ART_SIZE = 120;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function viewBoxFor(entry: FitEntry, stage: Stage): string {
  // Disc radius in viewBox units.
  const h = (entry.r * (ART_SIZE / 2)) / FIT_TARGETS[stage];
  return [entry.cx * ART_SIZE - h, entry.cy * ART_SIZE - h, 2 * h, 2 * h].map(round3).join(' ');
}

// Null when the file has no manifest entry. Own-property lookup so keys like
// "toString" never match Object.prototype.
export function fitViewBox(fileKey: string, stage: Stage): string | null {
  if (!Object.prototype.hasOwnProperty.call(manifest, fileKey)) return null;
  return viewBoxFor((manifest as Record<string, FitEntry>)[fileKey], stage);
}
