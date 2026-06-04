// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../src/core/auth';
import { PaywallUI } from '../src/ui/PaywallUI';

const TEST_API_ORIGIN = 'https://test.example.com';

// Tests for integrating AuthClient into PaywallUI:
// - `auth: true` creates an AuthClient automatically and puts it on paywall.auth;
// - `auth: AuthClient` uses the passed instance (doesn't create a second one);
// - the `authChange` event is emitted on login/logout.

const noopFetch: typeof fetch = async () =>
  new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

interface FetchCall {
  url: string;
  init: RequestInit;
}

function spyFetch(extra?: (url: string) => Response | null): {
  fetchSpy: typeof fetch;
  events: FetchCall[];
} {
  const events: FetchCall[] = [];
  const fetchSpy: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/events')) {
      events.push({ url, init: init ?? {} });
      return new Response(null, { status: 204 });
    }
    if (extra) {
      const r = extra(url);
      if (r) return r;
    }
    return noopFetch(input as RequestInfo, init);
  };
  return { fetchSpy, events };
}

describe('PaywallUI auth integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('auth: true creates AuthClient and exposes via .auth', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      auth: true,
      analytics: false
    });
    expect(ui.auth).toBeInstanceOf(AuthClient);
    expect(ui.auth?.paywallId).toBe('pw_1');
  });

  it('auth: <AuthClient> reuses passed instance', () => {
    const auth = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: noopFetch });
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      auth,
      analytics: false
    });
    expect(ui.auth).toBe(auth);
  });

  it('omitting auth keeps managed-auth disabled', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      analytics: false
    });
    expect(ui.auth).toBeUndefined();
  });

  it('billing client receives the same AuthClient (Bearer-bridge wired)', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      auth: true,
      analytics: false
    });
    expect(ui.billing.auth).toBe(ui.auth);
  });

  it('emits authChange when AuthClient session changes', () => {
    const auth = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: noopFetch });
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      auth,
      analytics: false
    });

    const handler = vi.fn();
    ui.on('authChange', handler);

    // Force an emit on AuthClient via the private setSession —
    // simulating login without a network round-trip. The alternative (a full signin)
    // would require mocking the /signin endpoint, which is already covered in auth.test.ts.
    const fakeSession = {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: Date.now() + 3600_000,
      user: { id: 'u_1', email: 'a@b.c' }
    };
    (
      auth as unknown as {
        setSession: (s: unknown, opts: { event: string }) => void;
      }
    ).setSession(fakeSession, { event: 'SIGNED_IN' });

    expect(handler).toHaveBeenCalledWith({ event: 'SIGNED_IN', session: fakeSession });
  });

  it('destroy() unsubscribes from AuthClient', () => {
    const auth = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: 'pw_1', fetch: noopFetch });
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: noopFetch,
      autoDetectReturn: false,
      auth,
      analytics: false
    });
    const handler = vi.fn();
    ui.on('authChange', handler);

    ui.destroy();

    const fakeSession = {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: Date.now() + 3600_000,
      user: { id: 'u_1', email: 'a@b.c' }
    };
    (
      auth as unknown as {
        setSession: (s: unknown, opts: { event: string }) => void;
      }
    ).setSession(fakeSession, { event: 'SIGNED_IN' });

    // listeners were cleared by destroy() — the handler must not fire, even if
    // AuthClient keeps emitting.
    expect(handler).not.toHaveBeenCalled();
  });
});
