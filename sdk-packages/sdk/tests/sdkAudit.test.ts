// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient } from '../src/core/auth';
import { BillingClient } from '../src/core/BillingClient';
import { ApiGatewayClient } from '../src/core/ApiGatewayClient';
import { PaywallError } from '../src/core/types';
import { PaywallUI } from '../src/ui/PaywallUI';

const TEST_API_ORIGIN = 'https://test.example.com';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function freshStorage() {
  return {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {})
  };
}

describe('AuthClient.resendConfirmation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to /auth/email/resend with email body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.resendConfirmation({ email: 'a@b.c' });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/paywall/pw_1/auth/email/resend');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'a@b.c' }));
    auth.destroy();
  });

  it('forwards idempotencyKey as Idempotency-Key header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.resendConfirmation({ email: 'a@b.c', idempotencyKey: 'idem-123' });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('Idempotency-Key')).toBe('idem-123');
    auth.destroy();
  });
});

describe('AuthClient.revokeAllSessions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws not_authenticated when no session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.ready();
    await expect(auth.revokeAllSessions()).rejects.toMatchObject({
      code: 'not_authenticated'
    });
    auth.destroy();
  });

  it('POSTs to /auth/revoke-all with Bearer and clears local session on success', async () => {
    const SESSION = {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 3_600_000,
      user: { id: 'u_1', email: 'a@b.c' }
    };
    const seedStorage = freshStorage();
    seedStorage.getItem = vi.fn(async (k: string) =>
      k.endsWith('-auth-v1') ? JSON.stringify(SESSION) : null
    );
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/auth/revoke-all')) return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    });

    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      fetch: fetchMock,
      storage: seedStorage
    });
    await auth.ready();
    expect(auth.getCachedSession()).not.toBeNull();

    await auth.revokeAllSessions();

    const revokeCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/auth/revoke-all')
    );
    expect(revokeCall).toBeDefined();
    const headers = new Headers(revokeCall![1]?.headers);
    expect(headers.get('Authorization')).toBe('Bearer access-1');

    expect(auth.getCachedSession()).toBeNull();
    auth.destroy();
  });
});

describe('AuthClient.destroy guards', () => {
  afterEach(() => vi.restoreAllMocks());

  it('isDestroyed flips to true and is idempotent', () => {
    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      storage: freshStorage()
    });
    expect(auth.isDestroyed()).toBe(false);
    auth.destroy();
    expect(auth.isDestroyed()).toBe(true);
    auth.destroy(); // does not throw
  });

  it('setSession after destroy is no-op (no listener calls, no persist)', async () => {
    const storage = freshStorage();
    const auth = new AuthClient({
      paywallId: 'pw_1',
      apiOrigin: 'https://api.example.com',
      storage
    });
    await auth.ready();
    const events: unknown[] = [];
    auth.onAuthChange((s) => events.push(s));
    auth.destroy();
    // emulate stale callback dispatching to setSession after destroy
    (auth as unknown as { setSession: Function }).setSession({
      access_token: 'x',
      refresh_token: 'y',
      expires_at: Date.now() + 1000,
      user: { id: 'u', email: 'a@b.c' }
    });
    expect(auth.getCachedSession()).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('BillingClient.destroy clears listeners', () => {
  afterEach(() => vi.restoreAllMocks());

  it('userListeners and balanceListeners cleared', () => {
    const billing = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      storage: freshStorage()
    });
    const userCb = vi.fn();
    const balCb = vi.fn();
    billing.onUserChange(userCb);
    billing.onBalanceChange(balCb);
    billing.destroy();
    // Emit directly via the private applyUser/applyBalances — the listeners
    // should already be empty.
    (billing as unknown as { applyUser: Function }).applyUser({
      has_active_subscription: true,
      purchases: [],
      trial: null
    });
    (billing as unknown as { applyBalances: Function }).applyBalances([
      { type: 'free', count: 1 }
    ]);
    expect(userCb).not.toHaveBeenCalled();
    expect(balCb).not.toHaveBeenCalled();
  });
});

