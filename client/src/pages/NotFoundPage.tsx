import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        boxSizing: 'border-box',
        padding: 'var(--sp-6)',
        background: 'var(--c-bg)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-3)',
        textAlign: 'center',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600, color: 'var(--c-text)' }}>
        Page not found
      </h1>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)' }}>
        The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
      </p>
      <Link
        to="/"
        style={{
          marginTop: 'var(--sp-3)',
          minHeight: 44,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 var(--sp-5)',
          borderRadius: 'var(--r-md)',
          background: 'var(--c-primary)',
          color: 'var(--c-text-on-primary)',
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        Back to Vernal
      </Link>
    </div>
  );
}
