import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BETA_HEADING_STYLE, BETA_TEXT_STYLE } from './BetaScreenLayout';
import { ALREADY_VERIFIED_COPY, NOT_ME_EXPIRED_COPY, TAKEOVER_QUESTION_COPY } from '../lib/takeoverCopy';

// The steps of the unverified-account question, rendered inside
// BetaScreenLayout (which defines vernal-beta-primary and vernal-beta-link).
// Each step focuses its heading when it appears, so a screen reader hears the
// new step after a button press.

const HEADING_STYLE: CSSProperties = { ...BETA_HEADING_STYLE, fontSize: 22 };

const INLINE_LINK_STYLE: CSSProperties = { color: 'var(--c-primary-dark)', textDecoration: 'underline' };

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 'var(--sp-3)',
  width: '100%',
};

const SECONDARY_CSS = `
  .vernal-takeover-secondary {
    min-height: 44px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--sp-5);
    margin-top: var(--sp-2);
    border: 1px solid var(--c-border);
    border-radius: var(--r-md);
    background: var(--c-surface);
    color: var(--c-text);
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
  }
  @media (max-width: 767px) {
    .vernal-takeover-secondary { width: 100%; }
  }
`;

export function StepHeading({ children, testId }: { children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} style={HEADING_STYLE} data-testid={testId}>
      {children}
    </h1>
  );
}

export function StepError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" style={{ margin: 0, fontSize: 14, color: 'var(--c-danger)' }}>
      {message}
    </p>
  );
}

export function StepText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p style={BETA_TEXT_STYLE} data-testid={testId}>
      {children}
    </p>
  );
}

// The address the question is about, under the question on every question screen.
export function TakeoverEmail({ email }: { email: string }) {
  return (
    <p
      data-testid="takeover-email"
      style={{ ...BETA_TEXT_STYLE, fontWeight: 600, color: 'var(--c-text)', overflowWrap: 'anywhere' }}
    >
      {email}
    </p>
  );
}

// The account was already verified, so the link can't remove it (/not-me and
// the verification link). Full-contrast text, not an error.
export function AlreadyVerifiedStep({ testId }: { testId: string }) {
  return (
    <>
      <StepHeading testId={testId}>{ALREADY_VERIFIED_COPY.heading}</StepHeading>
      <StepText testId="already-verified-body">
        {ALREADY_VERIFIED_COPY.body}
        <a href={`mailto:${ALREADY_VERIFIED_COPY.email}`} style={INLINE_LINK_STYLE}>
          {ALREADY_VERIFIED_COPY.email}
        </a>
        {ALREADY_VERIFIED_COPY.bodyEnd}
      </StepText>
    </>
  );
}

// An expired or unknown "This wasn't me" link.
export function NotMeExpiredStep() {
  return (
    <>
      <StepHeading testId="not-me-expired">{NOT_ME_EXPIRED_COPY.heading}</StepHeading>
      <StepText testId="not-me-expired-body">
        {NOT_ME_EXPIRED_COPY.body}
        <Link to="/login" style={INLINE_LINK_STYLE}>
          {NOT_ME_EXPIRED_COPY.signIn}
        </Link>
        {NOT_ME_EXPIRED_COPY.bodyEnd}
      </StepText>
    </>
  );
}

interface QuestionProps {
  email?: string | null;
  busy: boolean;
  error: string;
  onYes: () => void;
  onNo: () => void;
}

export function TakeoverQuestion({ email, busy, error, onYes, onNo }: QuestionProps) {
  return (
    <>
      <style>{SECONDARY_CSS}</style>
      <StepHeading testId="takeover-question">{TAKEOVER_QUESTION_COPY.question}</StepHeading>
      {email && <TakeoverEmail email={email} />}
      <StepError message={error} />
      <div style={ACTIONS_STYLE}>
        <button
          type="button"
          onClick={onYes}
          disabled={busy}
          className="vernal-beta-primary"
          style={{ opacity: busy ? 0.6 : 1 }}
        >
          {TAKEOVER_QUESTION_COPY.yes}
        </button>
        <button
          type="button"
          onClick={onNo}
          disabled={busy}
          className="vernal-takeover-secondary"
          style={{ opacity: busy ? 0.6 : 1 }}
        >
          {TAKEOVER_QUESTION_COPY.no}
        </button>
      </div>
    </>
  );
}

interface ConfirmProps {
  copy: { heading: string; body: string; remove: string; back?: string };
  busy: boolean;
  busyLabel?: string;
  error: string;
  onRemove: () => void;
  onBack?: () => void;
}

export function TakeoverConfirm({ copy, busy, busyLabel, error, onRemove, onBack }: ConfirmProps) {
  return (
    <>
      <StepHeading testId="takeover-confirm">{copy.heading}</StepHeading>
      <StepText>{copy.body}</StepText>
      <StepError message={error} />
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        className="vernal-beta-primary"
        style={{ opacity: busy ? 0.6 : 1 }}
      >
        {busy && busyLabel ? busyLabel : copy.remove}
      </button>
      {onBack && copy.back && (
        <button type="button" onClick={onBack} disabled={busy} className="vernal-beta-link">
          {copy.back}
        </button>
      )}
    </>
  );
}
