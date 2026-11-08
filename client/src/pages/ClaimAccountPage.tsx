import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api';
import { getUrlToken } from '../instrument';
import BetaScreenLayout from '../components/BetaScreenLayout';
import { StepHeading, TakeoverConfirm, TakeoverQuestion } from '../components/TakeoverSteps';
import { TAKEOVER_MISC_COPY, TAKEOVER_REPLACE_COPY } from '../lib/takeoverCopy';
import { googleSignInHref } from '../lib/googleSignIn';

// A Google sign-in held because it matched an account whose address was never
// verified: the callback redirects here with ?token=. The person says whether
// they created that account; only a button press posts.

const INVALID_TAKEOVER = 'This sign-in has expired. Please sign in with Google again.';
const CHANGED = 'The account changed while you were deciding. Please sign in with Google again.';

type Step =
  | { kind: 'loading' }
  | { kind: 'invalid'; message: string }
  // The account changed meanwhile (409): only a fresh Google sign-in can go on.
  | { kind: 'changed'; message: string }
  | { kind: 'question'; email: string }
  | { kind: 'confirm'; email: string };

export default function ClaimAccountPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { refetch } = useAuth();
  // Read once, then drop it from the address bar (history, Sentry).
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  const [step, setStep] = useState<Step>(() =>
    token ? { kind: 'loading' } : { kind: 'invalid', message: INVALID_TAKEOVER },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // A POST so the token stays out of URLs and logs.
    api
      .post<{ data: { email: string } }>('/api/auth/takeover/inspect', { token })
      .then((res) => {
        if (!cancelled) setStep({ kind: 'question', email: res?.data.email ?? '' });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof api.ApiError && err.status === 400
            ? api.apiErrorMessage(err, INVALID_TAKEOVER)
            : TAKEOVER_MISC_COPY.failed;
        setStep({ kind: 'invalid', message });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function answer(choice: 'mine' | 'not_mine') {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ data: { redirectTo: string } }>('/api/auth/takeover', { token, choice });
      await refetch();
      // The guards take a claimed account to the Terms screen from here.
      navigate(res?.data.redirectTo ?? '/', { replace: true });
    } catch (err) {
      setBusy(false);
      if (err instanceof api.ApiError && err.status === 403 && api.apiErrorCode(err) === 'not_invited') {
        navigate('/private-beta', { replace: true, state: { refused: true } });
        return;
      }
      if (err instanceof api.ApiError && err.status === 400) {
        setStep({ kind: 'invalid', message: api.apiErrorMessage(err, INVALID_TAKEOVER) });
        return;
      }
      if (err instanceof api.ApiError && err.status === 409) {
        setStep({ kind: 'changed', message: api.apiErrorMessage(err, CHANGED) });
        return;
      }
      setError(api.apiErrorMessage(err, TAKEOVER_MISC_COPY.failed));
    }
  }

  return (
    <BetaScreenLayout testId="claim-account">
      {step.kind === 'loading' && <p style={{ margin: 0, color: 'var(--c-text-3)' }}>{TAKEOVER_MISC_COPY.checking}</p>}

      {step.kind === 'invalid' && (
        <>
          <StepHeading>{step.message}</StepHeading>
          <Link to="/login" className="vernal-beta-link">
            {TAKEOVER_MISC_COPY.backToSignIn}
          </Link>
        </>
      )}

      {step.kind === 'changed' && (
        <>
          <StepHeading testId="claim-account-changed">{step.message}</StepHeading>
          <a href={googleSignInHref()} className="vernal-beta-primary">
            {TAKEOVER_MISC_COPY.googleAgain}
          </a>
        </>
      )}

      {step.kind === 'question' && (
        <TakeoverQuestion
          email={step.email}
          busy={busy}
          error={error}
          onYes={() => void answer('mine')}
          onNo={() => {
            setError('');
            setStep({ kind: 'confirm', email: step.email });
          }}
        />
      )}

      {step.kind === 'confirm' && (
        <TakeoverConfirm
          copy={TAKEOVER_REPLACE_COPY}
          busy={busy}
          error={error}
          onRemove={() => void answer('not_mine')}
          onBack={() => {
            setError('');
            setStep({ kind: 'question', email: step.email });
          }}
        />
      )}
    </BetaScreenLayout>
  );
}
