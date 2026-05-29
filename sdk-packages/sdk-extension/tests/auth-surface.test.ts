// @vitest-environment jsdom
// Phase 4 surface coverage. Доказываем что:
//  1. signInWithEmail в одной вкладке → broadcast authChange во все остальные
//  2. signOut в одной вкладке → broadcast в остальные
//  3. getCachedSession sync mirror работает после ready()
//
// Mock'аем только auth-эндпоинты; AuthClient остальное — это его настоящая
// реализация из @sdk/core/auth.

import { describe, it, expect, vi } from 'vitest';
import { AuthClient } from '@sdk/core/auth';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
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

function setupAuthServer(auth: AuthClient): TransportServer {
  const server = new TransportServer();
  server.on('auth.signInWithEmail', async (p) => auth.signInWithEmail(p));
  server.on('auth.signUp', async (p) => auth.signUp(p));
  server.on('auth.signOut', async () => auth.signOut());
  server.on('auth.refresh', async () => auth.refresh());
  server.on('auth.getCachedSession', () => auth.getCachedSession());
  // INITIAL_SESSION НЕ broadcast'им — каждый RemoteAuthClient выдаёт его
  // сам через свой microtask (см. реальный offscreen bridge в server.ts).
  auth.onAuthChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;
    server.broadcast('authChange', { event, session });
  });
  return server;
}

