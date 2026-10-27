import type { CSSProperties, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CONTACT_EMAIL, LEGAL_UPDATED, LEGAL_UPDATED_LABEL } from '../../lib/legal';

export const legalBodyStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  lineHeight: 1.6,
  color: 'var(--c-text-2)',
};

export const legalLinkStyle: CSSProperties = {
  color: 'var(--c-primary)',
  fontWeight: 600,
};

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: 19,
          fontWeight: 600,
          color: 'var(--c-text)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p style={legalBodyStyle}>{children}</p>;
}

export function List({ children }: { children: ReactNode }) {
  return (
    <ul
      style={{
        ...legalBodyStyle,
        paddingLeft: 'var(--sp-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
        listStyle: 'disc',
      }}
    >
      {children}
    </ul>
  );
}

export function ContactLink() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} style={legalLinkStyle}>
      {CONTACT_EMAIL}
    </a>
  );
}

interface Props {
  title: string;
  testId: string;
  children: ReactNode;
}

export default function LegalPageLayout({ title, testId, children }: Props) {
  const navigate = useNavigate();

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  };

  return (
    <div
      style={{
        minHeight: '100dvh',
        boxSizing: 'border-box',
        background: 'var(--c-bg)',
        padding: 'var(--sp-6) var(--sp-4) var(--sp-8)',
      }}
    >
      <main data-testid={testId} style={{ maxWidth: 720, margin: '0 auto' }}>
        <button
          type="button"
          onClick={goBack}
          style={{
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--sp-1)',
            padding: '0 var(--sp-3)',
            marginLeft: 'calc(-1 * var(--sp-3))',
            marginBottom: 'var(--sp-4)',
            border: 'none',
            borderRadius: 'var(--r-md)',
            background: 'transparent',
            color: 'var(--c-primary)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true">&larr;</span> Back
        </button>

        <h1
          style={{
            margin: '0 0 var(--sp-1)',
            fontFamily: 'var(--font-display)',
            fontSize: 28,
            fontWeight: 600,
            color: 'var(--c-text)',
          }}
        >
          {title}
        </h1>
        <p style={{ ...legalBodyStyle, fontSize: 13, color: 'var(--c-text-3)', marginBottom: 'var(--sp-6)' }}>
          Last updated <time dateTime={LEGAL_UPDATED}>{LEGAL_UPDATED_LABEL}</time>
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6)' }}>{children}</div>
      </main>
    </div>
  );
}
