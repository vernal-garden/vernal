import type { Bed } from '../../hooks/useGarden';

const GRID_PX = 30;

function shoelaceArea(points: number[]): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = points[i * 2];
    const y1 = points[i * 2 + 1];
    const x2 = points[((i + 1) % n) * 2];
    const y2 = points[((i + 1) % n) * 2 + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

interface Props {
  bed: Bed | null;
  onClose: () => void;
}

export default function BedDetailPanel({ bed, onClose }: Props) {
  if (!bed) return null;

  const isGrid = bed.type === 'grid' && bed.grid != null;
  const isFreeform = bed.type === 'freeform' && bed.freeform != null;

  let dimensionLine: string;
  if (isGrid && bed.grid) {
    const { cols, rows } = bed.grid;
    dimensionLine = `${cols} × ${rows} ft · ${cols * rows} sq ft`;
  } else if (isFreeform && bed.freeform) {
    const sqFt = Math.round(shoelaceArea(bed.freeform.points) / (GRID_PX * GRID_PX));
    dimensionLine = `~${sqFt} sq ft (approximate)`;
  } else {
    dimensionLine = '—';
  }

  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: 0,
      bottom: 0,
      width: 280,
      display: 'flex',
      flexDirection: 'column',
      background: '#faf7f2',
      borderLeft: '1px solid #d8ceba',
      boxShadow: '-4px 0 32px rgba(20, 40, 20, 0.12)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      zIndex: 20,
    }}>
      {/* Header */}
      <div style={{
        background: '#1c3a28',
        padding: '20px 20px 16px',
        position: 'relative',
        flexShrink: 0,
      }}>
        {/* Type chip */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 10px',
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          marginBottom: 10,
          background: isGrid ? 'rgba(212,237,218,0.15)' : 'rgba(255,243,205,0.12)',
          border: isGrid ? '1px solid rgba(168,212,176,0.35)' : '1px solid rgba(240,192,96,0.3)',
          color: isGrid ? '#9dcfaa' : '#e8b84a',
        }}>
          {isGrid ? 'Grid' : 'Freeform'}
        </div>

        {/* Bed name */}
        <div style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontSize: 18,
          fontWeight: 600,
          color: '#e8f4e8',
          lineHeight: 1.25,
          paddingRight: 32,
          wordBreak: 'break-word',
        }}>
          {bed.label || 'Untitled bed'}
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          aria-label="Close panel"
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.18)',
            color: 'rgba(232,244,232,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        {/* Dimensions */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 6 }}>
            Dimensions
          </div>
          <div style={{
            fontFamily: "'DM Mono', 'Courier New', monospace",
            fontSize: 14,
            color: '#2c3e2c',
            background: '#f0ebe0',
            border: '1px solid #e0d8c8',
            borderRadius: 6,
            padding: '8px 12px',
          }}>
            {dimensionLine}
          </div>
        </div>

        {/* Season */}
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 6 }}>
            Season
          </div>
          <div style={{
            fontFamily: "'DM Mono', 'Courier New', monospace",
            fontSize: 14,
            color: '#2c3e2c',
            background: '#f0ebe0',
            border: '1px solid #e0d8c8',
            borderRadius: 6,
            padding: '8px 12px',
          }}>
            {bed.season}
          </div>
        </div>
      </div>
    </div>
  );
}
