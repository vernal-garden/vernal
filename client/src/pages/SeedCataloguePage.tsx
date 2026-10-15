// client/src/pages/SeedCataloguePage.tsx
import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import SeedCard from '../components/catalogue/SeedCard';
import SeedDetailOverlay from '../components/catalogue/SeedDetailOverlay';
import { useCatalogueBrowse } from '../hooks/useCatalogueBrowse';
import { useFamilies } from '../hooks/useFamilies';
import type { BrowseCard } from '../types/catalogue';
import type { CatalogueSource } from '../hooks/useCatalogueBrowse';
import SeedForm from '../components/catalogue/SeedForm';
import SeedListRow from '../components/catalogue/SeedListRow';
import BottomSheet from '../components/shell/BottomSheet';
import { useIsMobile } from '../hooks/useIsMobile';
import type { CatalogueSeedDetail, PersonalSeedDetail } from '../types/catalogue';

// Builds the card the detail overlay needs from a fetched seed, for a
// ?open= deep link to a seed that isn't in the loaded page.
async function fetchCard(kind: 'personal' | 'community', id: string): Promise<BrowseCard | null> {
  if (kind === 'community') {
    const d = await get<CatalogueSeedDetail>(`/api/catalogue/seeds/${id}`);
    return d ? {
      kind: 'community', id: d.id, commonName: d.commonName, scientificName: d.scientificName,
      plantFamily: d.plantFamily, illustrationKey: d.illustrationKey,
      aggregateRating: d.aggregateRating, ratingCount: d.ratingCount,
    } : null;
  }
  const d = await get<PersonalSeedDetail>(`/api/seeds/${id}`);
  return d ? {
    kind: 'personal', id: d.id, commonName: d.commonName, scientificName: d.scientificName,
    plantFamily: d.plantFamily, illustrationKey: d.illustrationKey, userRating: d.userRating,
    isFavourite: d.isFavourite, origin: d.origin, contributionStatus: d.contributionStatus,
    cambiumSourceId: d.cambiumSourceId,
  } : null;
}

// ── Chip button ───────────────────────────────────────────────────────────────

