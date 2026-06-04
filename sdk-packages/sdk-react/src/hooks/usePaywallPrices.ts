import { useEffect, useState } from 'react';
import type { PaywallPrice } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * `prices` — the cached snapshot of bootstrap.prices (`null` before the first
 * fetch or when the instance isn't ready yet).
 * `loading` — true while the first request is in flight, always false after the
 * first response.
 * `error` — the last fetch error (`null` if successful or not yet failed).
 *
 * Deliberately no discriminating field like `status: 'loading'|'ready'|'error'`
 * as in `usePaywallAccess`, because for pricing the host usually needs three
 * independent values at once (show the previous list + skeleton + an error
 * message on top) — a discriminated union here only complicates things.
 */
export interface PaywallPricesState {
  prices: PaywallPrice[] | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Loads and subscribes to the paywall's prices. Suitable for a standalone
 * pricing page / pricing cards, where the host wants to show the same prices
 * as in the modal without opening the paywall.
 *
 * Implementation:
 *  - an initial sync read via `getCachedPrices()` (if the bootstrap is already
 *    in BillingClient's cache — for example, after `paywall.preload()` or a
 *    previous open — prices are available instantly);
 *  - `useEffect` calls `getPrices()` to guarantee loading;
 *  - a subscription to the `ready` event — refetching the bootstrap on a new
 *    open() can bring updated prices, and we refresh the snapshot.
 *
 * ```tsx
 * const { prices, loading } = usePaywallPrices();
 * if (loading && !prices) return <Skeleton />;
 * return prices?.map((p) => <PriceCard key={p.id} price={p} />);
 * ```
 */
export function usePaywallPrices(): PaywallPricesState {
  const paywall = usePaywall();
  const [state, setState] = useState<PaywallPricesState>(() => ({
    prices: paywall?.getCachedPrices() ?? null,
    loading: true,
    error: null
  }));

  useEffect(() => {
    if (!paywall) {
      setState({ prices: null, loading: true, error: null });
      return;
    }

    // Sync access via the cached snapshot — if the bootstrap is already loaded,
    // show prices immediately (without a "loading → ready" flash).
    const cached = paywall.getCachedPrices();
    setState({ prices: cached, loading: cached === null, error: null });

    const ctrl = new AbortController();
    let cancelled = false;

    const refresh = () => {
      paywall
        .getPrices({ signal: ctrl.signal })
        .then((prices) => {
          if (cancelled) return;
          setState({ prices, loading: false, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled || ctrl.signal.aborted) return;
          setState((prev) => ({
            prices: prev.prices,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error))
          }));
        });
    };

    refresh();

    // The `ready` event fires from an opened paywall with the final bootstrap —
    // if the host opened/closed the modal, the prices may have updated via
    // stale-while-revalidate. We listen so the numbers on the pricing page
    // don't diverge from what the user will see in the modal.
    const unsub = paywall.on('ready', () => {
      const fresh = paywall.getCachedPrices();
      if (fresh) setState({ prices: fresh, loading: false, error: null });
    });

    return () => {
      cancelled = true;
      ctrl.abort();
      unsub();
    };
  }, [paywall]);

  return state;
}
