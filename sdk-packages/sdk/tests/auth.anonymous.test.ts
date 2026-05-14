// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthClient, type AuthChangeEvent, type AuthSession } from '../src/core/auth';
import { PaywallError } from '../src/core/types';
import { STORAGE_KEYS, type StorageAdapter } from '../src/core/storage';

// Каждый тест получает изолированный storage — module-level memoryMap из
// storage.ts протекает между тестами и приносит чужие auth-сессии.
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

    // Body НЕ должен содержать captcha_token, когда host его не передал.
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

    // Rotated refresh_token должен быть persisted.
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar_new');

    // Только refresh, никакого signin.
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
    // Старый мёртвый token заменён на свежий.
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
    // Должен быть только один сетевой signin — второй вызов фигурирует как no-op.
    const signinCalls = fetchMock.mock.calls.filter(([u]) =>
      urlOf(u).endsWith('/auth/anonymous/signin')
    );
    expect(signinCalls).toHaveLength(1);
  });

  it('forceCaptcha bypasses resume and creates a new anon', async () => {
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
      forceCaptcha: true
    });

    expect(session.user.id).toBe('anon_uid_2');
    expect(storage._map.get(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe('ar_fresh');
    // Resume через refresh не вызывался.
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
    // GoTrue /logout НЕ должен быть вызван — иначе refresh_token инвалидируется
    // и resume в следующий signInAnonymously сломается.
    const signoutCalls = fetchMock.mock.calls.filter(([u]) =>
      urlOf(u).endsWith('/auth/signout')
    );
    expect(signoutCalls).toHaveLength(0);
    // Anon refresh-токен сохранён.
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
    // user.id остался тем же — балансы не теряются.
    expect(result.session.user.id).toBe('anon_uid_1');
    // Токены текущей сессии остались — GoTrue updateUser не вращает их.
    expect(result.session.access_token).toBe('aa1');

    // Anon refresh_token очищается — после upgrade юзер не должен случайно
    // вернуться в анон-стейт через signInAnonymously().
    expect(storage._map.has(STORAGE_KEYS.anonRefreshToken(PAYWALL_ID))).toBe(false);

    // Bearer был отправлен на upgrade-эндпоинт.
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

    // Локальная сессия должна остаться анонимной — confirmation pending.
    const cached = auth.getCachedSession();
    expect(cached?.user.is_anonymous).toBe(true);
    expect(cached?.user.email).toBeNull();
    // Anon refresh_token НЕ должен быть очищен — пользователь всё ещё анон,
    // signOut должен возвращать его в этот же акк.
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
