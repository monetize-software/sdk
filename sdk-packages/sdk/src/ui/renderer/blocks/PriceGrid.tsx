import type { LayoutBlock, PaywallOffer, PaywallPrice } from '../../../core/types';
import { findLiveOffer, readBrowserOfferStart } from '../../../core/offer';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type PriceGridBlock = Extract<LayoutBlock, { type: 'price_grid' }>;

interface FormattedPrice {
  /** Currency symbol (or ISO code if the symbol could not be resolved). */
  currency: string;
  /** Integer part, without fractional separators. */
  amount: string;
  /** Original (without discount), formatted — for strike-through. null if
   *  there is no discount or discount=0%. */
  originalAmount: string | null;
}

// The year plan shows the per-month equivalent right in the main price:
//   YEARLY PLAN €4.99 / month   (instead of €59.99 / year)
// This is legacy UX from online/PaywallPricing.tsx (`unit_amount / 12`):
// the user cares about the monthly cost to compare with the monthly plan, while the yearly
// charge is a detail that should not dominate the typography. planLabel
// stays "YEARLY PLAN", so the billed cadence is still clear from the
// name.
function displayedAmount(price: PaywallPrice): { amount: number; currency: string } {
  const display = price.local ?? { currency: price.currency, amount: price.amount };
  if (price.interval === 'year') {
    const months = (price.interval_count ?? 1) * 12;
    return { amount: display.amount / months, currency: display.currency };
  }
  return { amount: display.amount, currency: display.currency };
}

// Formats a number into a currency string without literals, splitting the currency symbol
// from the numeric part. Used both for the main price and for the strike-through
// original (in which case no discount needs to be applied — the value is already base).
// Fractional part is automatic: integer → "$8", non-integer → "$4.99". Integers without .00 convert
// better — the eye catches a short number faster.
function formatCurrencyParts(value: number, currency: string): {
  currency: string;
  amount: string;
} {
  const minFrac = value % 1 !== 0 ? 2 : 0;
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: minFrac,
      minimumFractionDigits: minFrac
    }).formatToParts(value);
    let cur = '';
    let amount = '';
    for (const part of parts) {
      if (part.type === 'currency') {
        cur = part.value;
      } else if (part.type !== 'literal') {
        amount += part.value;
      }
    }
    return { currency: cur || currency, amount: amount.trim() };
  } catch {
    return { currency, amount: String(value) };
  }
}

function formatPriceParts(price: PaywallPrice, discountPercent: number | null): FormattedPrice {
  const { amount: base, currency: cur } = displayedAmount(price);
  if (!discountPercent) {
    const { currency, amount } = formatCurrencyParts(base, cur);
    return { currency, amount, originalAmount: null };
  }
  const discounted = base * (1 - discountPercent / 100);
  const main = formatCurrencyParts(discounted, cur);
  const original = formatCurrencyParts(base, cur);
  // We show the strike-through in full (`€59.99`/`€9.99` — with the currency sign),
  // so the user immediately sees the old price in the same currency, no guessing.
  return {
    currency: main.currency,
    amount: main.amount,
    originalAmount: `${original.currency}${original.amount}`
  };
}

// Selecting the active offer is extracted into `core/offer.ts:findLiveOffer` —
// an expiry-aware wrapper over findApplicableOffer (it drops expired offers,
// so the strike-through/discount disappear in sync with the countdown banner).

function planLabel(price: PaywallPrice, t: TFn): string {
  if (price.label) return price.label.toUpperCase();
  if (!price.interval || price.interval === 'lifetime') {
    return t('pricing.plan_label.lifetime', 'LIFETIME');
  }
  const map: Record<string, { key: string; fallback: string }> = {
    day: { key: 'pricing.plan_label.daily', fallback: 'DAILY PLAN' },
    week: { key: 'pricing.plan_label.weekly', fallback: 'WEEKLY PLAN' },
    month: { key: 'pricing.plan_label.monthly', fallback: 'MONTHLY PLAN' },
    year: { key: 'pricing.plan_label.yearly', fallback: 'YEARLY PLAN' }
  };
  const entry = map[price.interval];
  if (entry) return t(entry.key, entry.fallback);
  return `${price.interval.toUpperCase()} PLAN`;
}

