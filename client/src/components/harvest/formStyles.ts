import type React from 'react';

// Shared styles for the harvest log. Button styles come from the planting
// guide (components/guide/styles.ts); every interactive element is at least
// 44x44px.
export {
  iconButtonStyle,
  linkStyle,
  primaryButtonStyle,
  segmentGroupStyle,
  segmentStyle,
  textButtonStyle,
} from '../guide/styles';

export const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 44,
  padding: '0 var(--sp-3)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 16,
};

export const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 'var(--sp-1)',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--c-text-2)',
};

export const fieldStyle: React.CSSProperties = {
  marginBottom: 'var(--sp-4)',
};

export const fieldErrorStyle: React.CSSProperties = {
  margin: 'var(--sp-1) 0 0',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-danger)',
};

export const secondaryTextStyle: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-text-3)',
};

export const textLinkButtonStyle: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 var(--sp-2)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'underline',
  cursor: 'pointer',
};

export const spinnerStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  border: '2px solid var(--c-primary-light)',
  borderTopColor: 'var(--c-primary)',
  borderRadius: '50%',
  animation: 'spin 0.8s linear infinite',
};
