'use client';

import {
  usePaywallPrices,
  usePaywallUser,
  PaywallButton,
  PaywallSupportButton
} from '@monetize.software/sdk-react';
import { PriceCard, formatAmount, intervalLabel } from '../components/PriceCard';

/**
 * Demonstrates:
 *  - usePaywallPrices — full price list straight from the SDK.
 *  - usePaywallUser   — show "current plan" badge for the active subscription.
 *  - PaywallButton    — both default and `renew` variants.
 */
export default function PricingPage() {
  const { prices, loading, error } = usePaywallPrices();
  const user = usePaywallUser();
  const isPro = user?.has_active_subscription === true;

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Simple, honest pricing</h1>
        <p className="mx-auto mt-3 max-w-xl text-stone-600 dark:text-stone-400">
          One paywall powers everything below. Prices, trial offers and currency are
          pulled live from{' '}
          <code className="rounded bg-stone-100 px-1 text-sm dark:bg-stone-800">
            usePaywallPrices()
          </code>
          .
        </p>
      </header>

      {isPro && (
        <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
          You already have an active subscription. Want to switch plans?{' '}
          <PaywallButton
            renew
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Open renewal flow
          </PaywallButton>
        </div>
      )}

      <section className="mt-12">
        {loading && !prices ? (
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-64 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800"
              />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-xl border border-rose-300 bg-rose-50 p-6 text-rose-900">
            Failed to load prices: {error.message}
          </div>
        ) : prices && prices.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-3">
            {prices.map((p, i) => (
              <PriceCard
                key={p.id}
                price={p}
                highlighted={i === Math.floor(prices.length / 2)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 p-12 text-center text-stone-500">
            No plans configured.
          </div>
        )}
      </section>

      {prices && prices.length > 0 && (
        <section className="mt-16">
          <h2 className="mb-4 text-lg font-semibold">All plans compared</h2>
          <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:bg-stone-950/40">
                <tr>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Interval</th>
                  <th className="px-4 py-3">Trial</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-stone-100 last:border-0 dark:border-stone-800"
                  >
                    <td className="px-4 py-3 font-medium">{p.label ?? p.id}</td>
                    <td className="px-4 py-3">{formatAmount(p)}</td>
                    <td className="px-4 py-3 capitalize">{intervalLabel(p)}</td>
                    <td className="px-4 py-3">
                      {p.trial_days ? `${p.trial_days} days` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <PaywallButton className="rounded-md border border-stone-300 px-3 py-1 text-xs font-medium hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800">
                        Choose
                      </PaywallButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-16 rounded-2xl bg-stone-100 p-8 text-center dark:bg-stone-900">
        <h3 className="text-xl font-semibold">Questions about a plan?</h3>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          Tap below to open the in-app support form.
        </p>
        <PaywallSupportButton className="mt-4 rounded-lg border border-stone-300 bg-white px-5 py-2 text-sm font-medium hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-950 dark:hover:bg-stone-800">
          Talk to us
        </PaywallSupportButton>
      </section>
    </div>
  );
}
