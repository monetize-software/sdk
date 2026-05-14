// Structural-compatibility tests. PaywallRoot и PaywallUI работают с
// `client: BillingClient` / `auth: AuthClient`, не зная что под капотом
// RemoteBillingClient/RemoteAuthClient. Поэтому remote-классы ОБЯЗАНЫ иметь
// все public-методы и -поля настоящих, которые PaywallRoot/PaywallUI читают.
//
// Эти тесты — explicit checklist'ы. Если PaywallUI/PaywallRoot начинают
// использовать новый метод billing/auth — добавь сюда, и тест поймает
// отсутствие в remote-варианте на CI до того как юзер кликнет по кнопке.

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

/** Public surface, которую PaywallRoot/PaywallUI читают на `client`.
 *  Список derived из чтения src/ui/PaywallUI.ts и src/ui/PaywallRoot.tsx —
 *  при добавлении нового method-call'а на client добавь сюда. */
const REQUIRED_BILLING_SURFACE = [
  // Fields
  'paywallId',
  'apiOrigin',
  'auth', // ← bug missed: RemoteBillingClient.auth был undefined, restore не работал
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
  'getStorage', // ← bug missed: тоже отсутствовал, trial-gate падал
  'createTrialStore' // duck-typed factory для extension-mode
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
    // PaywallUI extension-wrapper выставляет `auth` после конструктора —
    // эмулируем это для проверки.
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
