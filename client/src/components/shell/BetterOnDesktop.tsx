import { useEffect, useRef, useState } from 'react';
import { MonitorIcon } from './icons';

export const DESKTOP_MESSAGES = {
  canvasEditing: 'Editing your garden works best on a bigger screen. Open Vernal on your computer to add beds and place plants.',
  admin: 'The admin dashboard is desktop-only. Open Vernal on your computer to manage seeds and feedback.',
  contribute: 'Adding new seeds to the community catalogue works best on desktop. Open Vernal on your computer to contribute.',
  generic: 'This page works best on a bigger screen. Open Vernal on your computer to continue.',
};

const COPIED_MS = 2000;

interface Props {
  variant: 'inline' | 'fullscreen';
  message: string;
}

export default function BetterOnDesktop({ variant, message }: Props) {
  if (variant === 'inline') {
    return (
      <p
        style={{
          margin: 0,
          padding: 'var(--sp-3)',
          borderRadius: 'var(--r-md)',
          background: 'var(--c-surface-raised)',
          color: 'var(--c-text-2)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {message}
      </p>
    );
  }

  return (
    <div
      style={{
        minHeight: 'calc(100dvh - var(--shell-top, 0px) - var(--shell-bottom, 0px))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-5)',
        boxSizing: 'border-box',
        background: 'var(--c-bg)',
      }}
    >
      <div
        style={{
          maxWidth: 360,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--sp-4)',
          padding: 'var(--sp-6) var(--sp-5)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--c-surface)',
          boxShadow: 'var(--shadow-md)',
          textAlign: 'center',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <MonitorIcon width={40} height={40} style={{ color: 'var(--c-text-3)' }} />
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: 'var(--c-text)' }}>{message}</p>
        <CopyLinkButton />
      </div>
    </div>
  );
}

function CopyLinkButton() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (status === 'failed') inputRef.current?.select();
  }, [status]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(location.href);
      setStatus('copied');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus('idle'), COPIED_MS);
    } catch {
      setStatus('failed');
    }
  }

  if (status === 'failed') {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', width: '100%', fontSize: 13, color: 'var(--c-text-2)' }}>
        Copy this link
        <input
          ref={inputRef}
          readOnly
          value={location.href}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            minHeight: 44,
            boxSizing: 'border-box',
            width: '100%',
            padding: '0 var(--sp-3)',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            fontFamily: 'inherit',
            fontSize: 14,
          }}
        />
      </label>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      style={{
        minHeight: 44,
        minWidth: 44,
        padding: '0 var(--sp-5)',
        border: 'none',
        borderRadius: 'var(--r-md)',
        background: 'var(--c-primary)',
        color: 'var(--c-text-on-primary)',
        fontFamily: 'inherit',
        fontSize: 14,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {status === 'copied' ? 'Copied' : 'Copy link'}
    </button>
  );
}
