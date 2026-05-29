'use client';

import type { PaywallPrice } from '@monetize.software/sdk-react';
import { PaywallButton } from '@monetize.software/sdk-react';

interface Props {
  price: PaywallPrice;
  highlighted?: boolean;
}

/**
 * Reusable price card. Shows price/interval and opens the paywall
 * via PaywallButton — the modal handles checkout from there.
 */
export function PriceCard({ price, highlighted }: Props) {
  return (
    <div
      className={
        'flex flex-col rounded-2xl border p-6 ' +
        (highlighted
          ? 'border-brand-500 bg-white shadow-lg ring-2 ring-brand-200 dark:bg-stone-900'
          : 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900')
      }
    >
      {highlighted && (
        <div className="mb-2 inline-block self-start rounded-full bg-brand-500 px-2 py-0.5 text-xs font-semibold text-white">
          Most popular
        </div>
      )}
      <div className="text-sm uppercase tracking-wide text-stone-500">
        {price.label ?? planName(price)}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-4xl font-bold">{formatAmount(price)}</span>
        <span className="text-sm text-stone-500">/ {intervalLabel(price)}</span>
      </div>
      {price.description && (
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {price.description}
        </p>
      )}
      {price.trial_days ? (
        <p className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
          Includes a {price.trial_days}-day free trial.
        </p>
      ) : null}
      <div className="mt-6">
        <PaywallButton
          className={
            'w-full rounded-lg px-4 py-2.5 text-sm font-medium ' +
            (highlighted
              ? 'bg-brand-500 text-white hover:bg-brand-600'
              : 'border border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800')
          }
        >
          {price.trial_days ? `Start ${price.trial_days}-day trial` : 'Get this plan'}
        </PaywallButton>
      </div>
    </div>
  );
}

export function formatAmount(price: PaywallPrice): string {
  const amount = price.local?.amount ?? price.amount;
  const currency = price.local?.currency ?? price.currency;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: amount % 100 === 0 ? 0 : 2
  }).format(amount / 100);
}

export function intervalLabel(price: PaywallPrice): string {
  if (price.interval === 'lifetime' || price.interval == null) return 'one-time';
  const n = price.interval_count ?? 1;
  if (n === 1) return price.interval;
  return `${n} ${price.interval}s`;
}

function planName(price: PaywallPrice): string {
  switch (price.interval) {
    case 'year':
      return 'Annual';
    case 'month':
      return 'Monthly';
    case 'week':
      return 'Weekly';
    case 'lifetime':
      return 'Lifetime';
    default:
      return 'Plan';
  }
}
