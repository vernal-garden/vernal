import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import { useSignOut } from '../hooks/useSignOut';
import { useSubscription } from '../hooks/useSubscription';
import * as api from '../lib/api';
import BetaScreenLayout, { BETA_HEADING_STYLE } from '../components/BetaScreenLayout';
import BetaTermsCheckbox from '../components/BetaTermsCheckbox';
import TermsCheckbox from '../components/TermsCheckbox';
import { DeleteAccountDialog, ExportDataCard } from '../components/account/DataPrivacySettings';
import { bodyTextSt, cardSt, dangerButtonSt, errorTextSt, secondaryButtonSt } from '../components/account/settingsStyles';
import { BETA_TERMS_COPY } from '../lib/betaCopy';

const NOT_READY_ID = 'beta-terms-not-ready';
const tallButton: CSSProperties = { minHeight: 44 };

// Rendered only while the section is open, so the subscription read waits until then.
function ManageBillingButton({ busy }: { busy: boolean }) {
  const { data } = useSubscription();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleManageBilling() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<{ url: string }>('/api/subscription/portal');
      if (!res?.url) throw new Error('No portal URL returned');
      window.location.href = res.url;
    } catch (e) {
      const message =
        e instanceof api.ApiError && e.status === 400
          ? 'No billing account found. Please subscribe first.'
          : "Couldn't open billing. Please try again.";
      setError(message);
      setLoading(false);
    }
  }

  // A failed read leaves data null too, so the button is simply left out.
  if (!data?.hasCustomer) return null;

  const disabled = busy || loading;
  return (
    <>
      <button
        type="button"
        onClick={() => void handleManageBilling()}
        disabled={disabled}
        style={{ ...secondaryButtonSt, ...tallButton, opacity: disabled ? 0.6 : 1 }}
      >
        {loading ? 'Redirecting…' : data.interval === 'lifetime' ? 'View payment history' : 'Manage billing'}
      </button>
      {error && (
        <p role="alert" style={{ ...errorTextSt, margin: 0 }}>
          {error}
        </p>
      )}
    </>
  );
}

function NotReadySection({ deletionScheduled, busy }: { deletionScheduled: boolean; busy: boolean }) {
  const { billing } = useConfig();
  const signOut = useSignOut();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-4)' }}>
      <p style={bodyTextSt}>{BETA_TERMS_COPY.notReadyBody}</p>

      <div style={{ width: '100%', textAlign: 'left' }}>
        <ExportDataCard />
      </div>

      {/* The portal answers 409 while a deletion is scheduled. */}
      {billing && !deletionScheduled && <ManageBillingButton busy={busy} />}

      {!deletionScheduled && (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={busy}
          style={{ ...dangerButtonSt, ...tallButton, opacity: busy ? 0.6 : 1 }}
        >
          Delete account
        </button>
      )}

      {dialogOpen && <DeleteAccountDialog onClose={() => setDialogOpen(false)} onDeleted={signOut} />}
    </div>
  );
}

