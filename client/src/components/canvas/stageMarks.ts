import type Konva from 'konva';
import type { GrowthStage } from '../../lib/growthStages';

// Placeholder growth-stage marks drawn inside a planting marker. Each is a
// simple white glyph centred at (0,0) and scaled to the marker radius. Use as
// <Shape sceneFunc={(ctx) => drawStageMark(ctx, stage, r)} listening={false} />.

const MARK_COLOR = '#fff';

// A pointed leaf from (x, y) along `angle` (radians, 0 = right).
function leaf(ctx: Konva.Context, x: number, y: number, angle: number, len: number, width: number) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const tipX = x + cos * len, tipY = y + sin * len;
  const midX = x + cos * len * 0.5, midY = y + sin * len * 0.5;
  // Perpendicular offset for the leaf's two edges.
  const px = -sin * width, py = cos * width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(midX + px, midY + py, tipX, tipY);
  ctx.quadraticCurveTo(midX - px, midY - py, x, y);
  ctx.closePath();
  ctx.fill();
}

function stem(ctx: Konva.Context, y1: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(0, y1);
  ctx.lineTo(0, y2);
  ctx.stroke();
}

function dot(ctx: Konva.Context, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2, false);
  ctx.closePath();
  ctx.fill();
}

export function drawStageMark(context: Konva.Context, stage: GrowthStage, radius: number) {
  // Draw inside ~65% of the marker so the glyph never touches its edge.
  const r = radius * 0.65;
  const lineWidth = Math.max(r * 0.14, 0.5);
  context.setAttr('fillStyle', MARK_COLOR);
  context.setAttr('strokeStyle', MARK_COLOR);
  context.setAttr('lineWidth', lineWidth);
  context.setAttr('lineCap', 'round');

  switch (stage) {
    case 1: {
      // Seed: a small tilted oval.
      context.beginPath();
      context.ellipse(0, 0, r * 0.3, r * 0.45, -0.5, 0, Math.PI * 2, false);
      context.closePath();
      context.fill();
      break;
    }
    case 2: {
      // Seedling: short stem, two small leaves.
      stem(context, r * 0.7, -r * 0.1);
      leaf(context, 0, -r * 0.1, -Math.PI * 0.85, r * 0.6, r * 0.22);
      leaf(context, 0, -r * 0.1, -Math.PI * 0.15, r * 0.6, r * 0.22);
      break;
    }
    case 3: {
      // Vegetative: taller stem, four leaves.
      stem(context, r * 0.85, -r * 0.85);
      leaf(context, 0, r * 0.3, -Math.PI * 0.85, r * 0.6, r * 0.2);
      leaf(context, 0, r * 0.3, -Math.PI * 0.15, r * 0.6, r * 0.2);
      leaf(context, 0, -r * 0.3, -Math.PI * 0.8, r * 0.5, r * 0.17);
      leaf(context, 0, -r * 0.3, -Math.PI * 0.2, r * 0.5, r * 0.17);
      break;
    }
    case 4: {
      // Flowering / fruiting: stem topped by a five-petal flower.
      stem(context, r * 0.9, -r * 0.2);
      const fy = -r * 0.4;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        dot(context, Math.cos(a) * r * 0.32, fy + Math.sin(a) * r * 0.32, r * 0.16);
      }
      dot(context, 0, fy, r * 0.1);
      break;
    }
    case 5: {
      // Harvest-ready: round fruit with a leaf.
      dot(context, 0, r * 0.2, r * 0.6);
      stem(context, -r * 0.35, -r * 0.65);
      leaf(context, 0, -r * 0.55, -Math.PI * 0.2, r * 0.6, r * 0.2);
      break;
    }
  }
}

export type MarkerTier = 'large' | 'medium' | 'small';

// Marker detail by on-screen diameter in px: large shows the stage mark,
// medium the text label, small neither (harvest-ready shows as a gold fill).
// 20 < d < 21 counts as medium.
export function markerTier(diameterPx: number): MarkerTier {
  if (diameterPx >= 40) return 'large';
  if (diameterPx > 20) return 'medium';
  return 'small';
}
