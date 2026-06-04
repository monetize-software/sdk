import { useEffect, useRef } from 'react';
import type { PaywallEvent, PaywallEventHandler } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// We get a specific event's payload type via `Parameters<PaywallEventHandler<E>>[0]`,
// because `PaywallEventPayloads` itself is declared locally in the SDK and not
// exported. The `Parameters<>` approach is resilient to this: as long as
// `PaywallEventHandler` is in the public surface, we infer the SDK payload type
// correctly — the sdk-react TS build fails if the `PaywallEventHandler` signature drifts.
type EventPayload<E extends PaywallEvent> = Parameters<PaywallEventHandler<E>>[0];

/**
 * A declarative subscription to a PaywallUI event. A wrapper over
 * `paywall.on(event, cb)` with two important differences from a manual
 * useEffect:
 *
 * 1. The handler doesn't need to be memoized via `useCallback` — internally we
 *    keep the latest version in `useRef`, and the subscription itself is
 *    recreated only when `event` or the paywall instance changes. This
 *    eliminates a class of bugs around "forgot useCallback → the subscription
 *    unsubscribes-resubscribes on every render → events get lost".
 *
 * 2. Correctly handles `paywall === null` (SSR / before Provider mount): the
 *    subscription just isn't created, it waits until the instance appears.
 *
 * ```tsx
 * usePaywallEvent('purchase_completed', (payload) => {
 *   toast.success(`Покупка ${payload.priceId} прошла`);
 *   queryClient.invalidateQueries(['user']);
 * });
 * ```
 *
 * For self-cleaning logic (the host emitting analytics, invalidating caches,
 * hydrating local state) this is the most direct pattern — the component is
 * guaranteed to unsubscribe on unmount, and there's no need to keep
 * unsub-refs by hand.
 */
export function usePaywallEvent<E extends PaywallEvent>(
  event: E,
  handler: PaywallEventHandler<E>
): void {
  const paywall = usePaywall();
  const handlerRef = useRef(handler);

  // Update the ref on every render — the next event firing will pick up the
  // fresh handler. No separate useEffect, because a synchronous assign in the
  // render phase is correct for a ref and doesn't violate the rules-of-hooks.
  handlerRef.current = handler;

  useEffect(() => {
    if (!paywall) return;
    return paywall.on(event, (payload) => {
      // The cast is necessary because the generic `PaywallEventHandler` loses
      // narrowing by `E`. handlerRef.current is typed for the concrete E, but
      // `on()` accepts a union — the runtime shape is guaranteed by the SDK's emit.
      (handlerRef.current as (p: EventPayload<E>) => void)(payload);
    });
  }, [paywall, event]);
}
