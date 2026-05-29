import { useEffect, useRef, useState } from 'react';
import type { ResolvedOffer } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

/**
 * Reactive resolved offer for a given price.
 *
 * Returns the same shape as `paywall.getOfferForPrice(priceId)`, plus a live
 * countdown — re-renders every second while there's a positive `remainingMs`,
 * stops ticking when the offer expires (one final re-render brings the value
 * to `null`). Re-fetches on `ready` event too, so a bootstrap refresh that
 * brings new offers reflects immediately.
 *
 * Returns `null` when:
 *  - Provider isn't mounted yet (SSR / pre-mount);
 *  - bootstrap hasn't loaded the offers list;
 *  - no offer targets this price (no targeted match, no global offer);
 *  - the matching offer is a `duration_minutes`-only timer that hasn't been
 *    started yet (i.e. the paywall hasn't been opened by this user). The
 *    renderer writes the start on first paywall view — refreshing the page
 *    after the first view will then surface the countdown here.
 *  - the matching offer has already expired.
 *
 * ```tsx
 * const offer = usePaywallOffer(price.id);
 *
 * if (!offer) return <span>{formatAmount(price.amount)}</span>;
 *
 * const discounted = price.amount * (1 - offer.discountPercent / 100);
 * return (
 *   <>
 *     <s>{formatAmount(price.amount)}</s>
 *     <strong>{formatAmount(discounted)}</strong>
 *     <Badge>-{offer.discountPercent}%</Badge>
 *     {offer.remainingMs !== null && <Countdown ms={offer.remainingMs} />}
 *   </>
 * );
 * ```
 *
 * Implementation: a single `setInterval(1000)` ticks while there's a live
 * countdown. The PaywallUI handle is read on each tick, so a Provider re-mount
 * doesn't leave a stale closure.
 */
export function usePaywallOffer(priceId: string): ResolvedOffer | null {
  const paywall = usePaywall();
  const [snapshot, setSnapshot] = useState<ResolvedOffer | null>(() =>
    paywall ? paywall.getOfferForPrice(priceId) : null
  );

  // Stable ref to the latest priceId so a re-keyed interval-callback always
  // resolves against the current price (avoids re-creating the timer on every
  // identical-id rerender — only the close-over priceId would have changed).
  const priceIdRef = useRef(priceId);
  priceIdRef.current = priceId;

  useEffect(() => {
    if (!paywall) {
      setSnapshot(null);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const next = paywall.getOfferForPrice(priceIdRef.current);
      setSnapshot(next);
      return next;
    };

    // Initial sync (covers Provider mount + price_id changes).
    const current = refresh();

    const unsubReady = paywall.on('ready', () => refresh());

    // Tick only if there's actually a live countdown — for offers without
    // expiry we just react to `ready` events.
    let interval: ReturnType<typeof setInterval> | null = null;
    if (current && current.remainingMs !== null) {
      interval = setInterval(() => {
        const next = refresh();
        if (!next || next.remainingMs === null || next.remainingMs <= 0) {
          if (interval) clearInterval(interval);
          interval = null;
        }
      }, 1000);
    }

    return () => {
      cancelled = true;
      unsubReady();
      if (interval) clearInterval(interval);
    };
  }, [paywall, priceId]);

  return snapshot;
}
