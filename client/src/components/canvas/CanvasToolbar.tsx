import type { GardenSummary } from '../../hooks/useGardenList';

interface Props {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  gardens: GardenSummary[];
  activeGardenId: string;
  onGardenChange: (id: string) => void;
}

const btnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: 'transparent',
  border: '1px solid rgba(140,200,140,0.22)',
  color: '#b8d4b8',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
  transition: 'background 0.15s, color 0.15s',
  flexShrink: 0,
};

export default function CanvasToolbar({ scale, onZoomIn, onZoomOut, onResetZoom, gardens, activeGardenId, onGardenChange }: Props) {
  const pct = Math.round(scale * 100);

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      background: 'rgba(16, 34, 22, 0.88)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      border: '1px solid rgba(100,160,100,0.18)',
      borderRadius: 999,
      padding: '5px 10px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 1px 0 rgba(100,160,100,0.12) inset',
      zIndex: 10,
      userSelect: 'none',
    }}>
      {/* Zoom out */}
      <button style={btnStyle} onClick={onZoomOut} aria-label="Zoom out">
        −
      </button>

      {/* Zoom percentage — click to reset */}
      <button
        onClick={onResetZoom}
        aria-label="Reset zoom to 100%"
        title="Click to reset zoom"
        style={{
          fontFamily: "'DM Mono', 'Courier New', monospace",
          fontSize: 11,
          color: '#c0d8c0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          minWidth: 44,
          textAlign: 'center',
          padding: '0 4px',
          letterSpacing: '0.03em',
        }}
      >
        {pct}%
      </button>

      {/* Zoom in */}
      <button style={btnStyle} onClick={onZoomIn} aria-label="Zoom in">
        +
      </button>

      {/* Garden switcher — only when >1 garden */}
      {gardens.length > 1 && (
        <>
          <div style={{ width: 1, height: 18, background: 'rgba(100,160,100,0.2)', margin: '0 8px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {gardens.map(g => (
              <button
                key={g.id}
                onClick={() => onGardenChange(g.id)}
                title={g.name}
                style={{
                  padding: '3px 10px',
                  borderRadius: 999,
                  fontSize: 11,
                  fontFamily: "'DM Mono', 'Courier New', monospace",
                  cursor: 'pointer',
                  border: '1px solid',
                  transition: 'all 0.15s',
                  ...(g.id === activeGardenId
                    ? {
                        background: 'rgba(140,200,140,0.18)',
                        borderColor: 'rgba(140,200,140,0.4)',
                        color: '#c8e8c8',
                      }
                    : {
                        background: 'transparent',
                        borderColor: 'transparent',
                        color: '#7a9e7a',
                      }),
                }}
              >
                {g.name.length > 14 ? g.name.slice(0, 13) + '…' : g.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
