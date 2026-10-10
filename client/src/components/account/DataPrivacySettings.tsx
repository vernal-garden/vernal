import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { get, post, del, ApiError } from '../../lib/api';
import { useSignOut } from '../../hooks/useSignOut';
import type { AccountData } from './types';
import {
  cardSt,
  cardTitleSt,
  bodyTextSt,
  inputSt,
  primaryButtonSt,
  secondaryButtonSt,
  dangerButtonSt,
  errorTextSt,
  apiErrorMessage,
} from './settingsStyles';

interface Props {
  account: AccountData;
  onUpdate: (patch: Partial<AccountData>) => void;
}

function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setDeleting(true);
    try {
      await del('/api/me');
      onDeleted();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete your account.'));
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          width: '100%',
          maxWidth: 440,
          padding: 'var(--sp-6)',
          fontFamily: 'var(--font-ui)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm account deletion"
      >
        <h2 style={{ margin: '0 0 var(--sp-3)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
          Delete your account?
        </h2>
        <p style={bodyTextSt}>
          This schedules deletion of your account and all its data in 30 days. Type <strong>delete</strong> to
          confirm.
        </p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          style={{ ...inputSt, marginTop: 'var(--sp-3)' }}
          autoFocus
        />

        {error && <p style={errorTextSt}>{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-5)' }}>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirmText !== 'delete' || deleting}
            style={{ ...dangerButtonSt, opacity: confirmText !== 'delete' || deleting ? 0.5 : 1 }}
          >
            {deleting ? 'Deleting…' : 'Delete account'}
          </button>
          <button type="button" onClick={onClose} disabled={deleting} style={secondaryButtonSt}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

interface ExportJob {
  jobId: number;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  requestedAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
  expiresAt: string | null;
  expired: boolean;
}

interface ExportRequestResult {
  jobId?: number;
  status: 'pending' | 'complete';
  downloadUrl?: string;
  expiresAt?: string;
}

type RequestableKind = 'idle' | 'expired' | 'failed';

type ExportView =
  | { kind: 'loading' }
  | { kind: RequestableKind }
  | { kind: 'requesting'; from: RequestableKind }
  | { kind: 'pending' }
  | { kind: 'complete'; downloadUrl: string; expiresAt: string };

const EXPORT_POLL_MS = 4000;
const tallButton: CSSProperties = { minHeight: 44 };

function viewFromJob(job: ExportJob): ExportView {
  if (job.status === 'pending' || job.status === 'processing') return { kind: 'pending' };
  if (job.status === 'failed') return { kind: 'failed' };
  if (job.expired || !job.downloadUrl || !job.expiresAt) return { kind: 'expired' };
  return { kind: 'complete', downloadUrl: job.downloadUrl, expiresAt: job.expiresAt };
}

const EXPORT_COPY: Record<RequestableKind, { text: string; button: string }> = {
  idle: { text: 'Download a copy of all your Vernal data.', button: 'Request export' },
  expired: { text: 'Your last export has expired.', button: 'Request a new export' },
  failed: { text: "That export didn't finish. Try again.", button: 'Request export' },
};

function ExportDataCard() {
  const [view, setView] = useState<ExportView>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    get<{ data: ExportJob }>('/api/me/export')
      .then((res) => {
        if (!cancelled) setView(res ? viewFromJob(res.data) : { kind: 'idle' });
      })
      .catch((err) => {
        if (cancelled) return;
        if (!(err instanceof ApiError && err.status === 404)) {
          setError(apiErrorMessage(err, 'Could not load your export status.'));
        }
        setView({ kind: 'idle' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isPending = view.kind === 'pending';

  useEffect(() => {
    if (!isPending) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await get<{ data: ExportJob }>('/api/me/export');
        if (cancelled || !res) return;
        const next = viewFromJob(res.data);
        if (next.kind !== 'pending') setView(next);
      } catch {
        // Transient failure — keep polling.
      }
    }, EXPORT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isPending]);

  async function handleRequest(from: RequestableKind) {
    setError(null);
    setView({ kind: 'requesting', from });
    try {
      const res = await post<{ data: ExportRequestResult }>('/api/me/export');
      const result = res?.data;
      if (result?.status === 'complete' && result.downloadUrl && result.expiresAt) {
        setView({ kind: 'complete', downloadUrl: result.downloadUrl, expiresAt: result.expiresAt });
      } else {
        setView({ kind: 'pending' });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setView({ kind: 'pending' });
        return;
      }
      setError(apiErrorMessage(err, 'Could not start your export.'));
      setView({ kind: from });
    }
  }

  let body: ReactNode = null;

  if (view.kind === 'idle' || view.kind === 'expired' || view.kind === 'failed' || view.kind === 'requesting') {
    const from = view.kind === 'requesting' ? view.from : view.kind;
    const requesting = view.kind === 'requesting';
    body = (
      <>
        <p style={bodyTextSt}>{EXPORT_COPY[from].text}</p>
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <button
            type="button"
            onClick={() => handleRequest(from)}
            disabled={requesting}
            style={{ ...primaryButtonSt, ...tallButton, opacity: requesting ? 0.6 : 1 }}
          >
            {requesting ? 'Requesting…' : EXPORT_COPY[from].button}
          </button>
        </div>
      </>
    );
  } else if (view.kind === 'pending') {
    body = (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <div
          aria-hidden="true"
          style={{
            flexShrink: 0,
            width: 18,
            height: 18,
            border: '2px solid var(--c-primary-light)',
            borderTopColor: 'var(--c-primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <p style={bodyTextSt}>Preparing your export… this usually takes under a minute.</p>
      </div>
    );
  } else if (view.kind === 'complete') {
    const expires = new Date(view.expiresAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    body = (
      <>
        <p style={bodyTextSt}>Your export is ready.</p>
        <div style={{ marginTop: 'var(--sp-3)', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => window.open(view.downloadUrl, '_blank', 'noopener,noreferrer')}
            style={{ ...primaryButtonSt, ...tallButton }}
          >
            Download
          </button>
          <span style={{ ...bodyTextSt, fontSize: 13 }}>Link expires {expires}</span>
        </div>
      </>
    );
  }

  return (
    <div style={cardSt}>
      <h3 style={cardTitleSt}>Export your data</h3>
      {body}
      {error && <p style={errorTextSt}>{error}</p>}
    </div>
  );
}

export default function DataPrivacySettings({ account, onUpdate }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = useSignOut();

  async function handleCancelDeletion() {
    setError(null);
    setCancelling(true);
    try {
      await post('/api/me/cancel-deletion');
      onUpdate({ deletionScheduledAt: null });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not cancel deletion.'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section>
      <h2 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
        Data & Privacy
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <ExportDataCard />

        <div style={cardSt}>
          <h3 style={cardTitleSt}>Delete account</h3>

          {account.deletionScheduledAt ? (
            <>
              <p style={bodyTextSt}>
                Your account is scheduled for deletion. This will happen 30 days after you initiated the request.
              </p>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button type="button" onClick={handleCancelDeletion} disabled={cancelling} style={secondaryButtonSt}>
                  {cancelling ? 'Cancelling…' : 'Cancel deletion'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={bodyTextSt}>Permanently delete your account and all of its data.</p>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button type="button" onClick={() => setDialogOpen(true)} style={dangerButtonSt}>
                  Delete account
                </button>
              </div>
            </>
          )}

          {error && <p style={errorTextSt}>{error}</p>}
        </div>
      </div>

      {dialogOpen && (
        <DeleteAccountDialog onClose={() => setDialogOpen(false)} onDeleted={signOut} />
      )}
    </section>
  );
}
