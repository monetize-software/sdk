'use client';

import Link from 'next/link';
import {
  usePaywallUser,
  usePaywall,
  PaywallButton
} from '@monetize.software/sdk-react';

/**
 * Demonstrates:
 *  - usePaywallUser()  — current PaywallUser snapshot (live).
 *  - usePaywall()      — direct handle for `signOut` via paywall.auth.
 *  - PaywallButton     — declarative trigger with `mode="signin"`.
 */
export function Navbar() {
  const user = usePaywallUser();
  const paywall = usePaywall();
  const isPro = user?.has_active_subscription === true;

  return (
    <header className="border-b border-stone-200 bg-white/70 backdrop-blur dark:border-stone-800 dark:bg-stone-950/70">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-6 w-6 rounded-md bg-brand-500" />
          <span>FocusFlow</span>
        </Link>

        <div className="hidden gap-4 text-sm md:flex">
          <Link href="/app" className="hover:text-brand-600">
            App
          </Link>
          <Link href="/pricing" className="hover:text-brand-600">
            Pricing
          </Link>
          <Link href="/account" className="hover:text-brand-600">
            Account
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isPro && (
            <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800">
              PRO
            </span>
          )}

          {user ? (
            <button
              type="button"
              onClick={() => paywall?.auth?.signOut()}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
            >
              Sign out
            </button>
          ) : (
            <PaywallButton
              mode="signin"
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
            >
              Sign in
            </PaywallButton>
          )}

          <PaywallButton className="rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600">
            {isPro ? 'Manage plan' : 'Upgrade'}
          </PaywallButton>
        </div>
      </nav>
    </header>
  );
}