describe('signInWithEmail — single source of truth', () => {
  it('signin in tab1 broadcasts to tab2 onAuthChange', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/auth/email/signin')) {
        return new Response(
          JSON.stringify({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            expires_at: Date.now() / 1000 + 3600,
            token_type: 'bearer',
            user: { id: 'u1', email: 'u@x.io' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupAuthServer(auth);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteAuthClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteAuthClient(new TransportClient(() => c2), { paywallId: 'demo' });

    const tab2Sessions: (string | null)[] = [];
    tab2.onAuthChange((_event, s) => tab2Sessions.push(s?.access_token ?? null));

    const session = await tab1.signInWithEmail({ email: 'u@x.io', password: 'pw' });
    expect(session.access_token).toBe('at-1');

    // Дать microtask'ам docrunать broadcast.
    await new Promise((r) => setTimeout(r, 0));

    expect(tab2Sessions).toContain('at-1');
    // Sync getter в tab2 теперь выдаёт session — single source of truth.
    expect(tab2.getCachedSession()?.access_token).toBe('at-1');
  });

  it('signOut in tab1 broadcasts null to tab2', async () => {
    let signedOut = false;
    const fetch = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/auth/email/signin')) {
        return new Response(
          JSON.stringify({
            access_token: 'at-1',
            refresh_token: 'rt-1',
            expires_in: 3600,
            expires_at: Date.now() / 1000 + 3600,
            token_type: 'bearer',
            user: { id: 'u1', email: 'u@x.io' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      if (u.includes('/auth/signout')) {
        signedOut = true;
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const auth = new AuthClient({ paywallId: 'demo', apiOrigin: 'https://t.local', fetch });
    const server = setupAuthServer(auth);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteAuthClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteAuthClient(new TransportClient(() => c2), { paywallId: 'demo' });

    await tab1.signInWithEmail({ email: 'u@x.io', password: 'pw' });
    await new Promise((r) => setTimeout(r, 0));

    const events: (string | null)[] = [];
    tab2.onAuthChange((_event, s) => events.push(s?.access_token ?? null));

    await tab1.signOut();
    await new Promise((r) => setTimeout(r, 0));

    expect(signedOut).toBe(true);
    expect(events).toContain(null);
    expect(tab2.getCachedSession()).toBeNull();
  });
});

// OAuth split-API end-to-end (Phase 4.5). Симулируем полный flow:
//  1. content зовёт signInWithOAuth → transport.request('auth.oauthStart')
//  2. offscreen.AuthClient.startOAuthFlow → /init request → возвращает {url, state}
//  3. content делает window.open (мок), отдаёт fake popup
//  4. waitForOAuthCode подписывается на postMessage; мы шлём fake code
//  5. content зовёт transport.request('auth.oauthExchange') с code
//  6. offscreen.AuthClient.completeOAuthFlow → /exchange request → возвращает session
//  7. Server broadcast'ит authChange → tab2 видит session
describe('OAuth — full split-API flow', () => {
  function makeOAuthFetch(): {
    fetch: typeof globalThis.fetch;
    initCalls: number;
    exchangeCalls: number;
  } {
    let initCalls = 0;
    let exchangeCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
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
            access_token: 'oauth-at',
            refresh_token: 'oauth-rt',
            expires_in: 3600,
            expires_at: Date.now() / 1000 + 3600,
            token_type: 'bearer',
            user: { id: 'oauth-u1', email: 'oauth@x.io' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return {
      fetch: fetchImpl,
      get initCalls() { return initCalls; },
      get exchangeCalls() { return exchangeCalls; }
    };
  }

  it('signInWithOAuth: start → popup → exchange → session, broadcast в tab2', async () => {
    const fetchSpy = makeOAuthFetch();
    const auth = new AuthClient({
      paywallId: 'demo',
      apiOrigin: 'https://t.local',
      fetch: fetchSpy.fetch
    });
    const server = setupAuthServer(auth);
    // Add OAuth handlers (setupAuthServer был только для email surface).
    server.on('auth.oauthStart', async (params) => {
      const r = await auth.startOAuthFlow(params);
      return { authorizeUrl: r.authorize_url, state: r.state };
    });
    server.on('auth.oauthExchange', async (params) =>
      auth.completeOAuthFlow({ state: params.state, code: params.code })
    );

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteAuthClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteAuthClient(new TransportClient(() => c2), { paywallId: 'demo' });

    const tab2Sessions: (string | null)[] = [];
    tab2.onAuthChange((_event, s) => tab2Sessions.push(s?.access_token ?? null));

    // Mock window.open — возвращает fake popup. Sync-open с about:blank +
    // tempName, RemoteAuthClient переписывает popup.name = pw-oauth-<state>
    // после получения state из transport.request.
    let popupRef: { name: string; closed: boolean; close: () => void; location: { replace: (url: string) => void } } | null = null;
    const realOpen = window.open;
    window.open = vi.fn((_url, name) => {
      popupRef = {
        name: String(name),
        closed: false,
        close: () => {},
        location: { replace: () => {} }
      };
      return popupRef as unknown as Window;
    }) as typeof window.open;

    try {
      // Запускаем signin и в параллели «эмулируем» callback page'у.
      const signinPromise = tab1.signInWithOAuth({ provider: 'google' });

      // Дать popup открыться, RPC отстреляться, name переписаться, и
      // waitForOAuthCode подписаться на 'message'. 50мс вместо 5мс —
      // под параллельной нагрузкой (`pnpm test` запускает sdk-extension и
      // sdk-react vitest concurrently) 5мс не хватало, тест flaked.
      await new Promise((r) => setTimeout(r, 50));

      // Извлекаем state из popup.name (RemoteAuthClient выставил pw-oauth-<state>).
      expect(popupRef).not.toBeNull();
      const state = popupRef!.name.replace(/^pw-oauth-/, '');
      expect(state.length).toBeGreaterThan(0);

      // Симулируем postMessage от callback page'и: успешный code-redirect.
      window.postMessage(
        {
          type: 'pw-oauth',
          messageId: state,
          status: 'success',
          code: 'auth-code-xyz'
        },
        '*'
      );

      const session = await signinPromise;
      expect(session.access_token).toBe('oauth-at');
      expect(fetchSpy.initCalls).toBe(1);
      expect(fetchSpy.exchangeCalls).toBe(1);

      // Tab2 broadcast.
      await new Promise((r) => setTimeout(r, 0));
      expect(tab2Sessions).toContain('oauth-at');
      expect(tab2.getCachedSession()?.access_token).toBe('oauth-at');
    } finally {
      window.open = realOpen;
    }
  });

  it('signInWithOAuth: popup blocked → throws popup_blocked, no exchange call', async () => {
    const fetchSpy = makeOAuthFetch();
    const auth = new AuthClient({
      paywallId: 'demo',
      apiOrigin: 'https://t.local',
      fetch: fetchSpy.fetch
    });
    const server = setupAuthServer(auth);
    server.on('auth.oauthStart', async (params) => {
      const r = await auth.startOAuthFlow(params);
      return { authorizeUrl: r.authorize_url, state: r.state };
    });
    server.on('auth.oauthExchange', async (params) =>
      auth.completeOAuthFlow({ state: params.state, code: params.code })
    );

    const [c, s] = pairChannels();
    server.accept(s);

    const tab = new RemoteAuthClient(new TransportClient(() => c), { paywallId: 'demo' });

    const realOpen = window.open;
    window.open = vi.fn(() => null) as typeof window.open;

    try {
      await expect(tab.signInWithOAuth({ provider: 'google' })).rejects.toThrow(/popup/i);
      // Popup blocked СИНХРОННО — мы даже не успеваем дёрнуть oauthStart.
      // В отличие от старого варианта (где init шёл первым), новый порядок
      // sync popup → async RPC → redirect требует popup до RPC.
      expect(fetchSpy.initCalls).toBe(0);
      expect(fetchSpy.exchangeCalls).toBe(0);
    } finally {
      window.open = realOpen;
    }
  });
});
