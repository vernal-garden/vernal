import { Link } from 'react-router-dom';
import { BETA_TERMS_COPY } from '../lib/betaCopy';

const linkStyle = { color: 'var(--c-primary-dark)', textDecoration: 'underline' };

// The main Terms, for an account held after a claim. Required, so the browser
// holds the form until it is ticked. Same-tab links, as on the sign-up form.
export default function TermsCheckbox() {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sp-2)',
        textAlign: 'left',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        lineHeight: 1.5,
        color: 'var(--c-text-2)',
      }}
    >
      <input
        type="checkbox"
        required
        data-testid="terms-checkbox"
        style={{ flexShrink: 0, width: 18, height: 18, margin: '2px 0 0', accentColor: 'var(--c-primary)' }}
      />
      <span>
        {BETA_TERMS_COPY.termsCheckboxBefore}
        <Link to="/terms" style={linkStyle}>
          {BETA_TERMS_COPY.termsLink}
        </Link>
        {BETA_TERMS_COPY.termsCheckboxMiddle}
        <Link to="/privacy" style={linkStyle}>
          {BETA_TERMS_COPY.privacyLink}
        </Link>
        {BETA_TERMS_COPY.termsCheckboxAfter}
      </span>
    </label>
  );
}
