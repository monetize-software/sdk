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
  /** True если над dialog'ом рендерится OfferTopBanner (он берёт на себя
   *  visual top-bleed под X-крестиком). Без banner'а уменьшаем top-padding
   *  scrollable-зоны — иначе под X остаётся 32px пустоты. */
  hasTopBanner?: boolean;
}

export function Renderer({ layout, bootstrap, onAction, auth, authSession, hasTopBanner }: RendererProps) {
  // По умолчанию selected = popular_price_id (если он указан в каком-то
  // price_grid block'е и действительно существует в bootstrap.prices). Это
  // повторяет UX легаси-пейвола: highlighted-карточка сразу подсвечена и
  // готова к покупке, юзеру не нужно её доп. кликать. Fallback — первая цена.
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

  // CTA + всё после него — pinned footer внизу dialog'а: всегда видимы, даже
  // если контент сверху не помещается по высоте. Сплит по первому `cta_button`:
  // нет cta → секция не рендерится, весь layout скроллится как обычно.
  // Используем flex (а не position:sticky) — sticky не даёт scrollable-области
  // правильно отдать высоту footer'у (контент скроллился ПОД footer вместо
  // того чтобы расширить min-h: 0), плюс shadow от sticky показывался даже
  // когда overflow'а нет. Flex чист: footer auto-height, scroll = flex-1.
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
      {/* Scrollable: верхний padding визуально отделяет от dialog top (и
          banner'а), нижний — меньше, потому что footer добавляет свой pt
          + border. Раньше было `p-8` снизу, давало ~48px зазор до CTA. */}
      <div class="flex-1 min-h-0 overflow-y-auto px-6 pb-3 pt-6 sm:px-8 sm:pb-4 sm:pt-8">
        <div class="flex flex-col gap-6">
          {scrollBlocks.map(renderBlock)}
        </div>
      </div>
      {footerBlocks.length > 0 ? (
        // Тонкий shadow-top вместо border-t — создаёт depth, читается как
        // «footer закреплён к низу dialog'а». Линия выглядела как divider
        // в обычном flow, не передавала sticky-character.
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
