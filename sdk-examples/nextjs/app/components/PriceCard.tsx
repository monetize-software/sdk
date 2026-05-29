'use client';

import type { PaywallPrice } from '@monetize.software/sdk-react';
import { PaywallButton, usePaywallOffer } from '@monetize.software/sdk-react';

interface Props {
  price: PaywallPrice;
  highlighted?: boolean;
}

/**
 * Reusable price card. Reads the live offer via `usePaywallOffer(priceId)` —
 * strike-through original, discounted amount, and a 1Hz countdown all stay
 * in sync with what the modal shows.
 */
export function PriceCard({ price, highlighted }: Props) {
  const offer = usePaywallOffer(price.id);
  const display = formatPrice(price, offer?.discountPercent ?? 0);

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

      {display.original && (
        <div className="mt-2 flex items-center gap-2 text-sm">
          <s className="text-stone-400">{display.original}</s>
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800">
            -{offer?.discountPercent}%
          </span>
        </div>
      )}

      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-4xl font-bold">{display.amount}</span>
        <span className="text-sm text-stone-500">/ {display.suffix}</span>
      </div>

      {offer && offer.remainingMs !== null && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
          Offer ends in {formatCountdown(offer.remainingMs)}
        </div>
      )}

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

/**
 * Convenience formatter — same logic the SDK renderer applies to the modal.
 * Yearly plans show the per-month equivalent in the main amount; the
 * strike-through original is kept in the same currency for a clear "was X, now Y".
 */
function formatPrice(price: PaywallPrice, discountPercent: number) {
  const source = price.local ?? { amount: price.amount, currency: price.currency };
  const months = price.interval === 'year' ? (price.interval_count ?? 1) * 12 : 1;
  const base = source.amount / months;
  const discounted = discountPercent > 0 ? base * (1 - discountPercent / 100) : base;
  return {
    amount: formatCurrency(discounted, source.currency),
    original: discountPercent > 0 ? formatCurrency(base, source.currency) : null,
    suffix: priceSuffix(price)
  };
}

function priceSuffix(price: PaywallPrice): string {
  if (price.interval === 'lifetime' || price.interval == null) return 'one-time';
  if (price.interval === 'year') return 'month';
  const n = price.interval_count ?? 1;
  return n === 1 ? price.interval : `${n} ${price.interval}s`;
}

function formatCurrency(value: number, currency: string): string {
  const minFrac = value % 1 !== 0 ? 2 : 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: minFrac,
    minimumFractionDigits: minFrac
  }).format(value);
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s.toString().padStart(2, '0')}s`;
  }
  return `${m}m ${s.toString().padStart(2, '0')}s`;
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

/** Total billed amount (no per-month split) — used by the comparison table. */
export function formatFullAmount(price: PaywallPrice): string {
  const source = price.local ?? { amount: price.amount, currency: price.currency };
  return formatCurrency(source.amount, source.currency);
}

/** Real interval — for tables/lists where the per-month split isn't applied. */
export function realIntervalLabel(price: PaywallPrice): string {
  if (price.interval === 'lifetime' || price.interval == null) return 'one-time';
  const n = price.interval_count ?? 1;
  if (n === 1) return price.interval;
  return `${n} ${price.interval}s`;
}
