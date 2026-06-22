import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Konva from 'konva';
import { Layer, Line, Group, Rect, Stage, Text } from 'react-konva';
import type { Bed } from '../../hooks/useGarden';

Konva.hitOnDragEnabled = true;

export const GRID_PX = 30;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const GRID_HIDE_THRESHOLD = 0.4;

export interface GardenCanvasRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

interface Props {
  beds: Bed[];
  selectedBedId: string | null;
  onSelectBed: (bed: Bed | null) => void;
  onScaleChange?: (scale: number) => void;
}

function computeExtents(beds: Bed[]) {
  const MARGIN = 10 * GRID_PX;
  if (beds.length === 0) {
    return { minX: -MARGIN, minY: -MARGIN, maxX: 20 * GRID_PX + MARGIN, maxY: 15 * GRID_PX + MARGIN };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const bed of beds) {
    if (bed.type === 'grid' && bed.grid) {
      minX = Math.min(minX, bed.grid.x * GRID_PX);
      minY = Math.min(minY, bed.grid.y * GRID_PX);
      maxX = Math.max(maxX, (bed.grid.x + bed.grid.cols) * GRID_PX);
      maxY = Math.max(maxY, (bed.grid.y + bed.grid.rows) * GRID_PX);
    } else if (bed.type === 'freeform' && bed.freeform) {
      for (let i = 0; i < bed.freeform.points.length; i += 2) {
        minX = Math.min(minX, bed.freeform.points[i]);
        minY = Math.min(minY, bed.freeform.points[i + 1]);
        maxX = Math.max(maxX, bed.freeform.points[i]);
        maxY = Math.max(maxY, bed.freeform.points[i + 1]);
      }
    }
  }
  return { minX: minX - MARGIN, minY: minY - MARGIN, maxX: maxX + MARGIN, maxY: maxY + MARGIN };
}

function freeformBbox(points: number[]) {
  let minX = Infinity, minY = Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    minY = Math.min(minY, points[i + 1]);
  }
  return { minX, minY };
}

