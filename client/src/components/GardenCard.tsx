import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GardenSummary } from '../hooks/useGardenList';

const METHOD_LABELS: Record<string, string> = {
  square_foot: 'Square foot',
  container:   'Container',
  raised_bed:  'Raised bed',
  in_ground:   'In-ground',
};

// Deterministic colour per growingMethod for the fallback thumbnail
const FALLBACK_COLOURS: Record<string, string> = {
  square_foot: '#D8EBD5',
  raised_bed:  '#EDE0D2',
  container:   '#E0EEF5',
  in_ground:   '#E5E0D7',
};

interface Props {
  garden: GardenSummary;
  onRename: (id: string, newName: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export default function GardenCard({ garden, onRename, onDelete }: Props) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(garden.name);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function onOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [menuOpen]);

  // Focus rename input when opened
  useEffect(() => {
    if (renaming) {
      setRenameValue(garden.name);
      setRenameError(null);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [renaming, garden.name]);

  // Scroll-lock + Escape for rename modal
  useEffect(() => {
    if (!renaming) return;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setRenaming(false); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [renaming]);

  // Scroll-lock + Escape for delete modal
  useEffect(() => {
    if (!confirmingDelete) return;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setConfirmingDelete(false); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [confirmingDelete]);

  function handleCardClick(e: React.MouseEvent) {
    // Don't navigate when interacting with the menu or its children
    if ((e.target as HTMLElement).closest('[data-garden-menu]')) return;
    navigate(`/?garden=${garden.id}`);
  }

  async function handleRenameSubmit() {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === garden.name) { setRenaming(false); return; }
    setRenameLoading(true);
    setRenameError(null);
    try {
      await onRename(garden.id, trimmed);
      setRenaming(false);
    } catch {
      setRenameError('Failed to rename. Please try again.');
    } finally {
      setRenameLoading(false);
    }
  }

  async function handleDeleteConfirm() {
    setDeleteLoading(true);
    try {
      await onDelete(garden.id);
    } finally {
      setDeleteLoading(false);
      setConfirmingDelete(false);
    }
  }

  const fallbackBg = FALLBACK_COLOURS[garden.growingMethod] ?? 'var(--c-surface-raised)';

  return (
    <>
      {/* Card */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${garden.name}`}
        onClick={handleCardClick}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(e as unknown as React.MouseEvent); } }}
        style={{
          background: 'var(--c-surface)',
          border: '1px solid var(--c-border-subtle)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-sm)',
          overflow: 'hidden',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          transition: 'box-shadow 0.15s, transform 0.1s',
          userSelect: 'none',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-md)';
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLDivElement).style.boxShadow = 'var(--shadow-sm)';
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0)';
        }}
        onMouseDown={e => {
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0) scale(0.99)';
        }}
        onMouseUp={e => {
          (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
        }}
      >
        {/* Thumbnail area ~60% */}
        <div style={{
          height: 160,
          background: garden.thumbnailUrl ? undefined : fallbackBg,
          position: 'relative',
          flexShrink: 0,
        }}>
          {garden.thumbnailUrl ? (
            <img
              src={garden.thumbnailUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              opacity: 0.35,
            }}>
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                <rect x="6" y="18" width="36" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
                <path d="M14 18V14a10 10 0 0 1 20 0v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
          )}
        </div>

        {/* Info strip ~40% */}
        <div style={{ padding: 'var(--sp-3) var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)' }}>
            {/* Name */}
            <span style={{
              fontFamily: 'var(--font-display)',
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--c-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {garden.name}
            </span>

            {/* Overflow menu */}
            <div data-garden-menu style={{ position: 'relative', flexShrink: 0 }} ref={menuRef}>
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
                style={{
                  width: 28, height: 28, borderRadius: 'var(--r-sm)',
                  border: '1px solid transparent', background: 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', color: 'var(--c-text-3)',
                  transition: 'background 0.12s, color 0.12s',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--c-surface-inset)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--c-text)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--c-text-3)';
                }}
                aria-label="Garden options"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="3" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="13" r="1.2"/>
                </svg>
              </button>

              {menuOpen && (
                <div style={{
                  position: 'absolute', top: 32, right: 0, zIndex: 20,
                  background: 'var(--c-surface)', border: '1px solid var(--c-border)',
                  borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)',
                  minWidth: 140, overflow: 'hidden',
                }}>
                  <button
                    onClick={e => { e.stopPropagation(); setMenuOpen(false); setRenaming(true); }}
                    style={{
                      width: '100%', textAlign: 'left', padding: 'var(--sp-2) var(--sp-3)',
                      fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text)',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      display: 'block',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--c-primary-subtle)'}
                    onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
                  >
                    Rename
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); setMenuOpen(false); setConfirmingDelete(true); }}
                    style={{
                      width: '100%', textAlign: 'left', padding: 'var(--sp-2) var(--sp-3)',
                      fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-danger)',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      display: 'block',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = 'var(--c-danger-bg)'}
                    onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = 'transparent'}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Method + plant count */}
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--c-text-2)', display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <span>{METHOD_LABELS[garden.growingMethod] ?? garden.growingMethod}</span>
            <span style={{ color: 'var(--c-border)' }}>·</span>
            <span>{garden.activePlantingCount} {garden.activePlantingCount === 1 ? 'plant' : 'plants'}</span>
          </div>

          {/* Badges */}
          {(garden.harvestableCount > 0 || garden.hasCompanionWarnings) && (
            <div style={{ display: 'flex', gap: 'var(--sp-1)', flexWrap: 'wrap', marginTop: 'var(--sp-1)' }}>
              {garden.harvestableCount > 0 && (
                <span style={{
                  fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
                  padding: '2px 8px', borderRadius: 'var(--r-full)',
                  background: 'var(--c-success-bg)', color: 'var(--c-success)',
                }}>
                  {garden.harvestableCount} ready
                </span>
              )}
              {garden.hasCompanionWarnings && (
                <span style={{
                  fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
                  padding: '2px 8px', borderRadius: 'var(--r-full)',
                  background: 'var(--c-companion-warn-bg)', color: 'var(--c-companion-warn)',
                }}>
                  Companion warning
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Rename modal */}
      {renaming && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setRenaming(false)}
        >
          <div
            role="dialog"
            aria-modal={true}
            aria-label="Rename garden"
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--c-surface)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-5)', width: 360, boxShadow: 'var(--shadow-lg)' }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, color: 'var(--c-text)', marginBottom: 'var(--sp-3)' }}>
              Rename garden
            </div>
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRenameSubmit(); if (e.key === 'Escape') setRenaming(false); }}
              style={{
                width: '100%', padding: 'var(--sp-2) var(--sp-3)', borderRadius: 'var(--r-md)',
                border: '1px solid var(--c-border)', fontFamily: 'var(--font-ui)', fontSize: 14,
                color: 'var(--c-text)', outline: 'none', boxSizing: 'border-box',
              }}
            />
            {renameError && (
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--c-danger)', margin: 'var(--sp-1) 0 0' }}>
                {renameError}
              </p>
            )}
            <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end', marginTop: 'var(--sp-4)' }}>
              <button
                onClick={() => setRenaming(false)}
                style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)', background: 'transparent', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleRenameSubmit}
                disabled={renameLoading || !renameValue.trim()}
                style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: 'none', background: 'var(--c-primary)', color: 'var(--c-text-on-primary)', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer', opacity: renameLoading ? 0.6 : 1 }}
              >
                {renameLoading ? 'Saving\u2026' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmingDelete && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setConfirmingDelete(false)}
        >
          <div
            role="dialog"
            aria-modal={true}
            aria-label="Delete garden"
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--c-surface)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-5)', width: 400, boxShadow: 'var(--shadow-lg)' }}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, color: 'var(--c-text)', marginBottom: 'var(--sp-3)' }}>
              Delete {garden.name}?
            </div>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.6, margin: '0 0 var(--sp-4)' }}>
              This permanently removes the garden, all its beds, and all planting history. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmingDelete(false)}
                style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)', background: 'transparent', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleteLoading}
                style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: 'none', background: 'var(--c-danger)', color: '#fff', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer', opacity: deleteLoading ? 0.6 : 1 }}
              >
                {deleteLoading ? 'Deleting\u2026' : 'Delete garden'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
