import { useCallback, useEffect, useState } from 'react';
import type { PaywallUI } from '@monetize.software/sdk';
import { usePaywall } from './usePaywall';

// `TrialStatus` isn't exported from the SDK locally, but we obtain it via
// ReturnType inference on the public method `getTrialStatus()`. This way the
// type always matches what PaywallUI actually returns, without depending on a
// non-public SDK namespace.
type TrialStatus = NonNullable<ReturnType<PaywallUI['getTrialStatus']>>;

/**
 * The current trial status ({@link TrialStatus}) with an automatic re-render on
 * `trial_blocked` events.
 *
 * Returns `null` while the trial hasn't been checked (the host hasn't called
 * `paywall.open()` / `paywall.getAccess()`) or the trial is disabled in the
 * paywall config. The trial state itself lives in storage (localStorage /
 * chrome.storage), is checked in `paywall.open()` and in `paywall.getAccess()`
 * — both paths update the in-memory snapshot that we read here.
 *
 * Use it to draw your own UI:
 *  - "You have 3 showings left" (mode `opens`) — `status.remainingActions`;
 *  - "Trial expires in 2 hours" (mode `time`) — `status.remainingMs`;
 *  - "Trial is blocked, pay to continue" — `status.blocked === true`.
 *
 * ```tsx
 * const trial = usePaywallTrial();
 * if (trial?.mode === 'opens') {
 *   return <Banner>Showings left: {trial.remainingActions}</Banner>;
 * }
 * ```
 */
export function usePaywallTrial(): TrialStatus | null {
  const paywall = usePaywall();
  const [status, setStatus] = useState<TrialStatus | null>(() =>
    paywall?.getTrialStatus() ?? null
  );

  // A stable refresh for the effect — a separate function so the effect's deps
  // array stays clean (`[paywall]`), without useCallback chains.
  const sync = useCallback(() => {
    if (!paywall) {
      setStatus(null);
      return;
    }
    setStatus(paywall.getTrialStatus());
  }, [paywall]);

  useEffect(() => {
    if (!paywall) {
      setStatus(null);
      return;
    }
    // Sync read on mount — getTrialStatus() may have updated between the
    // previous render and the effect (for example, the hook was called after
    // the first open()).
    sync();

    // `trial_blocked` is the only event after which the snapshot actually
    // changes. `trial_expired` fires once per instance lifetime and doesn't
    // change the status shape (the status becomes `mode: 'none'` OR transitions
    // to un-blocked mode, which is read through sync() anyway).
    const unsubBlock = paywall.on('trial_blocked', sync);
    const unsubExpired = paywall.on('trial_expired', sync);

    return () => {
      unsubBlock();
      unsubExpired();
    };
  }, [paywall, sync]);

  return status;
}
