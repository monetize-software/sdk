import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  brandColor?: string | null;
  /** Пейвол в тестовом режиме эквайринга — рисуем предупреждающую полоску сверху. */
  testMode?: boolean;
  /** Можно ли закрыть модалку: ESC, клик по overlay, крестик. По умолчанию true.
   *  false — модалка остаётся открытой до явного host-close() / success-purchase. */
  allowClose?: boolean;
  /** Inline-режим: overlay позиционируется `absolute inset:0` относительно host'а
   *  (вместо `fixed` относительно viewport'а), не лочит body-scroll. Для live-
   *  preview редактора админки. */
  inline?: boolean;
  children: ComponentChildren;
}

export function Modal({
  open,
  onClose,
  labelledBy,
  brandColor,
  testMode,
  allowClose = true,
  inline = false,
  children
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = (document.activeElement as HTMLElement) ?? null;

    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus({ preventScroll: true });
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
    // Inline-preview не лочит body-scroll: host-страница (редактор) должна
    // оставаться кликабельной/скроллабельной, пока модалка живёт inline.
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

  // Inline: overlay сидит в `absolute inset-0` host'а (host сам absolute в parent'е,
  // см. mount.ts). Production: `fixed inset-0` относительно viewport'а.
  const overlayClass = `${inline ? 'absolute z-[1]' : 'fixed z-[2147483647]'} inset-0 flex items-center justify-center bg-slate-950/50 p-2 sm:p-4 backdrop-blur-md animate-[pw-fade-in_180ms_ease-out]`;

  return (
    <div
      class={overlayClass}
      onClick={onBackdrop}
      data-pw-root
    >
      {/* Wrapper нужен, чтобы Test-mode плашку позиционировать absolute поверх
          верхнего-правого угла dialog'а (с -translate-y), не ломая anim/scroll
          dialog'а. У dialog'а оставляем overflow-hidden (rounded clipping для
          scroll-area), плашка сидит снаружи и не обрезается. */}
      <div class="relative w-full max-w-md animate-[pw-scale-in_220ms_cubic-bezier(0.16,1,0.3,1)]">
        {testMode && (
          <div
            class="absolute right-3 top-0 z-20 flex -translate-y-[calc(100%+6px)] items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-300 to-amber-400 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-950 shadow-[0_4px_12px_-2px_rgba(245,158,11,0.45),0_0_0_1px_rgba(255,255,255,0.6)]"
            role="status"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1L15 14H1L8 1Z"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
              <path d="M8 6v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
            </svg>
            Test mode — no real charge
          </div>
        )}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          // max-h ограничивает высоту вьюпортом (использует dvh для мобильных
          // safe-area), flex-col + overflow на children даёт внутренний скролл
          // когда контент выше viewport'а — критично для extension popup'ов
          // (max 600px высоты) и узких контейнеров на сайтах.
          class="relative flex max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-3xl bg-white outline-none ring-1 ring-black/5"
          style={
            {
              '--pw-accent': accent,
              boxShadow:
                '0 1px 2px rgba(15,23,42,0.04), 0 12px 32px -8px rgba(15,23,42,0.18), 0 24px 64px -16px rgba(15,23,42,0.22)'
            } as unknown as Record<string, string>
          }
        >
          <div class="flex-1 overflow-y-auto p-8">
            {children}
          </div>
          {allowClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              // Absolute относительно dialog'а (не scrollable area) — кнопка
              // всегда в правом верхнем углу dialog'а, не двигается со скроллом
              // и не влияет на flow контента.
              class="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/80 text-gray-400 backdrop-blur-sm transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
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
