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
  /** Контент, который приклеивается сверху dialog'а внутри overlay (rounded-top,
   *  с лёгким negative-margin для визуального overlap). Используется для
   *  offer-countdown баннера (PaywallRoot решает рисовать его, если в
   *  bootstrap.offers есть активный таймер). */
  topBanner?: ComponentChildren;
  /** Можно ли закрыть модалку: ESC, клик по overlay, крестик. По умолчанию true.
   *  false — модалка остаётся открытой до явного host-close() / success-purchase. */
  allowClose?: boolean;
  /** Скрыть X-крестик (но оставить ESC/overlay рабочими). Используется когда
   *  view внутри модалки рисует свою Back-кнопку (AuthGate, SupportGate) —
   *  две одновременные кнопки в правом верхнем углу путают и визуально
   *  накладываются. */
  hideCloseButton?: boolean;
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
      {/* Wrapper над dialog'ом. topBanner (если передан) рендерится тут же,
          приклеивается к верху dialog'а через `-mb-2 pb-5 rounded-t-xl
          rounded-b-none` — даёт визуальный overlap (rounded-top банера и
          rounded-top dialog'а скрыты под банером), как в легаси PaywallModal. */}
      {/* --pw-accent определяется на wrapper'е (не на dialog'е) — чтобы
          topBanner-sibling тоже его наследовал. Раньше переменная сидела на
          dialog, и OfferTopBanner получал unstyled accent. */}
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
          // max-h ограничивает высоту вьюпортом (использует dvh для мобильных
          // safe-area), flex-col + overflow на children даёт внутренний скролл
          // когда контент выше viewport'а — критично для extension popup'ов
          // (max 600px высоты) и узких контейнеров на сайтах.
          class="relative flex max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl bg-white outline-none"
          style={{
            boxShadow:
              '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)'
          }}
        >
          {/* children сами структурируют scroll/footer-зоны (см. Renderer.tsx):
              flex-1 min-h-0 overflow-y-auto для scrollable, остаток — footer.
              Раньше Modal оборачивал в обёртку overflow-y-auto, но это не
              позволяло прибить CTA-footer к нижней кромке без overlap скролла
              с footer'ом. */}
          {children}
          {allowClose && !hideCloseButton ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('modal.close_aria', 'Close')}
              // Absolute относительно dialog'а (не scrollable area) — кнопка
              // всегда в правом верхнем углу dialog'а, не двигается со скроллом
              // и не влияет на flow контента.
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
