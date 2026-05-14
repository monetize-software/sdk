// Public surface of @monetize.software/sdk-react.

export { PaywallProvider, type PaywallProviderProps } from './PaywallProvider';
export { usePaywall } from './hooks/usePaywall';
export { usePaywallState } from './hooks/usePaywallState';
export { usePaywallUser } from './hooks/usePaywallUser';
export { usePaywallEvent } from './hooks/usePaywallEvent';
export {
  usePaywallAccess,
  type PaywallAccessState
} from './hooks/usePaywallAccess';
export {
  usePaywallPrices,
  type PaywallPricesState
} from './hooks/usePaywallPrices';
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
// Single source of truth остаётся `@monetize.software/sdk` — здесь только
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
  Identity
} from '@monetize.software/sdk';
