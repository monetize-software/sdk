// Content-script entry. Drop-in replacement for `@monetize.software/sdk` —
// host пишет `import { PaywallUI } from '@monetize.software/sdk-extension'` и получает
// тот же класс, тот же API, но под капотом BillingClient/AuthClient/Tracker
// проксируются в offscreen через RemoteBillingClient.
//
// Phase 2: RemoteBillingClient (bootstrap subset). PaywallUI re-export
// придёт в Phase 3 после полного remoting'а BillingClient.

// Public API: drop-in PaywallUI с тем же интерфейсом, что @monetize.software/sdk.
export { PaywallUI } from './PaywallUI';
export type { ExtensionPaywallUIOptions } from './PaywallUI';

// Низкоуровневые компоненты — для host'ов, которые хотят собрать flow сами.
export { RemoteBillingClient } from './RemoteBillingClient';
export type { RemoteBillingClientOptions } from './RemoteBillingClient';
export { RemoteAuthClient } from './RemoteAuthClient';
export type { RemoteAuthClientOptions, AuthChangeListener } from './RemoteAuthClient';
export { RemoteEventTracker } from './RemoteEventTracker';
export { getContentTransport } from './transport';

export { PROTOCOL_VERSION } from '../shared/protocol';
export type { RequestKind, EventKind } from '../shared/protocol';
