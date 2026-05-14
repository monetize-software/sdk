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
}

export function Renderer({ layout, bootstrap, onAction, auth, authSession }: RendererProps) {
  const defaultPriceId = useMemo(() => bootstrap.prices[0]?.id ?? null, [bootstrap.prices]);
  const [selectedPriceId, setSelectedPriceId] = useState<string | null>(defaultPriceId);

  const ctx: BlockContext = {
    bootstrap,
    selectedPriceId,
    setSelectedPriceId,
    onAction,
    auth,
    authSession
  };

  return (
    <div class="flex flex-col gap-4">
      {layout.blocks.map((block, i) => {
        const Cmp = blockRegistry[block.type];
        if (!Cmp) {
          if (typeof console !== 'undefined') {
            console.warn(`[paywall] unknown block type: ${block.type}`);
          }
          return null;
        }
        return <Cmp key={i} block={block as never} ctx={ctx} />;
      })}
    </div>
  );
}
