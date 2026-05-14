// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient, type AuthChangeEvent, type AuthSession } from '../src/core/auth';
import { PaywallError } from '../src/core/types';
import { STORAGE_KEYS, type StorageAdapter } from '../src/core/storage';

// Каждый тест получает изолированный storage — module-level memoryMap из
// storage.ts протекает между тестами и приносит чужие auth-сессии.
function freshStorage(seed: Record<string, string> = {}): StorageAdapter {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: vi.fn(async (k: string) => map.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      map.delete(k);
    })
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const PAYWALL_ID = 'pw_1';
const API_ORIGIN = 'https://api.example.com';

function expiresInSeconds(seconds: number): { expires_in: number; expires_at: number } {
  const inMs = Date.now() + seconds * 1000;
  return { expires_in: seconds, expires_at: Math.floor(inMs / 1000) };
}

const USER = { id: 'u_1', email: 'a@b.c', country: 'US' };

describe('AuthClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws on missing paywallId', () => {
    expect(() => new AuthClient({ paywallId: '' })).toThrow(PaywallError);
  });

  it('signInWithEmail stores session and emits onAuthChange', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'a1',
        refresh_token: 'r1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    const events: Array<[AuthChangeEvent, AuthSession | null]> = [];
    auth.onAuthChange((event, s) => events.push([event, s]));

    const session = await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    expect(session.access_token).toBe('a1');
    expect(session.refresh_token).toBe('r1');
    expect(session.user).toEqual(USER);
    expect(auth.getCachedSession()).toEqual(session);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_ORIGIN}/api/v1/paywall/${PAYWALL_ID}/auth/email/signin`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      password: 'pw'
    });

    // microtask для onAuthChange initial-snapshot + sync emit при setSession.
    await Promise.resolve();
    // Order: INITIAL_SESSION (null) сразу после hydrate'а + SIGNED_IN на signin.
    expect(events).toContainEqual(['SIGNED_IN', session]);
  });

  it('signInWithEmail forwards visitor_id when present in storage', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'a1',
        refresh_token: 'r1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage({
        [STORAGE_KEYS.visitorId]: 'visitor_1234567890abcdef'
      })
    });

    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      password: 'pw',
      visitor_id: 'visitor_1234567890abcdef'
    });
  });

  it('signUp returns confirmation_required without setting session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: 'confirmation_required',
        user: { id: 'u_2', email: 'new@b.c' }
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    const res = await auth.signUp({ email: 'new@b.c', password: 'pw' });

    expect(res).toEqual({
      kind: 'confirmation_required',
      user: { id: 'u_2', email: 'new@b.c' }
    });
    expect(auth.getCachedSession()).toBeNull();
  });

  it('signUp signed_in sets session same as signin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: 'signed_in',
        access_token: 'a1',
        refresh_token: 'r1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    const res = await auth.signUp({ email: 'a@b.c', password: 'pw' });

    expect(res.kind).toBe('signed_in');
    expect(auth.getCachedSession()?.access_token).toBe('a1');
  });

  it('getAccessToken returns cached token if still fresh', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'a1',
        refresh_token: 'r1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    const token = await auth.getAccessToken();
    expect(token).toBe('a1');
    // Только signin-вызов; refresh не должен сработать на свежем токене.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getAccessToken triggers lazy refresh when token close to expiry', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        // Токен истекает через 30s — внутри REFRESH_LEEWAY_MS (60s) → должен рефрешнуться.
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(30),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({
          access_token: 'a2',
          refresh_token: 'r2',
          ...expiresInSeconds(3600),
          token_type: 'bearer'
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    const token = await auth.getAccessToken();

    expect(token).toBe('a2');
    expect(auth.getCachedSession()?.refresh_token).toBe('r2');
    // /refresh должен был быть вызван c текущим refresh_token.
    const refreshCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/refresh'));
    expect(refreshCall).toBeDefined();
    expect(JSON.parse(refreshCall![1]!.body as string)).toEqual({ refresh_token: 'r1' });
  });

  it('refresh dedupes parallel calls', async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(30),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/refresh')) {
        refreshCalls++;
        // Имитируем сетевую задержку, чтобы оба вызова успели собраться.
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse({
          access_token: 'a2',
          refresh_token: 'r2',
          ...expiresInSeconds(3600),
          token_type: 'bearer'
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    const [t1, t2] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);

    expect(t1).toBe('a2');
    expect(t2).toBe('a2');
    expect(refreshCalls).toBe(1);
  });

  it('refresh on 401 clears session and emits null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(30),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ error: 'refresh_failed', code: 'invalid_refresh_token' }, 401);
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    const events: Array<[AuthChangeEvent, AuthSession | null]> = [];
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });
    auth.onAuthChange((event, s) => events.push([event, s]));

    const token = await auth.getAccessToken();

    expect(token).toBeNull();
    expect(auth.getCachedSession()).toBeNull();
    await Promise.resolve();
    // INITIAL_SESSION snapshot + SIGNED_OUT после revoke (refresh→401).
    expect(events.at(-1)).toEqual(['SIGNED_OUT', null]);
  });

  it('signOut clears local state immediately and best-effort calls server', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/signout')) {
        return jsonResponse({ ok: true });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    await auth.signOut();

    expect(auth.getCachedSession()).toBeNull();
    const signoutCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/signout'));
    expect(signoutCall).toBeDefined();
    const headers = new Headers(signoutCall![1]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer a1');
  });

  it('signOut swallows server error — local state stays cleared', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/signout')) {
        return new Response('{}', { status: 502, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });
    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });

    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(auth.getCachedSession()).toBeNull();
  });

  it('hydrates session from storage on construct', async () => {
    const persisted = {
      access_token: 'a1',
      refresh_token: 'r1',
      expires_at: Date.now() + 3600_000,
      user: USER
    };
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      storage: freshStorage({
        [STORAGE_KEYS.authSession(PAYWALL_ID)]: JSON.stringify(persisted)
      }),
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({}))
    });
    await auth.ready();

    expect(auth.getCachedSession()).toEqual(persisted);
    expect(auth.getCachedUser()).toEqual(USER);
  });

  it('persists session on signin and clears on signOut', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/email/signin')) {
        return jsonResponse({
          access_token: 'a1',
          refresh_token: 'r1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: USER
        });
      }
      if (url.endsWith('/auth/signout')) return jsonResponse({ ok: true });
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    await auth.signInWithEmail({ email: 'a@b.c', password: 'pw' });
    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEYS.authSession(PAYWALL_ID),
      expect.stringContaining('"access_token":"a1"')
    );

    await auth.signOut();
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEYS.authSession(PAYWALL_ID));
  });

  // ── OTP ──────────────────────────────────────────────────────────────────

  it('sendOtp posts to /auth/otp/send with create_user default true', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await auth.sendOtp({ email: 'a@b.c' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_ORIGIN}/api/v1/paywall/${PAYWALL_ID}/auth/otp/send`);
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      create_user: true
    });
  });

  it('sendOtp respects createUser=false and forwards userMeta', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await auth.sendOtp({
      email: 'a@b.c',
      createUser: false,
      userMeta: { source: 'extension' }
    });

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      create_user: false,
      user_meta: { source: 'extension' }
    });
  });

  it('verifyOtp sets session and forwards visitor_id+type', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'a1',
        refresh_token: 'r1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage({
        [STORAGE_KEYS.visitorId]: 'visitor_1234567890abcdef'
      })
    });

    const session = await auth.verifyOtp({
      email: 'a@b.c',
      token: '123456'
    });

    expect(session.access_token).toBe('a1');
    expect(auth.getCachedSession()?.user).toEqual(USER);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_ORIGIN}/api/v1/paywall/${PAYWALL_ID}/auth/otp/verify`);
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@b.c',
      token: '123456',
      type: 'email',
      visitor_id: 'visitor_1234567890abcdef'
    });
  });

  it('verifyOtp with type=recovery passes through', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'recovery_a',
        refresh_token: 'recovery_r',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await auth.verifyOtp({
      email: 'a@b.c',
      token: '654321',
      type: 'recovery'
    });

    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init?.body as string).type).toBe('recovery');
  });

  // ── password reset ──────────────────────────────────────────────────────

  it('requestPasswordReset posts email and returns void', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await auth.requestPasswordReset({ email: 'a@b.c' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${API_ORIGIN}/api/v1/paywall/${PAYWALL_ID}/auth/password/request-reset`
    );
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'a@b.c' });
  });

  it('updatePassword sends Bearer + body, fails when not authenticated', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true, user: { id: 'u_1', email: 'a@b.c' } })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await expect(auth.updatePassword({ password: 'newpass' })).rejects.toThrow(
      PaywallError
    );

    // hydrate session manually и попробуем снова.
    const persisted = {
      access_token: 'access_x',
      refresh_token: 'refresh_x',
      expires_at: Date.now() + 3600_000,
      user: USER
    };
    const auth2 = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage({
        [STORAGE_KEYS.authSession(PAYWALL_ID)]: JSON.stringify(persisted)
      })
    });
    await auth2.ready();
    await auth2.updatePassword({ password: 'newpass' });
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/auth/password/update')
    );
    expect(call).toBeDefined();
    const headers = new Headers(call![1]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer access_x');
    expect(JSON.parse(call![1]!.body as string)).toEqual({ password: 'newpass' });
  });

  // ── OAuth ───────────────────────────────────────────────────────────────

  it('signInWithOAuth opens popup, exchanges code for session', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/oauth/init')) {
        return jsonResponse({
          authorize_url: 'https://gotrue.example.com/auth/v1/authorize?provider=google'
        });
      }
      if (url.endsWith('/auth/oauth/exchange')) {
        return jsonResponse({
          access_token: 'oa1',
          refresh_token: 'or1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: USER
        });
      }
      throw new Error('unexpected ' + url);
    });

    let openedUrl: string | null = null;
    let openedName: string | null = null;
    const popupShape: { closed: boolean; close: () => void } = {
      closed: false,
      close: () => {
        popupShape.closed = true;
      }
    };
    const fakePopup = popupShape as unknown as Window;

    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage(),
      openPopup: (url, name) => {
        openedUrl = url;
        openedName = name;
        return fakePopup;
      }
    });

    const sessionPromise = auth.signInWithOAuth({ provider: 'google' });

    // Дождёмся /oauth/init и openPopup.
    await vi.waitFor(() => {
      expect(openedUrl).toBeTruthy();
    });

    // Извлекаем state из URL и шлём postMessage от имени callback page.
    const u = new URL(openedUrl!);
    const state = u.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(8);
    expect(openedName).toBe(`pw-oauth-${state}`);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'pw-oauth',
          status: 'success',
          code: 'auth_code_xyz',
          messageId: state
        }
      })
    );

    const session = await sessionPromise;
    expect(session.access_token).toBe('oa1');
    expect(auth.getCachedSession()?.user).toEqual(USER);

    const exchangeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/oauth/exchange')
    );
    expect(exchangeCall).toBeDefined();
    const exchangeBody = JSON.parse(exchangeCall![1]!.body as string);
    expect(exchangeBody.auth_code).toBe('auth_code_xyz');
    expect(typeof exchangeBody.code_verifier).toBe('string');
    expect(exchangeBody.code_verifier.length).toBeGreaterThanOrEqual(43);

    // Init body должен содержать code_challenge, не verifier (verifier — на клиенте).
    const initCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/oauth/init')
    );
    const initBody = JSON.parse(initCall![1]!.body as string);
    expect(initBody.provider).toBe('google');
    expect(initBody.code_challenge_method).toBe('s256');
    expect(typeof initBody.code_challenge).toBe('string');
    expect(initBody.code_challenge_method).toBe('s256');
  });

  it('signInWithOAuth ignores postMessage with wrong state', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/oauth/init')) {
        return jsonResponse({
          authorize_url: 'https://gotrue.example.com/auth/v1/authorize'
        });
      }
      if (url.endsWith('/auth/oauth/exchange')) {
        return jsonResponse({
          access_token: 'oa1',
          refresh_token: 'or1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: USER
        });
      }
      throw new Error('unexpected ' + url);
    });

    const fakePopup = { closed: false, close: vi.fn() } as unknown as Window;
    let openedUrl = '';
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage(),
      openPopup: (url) => {
        openedUrl = url;
        return fakePopup;
      }
    });

    const sessionPromise = auth.signInWithOAuth({ provider: 'google' });
    await vi.waitFor(() => expect(openedUrl).toBeTruthy());
    const realState = new URL(openedUrl).searchParams.get('state')!;

    // Чужое сообщение с другим state — должно быть проигнорировано.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'pw-oauth', status: 'success', code: 'evil', messageId: 'wrong' }
      })
    );
    // Реальное.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'pw-oauth', status: 'success', code: 'good', messageId: realState }
      })
    );

    await sessionPromise;
    const exchangeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/oauth/exchange')
    );
    const body = JSON.parse(exchangeCall![1]!.body as string);
    expect(body.auth_code).toBe('good');
  });

  it('signInWithOAuth rejects oauth_cancelled when popup closed', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ authorize_url: 'https://gotrue.example.com/auth/v1/authorize' })
    );

    const fakePopup = { closed: false, close: vi.fn() } as unknown as Window;
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage(),
      openPopup: () => fakePopup
    });

    const sessionPromise = auth.signInWithOAuth({ provider: 'apple' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Имитируем закрытие — поллер должен это поймать.
    Object.defineProperty(fakePopup, 'closed', { value: true, configurable: true });

    await expect(sessionPromise).rejects.toThrow(/oauth_cancelled|closed/i);
  });

  it('signInWithOAuth rejects on popup_blocked when openPopup returns null', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ authorize_url: 'https://gotrue.example.com/auth/v1/authorize' })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage(),
      openPopup: () => null
    });

    await expect(
      auth.signInWithOAuth({ provider: 'google' })
    ).rejects.toThrow(/popup_blocked|blocked/i);
  });

  it('signInWithOAuth rejects with oauth_failed on error message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ authorize_url: 'https://gotrue.example.com/auth/v1/authorize' })
    );
    const fakePopup = { closed: false, close: vi.fn() } as unknown as Window;
    let openedUrl = '';
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage(),
      openPopup: (url) => {
        openedUrl = url;
        return fakePopup;
      }
    });

    const p = auth.signInWithOAuth({ provider: 'google' });
    await vi.waitFor(() => expect(openedUrl).toBeTruthy());
    const state = new URL(openedUrl).searchParams.get('state')!;

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'pw-oauth',
          status: 'error',
          error: 'access_denied',
          description: 'User cancelled at provider',
          messageId: state
        }
      })
    );

    await expect(p).rejects.toThrow(/cancelled|access_denied/i);
  });
});
