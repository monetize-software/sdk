// @vitest-environment jsdom
// The OAuth rescue path: finishing a sign-in whose originating surface died
// mid-flow. A toolbar action popup is destroyed when the provider window takes
// focus — on some window managers, every single time — and with it goes the
// listener waiting for the code. The service worker sees the provider's redirect
// land on our callback URL, reads the code out of it, and offscreen (which owns
// the PKCE verifier) finishes alone.
//
// These exercise the real handler graph: a real OffscreenServer, a real
// AuthClient, a real RemoteAuthClient. Only fetch and window.open are faked.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OffscreenServer } from '../src/offscreen/server';
import { matchOAuthCallback, isCheckoutReturn } from '../src/sw/oauth-watcher';
import { TransportClient } from '../src/shared/transport-client';
import { RemoteAuthClient } from '../src/content/RemoteAuthClient';
import type { MessageChannel } from '../src/shared/channel';
import type { Envelope } from '../src/shared/protocol';
import '../src/shared/messages';

function pairChannels(): [MessageChannel, MessageChannel] {
  const aIn = new Set<(env: Envelope) => void>();
  const bIn = new Set<(env: Envelope) => void>();
  const aDisc = new Set<() => void>();
  const bDisc = new Set<() => void>();
  let alive = true;
  const close = (): void => {
    if (!alive) return;
    alive = false;
    for (const cb of [...aDisc, ...bDisc]) cb();
  };
  return [
    {
      send: (env) => { if (!alive) throw new Error('disconnected'); for (const cb of bIn) cb(env); },
      onMessage: (cb) => { aIn.add(cb); return () => aIn.delete(cb); },
      onDisconnect: (cb) => { aDisc.add(cb); return () => aDisc.delete(cb); },
      close
    },
    {
      send: (env) => { if (!alive) throw new Error('disconnected'); for (const cb of aIn) cb(env); },
      onMessage: (cb) => { bIn.add(cb); return () => bIn.delete(cb); },
      onDisconnect: (cb) => { bDisc.add(cb); return () => bDisc.delete(cb); },
      close
    }
  ];
}

interface FetchSpy {
  fetch: typeof globalThis.fetch;
  readonly initCalls: number;
  readonly exchangeCalls: number;
  readonly checkoutCalls: number;
  readonly lastCheckoutBody: Record<string, unknown> | null;
  /** Make /start-checkout answer 409, as it does for a user who already owns
   *  the subscription. */
  failCheckoutWith409(): void;
}

