import { useCallback, useSyncExternalStore } from 'react';
import type { PaywallUser } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * Подписка на текущего юзера пейвола (sync snapshot + автоматический ре-рендер
 * на любой userChange — bootstrap, /me refresh, после-checkout watcher).
 *
 * Возвращает `null` до первого ответа сети или когда инстанс ещё не готов
 * (SSR / до useEffect Provider'а / Provider не оборачивает дерево с инстансом).
 *
 * Удобно для подсветки текущего плана / e-mail юзера в собственном UI без
 * необходимости держать дублирующий state и руками подписываться на
 * `paywall.on('userChange', ...)`.
 *
 * ```tsx
 * const user = usePaywallUser();
 * if (user?.has_active_subscription) {
 *   return <ProBadge plan={user.active_subscription?.plan_name} />;
 * }
 * ```
 *
 * Реализация поверх `paywall.on('userChange', cb)` + `billing.getCachedUser()`.
 * `paywall.on` не делает initial replay'я, поэтому useSyncExternalStore сам
 * читает старт-snapshot через getSnapshot — без лишних cb-вызовов.
 *
 * Ссылочная стабильность: BillingClient сравнивает user shape перед update'ом
 * (`sameUser`), так что между неизменными обновлениями `getCachedUser()`
 * возвращает ===-равный объект. Это гарантирует, что useSyncExternalStore
 * не дёргает ре-рендер при no-op refresh'ах.
 */
export function usePaywallUser(): PaywallUser | null {
  const paywall = usePaywall();

  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      if (!paywall) return () => {};
      return paywall.on('userChange', () => cb());
    },
    [paywall]
  );

  const getSnapshot = useCallback((): PaywallUser | null => {
    return paywall ? paywall.billing.getCachedUser() : null;
  }, [paywall]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getServerSnapshot(): PaywallUser | null {
  return null;
}
