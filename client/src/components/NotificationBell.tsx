import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import * as api from '../lib/api';
import BottomSheet from './shell/BottomSheet';
import { BellIcon } from './shell/icons';

const POLL_MS = 5 * 60 * 1000;
const POPOVER_WIDTH = 320;
const EDGE_GAP = 8;

interface NotificationItem {
  id: number;
  type: string;
  payload: { seedId?: number | string; seedName?: string } | null;
  readAt: string | null;
  createdAt: string;
}

interface ListResponse {
  unreadCount: number; // includes types we don't render, so the UI derives its own
  data: NotificationItem[];
}

// Types nothing writes yet (guest_expiry_warning, correction_applied,
// cambium_source_updated) are skipped rather than shown with a generic line:
// an unreviewed placeholder in a user's inbox is worse than no row. Add a case
// here when a type starts being written.
function describe(n: NotificationItem): string | null {
  const name = n.payload?.seedName ?? 'Your seed';
  switch (n.type) {
    case 'contribution_rejected':
      return `Your submission of ${name} wasn't approved. You can edit it and try again.`;
    case 'contribution_approved':
      return `Your ${name} is now in Cambium™ for other gardeners to find. Thanks for sharing it.`;
    default:
      return null;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const SQUARE_44: CSSProperties = {
  width: 44,
  height: 44,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export default function NotificationBell() {
  const { isAccount } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Bumped on each request and on unmount so stale responses are dropped.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const res = await api.get<ListResponse>('/api/notifications');
      if (id !== requestId.current || !res) return;
      setItems(res.data);
    } catch {
      // Best-effort — keep whatever we last showed.
    }
  }, []);

  // Poll while visible; refresh when the tab comes back.
  useEffect(() => {
    if (!isAccount) {
      // Logout: drop the previous account's data and any in-flight response.
      requestId.current++;
      setItems([]);
      setOpen(false);
      return;
    }
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    function onVisible() {
      if (document.visibilityState === 'visible') void load();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      requestId.current++;
    };
  }, [isAccount, load]);

  const close = useCallback(() => setOpen(false), []);

  // Navigating anywhere closes the panel.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Desktop popover: anchor under the button, right-aligned, clamped on-screen.
  useLayoutEffect(() => {
    if (!open || isMobile) return;
    function place() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({ top: rect.bottom + 4, right: Math.max(EDGE_GAP, document.documentElement.clientWidth - rect.right) });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, isMobile]);

  // Desktop popover: focus in on open, back to the bell on close; Escape and outside click close.
  useEffect(() => {
    if (!open || isMobile) return;
    const button = buttonRef.current;
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || button?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      button?.focus();
    };
  }, [open, isMobile]);

  if (!isAccount) return null;

  const visible = items.filter((n) => describe(n) !== null);
  const unread = visible.filter((n) => n.readAt === null).length;

  async function markAll() {
    const prevItems = items;
    requestId.current++;
    const now = new Date().toISOString();
    setItems((cur) => cur.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    try {
      await api.post('/api/notifications/read-all');
    } catch {
      setItems(prevItems);
    }
  }

  function openItem(n: NotificationItem) {
    requestId.current++;
    if (!n.readAt) {
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      // Failure is self-correcting: the next poll restores the true state.
      api.patch(`/api/notifications/${n.id}/read`).catch(() => undefined);
    }
    close();
    const seedId = n.payload?.seedId;
    navigate(seedId != null ? `/catalogue?open=seed:${seedId}` : '/catalogue');
  }

  const content = (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 var(--sp-2)' }}>
        {unread > 0 && (
          <button
            type="button"
            data-testid="notification-mark-all"
            onClick={() => void markAll()}
            style={{
              minHeight: 44,
              padding: '0 var(--sp-3)',
              border: 'none',
              background: 'transparent',
              color: 'var(--c-primary)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Mark all as read
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <p
          data-testid="notification-empty"
          style={{ margin: 0, padding: 'var(--sp-4)', textAlign: 'center', fontSize: 14, color: 'var(--c-text-2)' }}
        >
          You're all caught up.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {visible.map((n) => (
            <li key={n.id} style={{ borderTop: '1px solid var(--c-border-subtle)' }}>
              <button
                type="button"
                data-testid="notification-row"
                data-id={n.id}
                data-unread={n.readAt === null ? 'true' : 'false'}
                onClick={() => openItem(n)}
                style={{
                  display: 'block',
                  width: '100%',
                  minHeight: 44,
                  boxSizing: 'border-box',
                  padding: 'var(--sp-3) var(--sp-4)',
                  border: 'none',
                  background: n.readAt === null ? 'var(--c-primary-subtle)' : 'transparent',
                  color: 'var(--c-text)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-ui)',
                }}
              >
                <span style={{ display: 'block', fontSize: 14, lineHeight: 1.4, fontWeight: n.readAt === null ? 700 : 400 }}>
                  {describe(n)}
                </span>
                <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: 'var(--c-text-3)' }}>
                  {formatDate(n.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="notification-bell"
        data-unread={unread}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          ...SQUARE_44,
          position: 'relative',
          padding: 0,
          border: 'none',
          borderRadius: 'var(--r-full)',
          background: 'transparent',
          color: 'var(--c-text-2)',
          cursor: 'pointer',
        }}
      >
        <BellIcon />
        {unread > 0 && (
          <span
            data-testid="notification-dot"
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 10,
              right: 11,
              width: 9,
              height: 9,
              borderRadius: 'var(--r-full)',
              background: 'var(--c-danger)',
              border: '2px solid var(--c-surface)',
            }}
          />
        )}
      </button>

      {isMobile ? (
        <BottomSheet open={open} onClose={close} title="Notifications">
          <div data-testid="notification-panel">{content}</div>
        </BottomSheet>
      ) : (
        open && anchor && createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            data-testid="notification-panel"
            tabIndex={-1}
            style={{
              position: 'fixed',
              top: anchor.top,
              right: anchor.right,
              zIndex: 1100,
              width: POPOVER_WIDTH,
              maxWidth: `calc(100vw - ${EDGE_GAP * 2}px)`,
              maxHeight: `calc(100dvh - ${anchor.top + EDGE_GAP}px)`,
              overflowY: 'auto',
              boxSizing: 'border-box',
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border-subtle)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--shadow-md)',
              outline: 'none',
            }}
          >
            <div
              style={{
                padding: 'var(--sp-3) var(--sp-4) 0',
                fontFamily: 'var(--font-display)',
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--c-text)',
              }}
            >
              Notifications
            </div>
            {content}
          </div>,
          document.body,
        )
      )}
    </>
  );
}
