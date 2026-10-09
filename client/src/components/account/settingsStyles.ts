import type React from 'react';

export const cardSt: React.CSSProperties = {
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--c-surface)',
  boxShadow: 'var(--shadow-sm)',
  padding: 'var(--sp-5)',
};

export const cardTitleSt: React.CSSProperties = {
  margin: '0 0 var(--sp-2)',
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  color: 'var(--c-text)',
};

export const bodyTextSt: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text-2)',
  lineHeight: 1.6,
};

export const labelSt: React.CSSProperties = {
  display: 'block',
  marginBottom: 'var(--sp-1)',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--c-text)',
};

export const inputSt: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
};

export const primaryButtonSt: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  border: 'none',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  cursor: 'pointer',
};

export const secondaryButtonSt: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'transparent',
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

export const dangerButtonSt: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  border: '1px solid var(--c-danger)',
  borderRadius: 'var(--r-md)',
  background: 'transparent',
  color: 'var(--c-danger)',
  cursor: 'pointer',
};

export const linkButtonSt: React.CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-primary)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

export const errorTextSt: React.CSSProperties = {
  margin: 'var(--sp-2) 0 0',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-danger)',
};

export const successTextSt: React.CSSProperties = {
  margin: 'var(--sp-2) 0 0',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-success)',
};

export function apiErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'body' in err) {
    const body = (err as { body?: unknown }).body;
    if (body && typeof body === 'object' && 'error' in body) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === 'string') return message;
    }
  }
  return fallback;
}
