'use client';

import { PaywallProvider } from '@monetize.software/sdk-react';
import type { ReactNode } from 'react';

/**
 * FocusFlow wires the SDK with `auth: true` so the paywall manages
 * its own session lifecycle — signin, signup and anonymous flows
 * are all handled by the modal and by `paywall.auth` directly.
 *
 * Read env vars at module scope: PaywallProvider memoizes on the
 * first mount, so changing them across renders would not pick up.
 */
const paywallId = process.env.NEXT_PUBLIC_PAYWALL_ID;
const apiOrigin = process.env.NEXT_PUBLIC_PAYWALL_API_ORIGIN;

export function Providers({ children }: { children: ReactNode }) {
  if (!paywallId || !apiOrigin) {
    return (
      <div className="mx-auto mt-24 max-w-xl rounded-lg border border-amber-300 bg-amber-50 p-6 text-amber-900">
        <h2 className="mb-2 text-lg font-semibold">SDK is not configured</h2>
        <p className="text-sm">
          Set <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_PAYWALL_ID</code> and{' '}
          <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_PAYWALL_API_ORIGIN</code> in{' '}
          <code className="rounded bg-amber-100 px-1">.env.local</code> and restart{' '}
          <code className="rounded bg-amber-100 px-1">next dev</code>.
        </p>
      </div>
    );
  }

  return (
    <PaywallProvider
      options={{
        paywallId,
        apiOrigin,
        auth: true,
        analytics: { enabled: true }
      }}
    >
      {children}
    </PaywallProvider>
  );
}
