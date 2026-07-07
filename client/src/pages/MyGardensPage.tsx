import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGardenList, type GardenSummary } from '../hooks/useGardenList';
import * as api from '../lib/api';
import GardenCard from '../components/GardenCard';
import AppNav from '../components/AppNav';

// ── Skeleton card for loading state ──────────────────────────────────────────

function SkeletonCard() {
  return (
    <div style={{
      background: 'var(--c-surface)',
      border: '1px solid var(--c-border-subtle)',
      borderRadius: 'var(--r-lg)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ height: 160, background: 'var(--c-surface-raised)', animation: 'pulse 1.5s ease-in-out infinite' }} />
      <div style={{ padding: 'var(--sp-3) var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        <div style={{ height: 16, width: '60%', borderRadius: 'var(--r-sm)', background: 'var(--c-surface-raised)', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <div style={{ height: 12, width: '40%', borderRadius: 'var(--r-sm)', background: 'var(--c-surface-raised)', animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
    </div>
  );
}

// ── "New garden" grid card ────────────────────────────────────────────────────

function NewGardenCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'var(--c-surface)',
        border: '2px dashed var(--c-border)',
        borderRadius: 'var(--r-lg)',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-2)',
        minHeight: 260,
        color: 'var(--c-text-3)',
        transition: 'border-color 0.15s, color 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--c-primary)';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--c-primary)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--c-border)';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--c-text-3)';
      }}
    >
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="16" cy="16" r="13"/>
        <line x1="16" y1="10" x2="16" y2="22"/>
        <line x1="10" y1="16" x2="22" y2="16"/>
      </svg>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 500 }}>New garden</span>
    </button>
  );
}

// ── Responsive grid (CSS breakpoints via injected style tag) ─────────────────

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 'var(--sp-4)',
  gridTemplateColumns: 'repeat(1, 1fr)',
};

const responsiveCss = `
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
  @media (min-width: 768px)  { .gardens-grid { grid-template-columns: repeat(2, 1fr) !important; } }
  @media (min-width: 1200px) { .gardens-grid { grid-template-columns: repeat(3, 1fr) !important; } }
`;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function MyGardensPage() {
  const navigate = useNavigate();
  const { gardens: rawGardens, loading, error, reload } = useGardenList();
  // Local copy for optimistic rename/delete updates
  const [localGardens, setLocalGardens] = useState<GardenSummary[] | null>(null);

  useEffect(() => {
    if (!loading) setLocalGardens(rawGardens);
  }, [rawGardens, loading]);

  const displayGardens = localGardens ?? rawGardens;

  const handleNewGarden = useCallback(() => {
    navigate('/onboarding', { state: { newGarden: true } });
  }, [navigate]);

  const handleRename = useCallback(async (id: string, newName: string) => {
    setLocalGardens(prev => prev ? prev.map(g => g.id === id ? { ...g, name: newName } : g) : prev);
    try {
      await api.patch(`/api/gardens/${id}`, { name: newName });
    } catch {
      reload();
      throw new Error('Failed to rename');
    }
  }, [reload]);

  const handleDelete = useCallback(async (id: string) => {
    setLocalGardens(prev => prev ? prev.filter(g => g.id !== id) : prev);
    try {
      await api.del(`/api/gardens/${id}`);
    } catch {
      reload();
      throw new Error('Failed to delete');
    }
  }, [reload]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--c-bg)', display: 'flex', flexDirection: 'column' }}>
      <style>{responsiveCss}</style>
      <AppNav />

      <main style={{ flex: 1, maxWidth: 1320, margin: '0 auto', width: '100%', padding: 'var(--sp-6) var(--sp-5)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-6)' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>
            My Gardens
          </h1>
          <button
            onClick={handleNewGarden}
            style={{
              fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 500,
              padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)',
              background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 'var(--sp-1)',
            }}
          >
            + New garden
          </button>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="gardens-grid" style={gridStyle}>
            {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-8)' }}>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-danger)', marginBottom: 'var(--sp-3)' }}>
              {error}
            </p>
            <button
              onClick={reload}
              style={{ fontFamily: 'var(--font-ui)', fontSize: 13, padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)', background: 'transparent', cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && displayGardens.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-9) var(--sp-5)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)', marginBottom: 'var(--sp-3)' }}>
              No gardens yet
            </div>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)', maxWidth: 360, margin: '0 auto var(--sp-5)' }}>
              Create your first garden to start planning what to grow this season.
            </p>
            <button
              onClick={handleNewGarden}
              style={{
                fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 500,
                padding: 'var(--sp-3) var(--sp-6)', borderRadius: 'var(--r-md)',
                background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
                border: 'none', cursor: 'pointer',
              }}
            >
              Create your first garden
            </button>
          </div>
        )}

        {/* Populated state */}
        {!loading && !error && displayGardens.length > 0 && (
          <div className="gardens-grid" style={gridStyle}>
            {displayGardens.map(g => (
              <GardenCard
                key={g.id}
                garden={g}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
            <NewGardenCard onClick={handleNewGarden} />
          </div>
        )}
      </main>
    </div>
  );
}
