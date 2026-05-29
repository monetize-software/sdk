import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AuthSession, PaywallUser } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * Состояние «кто такой текущий пользователь» с точки зрения хоста.
 *
 * Discriminated union намеренно совмещает три источника: готовность инстанса
 * PaywallUI (Provider mount), наличие session у managed-auth и `getCachedUser()`
 * от bootstrap'а. Это убирает у хоста нужду различать «пейвол ещё грузится»
 * vs «никого нет» вручную — типы сужают каждый случай.
 *
 *  - `loading` — Provider ещё не смонтировал PaywallUI (SSR / pre-mount /
 *     dev-double-mount cleanup). На этом этапе показывать skeleton.
 *  - `guest` — у пейвола нет identity:
 *      • managed-auth: `auth.getCachedSession()` вернул null;
 *      • hybrid (без managed-auth): bootstrap прошёл, но user-snapshot пуст.
 *     В этом состоянии валидно показать CTA «Sign in» / `<PaywallButton mode="signin">`.
 *  - `signed_in` — есть identity. `user` — последний снимок из BillingClient
 *     (может быть `null`, пока /me-refresh после signIn в полёте — UI должен
 *     показать skeleton, не «sign-in» CTA). `session` — managed-auth session
 *     или `null` для hybrid-режима.
 *
 * Хост обычно делает три проверки подряд:
 * ```tsx
 * const account = usePaywallUser();
 * if (account.status === 'loading') return <Skeleton />;
 * if (account.status === 'guest') return <SignInCTA />;
 * // account.user может быть null, пока /me грузится — показать skeleton тут же.
 * if (!account.user) return <Skeleton />;
 * return <Profile user={account.user} />;
 * ```
 *
 * Реализация подписана и на `userChange`, и на `authChange` — любой источник
 * меняющий status триггерит rerender. Snapshot reference закеширован через
 * useRef, чтобы useSyncExternalStore не словил infinite-loop на новых
 * объектах при каждом getSnapshot.
 */
export type PaywallUserState =
  | { status: 'loading'; user: null; session: null }
  | { status: 'guest'; user: null; session: null }
  | {
      status: 'signed_in';
      user: PaywallUser | null;
      session: AuthSession | null;
    };

const LOADING: PaywallUserState = { status: 'loading', user: null, session: null };
const GUEST: PaywallUserState = { status: 'guest', user: null, session: null };

export function usePaywallUser(): PaywallUserState {
  const paywall = usePaywall();
  // useRef-кэш предыдущего snapshot'а — обязателен для useSyncExternalStore.
  // Если каждый getSnapshot возвращает новый объект с теми же components,
  // React воспринимает это как изменение состояния и ловит infinite-loop
  // (или, в строгом режиме, валит warning'ом «getSnapshot should be cached»).
  const cacheRef = useRef<PaywallUserState>(LOADING);

  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      if (!paywall) return () => {};
      const unsubUser = paywall.on('userChange', () => cb());
      // authChange слушаем только в managed-auth режиме. В hybrid-режиме
      // authChange всё равно не эмитится — but defensive: paywall.auth
      // отсутствует, так что подписка просто пропускается.
      const unsubAuth = paywall.auth ? paywall.on('authChange', () => cb()) : null;
      return () => {
        unsubUser();
        unsubAuth?.();
      };
    },
    [paywall]
  );

  const getSnapshot = useCallback((): PaywallUserState => {
    if (!paywall) {
      cacheRef.current = LOADING;
      return LOADING;
    }

    const user = paywall.billing.getCachedUser();

    if (paywall.auth) {
      const session = paywall.auth.getCachedSession();
      if (!session) {
        cacheRef.current = GUEST;
        return GUEST;
      }
      const prev = cacheRef.current;
      if (
        prev.status === 'signed_in' &&
        prev.user === user &&
        prev.session === session
      ) {
        return prev;
      }
      const next: PaywallUserState = { status: 'signed_in', user, session };
      cacheRef.current = next;
      return next;
    }

    // hybrid (no managed-auth). identity приходит через open({identity}); до
    // этого момента billing.getCachedUser() вернёт null. Без session отличать
    // «host передал identity, user ещё грузится» от «гость» невозможно — так
    // что наличие user используем как сигнал signed-in.
    if (user) {
      const prev = cacheRef.current;
      if (
        prev.status === 'signed_in' &&
        prev.user === user &&
        prev.session === null
      ) {
        return prev;
      }
      const next: PaywallUserState = {
        status: 'signed_in',
        user,
        session: null
      };
      cacheRef.current = next;
      return next;
    }

    cacheRef.current = GUEST;
    return GUEST;
  }, [paywall]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getServerSnapshot(): PaywallUserState {
  return LOADING;
}
