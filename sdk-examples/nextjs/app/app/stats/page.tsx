'use client';

import { usePaywallAccess, PaywallButton } from '@monetize.software/sdk-react';

const FREE_DAYS = 7;
const PRO_DAYS = 90;

/**
 * Demonstrates fine-grained gating with usePaywallAccess:
 * everyone sees stats, but the time window is gated.
 */
export default function StatsPage() {
  const access = usePaywallAccess();
  const isPro = access.status === 'ready' && access.result.access === 'granted';
  const days = isPro ? PRO_DAYS : FREE_DAYS;
  const data = mockSessions(days);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold">Focus stats</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          Showing the last {days} days
          {isPro ? '' : ' — free tier window.'}
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sessions" value={data.length.toString()} />
        <Stat
          label="Total minutes"
          value={data.reduce((a, b) => a + b.minutes, 0).toLocaleString()}
        />
        <Stat
          label="Average / day"
          value={Math.round(
            data.reduce((a, b) => a + b.minutes, 0) / days
          ).toString()}
        />
      </section>

      <section className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-stone-500">
          Daily activity
        </h2>
        <div className="flex h-32 items-end gap-1">
          {data.map((d) => (
            <div
              key={d.day}
              title={`${d.day}: ${d.minutes}m`}
              className="flex-1 rounded-t bg-brand-500/80"
              style={{ height: `${(d.minutes / 120) * 100}%` }}
            />
          ))}
        </div>
      </section>

      {!isPro && (
        <section className="rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-6 dark:border-stone-700 dark:bg-stone-950/40">
          <h3 className="text-base font-semibold">Get the full 90-day history</h3>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Pro keeps your data around and sends a weekly streak summary by email.
          </p>
          <PaywallButton className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">
            Upgrade to Pro
          </PaywallButton>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <div className="text-xs uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function mockSessions(days: number) {
  return Array.from({ length: days }).map((_, i) => ({
    day: `D-${days - i}`,
    minutes: 25 + ((i * 17 + 13) % 90)
  }));
}
