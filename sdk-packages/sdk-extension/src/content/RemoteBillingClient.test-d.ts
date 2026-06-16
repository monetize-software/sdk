// Compile-time structural compatibility test.
// Not executed at runtime — only checked by `tsc --noEmit`. The paired analog of
// RemoteAuthClient.test-d.ts.
//
// Contract: RemoteBillingClient is a proxy implementation of BillingClient in the
// popup (via offscreen). PaywallUI / PaywallRoot / SupportGate / AuthGate work
// with a `BillingClient`-typed object without knowing that the thing under the
// hood is actually a RemoteBillingClient. If BillingClient gets a new public
// method, the SDK ui code will start calling it and the popup will crash at
// runtime (`r.someMethod is not a function`).
//
// BillingClient/RemoteBillingClient have significantly more diverging methods
// than the pair of AuthClients: the setIdentity signatures (sync void vs async
// Promise), the set of "factory" methods (createApiGatewayClient) and admin-only
// ones (setBootstrap) are intentionally not mirrored. All such — in
// EXCLUDED_FROM_PROXY with a justification.

import type { BillingClient } from '@sdk/core/BillingClient';
import type { RemoteBillingClient } from './RemoteBillingClient';

// BillingClient methods that are INTENTIONALLY not mirrored in RemoteBillingClient.
// Each exception requires a justification — by default any public method should
// be in the proxy.
//
// - capabilities: a readonly array, not needed by the popup host. If needed —
//   add a getter to RemoteBillingClient and remove it from the exceptions.
// - setBootstrap: the admin editor's live preview, not needed in the extension channel.
// - getCachedVisitorId: a sync snapshot of visitor_id; the proxy only has async getVisitorId
//   via transport — a sync mirror isn't supported.
// - getUserLanguage: not implemented in the proxy yet. If the SDK ui starts
//   reading the language — remove it from the exceptions and implement it.
// - decrementBalanceLocal / refreshBalances: local-only optimistic updates / an
//   explicit refresh trigger. In the extension the balance state lives in
//   offscreen, and dec/refresh go through transport.
// - createApiGatewayClient: a factory; the popup host does new ApiGatewayClient
//   directly with RemoteAuth (see popup.ts) — the proxy factory isn't needed.
// - getCustomerPortalUrl: not exposed through transport (TODO when needed).
// - getIdentity / setIdentity: the signatures diverge —
//   BillingClient: setIdentity(Identity | undefined): void;
//                 getIdentity(): Identity | undefined;
//   RemoteBillingClient: setIdentity(Identity | null): Promise<void>;
//                       getIdentity(): Identity | null;
//   The transport nature of RemoteBillingClient requires async for set, and it's
//   a design decision to use null instead of undefined for wire-friendly JSON.
//   We do NOT cover it with the compatibility test — but we also don't disguise
//   it as a BillingClient, because PaywallUI in the extension channel doesn't
//   call identity methods directly (the host gets either variant through
//   `paywall.billing.setIdentity`).
// - auth: BillingClient sets this field in its constructor as readonly. In
//   RemoteBillingClient it isn't on the class, but the PaywallUI subclass in the
//   extension monkey-patches `billing.auth = auth` (see content/PaywallUI.ts).
//   Structurally uneven, but in practice PaywallRoot always reads auth correctly.
//   TODO: make it a readonly field on RemoteBillingClient and initialize it via
//   the constructor.
type ExcludedFromProxy =
  | 'capabilities'
  | 'setBootstrap'
  | 'getCachedVisitorId'
  | 'getUserLanguage'
  | 'decrementBalanceLocal'
  | 'refreshBalances'
  | 'createApiGatewayClient'
  | 'getCustomerPortalUrl'
  | 'getIdentity'
  | 'setIdentity'
  // Server-SDK only (apiKey): manual token credit/debit. apiKey can't exist in a
  // browser/extension context, so these are intentionally NOT proxied to offscreen.
  | 'creditTokens'
  | 'debitTokens'
  | 'auth';

type RequiredBillingAPI = Pick<
  BillingClient,
  Exclude<keyof BillingClient, ExcludedFromProxy>
>;

// If the line below fails with TS2322 / TS2741 — RemoteBillingClient has diverged
// from BillingClient. Fix the proxy (+ the protocol + the offscreen handler), not
// the exceptions — exceptions are only for intentional divergence with a justification.
declare const _remote: RemoteBillingClient;
const _assertStructuralCompat: RequiredBillingAPI = _remote;
void _assertStructuralCompat;