function Chip({ label, active, onClick, large = false }: { label: string; active: boolean; onClick: () => void; large?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        // `large` is the mobile filter-sheet size: a 44px touch target.
        ...(large ? { minHeight: 44, minWidth: 44 } : {}),
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
  const isMobile = useIsMobile();
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  // Leaving mobile closes the sheet so it doesn't pop back open on return.
  useEffect(() => { if (!isMobile) setFilterSheetOpen(false); }, [isMobile]);

  // Guests are locked to 'cambium'
  const [source, setSource] = useState<CatalogueSource>('cambium');
  const [rawQ, setRawQ] = useState('');
  const [family, setFamily] = useState('');
  const [openCard, setOpenCard] = useState<BrowseCard | null>(null);

  const effectiveSource: CatalogueSource = isGuest ? 'cambium' : source;

  const { cards, total, loading, loadingMore, hasMore, error, loadMore, refetch } =
    useCatalogueBrowse({ source: effectiveSource, q: rawQ, family });

  const { families } = useFamilies();
  const [seedFormOpen, setSeedFormOpen] = useState(false);

  const handleCardClick = useCallback((card: BrowseCard) => {
    setOpenCard(card);
  }, []);

  // ?open=seed:<id> | cambium:<id> — open that seed's overlay once the first
  // page has loaded, then drop the param. Unknown ids are ignored.
  const [searchParams, setSearchParams] = useSearchParams();
  const handledOpen = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const param = searchParams.get('open');
    // Forget the last handled link once the param is gone, so the same (or a
    // new) ?open= can fire again while the page stays mounted.
    if (param === null) {
      handledOpen.current = null;
      return;
    }
    if (handledOpen.current === param) return;
    handledOpen.current = param;
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });

    const m = /^(seed|cambium):(\d+)$/.exec(param);
    if (!m) return;
    const kind = m[1] === 'seed' ? 'personal' : 'community';
    const loaded = cards.find(c => c.kind === kind && c.id === m[2]);
    if (loaded) {
      setOpenCard(loaded);
      return;
    }
    fetchCard(kind, m[2])
      .then(card => { if (card) setOpenCard(card); })
      .catch(() => { /* unknown or inaccessible seed: do nothing */ });
  }, [loading, cards, searchParams, setSearchParams]);

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

  // Mobile "Filter" button badge: a family filter, plus a non-default source.
  const activeFilterCount = (family !== '' ? 1 : 0) + (effectiveSource !== 'cambium' ? 1 : 0);

  // Mobile touch-target floor for the page's text buttons (desktop unchanged).
  const mobileTarget: CSSProperties = isMobile ? { minHeight: 44, minWidth: 44 } : {};

  const sourceChips = (large: boolean) => sourceOptions.map(opt => (
    <Chip
      key={opt.value}
      label={opt.label}
      large={large}
      active={effectiveSource === opt.value}
      onClick={() => {
        if (!isGuest) {
          setSource(opt.value);
          setFamily('');
        }
      }}
    />
  ));

  const familyChips = (large: boolean) => [
    <Chip key="" label="All families" large={large} active={family === ''} onClick={() => setFamily('')} />,
    ...families.map(f => (
      <Chip
        key={f.family}
        label={f.family}
        large={large}
        active={family === f.family}
        onClick={() => setFamily(family === f.family ? '' : f.family)}
      />
    )),
  ];

  const sheetHeadingStyle: CSSProperties = {
    margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
    color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em',
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--c-bg)', display: 'flex', flexDirection: 'column' }}>

      <main style={{ flex: 1, maxWidth: 1280, width: '100%', boxSizing: isMobile ? 'border-box' : undefined, margin: '0 auto', padding: isMobile ? '0 0 var(--sp-6)' : 'var(--sp-6) var(--sp-5)' }}>

        {/* The mobile top bar shows the title as plain text, so keep a page heading for AT. */}
        {isMobile && <h1 className="sr-only">Seed Catalogue</h1>}

        {isMobile && (
          // Sticky search + Filter, pinned under the mobile top bar.
          <div
            style={{
              position: 'sticky', top: 'var(--shell-top)', zIndex: 10,
              display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
              padding: 'var(--sp-3) var(--sp-4)',
              background: 'var(--c-bg)',
              borderBottom: '1px solid var(--c-border-subtle)',
            }}
          >
            <input
              type="search"
              value={rawQ}
              onChange={e => setRawQ(e.target.value)}
              placeholder="Search by name or family…"
              style={{
                flex: 1, minWidth: 0, minHeight: 44, boxSizing: 'border-box',
                padding: '0 var(--sp-3)',
                fontFamily: 'var(--font-ui)', fontSize: 16,
                background: 'var(--c-surface)', color: 'var(--c-text)',
                border: '1px solid var(--c-border)', borderRadius: 'var(--r-lg)',
                outline: 'none',
              }}
              aria-label="Search seeds"
            />
            <button
              type="button"
              onClick={() => setFilterSheetOpen(true)}
              aria-label="Filter"
              aria-describedby={activeFilterCount > 0 ? 'catalogue-filter-count' : undefined}
              aria-haspopup="dialog"
              style={{
                flexShrink: 0, minHeight: 44, minWidth: 44,
                display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)',
                padding: '0 var(--sp-3)',
                background: activeFilterCount > 0 ? 'var(--c-primary-subtle)' : 'var(--c-surface)',
                color: activeFilterCount > 0 ? 'var(--c-primary-dark)' : 'var(--c-text-2)',
                border: activeFilterCount > 0 ? '1.5px solid var(--c-primary)' : '1px solid var(--c-border)',
                borderRadius: 'var(--r-lg)',
                fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Filter
              {activeFilterCount > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    minWidth: 'var(--sp-5)', height: 'var(--sp-5)', padding: '0 var(--sp-1)', boxSizing: 'border-box',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 'var(--r-full)',
                    background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
                    fontSize: 12, fontWeight: 600,
                  }}
                >
                  {activeFilterCount}
                </span>
              )}
              {activeFilterCount > 0 && (
                <span id="catalogue-filter-count" className="sr-only">
                  {activeFilterCount} active filter{activeFilterCount !== 1 ? 's' : ''}
                </span>
              )}
            </button>
          </div>
        )}

        {isMobile && (
          <p style={{ margin: 0, padding: 'var(--sp-2) var(--sp-4)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-3)' }}>
            {loading ? 'Loading…' : `${total.toLocaleString()} seed${total !== 1 ? 's' : ''}`}
          </p>
        )}

        {!isMobile && (<>
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
            <button
              onClick={() => setSeedFormOpen(true)}
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
            {sourceChips(false)}
          </div>
          {/* Family chips */}
          {families.length > 0 && (
            <div style={{ display: 'flex', gap: 'var(--sp-1)', flexWrap: 'wrap' }}>
              {familyChips(false)}
            </div>
          )}
        </div>
        </>)}

        {/* Error */}
        {error && !loading && (
          <div style={{ textAlign: 'center', color: 'var(--c-danger)', padding: 'var(--sp-7) 0' }}>
            {error}.{' '}
            <button onClick={refetch} style={{ ...mobileTarget, background: 'none', border: 'none', color: 'var(--c-primary)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 14 }}>
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
              {isMobile
                ? 'Browse what the Cambium community has shared.'
                : 'Add seeds you grow, or browse what the Cambium community has shared.'}
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
              {!isMobile && (
              <button
                onClick={() => setSeedFormOpen(true)}
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
                Add a seed
              </button>
              )}
              <button
                onClick={() => setSource('cambium')}
                style={{
                  ...mobileTarget,
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
          <div style={{ textAlign: 'center', padding: isMobile ? 'var(--sp-7) var(--sp-4)' : 'var(--sp-7) 0', color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)', fontSize: 15 }}>
            No seeds found for &ldquo;{[rawQ, family].filter(Boolean).join(' + ')}&rdquo;. Try a different search or clear the filters.
          </div>
        )}

        {/* Grid (desktop) / one-column list (mobile) */}
        {!loading && !error && cards.length > 0 && (
          <>
            {isMobile ? (
              <ul
                role="list"
                aria-label="Seeds"
                style={{ listStyle: 'none', margin: 0, padding: 0, background: 'var(--c-surface)', borderTop: '1px solid var(--c-border-subtle)' }}
              >
                {cards.map(card => (
                  <SeedListRow
                    key={`${card.kind}-${card.id}`}
                    card={card}
                    onClick={() => handleCardClick(card)}
                  />
                ))}
              </ul>
            ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4" style={{ gap: 'var(--sp-4)' }}>
              {cards.map(card => (
                <SeedCard
                  key={`${card.kind}-${card.id}`}
                  card={card}
                  onClick={() => handleCardClick(card)}
                />
              ))}
            </div>
            )}

            {/* Load more */}
            {hasMore && (
              <div style={{ textAlign: 'center', marginTop: 'var(--sp-6)' }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    ...mobileTarget,
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
          onDetailUpdated={(seed) => {
            setOpenCard(prev =>
              prev ? { ...prev, commonName: seed.commonName, scientificName: seed.scientificName, plantFamily: seed.plantFamily } : prev
            );
            refetch();
          }}
          onDeleted={() => {
            setOpenCard(null);
            refetch();
          }}
        />
      )}

      {isMobile && (
        <BottomSheet open={isMobile && filterSheetOpen} onClose={() => setFilterSheetOpen(false)} title="Filters">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)', padding: 'var(--sp-2) var(--sp-4) var(--sp-5)' }}>
            <section>
              <h3 style={sheetHeadingStyle}>Source</h3>
              <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                {sourceChips(true)}
              </div>
            </section>
            {families.length > 0 && (
              <section>
                <h3 style={sheetHeadingStyle}>Family</h3>
                <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                  {familyChips(true)}
                </div>
              </section>
            )}
          </div>
        </BottomSheet>
      )}

      {/* Add-seed form is desktop-only: never rendered on mobile. */}
      {!isMobile && seedFormOpen && (
        <SeedForm
          mode="add"
          onClose={() => setSeedFormOpen(false)}
          onSaved={(_seed: PersonalSeedDetail) => {
            setSeedFormOpen(false);
            refetch();
            setSource('mine');
          }}
        />
      )}
    </div>
  );
}
