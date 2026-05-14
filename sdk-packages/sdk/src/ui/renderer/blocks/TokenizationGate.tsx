import type { LayoutBlock, PaywallPrice } from '../../../core/types';
import type { BlockProps } from '../types';

type TokenizationGateBlock = Extract<LayoutBlock, { type: 'tokenization_gate' }>;

const INTERVAL_MULTIPLIER: Record<string, number> = {
  week: 0.25,
  month: 1,
  year: 12
};

function intervalNoun(interval: PaywallPrice['interval']): string {
  if (!interval) return 'period';
  return interval;
}

export function TokenizationGate({ block, ctx }: BlockProps<TokenizationGateBlock>) {
  if (!block.queries.length) return null;

  const selectedPrice = ctx.bootstrap.prices.find((p) => p.id === ctx.selectedPriceId);
  const interval = selectedPrice?.interval ?? null;
  const multiplier = interval ? INTERVAL_MULTIPLIER[interval] : undefined;

  return (
    <div class="flex flex-col gap-2">
      <div class="text-sm font-semibold text-gray-800">
        Included per <span>{intervalNoun(interval)}</span>:
      </div>
      <ul class="flex flex-col gap-2" role="list">
        {block.queries.map((q) => {
          const rawCount = Number.isFinite(q.count as number) ? (q.count as number) : 0;
          const amount =
            multiplier !== undefined ? Math.round(rawCount * multiplier) : rawCount;
          return (
            <li key={q.id} class={`flex gap-2 ${q.desc ? '' : 'items-center'}`}>
              <span
                class={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${q.desc ? 'mt-0.5' : ''}`}
                style={{
                  background: 'var(--pw-accent)',
                  color: '#ffffff'
                }}
                aria-hidden="true"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M5 10l3 3 7-7"
                    stroke="currentColor"
                    stroke-width="2.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <div>
                <span class="font-semibold text-gray-900 text-sm">{amount}</span>{' '}
                <span class="text-sm text-gray-800">{q.name}</span>
                {q.desc ? (
                  <>
                    <br />
                    <span class="text-xs text-gray-500">{q.desc}</span>
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
