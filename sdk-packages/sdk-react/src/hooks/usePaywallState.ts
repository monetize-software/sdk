import { useCallback, useSyncExternalStore } from 'react';
import type { PaywallStateSnapshot } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// Mirrors CLOSED_STATE from PaywallUI.ts. Kept locally so that getSnapshot,
// when paywall=null, returns a stable reference (the same reference between
// renders → useSyncExternalStore doesn't trigger an extra re-render). Not
// exported outside: for the public API the public shape is available via
// usePaywallState().
//
// The shape is checked in contract.ts — if PaywallStateSnapshot in the SDK
// gains a new field, the sdk-react TS build fails before anyone notices the
// mismatch.
const SSR_SNAPSHOT: PaywallStateSnapshot = {
  open: false,
  view: null,
  error: null,
  processing: false
};

/**
 * A subscription to the paywall modal's state: open/closed, current view, last
 * error.
 *
 * Implemented on top of `paywall.onStateChange` + `paywall.getState` via
 * `useSyncExternalStore` — this gives correct concurrent-rendering semantics
 * (no tearing, the snapshot is stable within a single React commit) and a
 * minimum of re-renders (snapshot equality by `Object.is`).
 *
 * Before the Provider mounts or on the server it returns `{ open: false, view:
 * null, error: null }` — the same shape PaywallUI puts into the internal
 * CLOSED_STATE, so the host doesn't need to separately check "instance ready".
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
      // immediate: 'none' — useSyncExternalStore reads the snapshot itself via
      // getSnapshot. Replaying the initial state through subscribe would be a
      // redundant cb call bringing no new information.
      return paywall.onStateChange(cb, { immediate: 'none' });
    },
    [paywall]
  );

  const getSnapshot = useCallback((): PaywallStateSnapshot => {
    return paywall ? paywall.getState() : SSR_SNAPSHOT;
  }, [paywall]);

  return useSyncExternalStore(subscribe, getSnapshot, () => SSR_SNAPSHOT);
}
