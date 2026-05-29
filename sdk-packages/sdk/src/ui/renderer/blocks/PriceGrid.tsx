import type { LayoutBlock, PaywallOffer, PaywallPrice } from '../../../core/types';
import { findApplicableOffer } from '../../../core/offer';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type PriceGridBlock = Extract<LayoutBlock, { type: 'price_grid' }>;

interface FormattedPrice {
  /** Символ валюты (или ISO-код, если символ не определился). */
  currency: string;
  /** Целая часть, без разделителей дробной. */
  amount: string;
  /** Original (без discount), formatted — для strike-through. null если
   *  скидки нет или discount=0%. */
  originalAmount: string | null;
}

// Year-план показывает per-month эквивалент сразу в основной цене:
//   YEARLY PLAN €4.99 / month   (вместо €59.99 / year)
// Это легаси-UX из online/PaywallPricing.tsx (`unit_amount / 12`):
// юзеру важна стоимость в месяц для сравнения с monthly-планом, а годовое
// списание — деталь, которая не должна доминировать в типографике. planLabel
// остаётся "YEARLY PLAN", так что billed-cadence по-прежнему понятен из
// названия.
function displayedAmount(price: PaywallPrice): { amount: number; currency: string } {
  const display = price.local ?? { currency: price.currency, amount: price.amount };
  if (price.interval === 'year') {
    const months = (price.interval_count ?? 1) * 12;
    return { amount: display.amount / months, currency: display.currency };
  }
  return { amount: display.amount, currency: display.currency };
}

// Форматирует число в currency-string без литералов, разделяет currency-symbol
// и числовую часть. Используется и для основной цены, и для strike-through
// original (тогда discount применять не нужно — value уже base).
// Дробная часть авто: целое → "$8", нецелое → "$4.99". Целые без .00 заметнее
// конвертят — глаз быстрее цепляет короткое число.
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
  // Strike-through показываем полностью (`€59.99`/`€9.99` — с currency-знаком),
  // чтобы юзер сразу видел старую цену в той же валюте, без догадок.
  return {
    currency: main.currency,
    amount: main.amount,
    originalAmount: `${original.currency}${original.amount}`
  };
}

// Подбор активного offer'а вынесен в `core/offer.ts:findApplicableOffer` —
// единая точка для renderer'а и host-side API (`PaywallUI.getOfferForPrice`).

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

