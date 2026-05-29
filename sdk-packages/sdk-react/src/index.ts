'use client';

// Public surface of @monetize.software/sdk-react.
//
// Директива `'use client'` сверху файла маркирует весь package как
// client-only для bundler'ов RSC-aware фреймворков (Next.js App Router,
// Remix RSC). Хост может импортировать `PaywallProvider`/хуки прямо в
// server component — bundler сам пересечёт client-boundary без обёртки
// «'use client'»-файлом.
//
// Без директивы Next.js App Router потребовал бы от консьюмера обернуть
// провайдер в собственный 'use client'-компонент. С ней — нет.
// Эта директива игнорируется Vite/CRA-бандлерами и не ломает non-Next.js
// сценарии.

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
  Identity,
  AuthSession,
  ResolvedOffer
} from '@monetize.software/sdk';
