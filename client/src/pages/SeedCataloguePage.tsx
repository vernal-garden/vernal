// client/src/pages/SeedCataloguePage.tsx
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import AppNav from '../components/AppNav';
import SeedCard from '../components/catalogue/SeedCard';
import SeedDetailOverlay from '../components/catalogue/SeedDetailOverlay';
import { useCatalogueBrowse } from '../hooks/useCatalogueBrowse';
import { useFamilies } from '../hooks/useFamilies';
import type { BrowseCard } from '../types/catalogue';
import type { CatalogueSource } from '../hooks/useCatalogueBrowse';

// ── "Available soon" placeholder wrapper ──────────────────────────────────────

function PlaceholderBtn({ label, style }: { label: string; style?: React.CSSProperties }) {
  const [shown, setShown] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current !== null) clearTimeout(timerRef.current); };
  }, []);

  function handlePlaceholderClick() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setShown(true);
    timerRef.current = setTimeout(() => setShown(false), 2200);
  }

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        style={{
          padding: '9px 18px',
          background: 'var(--c-primary)',
          color: 'var(--c-text-on-primary)',
          border: 'none',
          borderRadius: 'var(--r-md)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          ...style,
        }}
        onClick={handlePlaceholderClick}
      >
        {label}
      </button>
      {shown && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--c-text)', color: 'var(--c-surface)', fontSize: 11,
          padding: '3px 8px', borderRadius: 'var(--r-sm)', whiteSpace: 'nowrap', pointerEvents: 'none',
          zIndex: 10,
        }}>
          Available soon
        </span>
      )}
    </span>
  );
}

