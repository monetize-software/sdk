import type { ComponentType } from 'preact';
import type { AuthClient, AuthSession } from '../../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../../core/types';

export interface BlockContext {
  bootstrap: PaywallBootstrap;
  selectedPriceId: string | null;
  setSelectedPriceId: (id: string) => void;
  onAction: (action: string, payload?: unknown) => void;
  /** AuthClient, если PaywallUI был сконфигурирован с managed-auth. Без него
   *  auth_panel-блок рендерит fallback ("auth not configured"). */
  auth?: AuthClient;
  /** Текущая auth-session (snapshot из AuthClient). null = разлогинен. PaywallRoot
   *  подписан на onAuthChange и пробрасывает свежий snapshot сюда. */
  authSession: AuthSession | null;
  /** Стартовый mode для AuthPanel — переопределяет дефолт 'signin'.
   *  Выставляется AuthGate'ом когда host вызвал openSignup()/openSignin().
   *  Остальные блоки игнорируют. */
  initialAuthMode?: 'signin' | 'signup';
}

export interface BlockProps<B extends LayoutBlock = LayoutBlock> {
  block: B;
  ctx: BlockContext;
}

export type BlockComponent<B extends LayoutBlock = LayoutBlock> = ComponentType<BlockProps<B>>;
