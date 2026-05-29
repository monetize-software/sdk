'use client';

import { useState } from 'react';
import {
  usePaywallUser,
  usePaywall,
  PaywallButton
} from '@monetize.software/sdk-react';

/**
 * Demonstrates the three managed-auth entry points the SDK exposes:
 *
 *  - PaywallButton mode="signin"        — opens the modal in sign-in mode.
 *  - PaywallButton mode="signup"        — opens the modal in sign-up mode.
 *  - paywall.signInAnonymously()        — headless: no modal at all.
 *
 * `usePaywallUser()` lets us reflect the current state immediately.
 */
export default function LoginPage() {
  const account = usePaywallUser();
  const paywall = usePaywall();
  const [anonBusy, setAnonBusy] = useState(false);
  const [anonError, setAnonError] = useState<string | null>(null);
  const signedIn = account.status === 'signed_in';

  const handleAnon = async () => {
    if (!paywall) return;
    setAnonBusy(true);
    setAnonError(null);
    try {
      await paywall.signInAnonymously();
    } catch (err) {
      setAnonError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setAnonBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-6 py-20">
      <h1 className="text-3xl font-bold">Sign in to FocusFlow</h1>
      <p className="mt-2 text-stone-600 dark:text-stone-400">
        Pick the flow that fits your product.
      </p>

      <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
        {signedIn ? (
          <div className="space-y-3">
            <div className="text-sm">You're signed in.</div>
            <button
              type="button"
              onClick={() => paywall?.auth?.signOut()}
              className="w-full rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              Sign out
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <PaywallButton
              mode="signin"
              className="block w-full rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
            >
              Sign in with email / OAuth
            </PaywallButton>

            <PaywallButton
              mode="signup"
              className="block w-full rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              Create an account
            </PaywallButton>

            <div className="relative my-4 text-center text-xs uppercase tracking-wider text-stone-400">
              <span className="bg-white px-2 dark:bg-stone-900">or</span>
              <span className="absolute left-0 right-0 top-1/2 -z-0 h-px bg-stone-200 dark:bg-stone-800" />
            </div>

            <button
              type="button"
              onClick={handleAnon}
              disabled={anonBusy || !paywall}
              className="block w-full rounded-lg border border-dashed border-stone-300 px-4 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              {anonBusy ? 'Signing in…' : 'Continue as guest (headless)'}
            </button>
            {anonError && (
              <p className="text-xs text-rose-600">{anonError}</p>
            )}
            <p className="text-xs text-stone-500">
              The guest button calls{' '}
              <code className="rounded bg-stone-100 px-1 dark:bg-stone-800">
                paywall.signInAnonymously()
              </code>{' '}
              directly — no modal.
            </p>
          </div>
        )}
      </div>

      <PaywallButton
        mode="auth"
        render={({ open, ready }) => (
          <button
            type="button"
            onClick={open}
            disabled={!ready}
            className="mt-6 text-sm text-stone-500 underline-offset-2 hover:underline disabled:opacity-50"
          >
            Or use the auth-gate render prop →
          </button>
        )}
      />
    </div>
  );
}
