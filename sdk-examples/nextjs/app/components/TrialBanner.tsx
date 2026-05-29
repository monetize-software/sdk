'use client';

import { usePaywallTrial } from '@monetize.software/sdk-react';

/**
 * Demonstrates usePaywallTrial(): displays a banner when the
 * paywall is in a pre-paywall trial period (opens-mode or time-mode).
 *
 * Renders nothing when trial is disabled or already exhausted.
 */
export function TrialBanner() {
  const trial = usePaywallTrial();

  if (!trial || trial.mode === 'none' || !trial.blocked) return null;

  return (
    <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-center text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
      {trial.mode === 'opens' ? (
        <>
          You're on a free preview — <strong>{trial.remainingActions}</strong> of{' '}
          {trial.totalActions} sessions left before the paywall kicks in.
        </>
      ) : (
        <>
          Free trial active — <strong>{formatRemaining(trial.remainingMs)}</strong>{' '}
          remaining.
        </>
      )}
    </div>
  );
}

function formatRemaining(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