export default function BetaTermsPage() {
  const { state, pendingGuestData, refetch } = useAuth();
  const navigate = useNavigate();

  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [notReadyOpen, setNotReadyOpen] = useState(false);
  const busy = submitting || signingOut || cancelling;

  const held = state.kind === 'beta_terms';
  const showForm = held && !pendingGuestData;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (showForm) headingRef.current?.focus();
  }, [showForm]);

  // Only a held account belongs here; '/' sends anyone else where they should be.
  if (state.kind === 'loading') return null;
  if (!held) return <Navigate to="/" replace />;

  // MergePrompt comes first. Sign out stays out of reach until it resolves,
  // because signing out deletes an unmerged guest garden.
  if (!showForm) return <BetaScreenLayout testId="beta-terms">{null}</BetaScreenLayout>;

  const { deletionScheduledAt, termsRequired, termsVersion, betaTermsRequired } = state;

  // One Accept posts whatever is pending, the main Terms first.
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (termsRequired) await api.post('/api/me/terms', { accept: true, version: termsVersion });
      if (betaTermsRequired) await api.post('/api/me/beta-terms', { accept: true });
      await refetch();
      navigate('/', { replace: true });
    } catch (err) {
      // The session ended while the form was up (401), or the Terms changed
      // (409): a refetch moves them on or brings the current version.
      if (err instanceof api.ApiError && (err.status === 401 || err.status === 409)) await refetch().catch(() => {});
      setError(api.apiErrorMessage(err, BETA_TERMS_COPY.failed));
      setSubmitting(false);
    }
  }

  // Not useSignOut: that goes to '/' even after a failed DELETE, and the guard
  // would bring them back here with no word of what happened. Success ends on
  // '/', whose guards pick the landing: a fresh guest session, or the
  // private-beta screen while guest mode is off.
  async function handleSignOut() {
    setSigningOut(true);
    setError('');
    try {
      await api.del('/api/auth/session');
      await refetch();
      navigate('/', { replace: true });
    } catch {
      setError(BETA_TERMS_COPY.failed);
      setSigningOut(false);
    }
  }

  async function handleCancelDeletion() {
    setCancelError('');
    setCancelling(true);
    try {
      await api.post('/api/me/cancel-deletion');
    } catch (err) {
      // The session ended while the form was up; the guard above moves them on.
      if (err instanceof api.ApiError && err.status === 401) await refetch().catch(() => {});
      setCancelError(api.apiErrorMessage(err, 'Could not cancel deletion.'));
      setCancelling(false);
      return;
    }
    try {
      await refetch();
      // The button that had focus is gone with the notice.
      headingRef.current?.focus();
    } catch {
      // The cancel succeeded; the next session refetch will catch up.
    }
    setCancelling(false);
  }

  return (
    <BetaScreenLayout testId="beta-terms">
      <h1 ref={headingRef} tabIndex={-1} style={BETA_HEADING_STYLE}>
        {termsRequired && !betaTermsRequired ? BETA_TERMS_COPY.termsHeading : BETA_TERMS_COPY.heading}
      </h1>

      {termsRequired && <p style={bodyTextSt}>{BETA_TERMS_COPY.termsBody}</p>}

      {deletionScheduledAt && (
        <div style={{ ...cardSt, width: '100%', boxSizing: 'border-box', textAlign: 'left' }}>
          <p style={bodyTextSt}>
            Your account is scheduled for deletion. This will happen 30 days after you initiated the request.
          </p>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <button
              type="button"
              onClick={() => void handleCancelDeletion()}
              disabled={busy}
              style={{ ...secondaryButtonSt, ...tallButton, opacity: busy ? 0.6 : 1 }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel deletion'}
            </button>
          </div>
          {cancelError && (
            <p role="alert" style={errorTextSt}>
              {cancelError}
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-4)', width: '100%' }}
      >
        {termsRequired && <TermsCheckbox />}
        {betaTermsRequired && <BetaTermsCheckbox />}

        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 14, color: 'var(--c-danger)' }}>
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className="vernal-beta-primary" style={{ opacity: busy ? 0.6 : 1 }}>
          {submitting ? BETA_TERMS_COPY.continuing : BETA_TERMS_COPY.continue}
        </button>
      </form>

      <button type="button" onClick={() => void handleSignOut()} disabled={busy} className="vernal-beta-link">
        {BETA_TERMS_COPY.signOut}
      </button>

      <button
        type="button"
        onClick={() => setNotReadyOpen((open) => !open)}
        disabled={busy}
        aria-expanded={notReadyOpen}
        aria-controls={NOT_READY_ID}
        className="vernal-beta-link"
      >
        {BETA_TERMS_COPY.notReady}
      </button>

      <div id={NOT_READY_ID} hidden={!notReadyOpen} style={{ width: '100%' }}>
        {notReadyOpen && <NotReadySection deletionScheduled={deletionScheduledAt !== null} busy={busy} />}
      </div>
    </BetaScreenLayout>
  );
}
