import { BETA_TERMS_COPY } from '../lib/betaCopy';
import { BETA_TERMS_URL } from '../lib/legal';

// Required, so the browser holds the form until it is ticked.
export default function BetaTermsCheckbox() {
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
        data-testid="beta-terms-checkbox"
        style={{ flexShrink: 0, width: 18, height: 18, margin: '2px 0 0', accentColor: 'var(--c-primary)' }}
      />
      <span>
        {BETA_TERMS_COPY.checkboxBefore}
        <a
          href={BETA_TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--c-primary-dark)', textDecoration: 'underline' }}
        >
          {BETA_TERMS_COPY.checkboxLink}
        </a>
        {BETA_TERMS_COPY.checkboxAfter}
      </span>
    </label>
  );
}
