import { useEffect, useState } from 'react';
import type {
  GetAccessOptions,
  PaywallAccessResult
} from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * `loading` — the first fetch is still in flight (or the Provider isn't ready).
 * `ready` — there's a fresh answer; `result` is guaranteed non-null.
 *
 * Made a discriminated union so the host can narrow the type with a single if:
 *
 *   `if (access.status === 'ready') access.result.access === 'granted'`
 */
export type PaywallAccessState =
  | { status: 'loading'; result: null }
  | { status: 'ready'; result: PaywallAccessResult };

const LOADING_STATE: PaywallAccessState = { status: 'loading', result: null };

/**
 * The main hook for feature gating: "should this feature be blocked for this
 * user?".
 *
 * Under the hood — `paywall.getAccess(opts)` without side-effects (the modal
 * isn't mounted, the trial-storage isn't moved). On every `userChange` event it
 * auto-refetches — after a successful purchase `has_subscription` fires
 * instantly, and the host re-renders the UI without a feature-lock.
 *
 * The bootstrap is cached in BillingClient, so usePaywallAccess can be called
 * in any component of the tree — there will be exactly one network request (or
 * none, if the cache is fresh).
 *
 * ```tsx
 * const access = usePaywallAccess();
 * const paywall = usePaywall();
 *
 * if (access.status === 'loading') return <Skeleton />;
 * if (access.result.access === 'blocked') {
 *   return <button onClick={() => paywall?.open()}>Upgrade</button>;
 * }
 * return <PremiumFeature />;
 * ```
 *
 * The `opts` are deserialized by `skipTrial`/`skipVisibility` — a stable `opts`
 * reference isn't required, the effect restarts only when these flags actually
 * change. We drop `signal` from the deps (it has a new ref on each render) —
 * cancellation of the inflight request is done locally via AbortController in
 * the cleanup effect.
 */
export function usePaywallAccess(opts: GetAccessOptions = {}): PaywallAccessState {
  const paywall = usePaywall();
  const [state, setState] = useState<PaywallAccessState>(LOADING_STATE);

  const skipTrial = opts.skipTrial === true;
  const skipVisibility = opts.skipVisibility === true;

  useEffect(() => {
    if (!paywall) {
      // The instance is gone (Provider unmount / StrictMode cleanup) — honestly
      // return loading so the host doesn't show a stale result from the
      // previous instance.
      setState(LOADING_STATE);
      return;
    }

    const ctrl = new AbortController();
    let cancelled = false;

    const refresh = () => {
      paywall
        .getAccess({ skipTrial, skipVisibility, signal: ctrl.signal })
        .then((result) => {
          if (cancelled || ctrl.signal.aborted) return;
          // Each refresh gives a new object — useState will see !== and
          // re-render. That's fine: for gating the `access` field is what
          // matters, the rest (visibility/trial snapshots) are auxiliary data
          // that shouldn't change the host's decision on the same inputs.
          setState({ status: 'ready', result });
        })
        .catch(() => {
          // getAccess() has its own offline-fallback and doesn't throw on a
          // failed network — we only land here on an abort, which comes from
          // the cleanup effect. Silently ignore.
        });
    };

    refresh();

    // userChange covers both sources of a decision update:
    //  - the post-checkout watcher emits userChange when has_subscription=true
    //  - a manual /me refresh from the host (paywall.billing.getUser())
    // We additionally listen to purchase_completed for symmetry — on some
    // payment providers userChange may be delayed, whereas purchase_completed
    // flies instantly via a URL marker / postMessage.
    const unsubUser = paywall.on('userChange', refresh);
    const unsubPurchase = paywall.on('purchase_completed', refresh);

    return () => {
      cancelled = true;
      ctrl.abort();
      unsubUser();
      unsubPurchase();
    };
  }, [paywall, skipTrial, skipVisibility]);

  return state;
}
