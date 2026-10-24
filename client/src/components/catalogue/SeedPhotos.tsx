// client/src/components/catalogue/SeedPhotos.tsx
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, postBlob, patch, del, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { compressImage } from '../../lib/imageCompress';
import type { SeedPhoto } from '../../types/catalogue';

const MAX_PHOTOS = 3;
const MAX_NOTES = 500;
const THUMB = 96;

interface Props {
  seedId: string;
  onCountChange: (count: number) => void;
}

type LoadState = 'loading' | 'error' | 'ready';

// ── Shared styles ─────────────────────────────────────────────────────────────

const headingStyle: React.CSSProperties = {
  margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
  color: 'var(--c-text-3)', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const tileStyle: React.CSSProperties = {
  width: THUMB, height: THUMB, flexShrink: 0,
  borderRadius: 'var(--r-md)', border: '1px solid var(--c-border-subtle)',
  background: 'var(--c-surface-inset)', padding: 0, overflow: 'hidden',
};

const textBtnStyle: React.CSSProperties = {
  minHeight: 44, padding: '0 var(--sp-4)',
  background: 'transparent', color: 'var(--c-text-2)',
  border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
};

const primarySmallBtnStyle: React.CSSProperties = {
  ...textBtnStyle,
  background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
  border: 'none', fontWeight: 600,
};

const iconBtnStyle: React.CSSProperties = {
  width: 44, height: 44, flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', borderRadius: 'var(--r-full)',
  cursor: 'pointer', fontSize: 18, padding: 0,
};

const spinnerStyle: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 'var(--r-full)',
  border: '3px solid var(--c-border)', borderTopColor: 'var(--c-primary)',
  animation: 'spin 0.8s linear infinite',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function SeedPhotos({ seedId, onCountChange }: Props) {
  const { isGuest, account } = useAuth();
  const navigate = useNavigate();
  const isSupporter = account?.subscriptionTier === 'supporter';

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [photos, setPhotos] = useState<SeedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep the latest callback without re-running effects when the parent re-renders.
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;

  useEffect(() => {
    if (isGuest) return;
    let cancelled = false;
    setLoadState('loading');
    get<{ photos: SeedPhoto[] }>(`/api/seeds/${seedId}/photos`)
      .then(d => {
        if (cancelled) return;
        setPhotos(d?.photos ?? []);
        setLoadState('ready');
      })
      .catch(() => { if (!cancelled) setLoadState('error'); });
    return () => { cancelled = true; };
  }, [seedId, isGuest, reloadKey]);

  useEffect(() => {
    if (loadState === 'ready') onCountChangeRef.current(photos.length);
  }, [photos.length, loadState]);

  if (isGuest) return null;

  function handleAdd() {
    setUploadError(null);
    if (!isSupporter) { setUpsellOpen(true); return; }
    fileInputRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after a failure
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      let blob: Blob;
      try {
        blob = await compressImage(file);
      } catch {
        setUploadError("That photo couldn't be read.");
        return;
      }

      const photo = await postBlob<SeedPhoto>(`/api/seeds/${seedId}/photos`, blob, {
        'Content-Type': 'image/jpeg',
      });
      if (photo) setPhotos(prev => [photo, ...prev]);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 400 || err.status === 409)) {
        const msg = (err.body as { error?: string } | null)?.error;
        setUploadError(msg ?? 'Upload failed. Try again.');
      } else if (err instanceof ApiError && err.status === 503) {
        const msg = (err.body as { error?: string } | null)?.error;
        setUploadError(msg ?? "Photo storage isn't available right now.");
      } else {
        setUploadError('Upload failed. Try again.');
      }
    } finally {
      setUploading(false);
    }
  }

  const canAddMore = photos.length < MAX_PHOTOS && !uploading;
  const showStrip = photos.length > 0 || uploading;

  return (
    <div>
      <style>{`
        @keyframes seed-photo-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }
        @keyframes seed-photo-viewer-in { from { opacity: 0; transform: scale(0.92) } to { opacity: 1; transform: scale(1) } }
        .seed-photo-skeleton { animation: seed-photo-pulse 1.4s ease-in-out infinite; }
        .seed-photo-viewer { animation: seed-photo-viewer-in 250ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .seed-photo-skeleton, .seed-photo-viewer { animation: none !important; }
        }
      `}</style>

      <h3 style={headingStyle}>My Photos</h3>

      {loadState === 'loading' && (
        <div style={{ display: 'flex', gap: 'var(--sp-2)' }} aria-busy="true" aria-label="Loading photos">
          {[0, 1, 2].map(i => (
            <div key={i} className="seed-photo-skeleton" style={{ ...tileStyle, border: 'none' }} />
          ))}
        </div>
      )}

      {loadState === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-3)' }}>Couldn't load your photos.</p>
          <button type="button" style={textBtnStyle} onClick={() => setReloadKey(k => k + 1)}>
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && (
        <>
          {showStrip ? (
            <div style={{ display: 'flex', gap: 'var(--sp-2)', overflowX: 'auto', paddingBottom: 'var(--sp-1)' }}>
              {photos.map((p, i) => (
                <div key={p.id} style={{ width: THUMB, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setViewerIndex(i)}
                    aria-label={p.notes ? `View photo: ${p.notes}` : `View photo ${i + 1}`}
                    style={{ ...tileStyle, cursor: 'pointer', display: 'block' }}
                  >
                    <img
                      src={p.url}
                      alt=""
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </button>
                  {p.notes && (
                    <p style={{
                      margin: 'var(--sp-1) 0 0', fontSize: 12, color: 'var(--c-text-2)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {p.notes}
                    </p>
                  )}
                </div>
              ))}
              {uploading && (
                <div style={{ ...tileStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }} role="status" aria-label="Uploading photo">
                  <div style={spinnerStyle} />
                </div>
              )}
              {canAddMore && (
                <button
                  type="button"
                  onClick={handleAdd}
                  aria-label="Add photo"
                  style={{
                    ...tileStyle, cursor: 'pointer', background: 'var(--c-surface-raised)',
                    border: '1px dashed var(--c-border)', color: 'var(--c-text-3)', fontSize: 28,
                  }}
                >
                  +
                </button>
              )}
            </div>
          ) : (
            <button type="button" style={textBtnStyle} onClick={handleAdd}>
              Add a photo
            </button>
          )}

          {uploadError && (
            <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
              {uploadError}
            </p>
          )}

          {upsellOpen && (
            <div style={{
              marginTop: 'var(--sp-2)', display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)',
              background: 'var(--c-surface-raised)', border: '1px solid var(--c-border-subtle)',
              borderRadius: 'var(--r-md)', padding: 'var(--sp-3)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: '0 0 var(--sp-2)', fontSize: 14, color: 'var(--c-text-2)' }}>
                  Photos are part of the Supporter tier. Upgrade to add photos to your seeds.
                </p>
                <button type="button" style={primarySmallBtnStyle} onClick={() => navigate('/account')}>
                  Upgrade
                </button>
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setUpsellOpen(false)}
                style={{ ...iconBtnStyle, color: 'var(--c-text-3)' }}
              >
                ✕
              </button>
            </div>
          )}
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        style={{ display: 'none' }}
      />

      {viewerIndex !== null && photos[viewerIndex] && (
        <PhotoViewer
          seedId={seedId}
          photos={photos}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onUpdated={updated => setPhotos(prev => prev.map(p => (p.id === updated.id ? updated : p)))}
          onDeleted={id => {
            setViewerIndex(null);
            setPhotos(prev => prev.filter(p => p.id !== id));
          }}
        />
      )}
    </div>
  );
}

// ── Viewer ────────────────────────────────────────────────────────────────────

interface ViewerProps {
  seedId: string;
  photos: SeedPhoto[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onUpdated: (photo: SeedPhoto) => void;
  onDeleted: (id: string) => void;
}

function PhotoViewer({ seedId, photos, index, onIndexChange, onClose, onUpdated, onDeleted }: ViewerProps) {
  const photo = photos[index];
  const count = photos.length;
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { closeBtnRef.current?.focus(); }, []);

  // Reset per-photo UI when moving between photos.
  useEffect(() => {
    setEditing(false);
    setConfirmingDelete(false);
    setError(null);
  }, [photo.id]);

  // Capture phase so Escape closes only the viewer, not the seed overlay beneath it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  function step(delta: number) {
    onIndexChange((index + delta + count) % count);
  }

  async function saveNote() {
    setBusy(true);
    setError(null);
    try {
      const updated = await patch<SeedPhoto>(`/api/seeds/${seedId}/photos/${photo.id}`, { notes: draft });
      if (updated) onUpdated(updated);
      setEditing(false);
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : undefined;
      setError(msg ?? "Couldn't save the note. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto() {
    setBusy(true);
    setError(null);
    try {
      await del(`/api/seeds/${seedId}/photos/${photo.id}`);
      onDeleted(photo.id);
    } catch {
      setError("Couldn't delete the photo. Try again.");
      setBusy(false);
    }
  }

  const onDark = 'var(--c-text-on-primary)';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'var(--c-text)', color: onDark,
        display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-ui)',
      }}
    >
      <div className="seed-photo-viewer" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--sp-2) var(--sp-3)' }}>
          <span style={{ fontSize: 13 }}>{count > 1 ? `${index + 1} of ${count}` : ''}</span>
          <button
            ref={closeBtnRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ ...iconBtnStyle, color: onDark }}
          >
            ✕
          </button>
        </div>

        {/* Image + nav */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: '0 var(--sp-2)' }}>
          {count > 1 && (
            <button type="button" aria-label="Previous photo" onClick={() => step(-1)} style={{ ...iconBtnStyle, color: onDark, fontSize: 24 }}>
              ‹
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src={photo.url}
              alt={photo.notes ?? 'Seed photo'}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 'var(--r-md)' }}
            />
          </div>
          {count > 1 && (
            <button type="button" aria-label="Next photo" onClick={() => step(1)} style={{ ...iconBtnStyle, color: onDark, fontSize: 24 }}>
              ›
            </button>
          )}
        </div>

        {/* Notes + actions */}
        <div style={{
          background: 'var(--c-surface)', color: 'var(--c-text)',
          padding: 'var(--sp-4)', borderTopLeftRadius: 'var(--r-xl)', borderTopRightRadius: 'var(--r-xl)',
          maxWidth: 640, width: '100%', margin: '0 auto', boxSizing: 'border-box',
        }}>
          {editing ? (
            <>
              <label htmlFor={`photo-note-${photo.id}`} style={{ ...headingStyle, display: 'block' }}>
                Note
              </label>
              <textarea
                id={`photo-note-${photo.id}`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                maxLength={MAX_NOTES}
                rows={3}
                autoFocus
                style={{
                  width: '100%', boxSizing: 'border-box',
                  fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text)',
                  background: 'var(--c-surface-inset)', border: '1px solid var(--c-border)',
                  borderRadius: 'var(--r-md)', padding: 'var(--sp-3)', resize: 'vertical', outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
                <span style={{ fontSize: 12, color: 'var(--c-text-3)', marginRight: 'auto' }}>
                  {draft.length}/{MAX_NOTES}
                </span>
                <button type="button" style={textBtnStyle} onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" style={{ ...primarySmallBtnStyle, opacity: busy ? 0.6 : 1 }} onClick={saveNote} disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : confirmingDelete ? (
            <>
              <p style={{ margin: '0 0 var(--sp-3)', fontSize: 14 }}>Delete this photo? This can't be undone.</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
                <button type="button" style={textBtnStyle} onClick={() => setConfirmingDelete(false)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={deletePhoto}
                  disabled={busy}
                  style={{ ...primarySmallBtnStyle, background: 'var(--c-danger)', opacity: busy ? 0.6 : 1 }}
                >
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: '0 0 var(--sp-3)', fontSize: 14, color: photo.notes ? 'var(--c-text)' : 'var(--c-text-3)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {photo.notes ?? 'No note yet.'}
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                <button
                  type="button"
                  style={textBtnStyle}
                  onClick={() => { setDraft(photo.notes ?? ''); setError(null); setEditing(true); }}
                >
                  Edit note
                </button>
                <button
                  type="button"
                  style={{ ...textBtnStyle, color: 'var(--c-danger)', borderColor: 'var(--c-danger)' }}
                  onClick={() => { setError(null); setConfirmingDelete(true); }}
                >
                  Delete photo
                </button>
              </div>
            </>
          )}
          {error && (
            <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
