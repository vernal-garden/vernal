// client/src/components/catalogue/SeedDetailOverlay.tsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, patch, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import type {
  BrowseCard,
  CatalogueSeedDetail,
  PersonalSeedDetail,
  PlantingHistoryEntry,
} from '../../types/catalogue';
import IllustrationImage from './IllustrationImage';
import StarRating from './StarRating';
import DataGrid from './DataGrid';
import type { DataGridEntry } from './DataGrid';
import SeedForm from './SeedForm';
import CorrectionModal from './CorrectionModal';
import ContributeModal from './ContributeModal';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sunlightLabel(v: string | null): string | null {
  if (!v) return null;
  return { full_sun: 'Full sun', partial_shade: 'Partial shade', full_shade: 'Full shade' }[v] ?? v;
}

function wateringLabel(v: string | null): string | null {
  if (!v) return null;
  return { low: 'Low', moderate: 'Moderate', high: 'High' }[v] ?? v;
}

function frostLabel(v: string | null): string | null {
  if (!v) return null;
  return { none: 'None', light: 'Light', hard: 'Hard' }[v] ?? v;
}

function rangeStr(min: number | null, max: number | null, unit: string): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min !== max) return `${min}–${max} ${unit}`;
  return `${min ?? max} ${unit}`;
}

function zoneRange(min: string | null, max: string | null): string | null {
  if (!min && !max) return null;
  if (min && max && min !== max) return `${min}–${max}`;
  return min ?? max;
}

// ── Button styles ─────────────────────────────────────────────────────────────

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px 18px',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  border: 'none',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '9px 18px',
  background: 'transparent',
  color: 'var(--c-text-2)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

// ── Shared data-grid builder ──────────────────────────────────────────────────

function buildDataEntries(d: CatalogueSeedDetail | PersonalSeedDetail): DataGridEntry[] {
  return [
    { label: 'Spacing', value: d.spacingInches !== null ? `${d.spacingInches}"` : null },
    { label: 'Row spacing', value: d.rowSpacingInches !== null ? `${d.rowSpacingInches}"` : null },
    { label: 'Planting depth', value: d.plantingDepthInches !== null ? `${d.plantingDepthInches}"` : null },
    { label: 'Maturity', value: rangeStr(d.maturityDaysMin, d.maturityDaysMax, 'days') },
    { label: 'Sunlight', value: sunlightLabel(d.sunlight) },
    { label: 'Watering', value: wateringLabel(d.wateringNeeds) },
    { label: 'Hardiness zone', value: zoneRange(d.hardinessZoneMin, d.hardinessZoneMax) },
    { label: 'Frost tolerance', value: frostLabel(d.frostTolerance) },
    { label: 'Weeks to transplant', value: d.weeksToTransplant },
    { label: 'Succession interval', value: d.successionIntervalWeeks !== null ? `${d.successionIntervalWeeks} wks` : null },
    { label: 'Germination', value: rangeStr(d.germinationDaysMin, d.germinationDaysMax, 'days') },
    { label: 'Germination temp', value: rangeStr(d.germinationTempMinF, d.germinationTempMaxF, '°F') },
  ];
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  card: BrowseCard;
  onClose: () => void;
  onDetailUpdated?: (seed: PersonalSeedDetail) => void;
}

type DetailStatus =
  | { status: 'loading' }
  | { status: 'loaded-community'; detail: CatalogueSeedDetail }
  | { status: 'loaded-personal'; detail: PersonalSeedDetail }
  | { status: 'error'; message: string };

