import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConfig } from '../context/ConfigContext';
import BetaScreenLayout, { BETA_HEADING_STYLE, BETA_TEXT_STYLE } from '../components/BetaScreenLayout';
import { PRIVATE_BETA_COPY, PRIVATE_BETA_VERSIONS } from '../lib/betaCopy';

export default function PrivateBetaPage() {
  const { state } = useAuth();
  const { privateBetaVersion } = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const refusedInState = (location.state as { refused?: unknown } | null)?.refused === true;
  const refusedInQuery = searchParams.get('refused') === '1';

  // Read once and held here, so clearing the URL and history state below leaves
  // the notice up for this page view while a reload shows the landing state.
  const [refused] = useState(refusedInState || refusedInQuery);

  // Accounts never see this screen, even when they arrive by a stale link.
  let redirect: string | null = null;
  if (state.kind === 'account') redirect = '/';
  else if (state.kind === 'beta_terms') redirect = '/beta-terms';

  useEffect(() => {
    if (redirect) return;
    if (refusedInState || searchParams.has('refused')) navigate(location.pathname, { replace: true, state: null });
  }, [redirect, refusedInState, searchParams, navigate, location.pathname]);

  useEffect(() => {
    const previous = document.title;
    document.title = PRIVATE_BETA_COPY.pageTitle;
    return () => {
      document.title = previous;
    };
  }, []);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const visible = state.kind !== 'loading' && !redirect;

  // The notice goes first when shown, so a screen reader reads it and then the heading.
  useEffect(() => {
    if (visible) (noticeRef.current ?? headingRef.current)?.focus();
  }, [visible]);

  if (state.kind === 'loading') return null;
  if (redirect) return <Navigate to={redirect} replace />;

  const version = PRIVATE_BETA_VERSIONS[privateBetaVersion];

  return (
    <BetaScreenLayout testId="private-beta">
      {refused && (
        <p ref={noticeRef} tabIndex={-1} data-testid="private-beta-refused" style={BETA_TEXT_STYLE}>
          {PRIVATE_BETA_COPY.refusedNotice}
          <a
            href={`mailto:${PRIVATE_BETA_COPY.refusedEmail}`}
            style={{ color: 'var(--c-primary-dark)', textDecoration: 'underline' }}
          >
            {PRIVATE_BETA_COPY.refusedEmail}
          </a>
          {PRIVATE_BETA_COPY.refusedNoticeEnd}
        </p>
      )}

      <h1 ref={headingRef} tabIndex={-1} style={BETA_HEADING_STYLE}>
        {PRIVATE_BETA_COPY.heading}
      </h1>

      <p style={BETA_TEXT_STYLE}>{version.body}</p>

      <a href={version.href} className="vernal-beta-primary" data-testid="private-beta-action">
        {version.action}
      </a>

      {refused ? (
        <Link to="/register" className="vernal-beta-link" data-testid="private-beta-try-another">
          {PRIVATE_BETA_COPY.tryAnotherAddress}
        </Link>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Link to="/login" className="vernal-beta-link" data-testid="private-beta-sign-in">
            {PRIVATE_BETA_COPY.signIn}
          </Link>
          <Link to="/register" className="vernal-beta-link" data-testid="private-beta-create-account">
            {PRIVATE_BETA_COPY.createAccount}
          </Link>
        </div>
      )}
    </BetaScreenLayout>
  );
}
