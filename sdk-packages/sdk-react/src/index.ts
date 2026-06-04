'use client';

// Public surface of @monetize.software/sdk-react.
//
// The `'use client'` directive at the top of the file marks the whole package
// as client-only for the bundlers of RSC-aware frameworks (Next.js App Router,
// Remix RSC). The host can import `PaywallProvider`/hooks directly into a
// server component — the bundler crosses the client boundary itself without a
// wrapping 'use client' file.
//
// Without the directive, Next.js App Router would require the consumer to wrap
// the provider in their own 'use client' component. With it — they don't.
// This directive is ignored by Vite/CRA bundlers and does not break non-Next.js
// scenarios.

export { PaywallProvider, type PaywallProviderProps } from './PaywallProvider';
export { usePaywall } from './hooks/usePaywall';
export { usePaywallState } from './hooks/usePaywallState';
export {
  usePaywallUser,
  type PaywallUserState
} from './hooks/usePaywallUser';
export { usePaywallEvent } from './hooks/usePaywallEvent';
export {
  usePaywallAccess,
  type PaywallAccessState
} from './hooks/usePaywallAccess';
export {
  usePaywallPrices,
  type PaywallPricesState
} from './hooks/usePaywallPrices';
export { usePaywallOffer } from './hooks/usePaywallOffer';
export { usePaywallOffers } from './hooks/usePaywallOffers';
export { usePaywallTrial } from './hooks/usePaywallTrial';
export { usePaywallVisibility } from './hooks/usePaywallVisibility';

export {
  PaywallGate,
  type PaywallGateProps,
  type BlockedRenderArgs
} from './components/PaywallGate';
export {
  PaywallButton,
  type PaywallButtonProps,
  type PaywallButtonRenderArgs
} from './components/PaywallButton';
export {
  PaywallSupportButton,
  type PaywallSupportButtonProps
} from './components/PaywallSupportButton';

// Type re-exports for ergonomics — host code can `import type { ... } from
// '@monetize.software/sdk-react'` without a second import from the core SDK.
// The single source of truth remains `@monetize.software/sdk` — this is only a
// pass-through.
export type {
  PaywallUI,
  PaywallUIOptions,
  PaywallEvent,
  PaywallEventHandler,
  PaywallStateSnapshot,
  PaywallAccessResult,
  GetAccessOptions,
  OpenOptions,
  AnalyticsOptions,
  PaywallUser,
  PaywallPrice,
  PaywallBootstrap,
  PaywallSettings,
  PaywallOffer,
  Identity,
  AuthSession,
  ResolvedOffer
} from '@monetize.software/sdk';
