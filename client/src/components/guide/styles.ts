import type React from 'react';

// Shared button styles for the planting guide. Every interactive element is at
// least 44x44px.

export const segmentGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  overflow: 'hidden',
  background: 'var(--c-surface)',
};

export function segmentStyle(active: boolean): React.CSSProperties {
  return {
    minHeight: 44,
    minWidth: 44,
    padding: '0 var(--sp-4)',
    border: 'none',
    background: active ? 'var(--c-primary)' : 'transparent',
    color: active ? 'var(--c-text-on-primary)' : 'var(--c-text-2)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

export const textButtonStyle: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 var(--sp-4)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--sp-2)',
  background: 'transparent',
  color: 'var(--c-text-2)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  cursor: 'pointer',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

export const primaryButtonStyle: React.CSSProperties = {
  ...textButtonStyle,
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  border: 'none',
  fontWeight: 600,
};

export const iconButtonStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  background: 'transparent',
  color: 'var(--c-text-2)',
  border: 'none',
  borderRadius: 'var(--r-full)',
  fontFamily: 'var(--font-ui)',
  fontSize: 20,
  cursor: 'pointer',
};

export const linkStyle: React.CSSProperties = {
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'underline',
};

export const tagStyle: React.CSSProperties = {
  display: 'inline-block',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--c-text-2)',
  background: 'var(--c-surface-raised)',
  border: '1px solid var(--c-border-subtle)',
  borderRadius: 'var(--r-full)',
  padding: '1px 8px',
};

export const sectionHeadingStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--c-text-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};
