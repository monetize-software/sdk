// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient, type AuthChangeEvent, type AuthSession } from '../src/core/auth';
import { PaywallError } from '../src/core/types';
import { STORAGE_KEYS, type StorageAdapter } from '../src/core/storage';

// Each test gets an isolated storage — the module-level memoryMap from
// storage.ts leaks between tests and brings in other tests' auth sessions.
function freshStorage(seed: Record<string, string> = {}): StorageAdapter & {
  _map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    _map: map,
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

function expiresInSeconds(seconds: number): { expires_in: number; expires_at: number } {
  const inMs = Date.now() + seconds * 1000;
  return { expires_in: seconds, expires_at: Math.floor(inMs / 1000) };
}

const PAYWALL_ID = 'pw_1';
const API_ORIGIN = 'https://api.example.com';

import type { AuthUser } from '../src/core/auth';

const ANON_USER: AuthUser = { id: 'anon_uid_1', email: null, is_anonymous: true };

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

describe('AuthClient.signInAnonymously', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates anon session and persists refresh_token without captcha', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const session = await auth.signInAnonymously();

    expect(session.access_token).toBe('aa1');
    expect(session.refresh_token).toBe('ar1');
    expect(session.user.is_anonymous).toBe(true);
    expect(session.user.email).toBeNull();
    expect(auth.getCachedSession()).toEqual(session);
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar1');

    // The body must NOT contain captcha_token when the host did not pass it.
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.captcha_token).toBeUndefined();
  });

  it('forwards captchaToken in body when host passes it (forward-compat)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'aa1',
        refresh_token: 'ar1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: ANON_USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage: freshStorage()
    });

    await auth.signInAnonymously({ captchaToken: 'cf_token_xyz' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      captcha_token: 'cf_token_xyz'
    });
  });

  it('resumes via stored anon refresh_token without captcha', async () => {
    const storage = freshStorage({
      [STORAGE_KEYS.anonRefreshToken(PAYWALL_ID)]: 'ar_old'
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({
          access_token: 'aa_new',
          refresh_token: 'ar_new',
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
      storage
    });

    const session = await auth.signInAnonymously();

    expect(session.access_token).toBe('aa_new');
    expect(session.refresh_token).toBe('ar_new');

    // The rotated refresh_token must be persisted.
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar_new');

    // Refresh only, no signin.
    const calls = fetchMock.mock.calls.map(([u]) => urlOf(u));
    expect(calls.some((u) => u.endsWith('/auth/refresh'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/auth/anonymous/signin'))).toBe(false);
  });

  it('clears anon token on resume 401 and falls through to fresh signin', async () => {
    const storage = freshStorage({
      [STORAGE_KEYS.anonRefreshToken(PAYWALL_ID)]: 'ar_dead'
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse({ error: 'invalid_refresh_token' }, 401);
      }
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa_new',
          refresh_token: 'ar_new',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const session = await auth.signInAnonymously();

    expect(session.refresh_token).toBe('ar_new');
    // The old dead token is replaced with a fresh one.
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar_new');

    const calls = fetchMock.mock.calls.map(([u]) => urlOf(u));
    expect(calls.some((u) => u.endsWith('/auth/refresh'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/auth/anonymous/signin'))).toBe(true);
  });

  it('is no-op when already anonymous (idempotent)', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const first = await auth.signInAnonymously({ captchaToken: 'tok' });
    const second = await auth.signInAnonymously();

    expect(second).toBe(first);
    // There must be only one network signin — the second call acts as a no-op.
    const signinCalls = fetchMock.mock.calls.filter(([u]) =>
      urlOf(u).endsWith('/auth/anonymous/signin')
    );
    expect(signinCalls).toHaveLength(1);
  });

  it('forceNewAnon bypasses resume and creates a new anon', async () => {
    const storage = freshStorage({
      [STORAGE_KEYS.anonRefreshToken(PAYWALL_ID)]: 'ar_existing'
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa_fresh',
          refresh_token: 'ar_fresh',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: { id: 'anon_uid_2', email: null, is_anonymous: true }
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const session = await auth.signInAnonymously({
      captchaToken: 'fresh_tok',
      forceNewAnon: true
    });

    expect(session.user.id).toBe('anon_uid_2');
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar_fresh');
    // Resume via refresh was not called.
    const calls = fetchMock.mock.calls.map(([u]) => urlOf(u));
    expect(calls.some((u) => u.endsWith('/auth/refresh'))).toBe(false);
  });

  it('dedupes parallel signInAnonymously calls', async () => {
    const storage = freshStorage();
    let serverHits = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        serverHits++;
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const [a, b, c] = await Promise.all([
      auth.signInAnonymously({ captchaToken: 't' }),
      auth.signInAnonymously({ captchaToken: 't' }),
      auth.signInAnonymously({ captchaToken: 't' })
    ]);

    expect(serverHits).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('emits onAuthChange after signin', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: 'aa1',
        refresh_token: 'ar1',
        ...expiresInSeconds(3600),
        token_type: 'bearer',
        user: ANON_USER
      })
    );
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    const events: Array<[AuthChangeEvent, AuthSession | null]> = [];
    auth.onAuthChange((event, s) => events.push([event, s]));

    const session = await auth.signInAnonymously({ captchaToken: 't' });
    await Promise.resolve();
    expect(events.at(-1)).toEqual(['SIGNED_IN', session]);
  });
});

describe('AuthClient.signOut with anonymous session', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps anon refresh_token by default and skips /auth/signout call', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
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
      storage
    });
    await auth.signInAnonymously({ captchaToken: 't' });

    await auth.signOut();

    expect(auth.getCachedSession()).toBeNull();
    // GoTrue /logout must NOT be called — otherwise the refresh_token is
    // invalidated and resume on the next signInAnonymously breaks.
    const signoutCalls = fetchMock.mock.calls.filter(([u]) =>
      urlOf(u).endsWith('/auth/signout')
    );
    expect(signoutCalls).toHaveLength(0);
    // The anon refresh token is preserved.
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar1');
  });

  it('forgetAnonymous=true clears anon refresh_token AND calls /auth/signout', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
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
      storage
    });
    await auth.signInAnonymously({ captchaToken: 't' });

    await auth.signOut({ forgetAnonymous: true });

    expect(auth.getCachedSession()).toBeNull();
    expect(storage._map.has(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe(false);
    const signoutCalls = fetchMock.mock.calls.filter(([u]) =>
      urlOf(u).endsWith('/auth/signout')
    );
    expect(signoutCalls).toHaveLength(1);
  });
});

