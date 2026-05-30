import { useCallback, useSyncExternalStore } from 'react';
import type { PaywallStateSnapshot } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// Зеркалит CLOSED_STATE из PaywallUI.ts. Хранится локально, чтобы getSnapshot
// при paywall=null отдавал стабильную ссылку (та же ссылка между рендерами →
// useSyncExternalStore не дёргает лишний re-render). Не экспортируется
// наружу: для public API публичная форма доступна через usePaywallState().
//
// Shape проверяется в contract.ts — если PaywallStateSnapshot в SDK обзаведётся
// новым полем, TS-build sdk-react падает раньше, чем кто-то заметит расхождение.
const SSR_SNAPSHOT: PaywallStateSnapshot = {
  open: false,
  view: null,
  error: null,
  processing: false
};

/**
 * Подписка на состояние модалки пейвола: открыта/закрыта, текущий view,
 * последняя ошибка.
 *
 * Реализована поверх `paywall.onStateChange` + `paywall.getState` через
 * `useSyncExternalStore` — это даёт корректную concurrent-rendering семантику
 * (никаких tearing'ов, snapshot стабилен в рамках одного React-commit'а) и
 * минимум re-render'ов (snapshot равенство по `Object.is`).
 *
 * До mount-а Provider'а или на сервере возвращает `{ open: false, view: null,
 * error: null }` — это та же форма, что PaywallUI кладёт во внутренний
 * CLOSED_STATE, так что хосту не нужно отдельно проверять «инстанс готов».
 *
 * ```tsx
 * const { open, view } = usePaywallState();
 * useEffect(() => {
 *   if (open) analytics.track('paywall_seen');
 * }, [open]);
 * ```
 */
export function usePaywallState(): PaywallStateSnapshot {
  const paywall = usePaywall();

  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      if (!paywall) return () => {};
      // immediate: 'none' — useSyncExternalStore сам читает snapshot через
      // getSnapshot. Реплей initial-state'а через subscribe был бы лишним
      // вызовом cb, не приносящим новой информации.
      return paywall.onStateChange(cb, { immediate: 'none' });
    },
    [paywall]
  );

  const getSnapshot = useCallback((): PaywallStateSnapshot => {
    return paywall ? paywall.getState() : SSR_SNAPSHOT;
  }, [paywall]);

  return useSyncExternalStore(subscribe, getSnapshot, () => SSR_SNAPSHOT);
}
