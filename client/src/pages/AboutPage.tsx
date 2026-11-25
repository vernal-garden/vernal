import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import WeatherCredit from '../components/weather/WeatherCredit';
import { secondaryTextStyle } from '../components/metrics/styles';
import { WHATS_NEW } from '../content/whatsNew';
import { openFeedbackPanel } from '../lib/feedbackPanel';
import { MONTH_LONG, parseDay } from '../lib/guideDates';

const REPO_URL = 'https://github.com/vernal-garden/vernal';

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 'var(--sp-1)',
  padding: 'var(--sp-4)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border-subtle)',
  borderRadius: 'var(--r-md)',
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--c-text-2)',
};

const linkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--c-primary)',
};

// A button that reads as one of the links above.
const buttonLinkStyle: CSSProperties = {
  ...linkStyle,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
};

function longDate(key: string): string {
  const { y, m, d } = parseDay(key);
  return `${MONTH_LONG[m - 1]} ${d}, ${y}`;
}

function ExternalLink({ href, testId, children }: { href: string; testId: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testId} style={linkStyle}>
      {children}
    </a>
  );
}

export default function AboutPage() {
  const { hash, key } = useLocation();
  const whatsNewRef = useRef<HTMLElement>(null);

  // The router doesn't scroll to hashes. The location key changes on every
  // navigation, so following the link while already here scrolls again.
  useEffect(() => {
    if (hash === '#whats-new') whatsNewRef.current?.scrollIntoView({ block: 'start' });
  }, [hash, key]);

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--sp-5)' }} data-testid="about-page">
      <h1
        style={{
          margin: '0 0 var(--sp-1)',
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          color: 'var(--c-text)',
        }}
      >
        Vernal
      </h1>
      <p data-testid="about-version" style={{ ...bodyStyle, marginBottom: 'var(--sp-5)' }}>
        Version {__APP_VERSION__}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <section style={sectionStyle} aria-label="License">
          <p style={bodyStyle}>Vernal is open source under the GNU Affero General Public License v3.0.</p>
          <ExternalLink href={`${REPO_URL}/blob/main/LICENSE`} testId="about-license-link">
            Read the license
          </ExternalLink>
          <ExternalLink href={REPO_URL} testId="about-source-link">
            Source code
          </ExternalLink>
          <ExternalLink href="/third-party-notices.txt" testId="about-notices-link">
            Third-party notices
          </ExternalLink>
          <Link to="/privacy" data-testid="about-privacy-link" style={linkStyle}>
            Privacy policy
          </Link>
          <Link to="/terms" data-testid="about-terms-link" style={linkStyle}>
            Terms
          </Link>
        </section>

        <section style={sectionStyle} aria-label="Credits">
          <p style={bodyStyle}>Weather and location data:</p>
          <WeatherCredit />
          <p style={{ ...bodyStyle, ...secondaryTextStyle }}>
            Weather forecasts and history come from outside services and can be wrong or out of date. Use them for planning, and check official forecasts and warnings before anything that matters.
          </p>
        </section>

        <section
          ref={whatsNewRef}
          id="whats-new"
          aria-label="What's new"
          style={{ ...sectionStyle, scrollMarginTop: 'calc(var(--shell-top, 0px) + var(--sp-4))' }}
        >
          <h2 style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600, color: 'var(--c-text)' }}>
            What&apos;s new
          </h2>
          {/* Already newest first. */}
          {WHATS_NEW.map((entry) => (
            <div key={entry.id} style={{ marginTop: 'var(--sp-2)' }}>
              <p style={{ ...bodyStyle, ...secondaryTextStyle }}>
                <time dateTime={entry.date}>{longDate(entry.date)}</time>
              </p>
              <h3 style={{ ...bodyStyle, fontWeight: 600, color: 'var(--c-text)' }}>{entry.title}</h3>
              <ul style={{ ...bodyStyle, paddingLeft: 'var(--sp-5)', listStyle: 'disc' }}>
                {entry.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {entry.link && (
                <Link to={entry.link.to} style={linkStyle}>
                  {entry.link.label}
                </Link>
              )}
            </div>
          ))}
        </section>

        <section style={sectionStyle} aria-label="Feedback">
          <button
            type="button"
            data-testid="about-feedback-button"
            onClick={() => openFeedbackPanel()}
            style={buttonLinkStyle}
          >
            Report a bug or request a feature
          </button>
          <p style={bodyStyle}>Opens the same feedback panel as the button in the corner.</p>
          <p style={{ ...bodyStyle, ...secondaryTextStyle }}>
            Contributors can also{' '}
            <ExternalLink href={`${REPO_URL}/issues`} testId="about-issues-link">
              file issues on GitHub
            </ExternalLink>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
