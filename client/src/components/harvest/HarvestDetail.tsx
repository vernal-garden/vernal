import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { MONTH_LONG, parseDay } from '../../lib/guideDates';
import { deleteHarvest, formatQuantity, getHarvest, seedParamOf } from '../../hooks/useHarvests';
import type { HarvestEntry, HarvestPhoto } from '../../types/harvest';
import { CloseIcon } from '../shell/icons';
import DeleteHarvestDialog from './DeleteHarvestDialog';
import {
  iconButtonStyle,
  linkStyle,
  secondaryTextStyle,
  spinnerStyle,
  textButtonStyle,
} from './formStyles';

interface Props {
  entryId: string;
  isMobile: boolean;
  // Bumped by the page after an edit so the detail refetches.
  version: number;
  // The list's filter query, kept on links back to /harvest.
  listSearch: string;
  onEdit: () => void;
  onDeleted: (entryId: string) => void;
}

export function formatLongDate(key: string): string {
  const { y, m, d } = parseDay(key);
  return `${MONTH_LONG[m - 1]} ${d}, ${y}`;
}

export default function HarvestDetail({ entryId, isMobile, version, listSearch, onEdit, onDeleted }: Props) {
  const [entry, setEntry] = useState<HarvestEntry | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    getHarvest(entryId)
      .then((e) => {
        if (cancelled) return;
        setEntry(e);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setEntry(null);
        setState(err instanceof ApiError && (err.status === 404 || err.status === 400) ? 'missing' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, version, reloadKey]);

  // Close the overflow menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const padding = isMobile ? 'var(--sp-4)' : 'var(--sp-5) var(--sp-6)';

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-8) 0' }}>
        <div style={spinnerStyle} />
      </div>
    );
  }

  if (state === 'missing' || state === 'error' || !entry) {
    return (
      <div style={{ padding, fontFamily: 'var(--font-ui)' }}>
        <p style={{ margin: '0 0 var(--sp-2)', fontSize: 15, color: 'var(--c-text-2)' }}>
          {state === 'missing' ? "This harvest entry wasn't found." : "Couldn't load this harvest."}
        </p>
        {state === 'error' ? (
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={textButtonStyle}>Retry</button>
        ) : (
          <Link to={`/harvest${listSearch}`} style={linkStyle}>Back to your harvest log</Link>
        )}
      </div>
    );
  }

  const quantity = formatQuantity(entry.quantity, entry.unit);
  const where = [entry.gardenName, entry.bedId ? entry.bedLabel?.trim() || 'Unnamed bed' : null].filter(Boolean).join(' · ');

  return (
    <article style={{ padding, fontFamily: 'var(--font-ui)', color: 'var(--c-text)' }}>
      {isMobile && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-2)' }}>
          <button type="button" onClick={onEdit} style={textButtonStyle}>Edit</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600 }}>
            {entry.commonName ?? 'Unnamed plant'}
          </h2>
          {entry.scientificName && (
            <div style={{ ...secondaryTextStyle, fontSize: 14, fontStyle: 'italic', marginTop: 2 }}>{entry.scientificName}</div>
          )}
        </div>
        {!isMobile && (
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              style={iconButtonStyle}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  zIndex: 20,
                  minWidth: 160,
                  padding: 'var(--sp-1) 0',
                  background: 'var(--c-surface)',
                  border: '1px solid var(--c-border)',
                  borderRadius: 'var(--r-md)',
                  boxShadow: 'var(--shadow-md)',
                }}
              >
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEdit(); }} style={menuItemStyle}>
                  Edit
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}
                  style={{ ...menuItemStyle, color: 'var(--c-danger)' }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <dl style={{ margin: 'var(--sp-4) 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--sp-2) var(--sp-4)', fontSize: 15 }}>
        <dt style={dtStyle}>Where</dt>
        <dd style={ddStyle}>{where}</dd>
        <dt style={dtStyle}>Date</dt>
        <dd style={ddStyle}>{formatLongDate(entry.harvestDate)}</dd>
        {quantity && (
          <>
            <dt style={dtStyle}>Quantity</dt>
            <dd style={ddStyle}>{quantity}</dd>
          </>
        )}
        {entry.qualityRating !== null && (
          <>
            <dt style={dtStyle}>Quality</dt>
            <dd style={ddStyle}>
              <span role="img" aria-label={`${entry.qualityRating} of 5 stars`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} aria-hidden="true" style={{ color: n <= entry.qualityRating! ? 'var(--c-warning)' : 'var(--c-border)', fontSize: 18 }}>★</span>
                ))}
              </span>
            </dd>
          </>
        )}
      </dl>

      {entry.notes && (
        <p data-testid="harvest-notes" style={{ margin: 'var(--sp-4) 0 0', whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.6 }}>
          {entry.notes}
        </p>
      )}

      {entry.photos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
          {entry.photos.map((p, i) => (
            <button
              key={p.key}
              type="button"
              aria-label={`Open photo ${i + 1}`}
              onClick={() => setViewerIndex(i)}
              style={{ width: 96, height: 96, padding: 0, border: 'none', borderRadius: 'var(--r-md)', overflow: 'hidden', cursor: 'zoom-in' }}
            >
              <img src={p.url} alt="" style={{ width: 96, height: 96, objectFit: 'cover', display: 'block' }} />
            </button>
          ))}
        </div>
      )}

      {entry.sowingEventId && (
        <div
          style={{
            marginTop: 'var(--sp-5)',
            padding: 'var(--sp-3) var(--sp-4)',
            background: 'var(--c-primary-subtle)',
            borderRadius: 'var(--r-md)',
          }}
        >
          <div style={{ fontSize: 14, color: 'var(--c-text-2)' }}>Linked to this season&rsquo;s sowing</div>
          <Link to={`/guide?open=${seedParamOf(entry)}&season=${entry.season}`} style={linkStyle}>
            View in planting guide
          </Link>
        </div>
      )}

      {viewerIndex !== null && (
        <PhotoViewer photos={entry.photos} index={viewerIndex} onIndex={setViewerIndex} onClose={() => setViewerIndex(null)} />
      )}

      {confirmDelete && (
        <DeleteHarvestDialog
          isMobile={isMobile}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await deleteHarvest(entry.id);
            setConfirmDelete(false);
            onDeleted(entry.id);
          }}
        />
      )}
    </article>
  );
}

