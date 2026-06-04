import { useState } from 'preact/hooks';
import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type CtaBlock = Extract<LayoutBlock, { type: 'cta_button' }>;

// Plan keys for "Get X Plan". If the interval is a known constant,
// we take the dedicated key (which gives the translator the correct gender/case for each
// interval). For exotic ones like day/half-year we fall back to the generic with
// {interval} substitution — it looks slightly worse grammatically in RU/DE, but
// we don't lose the interval in the UI.
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

// Plan-aware label following the legacy logic from online/PaywallPricing.tsx:
//   - trial_days > 0, interval !== 'lifetime', user hasn't taken a trial yet →
//     "Start N-Day Free Trial"
//   - interval === 'lifetime' → "Get Lifetime Access"
//   - otherwise → "Get {Interval} Plan"
// `hadPreviousTrial` suppresses the trial branch — anti-abuse: a user can take a
// trial on a paywall only once. Server-side enforcement in
// /start-checkout (utils/checkout-with-acquiring.ts) duplicates this.
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
  // `had_previous_trial` comes from the bootstrap.user snapshot. This means that
  // after signin via the preauth flow (the user was a guest at bootstrap time)
  // the flag stays false until the next bootstrap-revalidate; the UI will briefly
  // show "Start Free Trial", but the server-side enforcement in /start-checkout
  // will still create a checkout without a trial — anti-abuse isn't violated.
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
