import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';
import { useI18n } from '../../i18n';

type GuaranteeBlock = Extract<LayoutBlock, { type: 'guarantee_badge' }>;

// Money-back guarantee pill below the CtaButton. A compact one-liner: shield-check
// icon + text. The pill styling (rounded-full + bg-gray-100) visually separates it
// from the CTA without drawing attention to itself — it is a reassurance element.
// The subtitle is dropped from the default render: users scan a purchase
// quickly, and a second line is just noise. If the admin sets block.subtitle
// explicitly, it is rendered in small gray below the pill.
export function GuaranteeBadge({ block }: BlockProps<GuaranteeBlock>) {
  const { t } = useI18n();
  const title = block.title ?? t('pricing.money_back', '30-day money-back guarantee');
  const subtitle = block.subtitle;
  const showIcon = (block.icon ?? 'dollar_shield') !== 'none';

  // Highlight the "N-day" prefix in bold/dark — it is the key info (the period),
  // the rest in normal weight. The eye catches the number right away instead of a flat block.
  const parts = splitDaysPrefix(title);

  return (
    <div class="flex flex-col items-center gap-1.5 border-b-1 pb-4 mb-1 border-gray-100">
      <div class="inline-flex items-center gap-2 text-[12px] text-gray-700">
        {showIcon ? <ShieldCheckIcon /> : null}
        {parts ? (
          <span>
            <b class="font-bold text-gray-900">{parts.bold}</b>{' '}
            <span class="font-medium">{parts.rest}</span>
          </span>
        ) : (
          <span class="font-medium">{title}</span>
        )}
      </div>
      {subtitle ? (
        <span class="text-center text-xs leading-relaxed text-gray-500">{subtitle}</span>
      ) : null}
    </div>
  );
}

function splitDaysPrefix(title: string): { bold: string; rest: string } | null {
  const m = title.match(/^(\d+[-\s]?days?)\s+(.+)$/i);
  if (!m) return null;
  return { bold: m[1], rest: m[2] };
}

function ShieldCheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="16"
      height="16"
      // emerald-500 — semantic "safety/refund", raises the contrast of the
      // reassurance signal. Gray gray-500 was skipped over by the eye.
      class="flex-shrink-0 text-emerald-500"
      aria-hidden="true"
    >
      <path
        d="M12 2 4 5v6c0 5.25 3.5 9.5 8 11 4.5-1.5 8-5.75 8-11V5l-8-3Z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <path
        d="m9 12 2 2 4-4"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
