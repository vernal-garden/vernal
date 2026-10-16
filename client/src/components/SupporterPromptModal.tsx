import ResponsiveDialog from './shell/ResponsiveDialog';

interface Props {
  open: boolean;
  onClose: () => void;
  onLearnMore: () => void;
}

// ED: replace with final headline
const HEADLINE = 'Support the garden that helps you grow';

// ED: replace with final body copy
const BODY =
  "Vernal is free to use. A Supporter subscription keeps it running " +
  '— and unlocks photo journaling, PDF exports, soil chemistry, and more. ' +
  "Take a look when you're ready.";

export default function SupporterPromptModal({ open, onClose, onLearnMore }: Props) {
  return (
    <ResponsiveDialog
      open={open}
      onClose={onClose}
      title={HEADLINE}
      ariaLabel="Supporter prompt"
      align="center"
      footerLayout="stack"
      showClose
      hero={
        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: 'var(--r-full)',
          background: 'var(--c-primary-subtle)', marginBottom: 'var(--sp-4)',
        }}>
          <span style={{ fontSize: 24 }}>🌱</span>
        </div>
      }
      footer={
        <>
          <button
            type="button"
            onClick={onLearnMore}
            style={{
              padding: '10px 24px', fontSize: 14, fontFamily: 'var(--font-ui)',
              fontWeight: 600, border: 'none', borderRadius: 'var(--r-md)',
              background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
              cursor: 'pointer',
            }}
          >
            Learn about Supporter
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '9px 18px', background: 'transparent', color: 'var(--c-text-2)',
              border: 'none', borderRadius: 'var(--r-md)',
              fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
            }}
          >
            Not now
          </button>
        </>
      }
    >
      <p style={{
        margin: 0,
        fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)',
        lineHeight: 1.6,
      }}>
        {BODY}
      </p>
    </ResponsiveDialog>
  );
}
