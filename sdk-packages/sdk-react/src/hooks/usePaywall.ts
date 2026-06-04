import { useContext } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { PaywallContext, PaywallProviderMarker } from '../context';

/**
 * Pulls the PaywallUI instance from the nearest {@link PaywallProvider}.
 *
 * Throws if called outside a Provider — that's an outright programming bug, not
 * a runtime flow. On SSR / before the Provider's useEffect it returns `null`
 * (the Provider exists, but the instance isn't mounted yet).
 *
 * The vast majority of paywalls need `paywall.open()`,
 * `paywall.openSupport()`, event subscriptions from the host — for all of that
 * usePaywall() is the most direct path:
 *
 * ```tsx
 * const paywall = usePaywall();
 * <button onClick={() => paywall?.open()}>Upgrade</button>
 * ```
 *
 * For typical cases (gating, state-driven UI) the specialized hooks are usually
 * more convenient: {@link usePaywallState}, {@link usePaywallAccess},
 * {@link usePaywallUser}.
 */
export function usePaywall(): PaywallUI | null {
  const hasProvider = useContext(PaywallProviderMarker);
  const paywall = useContext(PaywallContext);

  if (!hasProvider) {
    throw new Error(
      '[sdk-react] usePaywall() called outside <PaywallProvider>. ' +
        'Wrap your tree with <PaywallProvider options={...}> or pass an ' +
        'externally-created instance via <PaywallProvider instance={paywall}>.'
    );
  }

  return paywall;
}
