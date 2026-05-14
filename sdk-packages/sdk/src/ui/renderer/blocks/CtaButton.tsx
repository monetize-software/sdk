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
      class="relative flex h-12 w-full items-center justify-center overflow-hidden rounded-2xl px-4 text-sm font-semibold tracking-tight text-white transition-all duration-150 hover:-translate-y-px hover:brightness-105 active:translate-y-0 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
      style={{
        background:
          'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
        boxShadow:
          '0 1px 0 rgba(255,255,255,0.25) inset, 0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -6px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
      }}
    >
      {busy ? (
        <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      ) : (
        block.label
      )}
    </button>
  );
}
