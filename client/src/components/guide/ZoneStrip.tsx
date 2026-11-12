import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import type { GuideGarden } from '../../types/plantingGuide';
import { FROST_COPY, framePrompt, stripFrostLine } from '../../lib/frostLabels';
import { useIsMobile } from '../../hooks/useIsMobile';
import FrostDateEditor from './FrostDateEditor';
import { linkStyle } from './styles';

interface Props {
  garden: GuideGarden;
  isAccount: boolean;
  onFrostSaved: () => void;
  // Controlled editor; uncontrolled (internal state) when these are absent.
  editorOpen?: boolean;
  onEditorOpenChange?: (open: boolean) => void;
}

// The guide's text link, as a button, in the strip's low-contrast colour.
const promptButtonStyle: CSSProperties = {
  ...linkStyle,
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'inherit',
  fontSize: 'inherit',
  fontWeight: 'inherit',
  cursor: 'pointer',
};

// Low-contrast "Zone 7b · Raleigh, NC" line with the frost-date source.
export default function ZoneStrip({ garden, isAccount, onFrostSaved, editorOpen, onEditorOpenChange }: Props) {
  const isMobile = useIsMobile();
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = editorOpen !== undefined;
  const open = isAccount && (controlled ? editorOpen : internalOpen);

  const linkRef = useRef<HTMLAnchorElement>(null);
  const promptRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  function setOpen(next: boolean) {
    if (!controlled) setInternalOpen(next);
    onEditorOpenChange?.(next);
  }

  function close() {
    returnFocus.current = true;
    setOpen(false);
  }

  const line = stripFrostLine(garden.frost, garden.zone);
  const prompt = isAccount ? framePrompt(garden.frost) : null;
  const hasPrompt = prompt !== null;

  // After the editor closes, put focus back on the prompt, or on the strip's
  // link when the prompt is gone. Runs after the BottomSheet's own restore.
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    (promptRef.current ?? linkRef.current)?.focus();
  });

  // A save reloads the guide; when the garden now has its own date the prompt
  // disappears and would take focus with it.
  const hadPrompt = useRef(hasPrompt);
  useEffect(() => {
    const lostPrompt = hadPrompt.current && !hasPrompt;
    hadPrompt.current = hasPrompt;
    if (!lostPrompt || open) return;
    const active = document.activeElement;
    if (!active || active === document.body) linkRef.current?.focus();
  }, [hasPrompt, open]);

  const zoneText = `Zone ${garden.zone}${garden.zoneLocationLabel ? ` · ${garden.zoneLocationLabel}` : ''}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          columnGap: 'var(--sp-3)',
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          color: 'var(--c-text-3)',
        }}
      >
        {isAccount ? (
          <Link
            ref={linkRef}
            to="/account"
            style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', color: 'var(--c-text-3)', textDecoration: 'underline' }}
          >
            {zoneText}
          </Link>
        ) : (
          <span style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{zoneText}</span>
        )}
        {(line || prompt) && (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 'var(--sp-2)' }}>
            {line && <span>{line}</span>}
            {prompt && (
              <>
                <span>{prompt.text}</span>
                <button
                  ref={promptRef}
                  type="button"
                  aria-label={FROST_COPY.setDateName}
                  onClick={() => setOpen(true)}
                  style={promptButtonStyle}
                >
                  {prompt.link}
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {open && (
        <FrostDateEditor
          initial={garden.frost.frostFree ? null : garden.frost.lastSpringFrost}
          isMobile={isMobile}
          onCancel={close}
          onSaved={() => {
            close();
            onFrostSaved();
          }}
        />
      )}
    </div>
  );
}