// ── Chip button ───────────────────────────────────────────────────────────────

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 14px',
        borderRadius: 'var(--r-full)',
        border: active ? '1.5px solid var(--c-primary)' : '1px solid var(--c-border)',
        background: active ? 'var(--c-primary-subtle)' : 'var(--c-surface)',
        color: active ? 'var(--c-primary-dark)' : 'var(--c-text-2)',
        fontFamily: 'var(--font-ui)',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SeedCataloguePage() {
  const { isGuest } = useAuth();
  const navigate = useNavigate();

  // Guests are locked to 'cambium'
  const [source, setSource] = useState<CatalogueSource>('cambium');
  const [rawQ, setRawQ] = useState('');
  const [family, setFamily] = useState('');
  const [openCard, setOpenCard] = useState<BrowseCard | null>(null);

  const effectiveSource: CatalogueSource = isGuest ? 'cambium' : source;

  const { cards, total, loading, loadingMore, hasMore, error, loadMore, refetch } =
    useCatalogueBrowse({ source: effectiveSource, q: rawQ, family });

  const { families } = useFamilies();

  const handleCardClick = useCallback((card: BrowseCard) => {
    setOpenCard(card);
  }, []);

  // ── Source chip definitions ────────────────────────────────────────────────
  const sourceOptions: { value: CatalogueSource; label: string }[] = isGuest
    ? [{ value: 'cambium', label: 'Cambium' }]
    : [
        { value: 'mine', label: 'My Seeds' },
        { value: 'all', label: 'All Seeds' },
        { value: 'cambium', label: 'Cambium' },
      ];

  // ── Empty state logic ─────────────────────────────────────────────────────
  const isEmptyMine =
    !loading &&
    cards.length === 0 &&
    effectiveSource === 'mine' &&
    rawQ === '' &&
    family === '';

  const isNoResults = !loading && cards.length === 0 && (rawQ !== '' || family !== '');

  return (
    <div style={{ minHeight: '100vh', background: 'var(--c-bg)', display: 'flex', flexDirection: 'column' }}>
      <AppNav />

      <main style={{ flex: 1, maxWidth: 1280, width: '100%', margin: '0 auto', padding: 'var(--sp-6) var(--sp-5)' }}>

        {/* Page header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--sp-5)', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, color: 'var(--c-text)' }}>
              Seed Catalogue
            </h1>
            <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)' }}>
              {loading ? 'Loading\u2026' : `${total.toLocaleString()} seed${total !== 1 ? 's' : ''}`}
            </p>
          </div>
          {/* Add Seed — account: placeholder. Guest: navigate to register. */}
          {!isGuest ? (
            <PlaceholderBtn label="+ Add Seed" />
          ) : (
            <button
              onClick={() => navigate('/register', { state: { intent: 'create-account' } })}
              style={{
                padding: '9px 18px',
                background: 'var(--c-primary)',
                color: 'var(--c-text-on-primary)',
                border: 'none',
                borderRadius: 'var(--r-md)',
                fontFamily: 'var(--font-ui)',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + Add Seed
            </button>
          )}
        </div>

        {/* Search */}
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <input
            type="search"
            value={rawQ}
            onChange={e => setRawQ(e.target.value)}
            placeholder="Search by name or family…"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: 'var(--sp-3) var(--sp-4)',
              fontFamily: 'var(--font-ui)', fontSize: 15,
              background: 'var(--c-surface)', color: 'var(--c-text)',
              border: '1px solid var(--c-border)', borderRadius: 'var(--r-lg)',
              outline: 'none',
              boxShadow: 'var(--shadow-sm)',
            }}
            aria-label="Search seeds"
          />
        </div>

        {/* Filter row */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', marginBottom: 'var(--sp-5)' }}>
          {/* Source chips */}
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            {sourceOptions.map(opt => (
              <Chip
                key={opt.value}
                label={opt.label}
                active={effectiveSource === opt.value}
                onClick={() => {
                  if (!isGuest) {
                    setSource(opt.value);
                    setFamily('');
                  }
                }}
              />
            ))}
          </div>
          {/* Family chips */}
          {families.length > 0 && (
            <div style={{ display: 'flex', gap: 'var(--sp-1)', flexWrap: 'wrap' }}>
              <Chip label="All families" active={family === ''} onClick={() => setFamily('')} />
              {families.map(f => (
                <Chip
                  key={f.family}
                  label={f.family}
                  active={family === f.family}
                  onClick={() => setFamily(family === f.family ? '' : f.family)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {error && !loading && (
          <div style={{ textAlign: 'center', color: 'var(--c-danger)', padding: 'var(--sp-7) 0' }}>
            {error}.{' '}
            <button onClick={refetch} style={{ background: 'none', border: 'none', color: 'var(--c-primary)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
              Retry
            </button>
          </div>
        )}

        {/* Loading spinner (initial load only); @keyframes spin is in index.css */}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-9) 0' }}>
            <div style={{ width: 32, height: 32, border: '2px solid var(--c-primary-light)', borderTopColor: 'var(--c-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        )}

        {/* Empty state — My Seeds with zero seeds */}
        {!loading && !error && isEmptyMine && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-8) var(--sp-5)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-4)' }}>
            <div style={{ fontSize: 48 }} aria-hidden="true">&#127807;</div>
            <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--c-text)' }}>
              Your catalogue is empty.
            </h2>
            <p style={{ margin: 0, color: 'var(--c-text-2)', fontFamily: 'var(--font-ui)', fontSize: 15, maxWidth: 340 }}>
              Add seeds you grow, or browse what the Cambium community has shared.
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
              <PlaceholderBtn label="Add a seed" />
              <button
                onClick={() => setSource('cambium')}
                style={{
                  padding: '9px 18px', background: 'transparent', color: 'var(--c-text-2)',
                  border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
                  fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
                }}
              >
                Browse Cambium
              </button>
            </div>
          </div>
        )}

        {/* No-results state */}
        {!loading && !error && isNoResults && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-7) 0', color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)', fontSize: 15 }}>
            No seeds found for &ldquo;{[rawQ, family].filter(Boolean).join(' + ')}&rdquo;. Try a different search or clear the filters.
          </div>
        )}

        {/* Grid */}
        {!loading && !error && cards.length > 0 && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4" style={{ gap: 'var(--sp-4)' }}>
              {cards.map(card => (
                <SeedCard
                  key={`${card.kind}-${card.id}`}
                  card={card}
                  onClick={() => handleCardClick(card)}
                />
              ))}
            </div>

            {/* Load more */}
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: 'var(--sp-6)' }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    padding: '10px 28px',
                    background: 'transparent',
                    color: 'var(--c-primary)',
                    border: '1.5px solid var(--c-primary)',
                    borderRadius: 'var(--r-md)',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: loadingMore ? 'default' : 'pointer',
                    opacity: loadingMore ? 0.6 : 1,
                  }}
                >
                  {loadingMore ? 'Loading\u2026' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* Detail overlay */}
      {openCard && (
        <SeedDetailOverlay
          card={openCard}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}