const dtStyle: CSSProperties = { color: 'var(--c-text-3)', fontSize: 13, fontWeight: 600, paddingTop: 2 };
const ddStyle: CSSProperties = { margin: 0 };

const menuItemStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: 44,
  padding: '0 var(--sp-4)',
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text)',
  cursor: 'pointer',
};

function PhotoViewer({
  photos, index, onIndex, onClose,
}: { photos: HarvestPhoto[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const stateRef = useRef({ index, onIndex, onClose, count: photos.length });
  stateRef.current = { index, onIndex, onClose, count: photos.length };

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      const s = stateRef.current;
      if (e.key === 'Escape') {
        e.stopPropagation();
        s.onClose();
      } else if (e.key === 'ArrowLeft' && s.index > 0) s.onIndex(s.index - 1);
      else if (e.key === 'ArrowRight' && s.index < s.count - 1) s.onIndex(s.index + 1);
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  const navButton: CSSProperties = {
    ...iconButtonStyle,
    color: 'var(--c-text-on-primary)',
    fontSize: 32,
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${photos.length}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'var(--c-text)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
      }}
    >
      <img
        src={photos[index].url}
        alt=""
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
      />
      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{ ...navButton, position: 'absolute', top: 'calc(env(safe-area-inset-top) + 8px)', right: 8 }}
      >
        <CloseIcon />
      </button>
      {index > 0 && (
        <button
          type="button"
          aria-label="Previous photo"
          onClick={() => onIndex(index - 1)}
          style={{ ...navButton, position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}
        >
          ‹
        </button>
      )}
      {index < photos.length - 1 && (
        <button
          type="button"
          aria-label="Next photo"
          onClick={() => onIndex(index + 1)}
          style={{ ...navButton, position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)' }}
        >
          ›
        </button>
      )}
    </div>,
    document.body,
  );
}
