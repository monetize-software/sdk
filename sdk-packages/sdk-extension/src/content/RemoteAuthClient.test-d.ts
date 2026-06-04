// Compile-time structural compatibility test.
// Not executed at runtime — only checked by `tsc --noEmit`. The file is named
// .test-d.ts so it's clearly visible in the tree as a "type test", and so that
// future e2e runners (vitest/jest) don't try to run it.
//
// Contract: RemoteAuthClient is a proxy implementation of AuthClient. PaywallUI
// and AuthPanel accept any object that passes runtime duck-typing
// (`isAuthClientLike` in PaywallUI) and call its public methods directly. If
// AuthClient gets a new public method (for example, another OAuth flow) and
// RemoteAuthClient doesn't implement it, the bug surfaces only at runtime
// (`auth.X is not a function` in the popup console). That already happened with
// `getLastLogin` in alpha.4.
//
// This file is the choke-point: add a public method to AuthClient → TS error here
// until you implement it in RemoteAuthClient. An exception method (intentionally
// not mirrored in the proxy) is added to EXCLUDED_FROM_PROXY with an explanation.

import type { AuthClient } from '@sdk/core/auth';
import type { RemoteAuthClient } from './RemoteAuthClient';

// Methods that should NOT be mirrored in RemoteAuthClient. Each exception
// requires a justification — otherwise by default every public method of
// AuthClient should be in the proxy.
//
// - upgradeAnonymousToEmail: not used by the SDK ui code yet. When needed —
//   remove from the exceptions and implement in RemoteAuthClient + add to the protocol.
// - startOAuthFlow / completeOAuthFlow: the split API isn't exposed outward; the
//   popup calls only signInWithOAuth, which under the hood makes oauthStart+oauthExchange
//   transport calls. The direct split is only needed in offscreen.
// - isDestroyed: a defensive getter that PaywallUI's host app doesn't use
//   (the modal tracks `destroy()` through its own lifecycle).
type ExcludedFromProxy =
  | 'upgradeAnonymousToEmail'
  | 'startOAuthFlow'
  | 'completeOAuthFlow'
  | 'isDestroyed';

type RequiredAuthAPI = Pick<
  AuthClient,
  Exclude<keyof AuthClient, ExcludedFromProxy>
>;

// If the line below fails with TS2322 — RemoteAuthClient has diverged from
// AuthClient. Most often: a new method was forgotten. Less often: a signature
// drifted (parameter / return type). Fix RemoteAuthClient (+ the protocol +
// the offscreen handler), not the exceptions — exceptions are only for
// intentional divergence.
declare const _remote: RemoteAuthClient;
const _assertStructuralCompat: RequiredAuthAPI = _remote;
void _assertStructuralCompat;
