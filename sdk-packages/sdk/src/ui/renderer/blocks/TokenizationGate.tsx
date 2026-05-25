import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n, type TFn } from '../../i18n';

type TokenizationGateBlock = Extract<LayoutBlock, { type: 'tokenization_gate' }>;

const INTERVAL_MULTIPLIER: Record<string, number> = {
  week: 0.25,
  month: 1,
  year: 12
};

function intervalNoun(interval: PaywallPrice['interval'], t: TFn): string {
  if (!interval) return t('pricing.interval.period', 'period');
  return t(`pricing.interval.${interval}`, interval);
}

export function TokenizationGate({ block, ctx }: BlockProps<TokenizationGateBlock>) {
  const { t } = useI18n();
  if (!block.queries.length) return null;

  const selectedPrice = ctx.bootstrap.prices.find((p) => p.id === ctx.selectedPriceId);
  const interval = selectedPrice?.interval ?? null;
  const multiplier = interval ? INTERVAL_MULTIPLIER[interval] : undefined;

  return (
    <div class="flex flex-col gap-2">
      <div class="text-sm font-semibold text-gray-800">
        {t('pricing.included_per', 'Included per {interval}:', {
          interval: intervalNoun(interval, t)
        })}
      </div>
      <ul class="flex flex-col gap-2" role="list">
        {block.queries.map((q) => {
          const rawCount = Number.isFinite(q.count as number) ? (q.count as number) : 0;
          const amount =
            multiplier !== undefined ? Math.round(rawCount * multiplier) : rawCount;
          return (
            <li key={q.id} class={`flex gap-3 ${q.desc ? 'items-start' : 'items-center'}`}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 20 20"
                fill="none"
                class={`flex-shrink-0 text-emerald-500 ${q.desc ? 'mt-0.5' : ''}`}
                aria-hidden="true"
              >
                <path
                  d="M4 10.5l3.5 3.5 8.5-8.5"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              <div>
                <span class="font-semibold text-gray-900 text-sm">{amount}</span>{' '}
                <span class="text-sm text-gray-800">{q.name}</span>
                {q.desc ? (
                  <>
                    <br />
                    <span class="text-xs text-gray-400">{q.desc}</span>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