// Suffix after the price. Year → "month" (because amount is already /12, see
// displayedAmount). Lifetime → "lifetime". Everything else — the singular interval
// or "N intervals" for interval_count > 1.
function intervalSuffix(price: PaywallPrice, t: TFn): string {
  if (!price.interval || price.interval === 'lifetime') {
    return t('pricing.interval.lifetime_short', 'lifetime');
  }
  if (price.interval === 'year') return t('pricing.interval.month', 'month');
  const n = price.interval_count ?? 1;
  if (n === 1) return t(`pricing.interval.${price.interval}`, price.interval);
  return `${n} ${price.interval}s`;
}

export function PriceGrid({ block, ctx }: BlockProps<PriceGridBlock>) {
  const { t } = useI18n();
  const filter = block.priceIds && block.priceIds.length > 0 ? new Set(block.priceIds) : null;
  const prices = ctx.bootstrap.prices.filter((p) => !filter || filter.has(p.id));

  if (prices.length === 0) {
    return <p class="text-sm text-gray-500">{t('pricing.no_prices', 'No prices available.')}</p>;
  }

  const popularLabel = block.popular_label ?? t('pricing.most_popular', 'Most popular');

  // Compact mode — a telegram-style list: a thin backing card around
  // all rows (rounded-xl + light bg + 1px border). Dividers between
  // rows are `border-b` on the inner label-wrapper of CompactRow (except
  // the last). Mirrors the legacy PaywallPricing wrapper: for a non-default view
  // it draws `rounded-xl border-1 border-default-200 bg-default-50` —
  // separating the price block from the rest of the layout.
  // The v2 storage key is `view: 'telegram'`, bootstrap normalizes it to 'compact'.
  if (block.view === 'compact') {
    return (
      <div
        class="flex w-full flex-col rounded-xl border border-gray-200 bg-gray-50"
        role="radiogroup"
        aria-label={t('pricing.plans_aria', 'Plans')}
      >
        {prices.map((price, idx) => (
          <CompactRow
            key={price.id}
            price={price}
            isLast={idx === prices.length - 1}
            isPopular={block.popular_price_id === price.id}
            popularLabel={popularLabel}
            offer={findLiveOffer(ctx.bootstrap.offers, price.id, { readStart: readBrowserOfferStart })}
            selected={ctx.selectedPriceId === price.id}
            onSelect={() => {
              ctx.setSelectedPriceId(price.id);
              ctx.onAction('price_selected', { priceId: price.id, price });
            }}
            t={t}
          />
        ))}
      </div>
    );
  }

  // Horizontal mode — a real grid of side-by-side cards. The v2 storage key
  // `view: 'row'` (SDK 3.0 only — old legacy paywalls don't select this
  // key; bootstrap normalizes it to 'horizontal'). max 3 columns; with 1-2
  // prices they stretch the row. Tailwind purge does not survive a runtime grid-cols-N,
  // hence the inline gridTemplateColumns.
  if (block.view === 'horizontal') {
    const cols = Math.min(prices.length, 3);
    // If at least one price in the grid has a discount, we reserve a strike-row
    // of fixed height in ALL cards (otherwise the main amount without a discount
    // jumps above its discounted neighbors). If there is no offer at all, the strike-row
    // collapses to 0 in all of them, and there's no 22px of empty space hanging under the label.
    const anyHasDiscount = prices.some(
      (p) => (findLiveOffer(ctx.bootstrap.offers, p.id, { readStart: readBrowserOfferStart })?.discount_percent ?? 0) > 0
    );
    return (
      <div
        class="grid items-stretch gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        role="radiogroup"
        aria-label={t('pricing.plans_aria', 'Plans')}
      >
        {prices.map((price) => (
          <RowCard
            key={price.id}
            price={price}
            isPopular={block.popular_price_id === price.id}
            popularLabel={popularLabel}
            offer={findLiveOffer(ctx.bootstrap.offers, price.id, { readStart: readBrowserOfferStart })}
            reserveStrikeRow={anyHasDiscount}
            selected={ctx.selectedPriceId === price.id}
            onSelect={() => {
              ctx.setSelectedPriceId(price.id);
              ctx.onAction('price_selected', { priceId: price.id, price });
            }}
            t={t}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      class="flex flex-col gap-2"
      role="radiogroup"
      aria-label={t('pricing.plans_aria', 'Plans')}
    >
      {prices.map((price) => {
        const selected = ctx.selectedPriceId === price.id;
        const isPopular = block.popular_price_id === price.id;
        const offer = findLiveOffer(ctx.bootstrap.offers, price.id, { readStart: readBrowserOfferStart });
        const discountPercent = offer?.discount_percent ?? null;
        const { currency, amount, originalAmount } = formatPriceParts(price, discountPercent);
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
              'group relative inline-flex w-full mx-auto items-center justify-between flex-row-reverse gap-4 rounded-2xl border-2 px-4 py-3.5 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]',
              // border 2px everywhere — selection is expressed by color only, the layout
              // does not jump (equal thickness for selected/unselected). The color
              // difference accent vs gray is strong enough for visual hierarchy.
              selected
                ? 'border-[var(--pw-accent)] bg-transparent'
                : 'border-gray-200 bg-transparent hover:bg-gray-50'
            ].join(' ')}
          >
            <span
              class={[
                'flex h-6.5 w-6.5 flex-shrink-0 items-center justify-center rounded-full border transition-colors',
                selected
                  ? 'border-[var(--pw-accent)] text-white'
                  : 'border-gray-300 bg-transparent text-transparent',
                // The popular-label badge sits absolute at the top-right of the card and
                // visually shifts the content's center down. flex items-center
                // on the card keeps the checkmark at the geometric center, which
                // makes it look too high — we compensate with a small mt.
                isPopular ? 'mt-3' : ''
              ].join(' ')}
              style={
                selected
                  ? {
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 70%, white) 0%, var(--pw-accent) 50%, color-mix(in srgb, var(--pw-accent) 85%, black) 100%)'
                    }
                  : undefined
              }
              aria-hidden="true"
            >
              <svg
                width="14"
                height="10"
                viewBox="0 0 17 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                class={selected ? 'opacity-100' : 'opacity-0'}
              >
                <path
                  d="M16.5234 0.476562C16.9805 0.898438 16.9805 1.63672 16.5234 2.05859L7.52344 11.0586C7.10156 11.5156 6.36328 11.5156 5.94141 11.0586L1.44141 6.55859C0.984375 6.13672 0.984375 5.39844 1.44141 4.97656C1.86328 4.51953 2.60156 4.51953 3.02344 4.97656L6.75 8.66797L14.9414 0.476562C15.3633 0.0195312 16.1016 0.0195312 16.5234 0.476562Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <div class="flex flex-1 flex-col gap-0.5">
              {/* Label + strike+badge on one line (flex-wrap for narrow
                  cards) — a compact 2-row layout instead of 3-row. Tags go
                  to the right of the label with a gap, wrapping on overflow. */}
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-xs font-normal uppercase tracking-normal text-gray-800/70">
                  {planLabel(price, t)}
                </span>
                {originalAmount ? (
                  // opacity-60 mutes the strike: the eye catches the label
                  // and discount badge first, then the main price; the original "former price"
                  // is tertiary info and should not compete with the label.
                  <span class="text-[15px] font-normal text-gray-400 opacity-60 line-through decoration-gray-400 decoration-[1.5px]">
                    {originalAmount}
                  </span>
                ) : null}
                {discountPercent ? (
                  // Emerald pill — a fixed "success/savings", independent of
                  // brand_color. Readable even on dark brand accents.
                  <span class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold leading-none text-emerald-700">
                    -{discountPercent}%
                  </span>
                ) : null}
              </div>
              <div class="flex items-baseline gap-2 flex-wrap">
                <span class="text-[26px] leading-tight whitespace-nowrap text-gray-800 font-medium">
                  <span class="opacity-90">{currency}</span>{amount}
                  <span class="text-sm font-normal text-gray-500">
                    {' '}/ {intervalSuffix(price, t)}
                  </span>
                </span>
              </div>
              {price.description ? (
                <span class="mt-1 text-xs leading-relaxed text-gray-500">{price.description}</span>
              ) : null}
            </div>
            {isPopular ? (
              <span
                // Solid accent + white text — high contrast; in a glasses-test
                // the eye picks out the popular choice immediately. The pastel variant
                // competed in visual weight with the price itself and worked
                // neither as a highlight nor as information.
                class="absolute -top-[9px] -right-[6px] rounded-[11px] border-[5px] border-white px-2 py-1 text-[12px] font-semibold text-white"
                style={{ background: 'var(--pw-accent)' }}
              >
                {popularLabel}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// A short one-word label for compact mode ("Month" / "Year" / "Lifetime")
// instead of the long "MONTHLY PLAN". Mirrors the legacy `getIntervalName` for
// TelegramPricingRadio: the more compact the row, the more compact the label, otherwise
// the text starts competing with the price.
function compactLabel(price: PaywallPrice, t: TFn): string {
  if (price.label) return price.label;
  if (!price.interval || price.interval === 'lifetime') {
    return t('pricing.interval.lifetime_short', 'lifetime');
  }
  return t(`pricing.interval.${price.interval}`, price.interval);
}

// A compact row for compact mode. Mirrors the legacy `TelegramPricingRadio`:
//   [radio] | [label + popular-pill]  ······  [strike+badge ▸ price]
// Dividers live on the inner label-wrapper (`border-b`), the last
// row without a border. Selection is expressed only by the color of the radio circle —
// no bg-tint, so it doesn't conflict with the pricing grid. Fonts — text-md
// without bold, as in legacy (heroui text-md ≈ 16px).
function CompactRow({
  price,
  isLast,
  isPopular,
  popularLabel,
  offer,
  selected,
  onSelect,
  t
}: {
  price: PaywallPrice;
  isLast: boolean;
  isPopular: boolean;
  popularLabel: string;
  offer: PaywallOffer | null;
  selected: boolean;
  onSelect: () => void;
  t: TFn;
}) {
  const discountPercent = offer?.discount_percent ?? null;
  const { currency, amount, originalAmount } = formatPriceParts(price, discountPercent);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      class="group relative inline-flex w-full max-w-[360px] mx-auto items-center justify-between gap-4 px-4 pt-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--pw-accent)]"
    >
      <span
        class={[
          'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border transition-colors mb-3',
          selected
            ? 'border-[var(--pw-accent)] text-white'
            : 'border-gray-300 bg-transparent text-transparent'
        ].join(' ')}
        style={
          selected
            ? {
                background:
                  'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 70%, white) 0%, var(--pw-accent) 50%, color-mix(in srgb, var(--pw-accent) 85%, black) 100%)'
              }
            : undefined
        }
        aria-hidden="true"
      >
        <svg
          width="14"
          height="10"
          viewBox="0 0 17 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          class={selected ? 'opacity-100' : 'opacity-0'}
        >
          <path
            d="M16.5234 0.476562C16.9805 0.898438 16.9805 1.63672 16.5234 2.05859L7.52344 11.0586C7.10156 11.5156 6.36328 11.5156 5.94141 11.0586L1.44141 6.55859C0.984375 6.13672 0.984375 5.39844 1.44141 4.97656C1.86328 4.51953 2.60156 4.51953 3.02344 4.97656L6.75 8.66797L14.9414 0.476562C15.3633 0.0195312 16.1016 0.0195312 16.5234 0.476562Z"
            fill="currentColor"
          />
        </svg>
      </span>
      {/* Inner wrapper, carrying `border-b` — the divider between rows.
          It sits after the radio (by flex-flow), giving a visual bottom line exactly
          under the label/price columns, as in legacy. */}
      <div
        class={[
          'flex flex-1 items-center gap-1.5 pb-3.5',
          isLast ? '' : 'border-b border-gray-200'
        ].join(' ')}
      >
        <div class="flex flex-wrap items-center gap-1 gap-x-1.5">
          <span class="text-base font-normal capitalize text-gray-800">
            {compactLabel(price, t)}
          </span>
          {isPopular ? (
            // Pastel brand-mix pill — exactly like `badge` in TelegramPricingRadio.
            // Low visual weight: the pill is about the "plan name" (most popular), not
            // about savings — it should not compete with the -X% discount pill.
            <span
              class="rounded-[9px] px-2 py-1 text-[10px] font-bold"
              style={{
                background:
                  'linear-gradient(160deg, color-mix(in srgb, var(--pw-accent) 6%, white) 0%, color-mix(in srgb, var(--pw-accent) 15%, white) 100%)',
                color: 'var(--pw-accent)'
              }}
            >
              {popularLabel}
            </span>
          ) : null}
          {discountPercent ? (
            <span class="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-emerald-700">
              -{discountPercent}%
            </span>
          ) : null}
        </div>
        <div class="flex-1" />
        <span class="flex items-baseline gap-1.5 text-base font-normal text-gray-600">
          {originalAmount ? (
            <span class="text-xs text-gray-400 line-through decoration-gray-400 decoration-[1.5px]">
              {originalAmount}
            </span>
          ) : null}
          <span class="whitespace-nowrap">
            <span class="opacity-90">{currency}</span>{amount}
            <span class="text-xs text-gray-400">
              {' '}/ {intervalSuffix(price, t)}
            </span>
          </span>
        </span>
      </div>
    </button>
  );
}

// A compact card for the horizontal grid. UX model — Stripe pricing tables:
// selection is expressed by border color + a tinted bg of the whole card, without a separate
// radio circle (in a narrow column any icon mark competes with the price for
// attention). The popular badge is an absolute pill at the top-right (as in the default view):
// it frees up vertical space inside the card and reads as a premium marker. All
// cards in a row are aligned via `items-stretch` on the grid (see the call site).
function RowCard({
  price,
  isPopular,
  popularLabel,
  offer,
  reserveStrikeRow,
  selected,
  onSelect,
  t
}: {
  price: PaywallPrice;
  isPopular: boolean;
  popularLabel: string;
  offer: PaywallOffer | null;
  /** Reserve height for the strike-row (originalAmount + discount-pill) even
   *  in this card without a discount. true when the grid has at least one price with
   *  a discount — otherwise the main amount without a discount jumps above its discounted neighbors.
   *  false when no price in the grid has an offer — the strike-row collapses
   *  to 0 in all of them, and there's no 22px of empty space under the label. */
  reserveStrikeRow: boolean;
  selected: boolean;
  onSelect: () => void;
  t: TFn;
}) {
  const discountPercent = offer?.discount_percent ?? null;
  const { currency, amount, originalAmount } = formatPriceParts(price, discountPercent);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      class={[
        'group relative flex h-full flex-col items-center justify-start gap-1 rounded-2xl border-2 px-3 pb-4 pt-3.5 text-center transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]',
        selected
          ? 'border-[var(--pw-accent)]'
          : 'border-gray-200 hover:bg-gray-50'
      ].join(' ')}
      style={
        selected
          ? { background: 'color-mix(in srgb, var(--pw-accent) 6%, transparent)' }
          : undefined
      }
    >
      {/* Label with a fixed min-height of 2 lines — long ("YEARLY PLAN")
          and short ("LIFETIME") ones don't shift the price between cards. */}
      <span class="flex min-h-[2.4em] items-center text-[10px] font-normal uppercase leading-tight text-gray-800/70">
        {planLabel(price, t)}
      </span>
      {/* Strike-row on top BEFORE the main amount: first "was $10" + "-20%",
          then "$8" large. Height is reserved (h-[22px]) only if the
          grid has at least one price with a discount — this keeps alignment between
          discounted and non-discounted cards. If there is no offer at all, we don't
          render the row, leaving no 22px of empty space under the label in all cards. */}
      {reserveStrikeRow ? (
        <div class="flex h-[22px] items-center justify-center gap-1.5">
          {originalAmount ? (
            <span class="text-[12px] text-gray-400 line-through decoration-gray-400 decoration-[1.5px]">
              {originalAmount}
            </span>
          ) : null}
          {discountPercent ? (
            <span class="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-emerald-700">
              -{discountPercent}%
            </span>
          ) : null}
        </div>
      ) : null}
      <span class="text-[26px] leading-none whitespace-nowrap text-gray-800 font-medium">
        <span class="opacity-90">{currency}</span>{amount}
      </span>
      <span class="text-xs font-normal text-gray-500">
        / {intervalSuffix(price, t)}
      </span>
      {isPopular ? (
        <span
          // Solid accent + white text + white border-ring — separates the badge
          // from the card's border, imitating a "sticker". Mirrors the default view.
          class="absolute -top-[10px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[11px] border-[3px] border-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white"
          style={{ background: 'var(--pw-accent)' }}
        >
          {popularLabel}
        </span>
      ) : null}
    </button>
  );
}
