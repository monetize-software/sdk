'use client';

import { usePaywallVisibility } from '@monetize.software/sdk-react';

/**
 * Demonstrates usePaywallVisibility(): the server-computed
 * targeting snapshot. When `visible: false`, the paywall will
 * silently no-op on open(); some hosts prefer to surface that
 * (e.g. "monetization is off in your region") explicitly.
 */
export function VisibilityBadge() {
  const visibility = usePaywallVisibility();
  if (!visibility) return null;
  if (visibility.visible) return null;

  return (
    <div className="border-b border-sky-200 bg-sky-50 px-6 py-2 text-center text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
      Premium plans aren't offered in your region
      {visibility.country ? ` (${visibility.country})` : ''}. You can still use the
      free tier.
    </div>
  );
}
