import { useEffect, type ReactNode } from 'react';
import type { PaywallAccessResult } from '@monetize.software/sdk';
import { usePaywall } from '../hooks/usePaywall';
import { usePaywallAccess } from '../hooks/usePaywallAccess';

export interface PaywallGateProps {
  /** What to show until `getAccess()` returns an answer (initial fetch / Provider mount). */
  loading?: ReactNode;
  /**
   * Fallback for a `blocked` answer — usually an "Upgrade" CTA. Accepts either
   * a static ReactNode or a render function that receives an `open()` callback
   * — handy so a custom button can trigger the modal itself:
   *
   * ```tsx
   * fallback={({ open }) => <MyCTA onClick={open}>Upgrade</MyCTA>}
   * ```
   *
   * If not provided — the component renders `null` for blocked (the host relies
   * on `openOnBlocked` or catches open() itself via `usePaywall`).
   */
  fallback?: ReactNode | ((args: BlockedRenderArgs) => ReactNode);
  /**
   * Automatically trigger `paywall.open()` as soon as access turns to blocked.
   * Handy for feature dividers like "click and you land on the paywall": the
   * component opens the modal itself, no need to write onClick.
   *
   * Defaults to `false` — most hosts want to first show an explanatory CTA and
   * open the modal on click. Enable deliberately.
   */
  openOnBlocked?: boolean;
  /** Premium content. Rendered only when access=granted. */
  children: ReactNode;
}

export interface BlockedRenderArgs {
  result: Extract<PaywallAccessResult, { access: 'blocked' }>;
  open: () => void;
}

/**
 * A declarative wrapper over {@link usePaywallAccess} + {@link usePaywall}.open().
 *
 * Three states:
 *  - `loading` (first fetch / Provider not ready) — render `props.loading`;
 *  - `granted` (has subscription / visibility / trial) — render `children`;
 *  - `blocked` — render `fallback` (if provided) and optionally trigger
 *    `paywall.open()` when `openOnBlocked={true}`.
 *
 * ```tsx
 * <PaywallGate
 *   loading={<Skeleton />}
 *   fallback={({ open }) => <button onClick={open}>Upgrade</button>}
 * >
 *   <PremiumFeature />
 * </PaywallGate>
 * ```
 *
 * For non-standard scenarios (show "Try free trial" instead of upgrade,
 * combine with your own auth flow) use {@link usePaywallAccess} directly — the
 * gate handles 80% of cases without trying to become configurable for every
 * little thing.
 */
export function PaywallGate(props: PaywallGateProps): JSX.Element | null {
  const paywall = usePaywall();
  const access = usePaywallAccess();

  // `openOnBlocked` is a side-effect, hence in useEffect. We depend on access
  // through the `result.access` discriminator, not the whole object, so we
  // don't trigger open() on every getAccess refresh with the same blocked
  // result.
  const isBlocked =
    access.status === 'ready' && access.result.access === 'blocked';
  const shouldAutoOpen = props.openOnBlocked === true && isBlocked;

  useEffect(() => {
    if (shouldAutoOpen && paywall) paywall.open();
  }, [shouldAutoOpen, paywall]);

  if (access.status === 'loading') {
    return <>{props.loading ?? null}</>;
  }

  if (access.result.access === 'granted') {
    return <>{props.children}</>;
  }

  // blocked
  const fallback = props.fallback;
  if (typeof fallback === 'function') {
    return (
      <>
        {fallback({
          result: access.result,
          open: () => paywall?.open()
        })}
      </>
    );
  }
  return <>{fallback ?? null}</>;
}
