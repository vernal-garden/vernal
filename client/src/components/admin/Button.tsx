import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--c-primary)', color: 'var(--c-text-on-primary)', border: '1px solid var(--c-primary)' },
  secondary: { background: 'var(--c-surface)', color: 'var(--c-text)', border: '1px solid var(--c-border)' },
  ghost: { background: 'transparent', color: 'var(--c-text-2)', border: '1px solid transparent' },
  danger: { background: 'var(--c-danger)', color: 'var(--c-text-on-primary)', border: '1px solid var(--c-danger)' },
};

/** Inline style for an admin button (36px tall, 14px text). Also usable on links. */
export function buttonStyle(variant: ButtonVariant = 'secondary', disabled = false): CSSProperties {
  return {
    ...VARIANTS[variant],
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    padding: '0 var(--sp-3)',
    boxSizing: 'border-box',
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    fontWeight: variant === 'ghost' ? 400 : 600,
    lineHeight: 1,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', type = 'button', style, disabled, ...rest },
  ref,
) {
  return <button ref={ref} type={type} disabled={disabled} style={{ ...buttonStyle(variant, disabled), ...style }} {...rest} />;
});

export default Button;
