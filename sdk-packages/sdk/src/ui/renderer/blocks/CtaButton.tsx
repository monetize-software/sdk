import { useState } from 'preact/hooks';
import type { LayoutBlock } from '../../../core/types';
import type { BlockProps } from '../types';

type CtaBlock = Extract<LayoutBlock, { type: 'cta_button' }>;

export function CtaButton({ block, ctx }: BlockProps<CtaBlock>) {
  const [busy, setBusy] = useState(false);
  const priceId = block.priceId ?? ctx.selectedPriceId;
  const disabled = busy || (block.action === 'checkout' && !priceId);

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
      class="pw-cta-shimmer relative mt-1 flex h-14 w-full items-center justify-center overflow-hidden rounded-full px-6 text-base font-semibold tracking-tight text-white transition-transform duration-150 hover:-translate-y-px active:scale-[0.98] active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
      style={{
        background:
          'linear-gradient(135deg, color-mix(in srgb, var(--pw-accent) 55%, white) 0%, var(--pw-accent) 55%, color-mix(in srgb, var(--pw-accent) 90%, black) 100%)',
        boxShadow:
          '0 0 24px 0 color-mix(in srgb, var(--pw-accent) 35%, transparent), inset 0 0 8px 0 color-mix(in srgb, white 25%, transparent), 0 1px 2px rgba(15,23,42,0.08)'
      }}
    >
      {busy ? (
        <span class="relative z-10 inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      ) : (
        <span class="relative z-10">{block.label}</span>
      )}
    </button>
  );
}
