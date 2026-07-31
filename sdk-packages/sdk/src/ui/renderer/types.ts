import type { ComponentType } from 'preact';
import type { AuthClient, AuthSession, OAuthResumeCheckout } from '../../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../../core/types';

export interface BlockContext {
  bootstrap: PaywallBootstrap;
  selectedPriceId: string | null;
  setSelectedPriceId: (id: string) => void;
  onAction: (action: string, payload?: unknown) => void;
  /** AuthClient, if PaywallUI was configured with managed-auth. Without it
   *  the auth_panel block renders a fallback ("auth not configured"). */
  auth?: AuthClient;
  /** Current auth session (snapshot from AuthClient). null = signed out. PaywallRoot
   *  subscribes to onAuthChange and forwards a fresh snapshot here. */
  authSession: AuthSession | null;
  /** Initial mode for AuthPanel — overrides the default 'signin'.
   *  Set by AuthGate when the host calls openSignup()/openSignin().
   *  Other blocks ignore it. */
  initialAuthMode?: 'signin' | 'signup';
  /** The checkout this sign-in is a gate for, if any. Passed into OAuth so the
   *  purchase can continue even when the surface that started it is destroyed
   *  mid-flow (extension SDK only — see {@link OAuthResumeCheckout}). Other
   *  blocks ignore it. */
  resumeCheckout?: OAuthResumeCheckout;
}

export interface BlockProps<B extends LayoutBlock = LayoutBlock> {
  block: B;
  ctx: BlockContext;
}

export type BlockComponent<B extends LayoutBlock = LayoutBlock> = ComponentType<BlockProps<B>>;
