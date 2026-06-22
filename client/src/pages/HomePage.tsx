import { useCallback, useRef, useState } from 'react';
import { useGardenList } from '../hooks/useGardenList';
import { useGarden } from '../hooks/useGarden';
import type { Bed } from '../hooks/useGarden';
import GardenCanvas from '../components/canvas/GardenCanvas';
import type { GardenCanvasRef } from '../components/canvas/GardenCanvas';
import BedDetailPanel from '../components/canvas/BedDetailPanel';
import CanvasToolbar from '../components/canvas/CanvasToolbar';

export default function HomePage() {
  const { gardens, loading: listLoading } = useGardenList();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedBed, setSelectedBed] = useState<Bed | null>(null);
  const [scale, setScale] = useState(1);
  const canvasRef = useRef<GardenCanvasRef>(null);

  // Default to first garden once loaded
  const resolvedId = activeId ?? (gardens.length > 0 ? gardens[0].id : null);
  const { garden, loading: gardenLoading } = useGarden(resolvedId);

  const handleGardenChange = useCallback((id: string) => {
    setActiveId(id);
    setSelectedBed(null);
  }, []);

  const handleSelectBed = useCallback((bed: Bed | null) => {
    setSelectedBed(bed);
  }, []);

  const handleZoomIn = useCallback(() => canvasRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => canvasRef.current?.zoomOut(), []);
  const handleResetZoom = useCallback(() => canvasRef.current?.resetZoom(), []);

  // Loading state
  if (listLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#f8f4eb',
      }}>
        <div style={{
          width: 32,
          height: 32,
          border: '2px solid #c8dcca',
          borderTopColor: '#2d6a4f',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Zero gardens — ProtectedRoute with requireOnboarding should have redirected;
  // render nothing as a defensive guard.
  if (!listLoading && gardens.length === 0) {
    return null;
  }

  const beds = garden?.beds ?? [];
  const hasNoBeds = !gardenLoading && garden != null && beds.length === 0;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#f8f4eb', overflow: 'hidden' }}>
      {/* Canvas */}
      <GardenCanvas
        ref={canvasRef}
        beds={beds}
        selectedBedId={selectedBed?.id ?? null}
        onSelectBed={handleSelectBed}
        onScaleChange={setScale}
      />

      {/* Empty-beds overlay */}
      {hasNoBeds && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <div style={{
            background: 'rgba(250, 247, 242, 0.88)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid #d8ceba',
            borderRadius: 12,
            padding: '18px 28px',
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 15,
            color: '#5a4e3a',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          }}>
            Place your first bed to start planning.
          </div>
        </div>
      )}

      {/* Toolbar */}
      {resolvedId && (
        <CanvasToolbar
          scale={scale}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetZoom={handleResetZoom}
          gardens={gardens}
          activeGardenId={resolvedId}
          onGardenChange={handleGardenChange}
        />
      )}

      {/* Bed detail panel */}
      <BedDetailPanel bed={selectedBed} onClose={() => setSelectedBed(null)} />
    </div>
  );
}
