'use client';

import {
  usePaywallUser,
  usePaywall,
  usePaywallVisibility,
  usePaywallTrial,
  PaywallButton,
  PaywallSupportButton
} from '@monetize.software/sdk-react';

/**
 * Demonstrates:
 *  - usePaywallUser       — read identity, subscription and purchases.
 *  - usePaywall           — direct handle for sign-out and getUserLanguage().
 *  - usePaywallVisibility — surface region targeting.
 *  - usePaywallTrial      — surface trial state.
 */
export default function AccountPage() {
  const account = usePaywallUser();
  const paywall = usePaywall();
  const visibility = usePaywallVisibility();
  const trial = usePaywallTrial();

  if (account.status === 'loading') {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="h-8 w-48 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
        <div className="mt-6 h-40 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800" />
      </div>
    );
  }

  if (account.status === 'guest') {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-bold">Your account</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          Sign in to manage your subscription.
        </p>
        <div className="mt-6 flex gap-3">
          <PaywallButton
            mode="signin"
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            Sign in
          </PaywallButton>
          <PaywallButton
            mode="signup"
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
          >
            Create account
          </PaywallButton>
        </div>
      </div>
    );
  }

  // status === 'signed_in' but the /me snapshot may still be in flight.
  if (!account.user) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="h-8 w-48 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
        <div className="mt-6 h-40 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800" />
      </div>
    );
  }

  const user = account.user;
  const lang = paywall?.getUserLanguage();
  const activePurchase = user.purchases.find(
    (p) => p.status === 'active' || p.status === 'trialing'
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Your account</h1>
          <p className="mt-1 text-stone-600 dark:text-stone-400">
            Signed in via paywall managed auth.
          </p>
        </div>
        <button
          type="button"
          onClick={() => paywall?.auth?.signOut()}
          className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
        >
          Sign out
        </button>
      </header>

      <section className="mt-8 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Subscription
        </h2>
        {user.has_active_subscription ? (
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                Active
              </span>
              <span className="text-stone-600 dark:text-stone-400">
                You have full access to FocusFlow Pro.
              </span>
            </div>
            {activePurchase?.current_period_end && (
              <div className="text-stone-600 dark:text-stone-400">
                Renews on{' '}
                <strong>
                  {new Date(activePurchase.current_period_end).toLocaleDateString()}
                </strong>
                {activePurchase.cancel_at_period_end ? ' (cancels at period end)' : ''}.
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <PaywallButton
                renew
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800"
              >
                Switch plan
              </PaywallButton>
              <PaywallSupportButton className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800">
                Cancel / refund
              </PaywallSupportButton>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3 text-sm">
            <p className="text-stone-600 dark:text-stone-400">
              You're on the free plan.
            </p>
            <PaywallButton className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
              Upgrade to Pro
            </PaywallButton>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Purchase history
        </h2>
        {user.purchases.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">No purchases yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100 dark:divide-stone-800">
            {user.purchases.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between py-3 text-sm"
              >
                <span className="font-mono text-xs text-stone-500">{p.id}</span>
                <span className="capitalize">{p.status ?? 'unknown'}</span>
                <span className="text-stone-600 dark:text-stone-400">
                  {p.current_period_end
                    ? `until ${new Date(p.current_period_end).toLocaleDateString()}`
                    : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          Debug snapshot
        </h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <DT label="Trial mode" value={trial?.mode ?? '—'} />
          <DT
            label="Trial blocked"
            value={trial ? String(trial.blocked) : '—'}
          />
          <DT
            label="Region visibility"
            value={
              visibility
                ? visibility.visible
                  ? `visible (${visibility.country ?? '—'})`
                  : `blocked: ${visibility.reason}`
                : '—'
            }
          />
          <DT label="Applied locale" value={lang?.applied ?? '—'} />
          <DT label="Had previous trial" value={String(user.had_previous_trial)} />
        </dl>
      </section>
    </div>
  );
}

function DT({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-0.5 font-mono">{value}</dd>
    </div>
  );
}
