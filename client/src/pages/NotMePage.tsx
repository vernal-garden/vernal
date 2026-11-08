import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import { getUrlToken } from '../instrument';
import BetaScreenLayout from '../components/BetaScreenLayout';
import { AlreadyVerifiedStep, NotMeExpiredStep, StepHeading, StepText, TakeoverConfirm } from '../components/TakeoverSteps';
import { NOT_ME_COPY, TAKEOVER_MISC_COPY } from '../lib/takeoverCopy';

// The "This wasn't me" link in the verification email. Mail scanners follow
// links, so loading this page must never act: the only read is the
// side-effect-free inspect call, and only the button posts.

type Step =
  | { kind: 'loading' }
  | { kind: 'ask' }
  | { kind: 'done' }
  // The account is already verified: this link can't remove it.
  | { kind: 'alreadyVerified' }
  // Expired, unknown, or too close to expiry to act on. The person may have
  // no account, so the page explains the way in rather than offering a new link.
  | { kind: 'expired' };

export default function NotMePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  const [step, setStep] = useState<Step>(() =>
    token ? { kind: 'loading' } : { kind: 'expired' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Read-only: only says early whether the link is still usable, and whether
  // the account is still unverified (a verified one can't be removed here).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .post<{ data: { unverifiedAccount: boolean } }>('/api/auth/verify-email/inspect', { token })
      .then((res) => {
        if (cancelled) return;
        if (res?.data.unverifiedAccount === false) setStep({ kind: 'alreadyVerified' });
        else setStep({ kind: 'ask' });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof api.ApiError && err.status === 400) {
          setStep({ kind: 'expired' });
        } else {
          // The POST will say what is wrong, if anything.
          setStep({ kind: 'ask' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleRemove() {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/not-me', { token });
      setStep({ kind: 'done' });
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 409 && api.apiErrorCode(err) === 'already_verified') {
        setStep({ kind: 'alreadyVerified' });
      } else if (err instanceof api.ApiError && err.status === 400) {
        // Invalid, expired, or nearly expired: all the same to this person.
        setStep({ kind: 'expired' });
      } else {
        setError(api.apiErrorMessage(err, TAKEOVER_MISC_COPY.failed));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <BetaScreenLayout testId="not-me">
      {step.kind === 'loading' && <p style={{ margin: 0, color: 'var(--c-text-3)' }}>{TAKEOVER_MISC_COPY.checking}</p>}

      {step.kind === 'ask' && (
        <TakeoverConfirm
          copy={NOT_ME_COPY}
          busy={busy}
          busyLabel={NOT_ME_COPY.removing}
          error={error}
          onRemove={() => void handleRemove()}
        />
      )}

      {step.kind === 'done' && (
        <>
          <StepHeading testId="not-me-done">{NOT_ME_COPY.doneHeading}</StepHeading>
          <StepText>{NOT_ME_COPY.done}</StepText>
        </>
      )}

      {step.kind === 'alreadyVerified' && <AlreadyVerifiedStep testId="not-me-already-verified" />}

      {step.kind === 'expired' && <NotMeExpiredStep />}
    </BetaScreenLayout>
  );
}
