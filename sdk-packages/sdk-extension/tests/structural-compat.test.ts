// Structural-compatibility tests. PaywallRoot and PaywallUI work with
// `client: BillingClient` / `auth: AuthClient`, without knowing that under the
// hood it's a RemoteBillingClient/RemoteAuthClient. So the remote classes MUST
// have all the public methods and fields of the real ones that PaywallRoot/PaywallUI read.
//
// These tests are explicit checklists. If PaywallUI/PaywallRoot start using a
// new billing/auth method — add it here, and the test will catch its absence
// in the remote variant on CI before the user clicks the button.

import { describe, it, expect } from 'vitest';
import { TransportClient } from '../src/shared/transport-client';
import { RemoteBillingClient } from '../src/content/RemoteBillingClient';
import { RemoteAuthClient } from '../src/content/RemoteAuthClient';
import { RemoteEventTracker } from '../src/content/RemoteEventTracker';
import type { MessageChannel } from '../src/shared/channel';
import '../src/shared/messages';

function makeNoopChannel(): MessageChannel {
  return {
    send: () => {},
    onMessage: () => () => {},
    onDisconnect: () => () => {},
    close: () => {}
  };
}

/** Public surface that PaywallRoot/PaywallUI read on `client`.
 *  The list is derived from reading src/ui/PaywallUI.ts and src/ui/PaywallRoot.tsx —
 *  when adding a new method call on client, add it here. */
const REQUIRED_BILLING_SURFACE = [
  // Fields
  'paywallId',
  'apiOrigin',
  'auth', // ← bug missed: RemoteBillingClient.auth was undefined, restore did not work
  // Methods
  'bootstrap',
  'getCachedBootstrap',
  'getUser',
  'getCachedUser',
  'onUserChange',
  'getBalances',
  'getCachedBalances',
  'onBalanceChange',
  'createCheckout',
  'listPurchases',
  'cancelSubscription',
  'getIdentity',
  'setIdentity',
  'getVisitorId',
  'getStorage', // ← bug missed: also absent, the trial-gate crashed
  'createTrialStore' // duck-typed factory for extension mode
] as const;

const REQUIRED_AUTH_SURFACE = [
  // Fields
  'paywallId',
  'apiOrigin',
  // Methods
  'getCachedSession',
  'getCachedUser',
  'onAuthChange',
  'signInWithEmail',
  'signUp',
  'signOut',
  'refresh',
  'signInWithOAuth',
  'getAccessToken'
] as const;

const REQUIRED_TRACKER_SURFACE = ['track'] as const;

describe('RemoteBillingClient structural compatibility', () => {
  it('exposes all fields/methods PaywallRoot/PaywallUI consume', () => {
    const transport = new TransportClient(makeNoopChannel);
    const auth = new RemoteAuthClient(transport, { paywallId: 'demo' });
    const remote = new RemoteBillingClient(transport, { paywallId: 'demo' });
    // The PaywallUI extension-wrapper sets `auth` after the constructor —
    // we emulate this for the check.
    (remote as { auth?: typeof auth }).auth = auth;

    const missing: string[] = [];
    for (const name of REQUIRED_BILLING_SURFACE) {
      if (!(name in remote)) missing.push(name);
    }
    expect(missing, `RemoteBillingClient missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('method types are functions (not undefined / non-callable)', () => {
    const transport = new TransportClient(makeNoopChannel);
    const remote = new RemoteBillingClient(transport, { paywallId: 'demo' });
    const methodsOnly = REQUIRED_BILLING_SURFACE.filter(
      (n) => !['paywallId', 'apiOrigin', 'auth'].includes(n)
    );
    for (const name of methodsOnly) {
      expect(
        typeof (remote as unknown as Record<string, unknown>)[name],
        `${name} should be a function`
      ).toBe('function');
    }
  });
});

describe('RemoteAuthClient structural compatibility', () => {
  it('exposes all fields/methods PaywallRoot consumes', () => {
    const transport = new TransportClient(makeNoopChannel);
    const remote = new RemoteAuthClient(transport, { paywallId: 'demo' });

    const missing: string[] = [];
    for (const name of REQUIRED_AUTH_SURFACE) {
      if (!(name in remote)) missing.push(name);
    }
    expect(missing, `RemoteAuthClient missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('method types are functions', () => {
    const transport = new TransportClient(makeNoopChannel);
    const remote = new RemoteAuthClient(transport, { paywallId: 'demo' });
    const methodsOnly = REQUIRED_AUTH_SURFACE.filter(
      (n) => !['paywallId', 'apiOrigin'].includes(n)
    );
    for (const name of methodsOnly) {
      expect(
        typeof (remote as unknown as Record<string, unknown>)[name],
        `${name} should be a function`
      ).toBe('function');
    }
  });
});

describe('RemoteEventTracker structural compatibility', () => {
  it('exposes track method', () => {
    const transport = new TransportClient(makeNoopChannel);
    const remote = new RemoteEventTracker(transport);
    for (const name of REQUIRED_TRACKER_SURFACE) {
      expect(name in remote).toBe(true);
      expect(typeof (remote as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