const GardenCanvas = forwardRef<GardenCanvasRef, Props>(({ beds, selectedBedId, onSelectBed, onScaleChange }, ref) => {
  const stageRef = useRef<Konva.Stage>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEffect(() => { (window as any).__stage = stageRef.current; });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const applyZoom = useCallback((newScale: number, cx: number, cy: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const clamped = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
    const old = stage.scaleX();
    const pt = { x: (cx - stage.x()) / old, y: (cy - stage.y()) / old };
    stage.scale({ x: clamped, y: clamped });
    stage.position({ x: cx - pt.x * clamped, y: cy - pt.y * clamped });
    stage.batchDraw();
    setScale(clamped);
    onScaleChange?.(clamped);
  }, [onScaleChange]);

  useImperativeHandle(ref, () => ({
    zoomIn() {
      const stage = stageRef.current;
      if (!stage) return;
      applyZoom(stage.scaleX() * ZOOM_STEP, stage.width() / 2, stage.height() / 2);
    },
    zoomOut() {
      const stage = stageRef.current;
      if (!stage) return;
      applyZoom(stage.scaleX() / ZOOM_STEP, stage.width() / 2, stage.height() / 2);
    },
    resetZoom() {
      const stage = stageRef.current;
      if (!stage) return;
      const cx = stage.width() / 2;
      const cy = stage.height() / 2;
      const old = stage.scaleX();
      const pt = { x: (cx - stage.x()) / old, y: (cy - stage.y()) / old };
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: cx - pt.x * 1, y: cy - pt.y * 1 });
      stage.batchDraw();
      setScale(1);
      onScaleChange?.(1);
    },
  }), [applyZoom, onScaleChange]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const newScale = e.evt.deltaY < 0 ? stage.scaleX() * ZOOM_STEP : stage.scaleX() / ZOOM_STEP;
    applyZoom(newScale, pointer.x, pointer.y);
  }, [applyZoom]);

  const extents = useMemo(() => computeExtents(beds), [beds]);

  const gridLines = useMemo(() => {
    const lines: ReactNode[] = [];
    const startX = Math.floor(extents.minX / GRID_PX) * GRID_PX;
    const startY = Math.floor(extents.minY / GRID_PX) * GRID_PX;
    for (let x = startX; x <= extents.maxX; x += GRID_PX) {
      lines.push(
        <Line key={`v${x}`}
          points={[x, extents.minY, x, extents.maxY]}
          stroke="#ddd5c4" strokeWidth={0.5} />,
      );
    }
    for (let y = startY; y <= extents.maxY; y += GRID_PX) {
      lines.push(
        <Line key={`h${y}`}
          points={[extents.minX, y, extents.maxX, y]}
          stroke="#ddd5c4" strokeWidth={0.5} />,
      );
    }
    return lines;
  }, [extents]);

  return (
    <Stage
      ref={stageRef}
      width={size.w}
      height={size.h}
      draggable
      onWheel={handleWheel}
      onClick={(e) => {
        const st = e.target.getStage();
        console.log('STAGE CLICK — target:', e.target.getClassName(), '| wasDragging:', st?.isDragging());
        if (e.target === st) onSelectBed(null);
      }}
    >
      <Layer listening={false}>
        {scale >= GRID_HIDE_THRESHOLD && gridLines}
      </Layer>

      <Layer>
        {beds.map(bed => {
          const selected = bed.id === selectedBedId;

          if (bed.type === 'grid' && bed.grid) {
            const { x, y, cols, rows } = bed.grid;
            const w = cols * GRID_PX;
            const h = rows * GRID_PX;

            const cellLines: ReactNode[] = [];
            for (let col = 1; col < cols; col++) {
              cellLines.push(
                <Line key={`vc${col}`}
                  points={[col * GRID_PX, 0, col * GRID_PX, h]}
                  stroke="#b8d0ba" strokeWidth={0.5} listening={false} />,
              );
            }
            for (let row = 1; row < rows; row++) {
              cellLines.push(
                <Line key={`hr${row}`}
                  points={[0, row * GRID_PX, w, row * GRID_PX]}
                  stroke="#b8d0ba" strokeWidth={0.5} listening={false} />,
              );
            }

            return (
              <Group
                key={bed.id}
                x={x * GRID_PX}
                y={y * GRID_PX}
              >
                <Rect
                  width={w}
                  height={h}
                  fill="#d4edda"
                  stroke={selected ? '#1a5c3a' : '#2d6a4f'}
                  strokeWidth={selected ? 3 : 1.5}
                  cornerRadius={2}
                  onClick={(e) => { console.log('GRID HIT'); e.cancelBubble = true; onSelectBed(bed); }}
                />
                {cellLines}
                <Text
                  text={bed.label || 'Bed'}
                  fontSize={12}
                  x={4}
                  y={4}
                  fill="#264a2e"
                  fontFamily="Georgia, serif"
                  listening={false}
                />
              </Group>
            );
          }

          if (bed.type === 'freeform' && bed.freeform) {
            const { points, closed } = bed.freeform;
            const { minX, minY } = freeformBbox(points);

            return (
              <Group
                key={bed.id}
                onClick={(e) => { console.log('FREEFORM HIT'); e.cancelBubble = true; onSelectBed(bed); }}
              >
                <Line
                  points={points}
                  closed={closed}
                  fill="#fff3cd"
                  stroke={selected ? '#8a5a00' : '#b8860b'}
                  strokeWidth={selected ? 3 : 1.5}
                  dash={[6, 4]}
                  hitFunc={(context, shape) => {
                    context.beginPath();
                    context.moveTo(points[0], points[1]);
                    for (let i = 2; i < points.length; i += 2) context.lineTo(points[i], points[i + 1]);
                    context.closePath();
                    context.fillStrokeShape(shape);
                  }}
                />
                <Text
                  text={bed.label || 'Bed'}
                  fontSize={12}
                  x={minX + 4}
                  y={minY + 4}
                  fill="#5a3e00"
                  fontFamily="Georgia, serif"
                  listening={false}
                />
              </Group>
            );
          }

          return null;
        })}
      </Layer>
    </Stage>
  );
});

GardenCanvas.displayName = 'GardenCanvas';
export default GardenCanvas;
