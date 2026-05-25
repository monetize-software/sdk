import { useState } from 'preact/hooks';
import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type CtaBlock = Extract<LayoutBlock, { type: 'cta_button' }>;

// Плановые ключи для "Get X Plan". Если interval — известная константа,
// берём dedicated-ключ (даёт переводчику правильный род/падёж для каждого
// интервала). Для экзотики вроде day/half-year fallback'имся на generic с
// {interval}-подстановкой — выглядит чуть хуже грамматически в RU/DE, но
// мы не теряем интервал в UI.
const INTERVAL_PLAN_KEY: Record<string, string> = {
  day: 'cta.get_plan_daily',
  week: 'cta.get_plan_weekly',
  month: 'cta.get_plan_monthly',
  year: 'cta.get_plan_yearly'
};
const INTERVAL_PLAN_FALLBACK: Record<string, string> = {
  day: 'Get Daily Plan',
  week: 'Get Weekly Plan',
  month: 'Get Monthly Plan',
  year: 'Get Yearly Plan'
};

// Plan-aware label по легаси-логике из online/PaywallPricing.tsx:
//   - trial_days > 0, interval !== 'lifetime', юзер ещё не брал trial →
//     "Start N-Day Free Trial"
//   - interval === 'lifetime' → "Get Lifetime Access"
//   - иначе → "Get {Interval} Plan"
// `hadPreviousTrial` гасит trial-ветку — anti-abuse: один юзер может взять
// trial по пейволу только один раз. Серверный enforcement в
// /start-checkout (utils/checkout-with-acquiring.ts) дублирует.
function dynamicLabel(
  price: PaywallPrice | null,
  action: CtaBlock['action'],
  hadPreviousTrial: boolean,
  t: TFn
): string {
  if (action === 'close') return t('cta.close', 'Close');
  if (!price) return t('cta.continue', 'Continue');
  if (
    !hadPreviousTrial &&
    price.trial_days &&
    price.interval &&
    price.interval !== 'lifetime'
  ) {
    return t('cta.start_trial', 'Start {days}-Day Free Trial', { days: price.trial_days });
  }
  if (!price.interval || price.interval === 'lifetime') {
    return t('cta.get_lifetime_access', 'Get Lifetime Access');
  }
  const dedicatedKey = INTERVAL_PLAN_KEY[price.interval];
  if (dedicatedKey) {
    return t(dedicatedKey, INTERVAL_PLAN_FALLBACK[price.interval]);
  }
  return t('cta.get_plan_generic', 'Get {interval} Plan', {
    interval: capitalize(price.interval)
  });
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function CtaButton({ block, ctx }: BlockProps<CtaBlock>) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const priceId = block.priceId ?? ctx.selectedPriceId;
  const disabled = busy || (block.action === 'checkout' && !priceId);

  const selectedPrice = priceId
    ? ctx.bootstrap.prices.find((p) => p.id === priceId) ?? null
    : null;
  // `had_previous_trial` берём из bootstrap.user snapshot'а. Это значит, что
  // после signin'а через preauth flow (юзер был гостем на момент bootstrap'а)
  // флаг останется false до следующего bootstrap-revalidate; UI коротко
  // покажет "Start Free Trial", но серверный enforcement в /start-checkout
  // всё равно создаст checkout без trial — анти-abuse не нарушится.
  const hadPreviousTrial = ctx.bootstrap.user?.had_previous_trial ?? false;
  const label =
    block.label ?? dynamicLabel(selectedPrice, block.action, hadPreviousTrial, t);

  const onClick = async () => {
    if (disabled) return;
    setBusy(true);
    try {
      await ctx.onAction(block.action, { priceId });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      class="pw-cta-shimmer relative flex min-h-12 w-full items-center justify-center overflow-hidden rounded-3xl px-5 py-2 text-center text-base font-semibold leading-tight text-white transition-transform duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
        boxShadow:
          '0 0 20px 0 color-mix(in srgb, var(--pw-accent) 25%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent)'
      }}
    >
      <span
        class="absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, color-mix(in srgb, white 40%, transparent) 0%, transparent 70%)'
        }}
        aria-hidden="true"
      />
      {busy ? (
        <span class="relative z-10 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      ) : (
        <span class="relative z-10">{label}</span>
      )}
    </button>
  );
}
