// Content-script entry. Drop-in replacement for `@monetize.software/sdk` —
// the host writes `import { PaywallUI } from '@monetize.software/sdk-extension'` and gets
// the same class, the same API, but under the hood BillingClient/AuthClient/Tracker
// are proxied to offscreen via RemoteBillingClient.
//
// Phase 2: RemoteBillingClient (bootstrap subset). The PaywallUI re-export
// lands in Phase 3 after BillingClient is fully remoted.

// Public API: drop-in PaywallUI with the same interface as @monetize.software/sdk.
export { PaywallUI } from './PaywallUI';
export type { ExtensionPaywallUIOptions } from './PaywallUI';

// Low-level components — for hosts that want to assemble the flow themselves.
//
// For a raw call to the metered gateway (`/api/v1/api-gateway/...`) build
// `ApiGatewayClient` from `@monetize.software/sdk/core`, passing in
// `RemoteAuthClient` as the auth source (`auth.getAccessToken()` goes to offscreen).
// `ApiGatewayClient`/`QuotaExceededError` are deliberately NOT re-exported here:
// the content bundle inlines a copy of `sdk`, so a re-exported `QuotaExceededError`
// would be a different class identity and silently break `instanceof` on the
// caller side — import both symbols from the same `@monetize.software/sdk/core`.
export { RemoteBillingClient } from './RemoteBillingClient';
export type { RemoteBillingClientOptions } from './RemoteBillingClient';
export { RemoteAuthClient } from './RemoteAuthClient';
export type { RemoteAuthClientOptions, AuthChangeListener } from './RemoteAuthClient';
export { RemoteEventTracker } from './RemoteEventTracker';
export { getContentTransport } from './transport';

export { PROTOCOL_VERSION } from '../shared/protocol';
export type { RequestKind, EventKind } from '../shared/protocol';
