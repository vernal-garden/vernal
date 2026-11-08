import type { CSSProperties, ReactNode } from 'react';

export const BETA_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 28,
  fontWeight: 600,
  lineHeight: 1.3,
  color: 'var(--c-primary-dark)',
  outline: 'none',
};

export const BETA_TEXT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 16,
  lineHeight: 1.5,
  color: 'var(--c-text-2)',
  outline: 'none',
};

interface Props {
  testId: string;
  children: ReactNode;
}

// The full-screen layout shared by /private-beta and /beta-terms: the Expired
// interstitial's calm page, at the account form's width. Also defines the
// vernal-beta-primary and vernal-beta-link classes, which change at the mobile
// breakpoint.
export default function BetaScreenLayout({ testId, children }: Props) {
  return (
    <main className="vernal-beta-screen" data-testid={testId}>
      <style>{`
        @keyframes vernal-beta-in { from { opacity: 0; } to { opacity: 1; } }
        .vernal-beta-screen {
          min-height: 100vh;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: var(--sp-6) var(--sp-6) 12vh;
          background: var(--c-bg);
          color: var(--c-text);
          font-family: var(--font-ui);
          text-align: center;
          animation: vernal-beta-in 250ms ease-out;
        }
        .vernal-beta-block {
          width: 100%;
          max-width: 480px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--sp-4);
        }
        .vernal-beta-primary {
          min-height: 44px;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0 var(--sp-5);
          margin-top: var(--sp-2);
          border: none;
          border-radius: var(--r-md);
          background: var(--c-primary);
          color: var(--c-text-on-primary);
          font-family: var(--font-ui);
          font-size: 15px;
          font-weight: 600;
          text-decoration: none;
          cursor: pointer;
        }
        .vernal-beta-link {
          min-height: 44px;
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          border: none;
          background: none;
          color: var(--c-primary-dark);
          font-family: var(--font-ui);
          font-size: 15px;
          text-decoration: underline;
          cursor: pointer;
        }
        @media (max-width: 767px) {
          .vernal-beta-screen {
            justify-content: flex-start;
            padding:
              calc(var(--sp-7) + env(safe-area-inset-top))
              calc(var(--sp-4) + env(safe-area-inset-right))
              calc(var(--sp-5) + env(safe-area-inset-bottom))
              calc(var(--sp-4) + env(safe-area-inset-left));
          }
          .vernal-beta-primary { width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .vernal-beta-screen { animation: none; }
        }
      `}</style>

      <div className="vernal-beta-block">
        {/* Same as AppNav's wordmark: there is no wordmark graphic yet. */}
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 18,
            fontWeight: 600,
            color: 'var(--c-primary-dark)',
          }}
        >
          Vernal
        </span>
        {children}
      </div>
    </main>
  );
}