describe('AuthClient.upgradeAnonymousToEmail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws not_authenticated when no session', async () => {
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({})),
      storage: freshStorage()
    });

    await expect(
      auth.upgradeAnonymousToEmail({ email: 'a@b.c', password: 'pw' })
    ).rejects.toBeInstanceOf(PaywallError);
  });

  it('updated → patches session with email + is_anonymous=false; clears anon token', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      if (url.endsWith('/auth/anonymous/upgrade')) {
        return jsonResponse({
          status: 'updated',
          user: { id: 'anon_uid_1', email: 'a@b.c', is_anonymous: false }
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    await auth.signInAnonymously({ captchaToken: 't' });
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar1');

    const result = await auth.upgradeAnonymousToEmail({
      email: 'a@b.c',
      password: 'pw'
    });

    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') throw new Error('expected updated');
    expect(result.session.user.email).toBe('a@b.c');
    expect(result.session.user.is_anonymous).toBe(false);
    // user.id stayed the same — balances are not lost.
    expect(result.session.user.id).toBe('anon_uid_1');
    // The current session's tokens stayed — GoTrue updateUser does not rotate them.
    expect(result.session.access_token).toBe('aa1');

    // The anon refresh_token is cleared — after the upgrade the user must not
    // accidentally fall back to the anon state via signInAnonymously().
    expect(storage._map.has(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe(false);

    // Bearer was sent to the upgrade endpoint.
    const upgradeCall = fetchMock.mock.calls.find(([u]) =>
      urlOf(u).endsWith('/auth/anonymous/upgrade')
    );
    const headers = new Headers(upgradeCall![1]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer aa1');
  });

  it('confirmation_required → keeps anon session unchanged', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      if (url.endsWith('/auth/anonymous/upgrade')) {
        return jsonResponse({ status: 'confirmation_required', email: 'a@b.c' });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    await auth.signInAnonymously({ captchaToken: 't' });
    const result = await auth.upgradeAnonymousToEmail({
      email: 'a@b.c',
      password: 'pw'
    });

    expect(result.kind).toBe('confirmation_required');
    if (result.kind !== 'confirmation_required') throw new Error('wrong branch');
    expect(result.email).toBe('a@b.c');

    // The local session must stay anonymous — confirmation pending.
    const cached = auth.getCachedSession();
    expect(cached?.user.is_anonymous).toBe(true);
    expect(cached?.user.email).toBeNull();
    // The anon refresh_token must NOT be cleared — the user is still anonymous,
    // and signOut should return them to the same account.
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar1');
  });

  it('forwards Idempotency-Key header when provided', async () => {
    const storage = freshStorage();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/anonymous/signin')) {
        return jsonResponse({
          access_token: 'aa1',
          refresh_token: 'ar1',
          ...expiresInSeconds(3600),
          token_type: 'bearer',
          user: ANON_USER
        });
      }
      if (url.endsWith('/auth/anonymous/upgrade')) {
        return jsonResponse({
          status: 'updated',
          user: { id: 'anon_uid_1', email: 'a@b.c', is_anonymous: false }
        });
      }
      throw new Error('unexpected ' + url);
    });
    const auth = new AuthClient({
      paywallId: PAYWALL_ID,
      apiOrigin: API_ORIGIN,
      fetch: fetchMock,
      storage
    });

    await auth.signInAnonymously({ captchaToken: 't' });
    await auth.upgradeAnonymousToEmail({
      email: 'a@b.c',
      password: 'pw',
      idempotencyKey: 'idem_42'
    });

    const upgradeCall = fetchMock.mock.calls.find(([u]) =>
      urlOf(u).endsWith('/auth/anonymous/upgrade')
    );
    const headers = new Headers(upgradeCall![1]!.headers);
    expect(headers.get('Idempotency-Key')).toBe('idem_42');
  });
});
