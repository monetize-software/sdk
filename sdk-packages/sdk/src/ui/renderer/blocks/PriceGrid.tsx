import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';

type PriceGridBlock = Extract<LayoutBlock, { type: 'price_grid' }>;

function formatPrice(price: PaywallPrice): string {
  const display = price.local ?? { currency: price.currency, amount: price.amount };
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: display.currency,
      maximumFractionDigits: display.amount % 1 === 0 ? 0 : 2
    }).format(display.amount);
  } catch {
    return `${display.amount} ${display.currency}`;
  }
}

function intervalLabel(price: PaywallPrice): string {
  if (!price.interval || price.interval === 'lifetime') return 'one-time';
  const n = price.interval_count ?? 1;
  if (n === 1) return `per ${price.interval}`;
  return `every ${n} ${price.interval}s`;
}

export function PriceGrid({ block, ctx }: BlockProps<PriceGridBlock>) {
  const filter = block.priceIds && block.priceIds.length > 0 ? new Set(block.priceIds) : null;
  const prices = ctx.bootstrap.prices.filter((p) => !filter || filter.has(p.id));

  if (prices.length === 0) {
    return <p class="text-sm text-gray-500">No prices available.</p>;
  }

  const horizontal = block.view === 'horizontal';
  const popularLabel = block.popular_label ?? 'Most popular';

  // Horizontal раскладывает карточки в ряд через CSS grid. Кол-во колонок
  // = min(N,3) — задаём через inline-style, потому что Tailwind purge не
  // переживает runtime-конкатенацию `grid-cols-${N}`. Карточки в горизонтали
  // выкладывают цену снизу, не справа — иначе при N≥3 не хватает ширины.
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
              'group relative rounded-2xl border px-4 py-3.5 text-left transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]',
              horizontal
                ? 'flex w-full flex-col items-start gap-1'
                : 'flex w-full items-center justify-between gap-3',
              selected
                ? 'border-[var(--pw-accent)] bg-[color-mix(in_srgb,var(--pw-accent)_6%,white)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--pw-accent)_12%,transparent)]'
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
            <div class={horizontal ? 'flex w-full items-start gap-2.5' : 'flex flex-1 items-start gap-2.5'}>
              <span
                class={[
                  'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
                  selected
                    ? 'border-[var(--pw-accent)] bg-[var(--pw-accent)]'
                    : 'border-gray-300 bg-white group-hover:border-gray-400'
                ].join(' ')}
                aria-hidden="true"
              >
                {selected ? <span class="h-1.5 w-1.5 rounded-full bg-white" /> : null}
              </span>
              <div class="flex flex-col">
                <span class="text-sm font-semibold text-gray-900">{price.label ?? intervalLabel(price)}</span>
                {price.description ? (
                  <span class="text-xs leading-relaxed text-gray-500">{price.description}</span>
                ) : null}
                {price.trial_days ? (
                  <span class="text-xs font-medium text-[var(--pw-accent)]">
                    {price.trial_days}-day free trial
                  </span>
                ) : null}
              </div>
            </div>
            <div class={horizontal ? 'mt-1 flex flex-col items-start' : 'flex flex-col items-end'}>
              <span class="text-base font-semibold tracking-tight text-gray-900">{formatPrice(price)}</span>
              <span class="text-[11px] text-gray-500">{intervalLabel(price)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
