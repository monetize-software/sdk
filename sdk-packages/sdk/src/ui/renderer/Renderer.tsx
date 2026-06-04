import { useMemo, useState } from 'preact/hooks';
import type { AuthClient, AuthSession } from '../../core/auth';
import type { Layout, PaywallBootstrap } from '../../core/types';
import { blockRegistry } from './registry';
import type { BlockContext } from './types';

export interface RendererProps {
  layout: Layout;
  bootstrap: PaywallBootstrap;
  onAction: (action: string, payload?: unknown) => void;
  auth?: AuthClient;
  authSession: AuthSession | null;
  /** True if an OfferTopBanner is rendered above the dialog (it takes on the
   *  visual top-bleed under the X close button). Without the banner we reduce the
   *  top padding of the scrollable area — otherwise there's 32px of empty space under the X. */
  hasTopBanner?: boolean;
}

export function Renderer({ layout, bootstrap, onAction, auth, authSession, hasTopBanner }: RendererProps) {
  // By default selected = popular_price_id (if it's set in some
  // price_grid block and actually exists in bootstrap.prices). This
  // mirrors the legacy paywall UX: the highlighted card is highlighted right away and
  // ready to purchase, the user doesn't need an extra click on it. Fallback — the first price.
  const defaultPriceId = useMemo(() => {
    for (const b of layout.blocks) {
      if (b.type === 'price_grid' && b.popular_price_id) {
        if (bootstrap.prices.some((p) => p.id === b.popular_price_id)) {
          return b.popular_price_id;
        }
      }
    }
    return bootstrap.prices[0]?.id ?? null;
  }, [layout.blocks, bootstrap.prices]);
  const [selectedPriceId, setSelectedPriceId] = useState<string | null>(defaultPriceId);

  const ctx: BlockContext = {
    bootstrap,
    selectedPriceId,
    setSelectedPriceId,
    onAction,
    auth,
    authSession
  };

  // CTA + everything after it — a pinned footer at the bottom of the dialog: always visible, even
  // if the content above doesn't fit by height. Split on the first `cta_button`:
  // no cta → the section isn't rendered, the whole layout scrolls as usual.
  // We use flex (not position:sticky) — sticky doesn't let the scrollable area
  // give its height to the footer correctly (content scrolled UNDER the footer instead
  // of expanding min-h: 0), plus the sticky shadow showed up even
  // when there's no overflow. Flex is clean: footer auto-height, scroll = flex-1.
  const ctaIdx = layout.blocks.findIndex((b) => b.type === 'cta_button');
  const scrollBlocks = ctaIdx === -1 ? layout.blocks : layout.blocks.slice(0, ctaIdx);
  const footerBlocks = ctaIdx === -1 ? [] : layout.blocks.slice(ctaIdx);

  const renderBlock = (block: Layout['blocks'][number], i: number) => {
    const Cmp = blockRegistry[block.type];
    if (!Cmp) {
      if (typeof console !== 'undefined') {
        console.warn(`[paywall] unknown block type: ${block.type}`);
      }
      return null;
    }
    return <Cmp key={`${block.type}-${i}`} block={block as never} ctx={ctx} />;
  };

  return (
    <>
      {/* Scrollable: the top padding visually separates it from the dialog top (and
          banner), the bottom one is smaller because the footer adds its own pt
          + border. It used to be `p-8` at the bottom, which gave a ~48px gap before the CTA. */}
      <div class="flex-1 min-h-0 overflow-y-auto px-6 pb-3 pt-6 sm:px-8 sm:pb-4 sm:pt-8">
        <div class="flex flex-col gap-6">
          {scrollBlocks.map(renderBlock)}
        </div>
      </div>
      {footerBlocks.length > 0 ? (
        // A thin shadow-top instead of border-t — creates depth, reads as
        // "the footer is pinned to the bottom of the dialog". The line looked like a divider
        // in normal flow and didn't convey the sticky character.
        <div
          class="flex flex-col gap-4 bg-white px-6 pb-6 pt-3 sm:px-8"
          style={{ boxShadow: '0 -4px 12px -4px rgba(15,23,42,0.06)' }}
        >
          {footerBlocks.map((b, i) => renderBlock(b, scrollBlocks.length + i))}
        </div>
      ) : null}
    </>
  );
}
