import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';

type PriceGridBlock = Extract<LayoutBlock, { type: 'price_grid' }>;

interface FormattedPrice {
  /** Символ валюты (или ISO-код, если символ не определился). */
  currency: string;
  /** Целая часть, без разделителей дробной. */
  amount: string;
}

function formatPriceParts(price: PaywallPrice): FormattedPrice {
  const display = price.local ?? { currency: price.currency, amount: price.amount };
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: display.currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: display.amount % 1 === 0 ? 0 : 2,
      minimumFractionDigits: display.amount % 1 === 0 ? 0 : 2
    }).formatToParts(display.amount);
    let currency = '';
    let amount = '';
    for (const part of parts) {
      if (part.type === 'currency') {
        currency = part.value;
      } else if (part.type !== 'literal') {
        amount += part.value;
      }
    }
    return { currency: currency || display.currency, amount: amount.trim() };
  } catch {
    return { currency: display.currency, amount: String(display.amount) };
  }
}

function planLabel(price: PaywallPrice): string {
  if (price.label) return price.label.toUpperCase();
  if (!price.interval || price.interval === 'lifetime') return 'LIFETIME';
  const map: Record<string, string> = {
    day: 'DAILY PLAN',
    week: 'WEEKLY PLAN',
    month: 'MONTHLY PLAN',
    year: 'YEARLY PLAN'
  };
  return map[price.interval] ?? `${price.interval.toUpperCase()} PLAN`;
}

function intervalSuffix(price: PaywallPrice): string {
  if (!price.interval || price.interval === 'lifetime') return 'lifetime';
  const n = price.interval_count ?? 1;
  if (n === 1) return price.interval;
  return `${n} ${price.interval}s`;
}

export function PriceGrid({ block, ctx }: BlockProps<PriceGridBlock>) {
  const filter = block.priceIds && block.priceIds.length > 0 ? new Set(block.priceIds) : null;
  const prices = ctx.bootstrap.prices.filter((p) => !filter || filter.has(p.id));

  if (prices.length === 0) {
    return <p class="text-sm text-gray-500">No prices available.</p>;
  }

  const horizontal = block.view === 'horizontal';
  const popularLabel = block.popular_label ?? 'Most popular';

  // Horizontal: ряд из N карточек (max 3) — Tailwind purge не переживает
  // runtime-конкатенацию `grid-cols-${N}`, поэтому inline-style.
  const cols = horizontal ? Math.min(prices.length, 3) : 1;

  return (
    <div
      class={horizontal ? 'grid gap-2.5' : 'flex flex-col gap-2.5'}
      style={horizontal ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
      role="radiogroup"
      aria-label="Plans"
    >
      {prices.map((price) => {
        const selected = ctx.selectedPriceId === price.id;
        const isPopular = block.popular_price_id === price.id;
        const { currency, amount } = formatPriceParts(price);
        return (
          <button
            key={price.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              ctx.setSelectedPriceId(price.id);
              ctx.onAction('price_selected', { priceId: price.id, price });
            }}
            class={[
              'group relative flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]',
              selected
                ? 'border-[var(--pw-accent)] shadow-[0_0_0_1px_var(--pw-accent)]'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm',
              isPopular ? 'mt-2.5' : ''
            ].join(' ')}
          >
            {isPopular ? (
              <span
                class="absolute -top-2.5 left-4 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-sm"
                style={{
                  background:
                    'linear-gradient(135deg, var(--pw-accent), color-mix(in srgb, var(--pw-accent) 70%, black))'
                }}
              >
                {popularLabel}
              </span>
            ) : null}
            <div class="flex flex-1 flex-col gap-0.5">
              <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500">
                {planLabel(price)}
              </span>
              <div class="flex items-baseline gap-1.5 leading-none">
                <span class="text-[24px] font-normal text-gray-400">{currency}</span>
                <span class="text-[34px] font-semibold tracking-tight text-gray-900">
                  {amount}
                </span>
                <span class="ml-1 text-sm font-medium text-gray-400">
                  / {intervalSuffix(price)}
                </span>
              </div>
              {price.description ? (
                <span class="mt-1 text-xs leading-relaxed text-gray-500">{price.description}</span>
              ) : null}
              {price.trial_days ? (
                <span class="mt-1 text-xs font-medium text-[var(--pw-accent)]">
                  {price.trial_days}-day free trial
                </span>
              ) : null}
            </div>
            <span
              class={[
                'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
                selected
                  ? 'border-[var(--pw-accent)] bg-[var(--pw-accent)] text-white'
                  : 'border-gray-300 bg-white text-transparent group-hover:border-gray-400'
              ].join(' ')}
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>
        );
      })}
    </div>
  );
}