function makeOAuthFetch(): FetchSpy {
  let initCalls = 0;
  let exchangeCalls = 0;
  let checkoutCalls = 0;
  let lastCheckoutBody: Record<string, unknown> | null = null;
  let checkout409 = false;
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/start-checkout')) {
      checkoutCalls++;
      lastCheckoutBody = init?.body ? JSON.parse(String(init.body)) : null;
      if (checkout409) {
        return new Response(
          JSON.stringify({ error: 'User already has an active purchase', hasActivePurchase: true }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      return new Response(
        JSON.stringify({
          checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_1',
          userId: 'rescued-u1',
          acquiring: 'stripe'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as unknown as Response;
    }
    if (u.includes('/auth/oauth/init')) {
      initCalls++;
      return new Response(
        JSON.stringify({ authorize_url: 'https://provider.example/authorize?x=1' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as unknown as Response;
    }
    if (u.includes('/auth/oauth/exchange')) {
      exchangeCalls++;
      return new Response(
        JSON.stringify({
          access_token: 'rescued-at',
          refresh_token: 'rescued-rt',
          expires_in: 3600,
          expires_at: Date.now() / 1000 + 3600,
          token_type: 'bearer',
          user: { id: 'rescued-u1', email: 'rescued@x.io' }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ) as unknown as Response;
    }
    return new Response('not found', { status: 404 }) as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch: impl,
    get initCalls() { return initCalls; },
    get exchangeCalls() { return exchangeCalls; },
    get checkoutCalls() { return checkoutCalls; },
    get lastCheckoutBody() { return lastCheckoutBody; },
    failCheckoutWith409() { checkout409 = true; }
  };
}

/** A server wired the way offscreen really is, with fetch stubbed globally
 *  (OffscreenServerOptions has no fetch injection — the clients pick up the
 *  global). */
function makeServer(paywallId: string, fetchSpy: FetchSpy): OffscreenServer {
  globalThis.fetch = fetchSpy.fetch;
  return new OffscreenServer({
    paywallId,
    apiOrigin: 'https://t.local',
    auth: true,
    analytics: false
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('matchOAuthCallback', () => {
  const origin = 'https://pay.acme.io';

  it('returns the code for our callback on the configured origin', () => {
    expect(
      matchOAuthCallback(`${origin}/paywall/v3/auth/callback?code=abc123`, origin)
    ).toBe('abc123');
  });

  it('accepts the edge mirror in both directions', () => {
    // The SDK failed over to the mirror, so /oauth/init built redirect_to there.
    expect(
      matchOAuthCallback('https://edge.pay.acme.io/paywall/v3/auth/callback?code=e1', origin)
    ).toBe('e1');
    // Configured with the mirror, callback came back on the canonical host.
    expect(
      matchOAuthCallback(`${origin}/paywall/v3/auth/callback?code=e2`, 'https://edge.pay.acme.io')
    ).toBe('e2');
  });

  it('ignores a foreign host, even with the right path and a code', () => {
    expect(
      matchOAuthCallback('https://evil.example/paywall/v3/auth/callback?code=abc', origin)
    ).toBeNull();
    // Suffix match must not be enough.
    expect(
      matchOAuthCallback('https://notpay.acme.io.evil.com/paywall/v3/auth/callback?code=abc', origin)
    ).toBeNull();
  });

  it('ignores other paths on our own origin', () => {
    expect(matchOAuthCallback(`${origin}/paywall/v3/auth/confirm?code=abc`, origin)).toBeNull();
    expect(matchOAuthCallback(`${origin}/?code=abc`, origin)).toBeNull();
  });

  it('returns null without a code, and for a code that is only in the fragment', () => {
    expect(matchOAuthCallback(`${origin}/paywall/v3/auth/callback`, origin)).toBeNull();
    // A worker cannot see fragments; GoTrue puts errors (not codes) there, so
    // this path stays with the old postMessage handling.
    expect(matchOAuthCallback(`${origin}/paywall/v3/auth/callback#code=abc`, origin)).toBeNull();
  });

  it('ignores non-http schemes and malformed input', () => {
    expect(matchOAuthCallback('javascript:alert(1)', origin)).toBeNull();
    expect(matchOAuthCallback('not a url', origin)).toBeNull();
    expect(matchOAuthCallback(`${origin}/paywall/v3/auth/callback?code=x`, 'not a url')).toBeNull();
  });
});

describe('isCheckoutReturn', () => {
  const origin = 'https://pay.acme.io';

  it('matches both post-payment pages, on the mirror too', () => {
    expect(isCheckoutReturn(`${origin}/paywall/797/checkout/success`, origin)).toBe(true);
    expect(isCheckoutReturn(`${origin}/paywall/797/checkout/error`, origin)).toBe(true);
    // The outcome rides in the fragment; matching must not depend on it.
    expect(
      isCheckoutReturn(`${origin}/paywall/797/checkout/success#paywall_status=paid`, origin)
    ).toBe(true);
    expect(
      isCheckoutReturn('https://edge.pay.acme.io/paywall/797/checkout/success', origin)
    ).toBe(true);
  });

  it('ignores anything else — including a merchant page we must not close', () => {
    expect(isCheckoutReturn('https://shop.example/thanks', origin)).toBe(false);
    expect(isCheckoutReturn(`${origin}/paywall/797/checkout`, origin)).toBe(false);
    expect(isCheckoutReturn(`${origin}/paywall/797/checkout/success/extra`, origin)).toBe(false);
    expect(isCheckoutReturn(`${origin}/paywall/v3/auth/callback?code=x`, origin)).toBe(false);
  });
});

describe('auth.oauthAdopt', () => {
  it('finishes a flow the originating surface never came back for', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('adopt-1', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    // The surface got as far as opening the provider window, then died.
    await sw.request('auth.oauthStart', { provider: 'google' });
    expect(fetchSpy.initCalls).toBe(1);

    const result = await sw.request('auth.oauthAdopt', { code: 'code-from-url' });

    expect(result.adopted).toBe(true);
    expect(fetchSpy.exchangeCalls).toBe(1);
    expect(server.auth!.getCachedSession()?.access_token).toBe('rescued-at');
  });

  it('reports no_pending_flow instead of throwing when there is nothing to adopt', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('adopt-2', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    const result = await sw.request('auth.oauthAdopt', { code: 'stray-code' });

    expect(result).toEqual({ adopted: false, reason: 'no_pending_flow' });
    expect(fetchSpy.exchangeCalls).toBe(0);
  });

  it('never sends one code to the provider twice when both paths race', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('adopt-3', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    const { state } = await sw.request('auth.oauthStart', { provider: 'google' });

    // The worker adopts; the surface turns out to be alive and asks too. The
    // code is single-use at GoTrue — a second exchange would kill the session.
    const [adopt, exchange] = await Promise.all([
      sw.request('auth.oauthAdopt', { code: 'shared-code' }),
      sw.request('auth.oauthExchange', { state, code: 'shared-code' })
    ]);

    expect(adopt.adopted).toBe(true);
    expect(exchange.access_token).toBe('rescued-at');
    expect(fetchSpy.exchangeCalls).toBe(1);

    // Late straggler, after both settled — still answered from the memo.
    const late = await sw.request('auth.oauthExchange', { state, code: 'shared-code' });
    expect(late.access_token).toBe('rescued-at');
    expect(fetchSpy.exchangeCalls).toBe(1);
  });
});

describe('resuming the purchase the sign-in was gating', () => {
  it('creates the checkout and hands its URL back for the tab to follow', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('resume-1', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    await sw.request('auth.oauthStart', {
      provider: 'google',
      resumeCheckout: { priceId: 'price_42', offerId: 'offer_7' }
    });

    const result = await sw.request('auth.oauthAdopt', { code: 'code-from-url' });

    expect(result.adopted).toBe(true);
    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/pay/cs_test_1');
    expect(fetchSpy.checkoutCalls).toBe(1);
    // The offer must travel with the intent — duration offers tick in client
    // storage and the backend cannot re-derive them.
    expect(fetchSpy.lastCheckoutBody?.offerId).toBe('offer_7');

    // The next surface to open must not flash the paywall at a user who is
    // mid-payment — same marker PaywallUI writes on checkout_started.
    const marker = await server.billing
      .getStorage()
      .getItem(`pw-resume-1-checkout-pending-v1`);
    expect(marker).toBeTruthy();
  });

  it('adopts without a checkout when no purchase was pending', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('resume-2', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    await sw.request('auth.oauthStart', { provider: 'google' });
    const result = await sw.request('auth.oauthAdopt', { code: 'code-from-url' });

    expect(result.adopted).toBe(true);
    expect(result.checkoutUrl).toBeUndefined();
    expect(fetchSpy.checkoutCalls).toBe(0);
  });

  it('does not create a second checkout when the surface handled the flow itself', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('resume-4', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    const { state } = await sw.request('auth.oauthStart', {
      provider: 'google',
      resumeCheckout: { priceId: 'price_42' }
    });

    // The popup survived, got the code by postMessage and exchanged it — it will
    // open the checkout itself, as it always has.
    await sw.request('auth.oauthExchange', { state, code: 'shared-code' });
    const adopt = await sw.request('auth.oauthAdopt', { code: 'shared-code' });

    // Two checkouts for one sign-in would mean two payment pages for the user.
    expect(adopt).toEqual({ adopted: false, reason: 'no_pending_flow' });
    expect(fetchSpy.checkoutCalls).toBe(0);
  });

  it('keeps the sign-in when the checkout 409s for an existing subscriber', async () => {
    const fetchSpy = makeOAuthFetch();
    fetchSpy.failCheckoutWith409();
    const server = makeServer('resume-3', fetchSpy);
    const [swSide, serverSide] = pairChannels();
    server.acceptChannel(serverSide);
    const sw = new TransportClient(() => swSide);

    await sw.request('auth.oauthStart', {
      provider: 'google',
      resumeCheckout: { priceId: 'price_42' }
    });
    const result = await sw.request('auth.oauthAdopt', { code: 'code-from-url' });

    // Sending them to pay a second time would be worse than sending them
    // nowhere: the session stands, the tab just closes.
    expect(result.adopted).toBe(true);
    expect(result.checkoutUrl).toBeUndefined();
    expect(server.auth!.getCachedSession()?.access_token).toBe('rescued-at');
  });
});

describe('signInWithOAuth when the window is closed by the rescue path', () => {
  it('resolves with the adopted session instead of reporting a cancellation', async () => {
    const fetchSpy = makeOAuthFetch();
    const server = makeServer('race-1', fetchSpy);
    const [tabSide, tabServerSide] = pairChannels();
    const [swSide, swServerSide] = pairChannels();
    server.acceptChannel(tabServerSide);
    server.acceptChannel(swServerSide);

    const tab = new RemoteAuthClient(new TransportClient(() => tabSide), {
      paywallId: 'race-1'
    });
    const sw = new TransportClient(() => swSide);

    const popup = {
      name: '',
      closed: false,
      close: () => {},
      location: { replace: () => {} }
    };
    const realOpen = window.open;
    window.open = vi.fn(() => popup as unknown as Window) as typeof window.open;

    try {
      // No postMessage will ever arrive — the surface's opener link is what the
      // real bug destroys.
      const signin = tab.signInWithOAuth({ provider: 'google' });
      await new Promise((r) => setTimeout(r, 50));

      // The worker read the code off the callback URL and finished the flow,
      // then closed the tab — which from the surface looks exactly like the user
      // closing the window.
      const adopt = await sw.request('auth.oauthAdopt', { code: 'code-from-url' });
      expect(adopt.adopted).toBe(true);
      popup.closed = true;

      // waitForOAuthResult polls `closed` every 500ms.
      const session = await signin;
      expect(session.access_token).toBe('rescued-at');
      expect(fetchSpy.exchangeCalls).toBe(1);
    } finally {
      window.open = realOpen;
    }
  }, 10_000);
});
