import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useI18n } from './i18n';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  brandColor?: string | null;
  /** Content that sticks to the top of the dialog inside the overlay
   *  (rounded-top, with a slight negative margin for a visual overlap). Used
   *  for the offer-countdown banner (PaywallRoot decides to draw it if
   *  bootstrap.offers has an active timer). */
  topBanner?: ComponentChildren;
  /** Whether the modal can be closed: ESC, overlay click, X button. Defaults to
   *  true. false — the modal stays open until an explicit host-close() /
   *  success-purchase. */
  allowClose?: boolean;
  /** Hide the X button (but keep ESC/overlay working). Used when a view inside
   *  the modal draws its own Back button (AuthGate, SupportGate) — two
   *  simultaneous buttons in the top-right corner confuse the user and overlap
   *  visually. */
  hideCloseButton?: boolean;
  /** Inline mode: the overlay is positioned `absolute inset:0` relative to the
   *  host (instead of `fixed` relative to the viewport) and doesn't lock
   *  body-scroll. For the admin panel editor's live-preview. */
  inline?: boolean;
  children: ComponentChildren;
}

export function Modal({
  open,
  onClose,
  labelledBy,
  brandColor,
  topBanner,
  allowClose = true,
  hideCloseButton = false,
  inline = false,
  children
}: ModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;

    const dialog = dialogRef.current;
    if (dialog) {
      // Don't auto-focus the first interactive control. When the paywall
      // auto-opens (no preceding user gesture), the browser's focus-visible
      // heuristic draws a ring on whatever we focus — and the first focusable
      // is the first plan card (e.g. the monthly tariff), while the *selected*
      // plan is the popular one. The ring then sits on a different card than
      // the accent-border selection, which reads as two conflicting "active"
      // states and confuses users. Focus the dialog container itself instead
      // (tabIndex=-1, outline-none → no ring); the focus trap still has its
      // anchor inside the dialog and Tab walks the focusables normally.
      // A view that genuinely wants an input focused (e.g. an email field)
      // opts in explicitly via [data-pw-autofocus].
      const target = dialog.querySelector<HTMLElement>('[data-pw-autofocus]');
      (target ?? dialog).focus({ preventScroll: true });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!allowClose) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    // Inline-preview doesn't lock body-scroll: the host page (editor) must stay
    // clickable/scrollable while the modal lives inline.
    const prevOverflow = document.body.style.overflow;
    if (!inline) document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (!inline) document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose, allowClose, inline]);

  if (!open) return null;

  const onBackdrop = (e: MouseEvent) => {
    if (!allowClose) return;
    if (e.target === e.currentTarget) onClose();
  };

  const accent = brandColor ?? '#3b82f6';

  // Inline: the overlay sits in the host's `absolute inset-0` (the host is
  // itself absolute in its parent, see mount.ts). Production: `fixed inset-0`
  // relative to the viewport.
  const overlayClass = `${inline ? 'absolute z-[1]' : 'fixed z-[2147483647]'} inset-0 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4 backdrop-blur-md animate-[pw-fade-in_180ms_ease-out]`;

  return (
    <div
      class={overlayClass}
      onClick={onBackdrop}
      data-pw-root
    >
      {/* Wrapper over the dialog. topBanner (if passed) renders right here,
          sticking to the top of the dialog via `-mb-2 pb-5 rounded-t-xl
          rounded-b-none` — giving a visual overlap (the banner's rounded-top
          and the dialog's rounded-top are hidden under the banner), as in the
          legacy PaywallModal. */}
      {/* --pw-accent is defined on the wrapper (not on the dialog) — so the
          topBanner sibling inherits it too. Previously the variable sat on the
          dialog, and OfferTopBanner got an unstyled accent. */}
      <div
        class="relative flex w-full max-w-[400px] flex-col animate-[pw-scale-in_220ms_cubic-bezier(0.16,1,0.3,1)]"
        style={{ '--pw-accent': accent } as unknown as Record<string, string>}
      >
        {topBanner}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          // max-h caps the height at the viewport (uses dvh for the mobile
          // safe-area); flex-col + overflow on children gives an inner scroll
          // when content is taller than the viewport — critical for extension
          // popups (max 600px tall) and narrow containers on websites.
          class="relative flex max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl bg-white outline-none"
          style={{
            boxShadow:
              '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)'
          }}
        >
          {/* children structure the scroll/footer zones themselves (see
              Renderer.tsx): flex-1 min-h-0 overflow-y-auto for the scrollable
              part, the rest is the footer. Previously Modal wrapped everything
              in an overflow-y-auto wrapper, but that didn't let us pin the
              CTA footer to the bottom edge without the scroll overlapping the
              footer. */}
          {children}
          {allowClose && !hideCloseButton ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('modal.close_aria', 'Close')}
              // Absolute relative to the dialog (not the scrollable area) — the
              // button is always in the top-right corner of the dialog, doesn't
              // move with the scroll, and doesn't affect the content flow.
              class="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-gray-500 backdrop-blur-sm transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <style>{`
        @keyframes pw-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pw-scale-in {
          from { opacity: 0; transform: translateY(12px) scale(0.96) }
          to { opacity: 1; transform: none }
        }
      `}</style>
    </div>
  );
}
