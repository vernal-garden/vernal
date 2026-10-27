import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import WeatherCredit from '../components/weather/WeatherCredit';
import { secondaryTextStyle } from '../components/metrics/styles';

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

function ExternalLink({ href, testId, children }: { href: string; testId: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" data-testid={testId} style={linkStyle}>
      {children}
    </a>
  );
}

export default function AboutPage() {
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

        <section style={sectionStyle} aria-label="Feedback">
          <ExternalLink href={`${REPO_URL}/issues`} testId="about-issues-link">
            Report a bug or request a feature
          </ExternalLink>
          <p style={bodyStyle}>You can also use the feedback button in the corner of the screen.</p>
        </section>
      </div>
    </div>
  );
}