// Суффикс после цены. Year → "month" (потому что amount уже /12, см.
// displayedAmount). Lifetime → "lifetime". Прочее — singular interval
// или "N intervals" для interval_count > 1.
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

  // Compact-режим — telegram-style список: тонкая подложка-карточка вокруг
  // всех строк (rounded-xl + light bg + 1px border). Разделители между
  // строками — `border-b` на внутреннем label-wrapper'е CompactRow (кроме
  // последней). Зеркало legacy PaywallPricing wrapper'а: для не-default view
  // он рисует `rounded-xl border-1 border-default-200 bg-default-50` —
  // отделяет блок цен от остального layout'а.
  // v2 storage-ключ — `view: 'telegram'`, bootstrap нормализует в 'compact'.
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
            offer={findApplicableOffer(ctx.bootstrap.offers, price.id)}
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

  // Horizontal-режим — реальный grid из карточек side-by-side. v2 storage-ключ
  // `view: 'row'` (SDK 3.0 only — старые legacy-paywall'ы этого ключа не
  // выбирают; bootstrap нормализует в 'horizontal'). max 3 столбца, при 1-2
  // ценах stretch'ат строку. Tailwind purge не переживает runtime grid-cols-N,
  // потому inline gridTemplateColumns.
  if (block.view === 'horizontal') {
    const cols = Math.min(prices.length, 3);
    // Если хоть у одной цены в гриде есть discount — резервируем strike-row
    // фиксированной высотой у ВСЕХ карточек (иначе main amount без скидки
    // прыгает выше соседних со скидкой). Если оффера нет совсем — strike-row
    // схлопывается в 0 у всех, и не висит 22px пустоты под label'ом.
    const anyHasDiscount = prices.some(
      (p) => (findApplicableOffer(ctx.bootstrap.offers, p.id)?.discount_percent ?? 0) > 0
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
            offer={findApplicableOffer(ctx.bootstrap.offers, price.id)}
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
        const offer = findApplicableOffer(ctx.bootstrap.offers, price.id);
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
              // Везде border 2px — selection выражается только цветом, layout
              // не прыгает (равная толщина у selected/unselected). Цветовая
              // разница accent vs gray достаточно сильная для visual hierarchy.
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
                // Popular-label badge сидит absolute сверху-справа карточки и
                // визуально сдвигает центр content'а вниз. flex items-center
                // на карточке держит галочку по геометрическому центру, что
                // делает её визуально выше — компенсируем небольшим mt'ом.
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
              {/* Label + strike+badge на одной строке (flex-wrap для узких
                  карточек) — компактный 2-row layout вместо 3-row. Tags идут
                  справа от label с gap'ом, при переполнении переносятся. */}
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-xs font-normal uppercase tracking-normal text-gray-800/70">
                  {planLabel(price, t)}
                </span>
                {originalAmount ? (
                  // opacity-60 приглушает strike: глаз сначала ловит label
                  // и discount-badge, потом main price; original «бывшая цена»
                  // — третичная информация, не должна конкурировать с label.
                  <span class="text-[15px] font-normal text-gray-400 opacity-60 line-through decoration-gray-400 decoration-[1.5px]">
                    {originalAmount}
                  </span>
                ) : null}
                {discountPercent ? (
                  // Emerald pill — фиксированный «успех/выгода», не зависит от
                  // brand_color. Читается даже на тёмных бренд-акцентах.
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
                // Solid accent + white text — высокий contrast, glasses-test'ом
                // глаз сразу выхватывает popular pick. Pastel-вариант
                // конкурировал по visual weight с самой ценой и не работал
                // ни как highlight, ни как информация.
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

// Короткий one-word label для compact-режима ("Month" / "Year" / "Lifetime")
// вместо длинного "MONTHLY PLAN". Зеркало legacy `getIntervalName` для
// TelegramPricingRadio: чем компактнее ряд — тем компактнее лейбл, иначе
// текст начинает конкурировать с ценой.
function compactLabel(price: PaywallPrice, t: TFn): string {
  if (price.label) return price.label;
  if (!price.interval || price.interval === 'lifetime') {
    return t('pricing.interval.lifetime_short', 'lifetime');
  }
  return t(`pricing.interval.${price.interval}`, price.interval);
}

// Компактная строка для compact-режима. Зеркало legacy `TelegramPricingRadio`:
//   [radio] | [label + popular-pill]  ······  [strike+badge ▸ price]
// Разделители живут на внутреннем label-wrapper'е (`border-b`), последняя
// строка без border'а. Selection выражается только цветом radio-кружочка —
// никакого bg-tint'а, чтобы не конфликтовало с pricing-сеткой. Шрифты — text-md
// без жирного, как в legacy (heroui text-md ≈ 16px).
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
      {/* Внутренний wrapper, на нём `border-b` — разделитель между строками.
          Сидит за radio'м (по flex-flow), даёт визуальную нижнюю линию ровно
          под label/price колонками, как в legacy. */}
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
            // Pastel brand-mix pill — точно как `badge` в TelegramPricingRadio.
            // Низкий visual weight: pill про "имя плана" (most popular), а не
            // про savings — не должна конкурировать с -X% discount-pill.
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

// Компактная карточка для horizontal-grid'а. UX-модель — Stripe pricing tables:
// selection выражается border-цветом + tinted bg всей карточки, без отдельного
// radio-кружочка (в узкой колонке любая icon-метка конкурирует с ценой за
// внимание). Popular-badge — absolute pill сверху-справа (как в default view):
// освобождает вертикаль внутри карточки, читается как premium-маркер. Все
// карточки в ряду выровнены через `items-stretch` на grid'е (см. вызов).
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
  /** Резервировать высоту под strike-row (originalAmount + discount-pill) даже
   *  у этой карточки без скидки. true когда в гриде есть хотя бы одна цена со
   *  скидкой — иначе main amount без скидки прыгает выше соседних со скидкой.
   *  false когда оффера нет ни у одной цены в гриде — strike-row коллапсится
   *  в 0 у всех, не висит 22px пустоты под label'ом. */
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
      {/* Label с фиксированной min-height на 2 строки — длинные ("YEARLY PLAN")
          и короткие ("LIFETIME") не сдвигают цену между карточками. */}
      <span class="flex min-h-[2.4em] items-center text-[10px] font-normal uppercase leading-tight text-gray-800/70">
        {planLabel(price, t)}
      </span>
      {/* Strike-row сверху ПЕРЕД main amount: сначала "была $10" + "-20%",
          потом крупно "$8". Высота резервируется (h-[22px]) только если в
          гриде есть хоть одна цена со скидкой — это держит alignment между
          карточками со скидкой и без. Если оффера нет совсем — row не
          рендерим, не остаётся 22px пустоты под label'ом во всех карточках. */}
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
          // Solid accent + white text + white border-ring — отстраивает badge
          // от border'а карточки, имитирует "наклейку". Зеркало default-view.
          class="absolute -top-[10px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[11px] border-[3px] border-white px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white"
          style={{ background: 'var(--pw-accent)' }}
        >
          {popularLabel}
        </span>
      ) : null}
    </button>
  );
}
