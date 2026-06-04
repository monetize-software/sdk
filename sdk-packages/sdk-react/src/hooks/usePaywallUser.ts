import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { AuthSession, PaywallUser } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * The "who is the current user" state from the host's point of view.
 *
 * The discriminated union deliberately combines three sources: readiness of the
 * PaywallUI instance (Provider mount), presence of a managed-auth session, and
 * `getCachedUser()` from bootstrap. This frees the host from manually
 * distinguishing "the paywall is still loading" vs "nobody is here" — the types
 * narrow each case.
 *
 *  - `loading` — the Provider has not mounted PaywallUI yet (SSR / pre-mount /
 *     dev-double-mount cleanup). Show a skeleton at this stage.
 *  - `guest` — the paywall has no identity:
 *      • managed-auth: `auth.getCachedSession()` returned null;
 *      • hybrid (without managed-auth): bootstrap completed, but the user
 *        snapshot is empty.
 *     In this state it is valid to show a "Sign in" CTA / `<PaywallButton mode="signin">`.
 *  - `signed_in` — identity exists. `user` is the latest snapshot from
 *     BillingClient (may be `null` while the /me-refresh after signIn is in
 *     flight — the UI should show a skeleton, not a "sign-in" CTA). `session` is
 *     the managed-auth session, or `null` in hybrid mode.
 *
 * The host typically runs three checks in a row:
 * ```tsx
 * const account = usePaywallUser();
 * if (account.status === 'loading') return <Skeleton />;
 * if (account.status === 'guest') return <SignInCTA />;
 * // account.user may be null while /me is loading — show a skeleton right here.
 * if (!account.user) return <Skeleton />;
 * return <Profile user={account.user} />;
 * ```
 *
 * The implementation subscribes to both `userChange` and `authChange` — any
 * source that changes status triggers a rerender. The snapshot reference is
 * cached via useRef so that useSyncExternalStore does not hit an infinite loop
 * on new objects on every getSnapshot.
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
  // useRef cache of the previous snapshot — required for useSyncExternalStore.
  // If every getSnapshot returns a new object with the same components,
  // React treats it as a state change and hits an infinite loop (or, in strict
  // mode, fires the "getSnapshot should be cached" warning).
  const cacheRef = useRef<PaywallUserState>(LOADING);

  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      if (!paywall) return () => {};
      const unsubUser = paywall.on('userChange', () => cb());
      // We listen to authChange only in managed-auth mode. In hybrid mode
      // authChange is never emitted anyway — but defensively: paywall.auth is
      // absent, so the subscription is simply skipped.
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

    // hybrid (no managed-auth). identity arrives via open({identity}); until
    // that moment billing.getCachedUser() returns null. Without a session it is
    // impossible to tell "host passed identity, user still loading" from
    // "guest" — so we use the presence of a user as the signed-in signal.
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
