import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import { getUrlToken } from '../instrument';
import BetaScreenLayout from '../components/BetaScreenLayout';
import {
  AlreadyVerifiedStep,
  StepHeading,
  StepText,
  TakeoverConfirm,
  TakeoverQuestion,
} from '../components/TakeoverSteps';
import { NOT_ME_COPY, TAKEOVER_MISC_COPY, TAKEOVER_REMOVE_COPY } from '../lib/takeoverCopy';

// The verification link. Signed in as the link's account (or the account is
// already verified): verified straight away. Otherwise the account may not be
// the clicker's own, so they are asked whether they created it first.
type Status =
  | { kind: 'loading' }
  | { kind: 'success' }
  | { kind: 'error'; message: string }
  | { kind: 'question'; email: string | null }
  | { kind: 'confirm'; email: string | null }
  | { kind: 'claimed' }
  | { kind: 'removed' }
  // "No" answered, but the account was verified meanwhile (409 already_verified).
  | { kind: 'alreadyVerified' };

const INVALID = 'This verification link is invalid or has expired.';
const FAILED = 'Something went wrong verifying your email.';

const wrapperSt: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: 'var(--sp-6) var(--sp-5)',
  textAlign: 'center',
};

const headingSt: React.CSSProperties = {
  margin: '0 0 var(--sp-3)',
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  color: 'var(--c-text)',
};

const bodyTextSt: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text-2)',
  lineHeight: 1.6,
};

const linkSt: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 'var(--sp-4)',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
};

function errorMessage(err: unknown): string {
  return api.apiErrorMessage(err, FAILED);
}

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Held in state: the address bar loses it below, and later posts need it.
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Tokens are single-use; StrictMode's double effect must not submit twice.
  const started = useRef(false);

  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setStatus({ kind: 'error', message: INVALID });
      return;
    }

    async function verifyStraightAway() {
      try {
        await api.post('/api/auth/verify-email', { token });
        setStatus({ kind: 'success' });
      } catch (err) {
        // The server found the question needed after all.
        if (api.apiErrorCode(err) === 'takeover_choice_required') {
          // The 409 carries the address, as inspect would have.
          const body = err instanceof api.ApiError ? (err.body as { email?: unknown } | null) : null;
          setStatus({ kind: 'question', email: typeof body?.email === 'string' ? body.email : null });
        } else {
          setStatus({ kind: 'error', message: errorMessage(err) });
        }
      }
    }

    // A POST so the token stays out of URLs and logs.
    api
      .post<{ data: { signedInAsAccount: boolean; unverifiedAccount: boolean; email?: string } }>(
        '/api/auth/verify-email/inspect',
        { token },
      )
      .then((res) => {
        const data = res?.data;
        if (!data || data.signedInAsAccount || !data.unverifiedAccount) return verifyStraightAway();
        setStatus({ kind: 'question', email: data.email ?? null });
      })
      .catch((err) => {
        if (err instanceof api.ApiError && err.status === 400) {
          setStatus({ kind: 'error', message: errorMessage(err) });
          return;
        }
        // Inspect failed for another reason: the plain post asks for a choice when one is needed.
        return verifyStraightAway();
      });
  }, [token]);

  async function answer(choice: 'mine' | 'not_mine') {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ data: { verified?: boolean; removed?: boolean } }>('/api/auth/verify-email', {
        token,
        choice,
      });
      setStatus(res?.data.removed ? { kind: 'removed' } : { kind: 'claimed' });
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 400) {
        setStatus({ kind: 'error', message: errorMessage(err) });
      } else if (err instanceof api.ApiError && err.status === 409 && api.apiErrorCode(err) === 'already_verified') {
        setStatus({ kind: 'alreadyVerified' });
      } else {
        // Billing unreachable (502), or a network failure.
        setError(api.apiErrorMessage(err, TAKEOVER_MISC_COPY.failed));
      }
    } finally {
      setBusy(false);
    }
  }

  if (
    status.kind === 'question' ||
    status.kind === 'confirm' ||
    status.kind === 'claimed' ||
    status.kind === 'removed' ||
    status.kind === 'alreadyVerified'
  ) {
    return (
      <BetaScreenLayout testId="verify-email">
        {status.kind === 'question' && (
          <TakeoverQuestion
            email={status.email}
            busy={busy}
            error={error}
            onYes={() => void answer('mine')}
            onNo={() => {
              setError('');
              setStatus({ kind: 'confirm', email: status.email });
            }}
          />
        )}
        {status.kind === 'confirm' && (
          <TakeoverConfirm
            copy={TAKEOVER_REMOVE_COPY}
            busy={busy}
            error={error}
            onRemove={() => void answer('not_mine')}
            onBack={() => {
              setError('');
              setStatus({ kind: 'question', email: status.email });
            }}
          />
        )}
        {status.kind === 'claimed' && (
          <>
            <StepHeading testId="verify-email-claimed">{TAKEOVER_MISC_COPY.verifiedHeading}</StepHeading>
            <StepText>{TAKEOVER_MISC_COPY.verifiedSignIn}</StepText>
            <Link to="/login" className="vernal-beta-primary">
              {TAKEOVER_MISC_COPY.signIn}
            </Link>
          </>
        )}
        {status.kind === 'alreadyVerified' && <AlreadyVerifiedStep testId="verify-email-already-verified" />}
        {status.kind === 'removed' && (
          <>
            <StepHeading testId="verify-email-removed">{NOT_ME_COPY.doneHeading}</StepHeading>
            <StepText>{NOT_ME_COPY.done}</StepText>
          </>
        )}
      </BetaScreenLayout>
    );
  }

  return (
    <div style={wrapperSt} role="status">
      {status.kind === 'loading' && <p style={bodyTextSt}>Verifying your email…</p>}

      {status.kind === 'success' && (
        <>
          <h1 style={headingSt}>Email verified</h1>
          <p style={bodyTextSt}>Thanks, your email address is confirmed.</p>
          <Link to="/" style={linkSt}>
            Go to Vernal
          </Link>
        </>
      )}

      {status.kind === 'error' && (
        <>
          <h1 style={headingSt}>Couldn't verify email</h1>
          <p style={{ ...bodyTextSt, color: 'var(--c-danger)' }}>{status.message}</p>
          <Link to="/account" style={linkSt}>
            Go to your account to send a new link
          </Link>
        </>
      )}
    </div>
  );
}
