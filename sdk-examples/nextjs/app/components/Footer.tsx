'use client';

import Link from 'next/link';
import { PaywallSupportButton } from '@monetize.software/sdk-react';

/**
 * Demonstrates PaywallSupportButton: shorthand for
 * `<PaywallButton mode="support" />`. Opens the support form
 * managed by the paywall instead of the pricing layout.
 */
export function Footer() {
  return (
    <footer className="border-t border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-950/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-6 text-sm text-stone-600 sm:flex-row sm:items-center sm:justify-between dark:text-stone-400">
        <div>© FocusFlow — a focus timer demo for @monetize.software SDK.</div>
        <div className="flex items-center gap-4">
          <Link href="/pricing" className="hover:text-brand-600">
            Pricing
          </Link>
          <PaywallSupportButton className="text-sm underline-offset-2 hover:text-brand-600 hover:underline">
            Contact support
          </PaywallSupportButton>
        </div>
      </div>
    </footer>
  );
}
