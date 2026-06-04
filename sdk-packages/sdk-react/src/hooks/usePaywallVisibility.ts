import { useCallback, useEffect, useState } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// `VisibilityStatus` is not exported locally from the SDK — we derive it via
// ReturnType of the public `getVisibility()`. See usePaywallTrial for the same
// reasoning.
type VisibilityStatus = NonNullable<ReturnType<PaywallUI['getVisibility']>>;

/**
 * Server-computed visibility snapshot ({@link VisibilityStatus}): whether the
 * user falls within the paywall's monetization scope (country, device, manual
 * visibility flag).
 *
 * Returns `null` until bootstrap has loaded or the server has not returned
 * `settings.visibility` (older online without the targeting patch).
 *
 * Use it to:
 *  - show your own fallback ("service unavailable in your country") instead of
 *    the modal when `visible === false`;
 *  - log an impression for analytics on the user's country/tier;
 *  - decide which CTA to render without calling open() and without waiting for
 *    the visibility_blocked event.
 *
 * ```tsx
 * const visibility = usePaywallVisibility();
 * if (visibility && !visibility.visible) {
 *   return <SoftBlock reason={visibility.reason} />;
 * }
 * ```
 */
export function usePaywallVisibility(): VisibilityStatus | null {
  const paywall = usePaywall();
  const [visibility, setVisibility] = useState<VisibilityStatus | null>(() =>
    paywall?.getVisibility() ?? null
  );

  const sync = useCallback(() => {
    if (!paywall) {
      setVisibility(null);
      return;
    }
    setVisibility(paywall.getVisibility());
  }, [paywall]);

  useEffect(() => {
    if (!paywall) {
      setVisibility(null);
      return;
    }
    sync();

    // The `ready` event fires after a successful bootstrap — that's when
    // `lastVisibility` in PaywallUI is updated. `visibility_blocked` fires when
    // the block actually triggers at the gate. Both change the snapshot.
    const unsubReady = paywall.on('ready', sync);
    const unsubBlocked = paywall.on('visibility_blocked', sync);

    return () => {
      unsubReady();
      unsubBlocked();
    };
  }, [paywall, sync]);

  return visibility;
}
