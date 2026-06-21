import { ReactNode } from 'react';

const GoogleG = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

interface Props {
  title: string;
  returnTo?: string;
  children: ReactNode;
}

export default function AuthFormLayout({ title, returnTo = '/', children }: Props) {
  const googleHref = `/api/auth/oauth/google?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f0',
      padding: '1rem',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '12px',
        padding: '2.5rem',
        width: '100%',
        maxWidth: '400px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
      }}>
        <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#1a1a1a' }}>
          {title}
        </h1>

        <a
          href={googleHref}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem',
            width: '100%',
            padding: '0.625rem 1rem',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            background: '#fff',
            color: '#374151',
            fontSize: '0.9375rem',
            fontWeight: 500,
            textDecoration: 'none',
            boxSizing: 'border-box',
          }}
        >
          <GoogleG />
          Continue with Google
        </a>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          margin: '1.25rem 0',
          color: '#9ca3af',
          fontSize: '0.875rem',
        }}>
          <div style={{ flex: 1, height: '1px', background: '#e5e7eb' }} />
          or
          <div style={{ flex: 1, height: '1px', background: '#e5e7eb' }} />
        </div>

        {children}
      </div>
    </div>
  );
}
