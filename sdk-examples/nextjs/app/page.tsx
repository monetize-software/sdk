'use client';

import Link from 'next/link';
import {
  usePaywallPrices,
  usePaywallState,
  PaywallButton
} from '@monetize.software/sdk-react';
import { PriceCard } from './components/PriceCard';

/**
 * Landing page.
 *
 * Demonstrates:
 *  - usePaywallPrices — render the same pricing as the modal, inline.
 *  - usePaywallState  — pulse the CTA while the paywall is opening.
 *  - PaywallButton    — primary CTA (default mode='paywall').
 */
export default function Home() {
  const { prices, loading } = usePaywallPrices();
  const { open: modalOpen } = usePaywallState();

  const teaserPrices = (prices ?? []).slice(0, 3);

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-12 text-center">
        <span className="inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-medium text-brand-800">
          Stay in flow. Ship more.
        </span>
        <h1 className="mt-4 text-5xl font-bold tracking-tight sm:text-6xl">
          A focus timer that <span className="text-brand-500">respects</span> your time.
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-stone-600 dark:text-stone-400">
          FocusFlow blocks distractions, tracks your deep-work streaks and helps you
          design Pomodoro sessions you actually want to repeat.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <PaywallButton
            className={
              'rounded-lg bg-brand-500 px-6 py-3 text-base font-semibold text-white hover:bg-brand-600 ' +
              (modalOpen ? 'animate-pulse' : '')
            }
          >
            Try Pro for free
          </PaywallButton>
          <Link
            href="/app"
            className="rounded-lg border border-stone-300 px-6 py-3 text-base font-semibold hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-900"
          >
            Open the app
          </Link>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          No credit card needed for the free tier.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold">Plans, straight from your paywall</h2>
            <p className="mt-2 text-stone-600 dark:text-stone-400">
              These cards render with{' '}
              <code className="rounded bg-stone-100 px-1 dark:bg-stone-800">
                usePaywallPrices()
              </code>{' '}
              — same source of truth the modal uses.
            </p>
          </div>
          <Link
            href="/pricing"
            className="hidden text-sm font-medium text-brand-600 hover:underline sm:block"
          >
            See full pricing →
          </Link>
        </div>

        {loading && !prices ? (
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-56 animate-pulse rounded-2xl bg-stone-200 dark:bg-stone-800"
              />
            ))}
          </div>
        ) : teaserPrices.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 p-12 text-center text-stone-500 dark:border-stone-700">
            No plans available yet — check your paywall configuration.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {teaserPrices.map((p, i) => (
              <PriceCard
                key={p.id}
                price={p}
                highlighted={i === Math.floor(teaserPrices.length / 2)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-8 sm:grid-cols-3">
          {[
            {
              title: 'Distraction-free timer',
              body: 'Three Pomodoro presets, ambient sounds and a full-screen focus mode that hides the rest of your browser.'
            },
            {
              title: 'Deep-work analytics',
              body: 'Free for the last seven days. Pro keeps the full history and ships weekly streak reports to your inbox.'
            },
            {
              title: 'Theme it like you mean it',
              body: 'Six pro themes, custom CSS for the timer, and exportable CSVs of every session.'
            }
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900"
            >
              <h3 className="text-lg font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