export default function SeedDetailOverlay({ card, onClose, onDetailUpdated }: Props) {
  const { isGuest } = useAuth();
  const navigate = useNavigate();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [detailStatus, setDetailStatus] = useState<DetailStatus>({ status: 'loading' });

  // ── Fetch detail ───────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setDetailStatus({ status: 'loading' });
    if (card.kind === 'community') {
      get<CatalogueSeedDetail>(`/api/catalogue/seeds/${card.id}`)
        .then(d => { if (!cancelled && d) setDetailStatus({ status: 'loaded-community', detail: d }); })
        .catch(() => { if (!cancelled) setDetailStatus({ status: 'error', message: 'Failed to load seed details.' }); });
    } else {
      get<PersonalSeedDetail>(`/api/seeds/${card.id}`)
        .then(d => { if (!cancelled && d) setDetailStatus({ status: 'loaded-personal', detail: d }); })
        .catch(() => { if (!cancelled) setDetailStatus({ status: 'error', message: 'Failed to load seed details.' }); });
    }
    return () => { cancelled = true; };
  }, [card.id, card.kind]);

  // ── Body scroll lock + focus ───────────────────────────────────────────────

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtnRef.current?.focus();
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Escape key ────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // ── Guest prompt helper ────────────────────────────────────────────────────

  function promptAccount() {
    navigate('/register', { state: { intent: 'create-account' } });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px 40px',
        overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <style>{`
        @keyframes catalogue-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          .catalogue-overlay { animation: none !important; }
        }
      `}</style>

      <div
        className="catalogue-overlay"
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          width: '100%',
          maxWidth: 640,
          padding: 'var(--sp-6)',
          position: 'relative',
          fontFamily: 'var(--font-ui)',
          animation: 'catalogue-fade-in 0.18s ease',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={card.commonName}
      >
        {/* Close button */}
        <button
          ref={closeBtnRef}
          onClick={onClose}
          style={{
            position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)',
            background: 'var(--c-surface-raised)', border: 'none',
            borderRadius: 'var(--r-full)', width: 32, height: 32,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: 'var(--c-text-2)',
          }}
          aria-label="Close"
        >
          ✕
        </button>

        {/* Content */}
        {detailStatus.status === 'loading' && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-8)', color: 'var(--c-text-3)' }}>
            Loading…
          </div>
        )}

        {detailStatus.status === 'error' && (
          <div style={{ textAlign: 'center', padding: 'var(--sp-8)', color: 'var(--c-danger)' }}>
            {detailStatus.message}
          </div>
        )}

        {detailStatus.status === 'loaded-community' && (
          <CommunityDetail
            detail={detailStatus.detail}
            isGuest={isGuest}
            onPromptAccount={promptAccount}
            onNavigateToGarden={() => navigate('/')}
          />
        )}

        {detailStatus.status === 'loaded-personal' && (
          <PersonalDetail
            detail={detailStatus.detail}
            isGuest={isGuest}
            onPromptAccount={promptAccount}
            onNavigateToGarden={() => navigate('/')}
            onNavigateToCanvas={(gardenId) => navigate(`/?garden=${gardenId}`)}
            onDetailUpdated={(seed) => {
              setDetailStatus({ status: 'loaded-personal', detail: seed });
              onDetailUpdated?.(seed);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Community detail ──────────────────────────────────────────────────────────

interface CommunityDetailProps {
  detail: CatalogueSeedDetail;
  isGuest: boolean;
  onPromptAccount: () => void;
  onNavigateToGarden: () => void;
}

function CommunityDetail({ detail, isGuest, onPromptAccount, onNavigateToGarden }: CommunityDetailProps) {
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'added' | 'duplicate' | 'error'>('idle');
  const [correctionOpen, setCorrectionOpen] = useState(false);

  async function handleAddToCatalogue() {
    if (isGuest) { onPromptAccount(); return; }
    setImportStatus('loading');
    try {
      await post('/api/seeds/add-from-cambium', { cambiumSeedId: detail.id });
      setImportStatus('added');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setImportStatus('duplicate');
      } else {
        setImportStatus('error');
      }
    }
  }

  const importLabel =
    importStatus === 'added' || importStatus === 'duplicate' ? 'Already in your catalogue' :
    importStatus === 'loading' ? 'Adding…' :
    importStatus === 'error' ? 'Failed — try again' :
    'Add to my catalogue';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
      {/* Hero */}
      <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
        <IllustrationImage illustrationKey={detail.illustrationKey} size={96} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'inline-block', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--c-primary-dark)',
            background: 'var(--c-primary-subtle)', border: '1px solid var(--c-primary-light)',
            borderRadius: 'var(--r-full)', padding: '2px 8px', marginBottom: 'var(--sp-2)',
          }}>
            Cambium
          </span>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
            {detail.commonName}
          </h2>
          {detail.scientificName && (
            <p style={{ margin: '2px 0 0', fontStyle: 'italic', color: 'var(--c-text-2)', fontSize: 14 }}>
              {detail.scientificName}
            </p>
          )}
          <p style={{ margin: '4px 0 0', color: 'var(--c-text-3)', fontSize: 13 }}>
            {detail.plantFamily ?? ''}
          </p>
        </div>
      </div>

      {/* Aggregate rating */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        {detail.aggregateRating !== null ? (
          <>
            <StarRating value={detail.aggregateRating} size={16} />
            <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>
              {detail.aggregateRating.toFixed(1)} ({detail.ratingCount} rating{detail.ratingCount !== 1 ? 's' : ''})
            </span>
          </>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--c-text-3)' }}>No community ratings yet</span>
        )}
      </div>

      {/* Data grid */}
      <DataGrid entries={buildDataEntries(detail)} />

      {/* Companions */}
      {detail.companions.length > 0 && (
        <div>
          <h3 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Companions
          </h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-1)' }}>
            {detail.companions.map(c => (
              <span key={c.seed.id} style={{
                fontSize: 13, color: 'var(--c-text-2)',
                background: c.relationship === 'beneficial'
                  ? 'rgba(83,160,68,0.10)'
                  : c.relationship === 'antagonistic'
                    ? 'var(--c-companion-warn-bg)'
                    : 'var(--c-surface-inset)',
                borderRadius: 'var(--r-full)', padding: '3px 10px',
                border: `1px solid ${c.relationship === 'beneficial' ? 'rgba(83,160,68,0.3)' : c.relationship === 'antagonistic' ? 'var(--c-companion-warn)' : 'var(--c-border)'}`,
              }}>
                {c.seed.commonName}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', paddingTop: 'var(--sp-2)', borderTop: '1px solid var(--c-border-subtle)' }}>
        <button style={primaryBtnStyle} onClick={onNavigateToGarden}>Add to Garden</button>
        <button
          style={{
            ...secondaryBtnStyle,
            opacity: importStatus === 'loading' ? 0.6 : 1,
            background: (importStatus === 'added' || importStatus === 'duplicate') ? 'var(--c-success-bg)' : undefined,
            color: (importStatus === 'added' || importStatus === 'duplicate') ? 'var(--c-success)' : undefined,
            borderColor: (importStatus === 'added' || importStatus === 'duplicate') ? 'var(--c-success)' : undefined,
          }}
          onClick={handleAddToCatalogue}
          disabled={importStatus === 'loading' || importStatus === 'added' || importStatus === 'duplicate'}
        >
          {importLabel}
        </button>
        <button
          style={secondaryBtnStyle}
          onClick={() => {
            if (isGuest) { onPromptAccount(); return; }
            setCorrectionOpen(true);
          }}
        >
          Suggest a correction
        </button>
      </div>
      {correctionOpen && (
        <CorrectionModal
          cambiumSeedId={detail.id}
          seedName={detail.commonName}
          onClose={() => setCorrectionOpen(false)}
        />
      )}
    </div>
  );
}

// ── Personal detail ───────────────────────────────────────────────────────────

interface PersonalDetailProps {
  detail: PersonalSeedDetail;
  isGuest: boolean;
  onPromptAccount: () => void;
  onNavigateToGarden: () => void;
  onNavigateToCanvas: (gardenId: string) => void;
  onDetailUpdated: (seed: PersonalSeedDetail) => void;
}

function PersonalDetail({ detail, isGuest, onPromptAccount, onNavigateToGarden, onNavigateToCanvas, onDetailUpdated }: PersonalDetailProps) {
  const [localRating, setLocalRating] = useState<number | null>(detail.userRating);
  const [localFav, setLocalFav] = useState(detail.isFavourite);
  const [notes, setNotes] = useState(detail.userNotes ?? '');
  const [notesSaved, setNotesSaved] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [contributeOpen, setContributeOpen] = useState(false);
  const [contributionStatus, setContributionStatus] = useState(detail.contributionStatus);

  async function handleRating(rating: number | null) {
    if (isGuest) { onPromptAccount(); return; }
    const prev = localRating;
    setLocalRating(rating);
    try {
      await patch(`/api/seeds/${detail.id}`, { userRating: rating });
    } catch {
      setLocalRating(prev);
      setPatchError('Failed to save rating');
    }
  }

  async function handleFav() {
    if (isGuest) { onPromptAccount(); return; }
    const next = !localFav;
    setLocalFav(next);
    try {
      await patch(`/api/seeds/${detail.id}`, { isFavourite: next });
    } catch {
      setLocalFav(!next);
      setPatchError('Failed to save');
    }
  }

  async function handleNotesBlur() {
    if (isGuest) return;
    const trimmed = notes.trim() || null;
    if (trimmed === (detail.userNotes?.trim() || null)) return; // no change, skip PATCH
    try {
      await patch(`/api/seeds/${detail.id}`, { userNotes: trimmed });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2200);
    } catch {
      setPatchError('Failed to save notes');
    }
  }

  const visibleHistory = historyExpanded ? detail.plantingHistory : detail.plantingHistory.slice(0, 5);
  const isCambiumImport = !!detail.cambiumSourceId;

  const canContribute =
    detail.origin === 'user_created' &&
    (contributionStatus === 'private' || contributionStatus === 'rejected');
  const contributionStatusLabel: Record<string, string> = {
    pending: 'Contribution pending review',
    published: 'Contributed to Cambium',
    rejected: 'Contribution returned',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
      {/* Hero */}
      <div style={{ display: 'flex', gap: 'var(--sp-4)', alignItems: 'flex-start' }}>
        <IllustrationImage illustrationKey={detail.illustrationKey} size={96} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {isCambiumImport && (
            <span style={{ fontSize: 11, color: 'var(--c-text-3)', display: 'block', marginBottom: 'var(--sp-1)' }}>
              Originally from Cambium
            </span>
          )}
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
            {detail.commonName}
          </h2>
          {detail.scientificName && (
            <p style={{ margin: '2px 0 0', fontStyle: 'italic', color: 'var(--c-text-2)', fontSize: 14 }}>
              {detail.scientificName}
            </p>
          )}
          <p style={{ margin: '4px 0 0', color: 'var(--c-text-3)', fontSize: 13 }}>
            {detail.plantFamily ?? ''}
          </p>
        </div>
      </div>

      {/* Rating + favourite */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
        <StarRating
          value={localRating}
          interactive
          onChange={handleRating}
          size={20}
          label="Your rating"
        />
        <button
          onClick={handleFav}
          aria-label={localFav ? 'Remove from favourites' : 'Add to favourites'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: localFav ? 'var(--c-secondary)' : 'var(--c-border)',
            padding: 0,
          }}
        >
          {localFav ? '♥' : '♡'}
        </button>
      </div>

      {patchError && (
        <p style={{ color: 'var(--c-danger)', fontSize: 13, margin: 0 }}>{patchError}</p>
      )}

      {/* Data grid */}
      <DataGrid entries={buildDataEntries(detail)} />

      {/* My Notes */}
      <div>
        <label htmlFor={`seed-notes-${detail.id}`} style={{
          display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--c-text-3)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 'var(--sp-2)',
        }}>
          My Notes
          {notesSaved && <span style={{ color: 'var(--c-success)', fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>Saved</span>}
        </label>
        <textarea
          id={`seed-notes-${detail.id}`}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={handleNotesBlur}
          placeholder="Add notes about this seed…"
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box',
            fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text)',
            background: 'var(--c-surface-inset)', border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-md)', padding: 'var(--sp-3)',
            resize: 'vertical', outline: 'none',
          }}
        />
      </div>

      {/* Planting history */}
      <div>
        <h3 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Planting History
        </h3>
        {detail.plantingHistory.length === 0 ? (
          <p style={{ fontSize: 14, color: 'var(--c-text-3)', margin: 0 }}>You haven't planted this one yet.</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
              {visibleHistory.map((h: PlantingHistoryEntry) => (
                <button
                  key={h.plantingId}
                  onClick={() => onNavigateToCanvas(h.gardenId)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: 'var(--sp-2) var(--sp-3)',
                    background: 'var(--c-surface-raised)', borderRadius: 'var(--r-md)',
                    border: '1px solid var(--c-border-subtle)',
                    cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-2)',
                    textAlign: 'left',
                  }}
                >
                  <span>{h.gardenName} — {h.bedLabel} (Season {h.season})</span>
                  {h.harvestLogged && <span style={{ fontSize: 11, color: 'var(--c-success)' }}>Harvested</span>}
                </button>
              ))}
            </div>
            {detail.plantingHistory.length > 5 && (
              <button
                onClick={() => setHistoryExpanded(e => !e)}
                style={{ marginTop: 'var(--sp-2)', background: 'none', border: 'none', color: 'var(--c-primary)', cursor: 'pointer', fontSize: 13, padding: 0 }}
              >
                {historyExpanded ? 'Show less' : `Show all ${detail.plantingHistory.length}`}
              </button>
            )}
          </>
        )}
      </div>

      {/* My Photos stub */}
      <div style={{ background: 'var(--c-surface-raised)', borderRadius: 'var(--r-md)', padding: 'var(--sp-4)', textAlign: 'center', border: '1px dashed var(--c-border)' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
          Photo uploads coming soon.
        </p>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', paddingTop: 'var(--sp-2)', borderTop: '1px solid var(--c-border-subtle)' }}>
        <button style={primaryBtnStyle} onClick={onNavigateToGarden}>Add to Garden</button>
        <button
          style={secondaryBtnStyle}
          onClick={() => {
            if (isGuest) { onPromptAccount(); return; }
            setEditOpen(true);
          }}
        >
          Edit
        </button>
        {canContribute && (
          <button
            style={secondaryBtnStyle}
            onClick={() => {
              if (isGuest) { onPromptAccount(); return; }
              setContributeOpen(true);
            }}
          >
            Contribute
          </button>
        )}
        {!canContribute && detail.origin === 'user_created' && contributionStatusLabel[contributionStatus] !== undefined && (
          <span style={{ fontSize: 13, color: 'var(--c-text-3)', alignSelf: 'center', padding: '0 var(--sp-2)' }}>
            {contributionStatusLabel[contributionStatus]}
          </span>
        )}
      </div>
      {editOpen && (
        <SeedForm
          mode="edit"
          initialSeed={detail}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            try {
              const fresh = await get<PersonalSeedDetail>(`/api/seeds/${detail.id}`);
              if (fresh) onDetailUpdated(fresh);
            } catch {
              // re-fetch failed; overlay closes, user can reopen for fresh data
            }
          }}
        />
      )}
      {contributeOpen && (
        <ContributeModal
          seed={detail}
          onClose={() => setContributeOpen(false)}
          onContributed={() => setContributionStatus('pending')}
        />
      )}
    </div>
  );
}
