import { useCallback, useSyncExternalStore } from 'react';
import type { PaywallOffer } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * Cached offers list, refreshed on every `ready` event (= bootstrap refresh).
 *
 * Returns `null` before bootstrap loads, then the server-filtered offer list
 * (server-side targeting on countries / emails / mode is already applied).
 * Client code is still responsible for `price_id` matching (use
 * `findApplicableOffer` from `@monetize.software/sdk` or the higher-level
 * `usePaywallOffer(priceId)` hook).
 *
 * Mostly useful for hosts that want to iterate offers manually (e.g. render
 * a global "Limited offer" banner above the page). For per-price strike-
 * through + countdown, `usePaywallOffer(priceId)` is the right primitive.
 */
export function usePaywallOffers(): PaywallOffer[] | null {
  const paywall = usePaywall();

  const subscribe = useCallback(
    (cb: () => void): (() => void) => {
      if (!paywall) return () => {};
      return paywall.on('ready', () => cb());
    },
    [paywall]
  );

  const getSnapshot = useCallback((): PaywallOffer[] | null => {
    return paywall ? paywall.getCachedOffers() : null;
  }, [paywall]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getServerSnapshot(): PaywallOffer[] | null {
  return null;
}