describe('apiKey/userId security warnings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('apiKey in browser throws apikey_in_browser by default', () => {
    expect(
      () =>
        new BillingClient({
          apiOrigin: TEST_API_ORIGIN,
          paywallId: 'pw_1',
          apiKey: 'sk_test_xxx',
          fetch: async () => jsonResponse({}),
          storage: freshStorage()
        })
    ).toThrowError(
      expect.objectContaining({ code: 'apikey_in_browser' })
    );
  });

  it('apiKey in browser with allowInsecureBrowserUsage warns instead of throwing', () => {
    const errSpy = console.error as unknown as ReturnType<typeof vi.fn>;
    expect(
      () =>
        new BillingClient({
          apiOrigin: TEST_API_ORIGIN,
          paywallId: 'pw_1',
          apiKey: 'sk_test_xxx',
          allowInsecureBrowserUsage: true,
          fetch: async () => jsonResponse({}),
          storage: freshStorage()
        })
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    const msg = (errSpy.mock.calls[0]?.[0] as string) || '';
    expect(msg).toContain('SECURITY');
    expect(msg).toContain('apiKey');
  });

  it('ApiGatewayClient userId without auth in browser triggers console.warn', () => {
    const warnSpy = console.warn as unknown as ReturnType<typeof vi.fn>;
    new ApiGatewayClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      userId: 'usr_1',
      fetch: async () => jsonResponse({})
    });
    expect(warnSpy).toHaveBeenCalled();
    const msg = (warnSpy.mock.calls[0]?.[0] as string) || '';
    expect(msg).toContain('WARNING');
  });
});

describe('AbortSignal threading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bootstrap propagates AbortSignal and surfaces aborted error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      // simulate aborted fetch
      if (init?.signal?.aborted) {
        const err = new DOMException('aborted', 'AbortError');
        throw err;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const billing = new BillingClient({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: fetchMock,
      storage: freshStorage()
    });
    const ctrl = new AbortController();
    const promise = billing.bootstrap({ signal: ctrl.signal });
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    expect(promise).toBeInstanceOf(Promise);
  });
});

describe('PaywallUI.getState / onStateChange', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => vi.restoreAllMocks());

  it('default state is closed', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    expect(ui.getState()).toEqual({ open: false, view: null, error: null, processing: false });
  });

  it('onStateChange emits initial snapshot in microtask by default', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    ui.onStateChange(cb);
    expect(cb).not.toHaveBeenCalled(); // microtask, not sync
    await Promise.resolve();
    expect(cb).toHaveBeenCalledWith({ open: false, view: null, error: null, processing: false });
  });

  it('onStateChange with immediate:sync calls in same tick', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    ui.onStateChange(cb, { immediate: 'sync' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ open: false, view: null, error: null, processing: false });
  });

  it('onStateChange with immediate:none does not deliver initial', async () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    ui.onStateChange(cb, { immediate: 'none' });
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes listener', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    const off = ui.onStateChange(cb, { immediate: 'sync' });
    cb.mockReset();
    off();
    // applyState directly for the check
    (ui as unknown as { applyState: Function }).applyState({
      open: true,
      view: 'loading',
      error: null,
      processing: false
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('applyState is idempotent for same snapshot', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    ui.onStateChange(cb, { immediate: 'sync' });
    cb.mockReset();
    (ui as unknown as { applyState: Function }).applyState({
      open: false,
      view: null,
      error: null,
      processing: false
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it('error snapshot carries PaywallError', () => {
    const ui = new PaywallUI({
      apiOrigin: TEST_API_ORIGIN,
      paywallId: 'pw_1',
      fetch: async () => jsonResponse({}),
      autoDetectReturn: false
    });
    const cb = vi.fn();
    ui.onStateChange(cb, { immediate: 'sync' });
    cb.mockReset();
    const err = new PaywallError('boom', 'oops');
    (ui as unknown as { applyState: Function }).applyState({
      open: true,
      view: 'error',
      error: err,
      processing: false
    });
    expect(cb).toHaveBeenCalledWith({
      open: true,
      view: 'error',
      error: err,
      processing: false
    });
    expect(ui.getState().error).toBe(err);
  });
});
