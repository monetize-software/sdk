import { describe, it, expect, vi } from 'vitest';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import type { MessageChannel } from '../src/shared/channel';
import type { Envelope } from '../src/shared/protocol';
import { RemoteBillingClient } from '../src/content/RemoteBillingClient';
import { BillingClient } from '@sdk/core/BillingClient';
import '../src/shared/messages';

// E2E-стиль тест: дёргаем тот же handler-граф, что в проде — RemoteBillingClient
// (content-side) → TransportClient → in-memory channel → TransportServer →
// real BillingClient (offscreen-side, mock fetch).
//
// Не покрывает SW forwarder и chrome.runtime layer (это в Phase 6 e2e через
// playwright + загруженное расширение). Здесь — что billing-граф работает
// при реальной сериализации запросов через wire-protocol.

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
      send: (env) => {
        if (!alive) throw new Error('disconnected');
        for (const cb of bIn) cb(env);
      },
      onMessage: (cb) => {
        aIn.add(cb);
        return () => aIn.delete(cb);
      },
      onDisconnect: (cb) => {
        aDisc.add(cb);
        return () => aDisc.delete(cb);
      },
      close
    },
    {
      send: (env) => {
        if (!alive) throw new Error('disconnected');
        for (const cb of aIn) cb(env);
      },
      onMessage: (cb) => {
        bIn.add(cb);
        return () => bIn.delete(cb);
      },
      onDisconnect: (cb) => {
        bDisc.add(cb);
        return () => bDisc.delete(cb);
      },
      close
    }
  ];
}

function setupOffscreenSide(billing: BillingClient): TransportServer {
  const server = new TransportServer();
  server.on('billing.bootstrap', async (params) => billing.bootstrap({ force: params.force }));
  server.on('billing.getCachedBootstrap', () => billing.getCachedBootstrap());
  server.on('billing.getVisitorId', async () => billing.getVisitorId());
  return server;
}

describe('bootstrap end-to-end (content ↔ in-memory ↔ offscreen)', () => {
  it('content gets bootstrap from offscreen via wire protocol', async () => {
    const mockBootstrap = {
      settings: { id: 'demo', name: 'Demo', brand_color: '#000' },
      prices: [] as unknown[],
      offers: [] as unknown[]
    };

    const fetch = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/bootstrap')) {
        return new Response(JSON.stringify(mockBootstrap), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });

    const server = setupOffscreenSide(billing);
    const [contentCh, offscreenCh] = pairChannels();
    server.accept(offscreenCh);

    const transport = new TransportClient(() => contentCh);
    const remote = new RemoteBillingClient(transport, {
      paywallId: 'demo',
      apiOrigin: 'https://test.local'
    });

    // Перед bootstrap'ом cached === null — как в обычном BillingClient.
    expect(remote.getCachedBootstrap()).toBeNull();

    const result = await remote.bootstrap();

    // Получили payload, fetch дёрнулся ровно один раз.
    expect(result.settings.id).toBe('demo');
    expect(fetch).toHaveBeenCalledTimes(1);

    // Sync-cache на content-стороне — теперь заполнен (mirror server-side).
    expect(remote.getCachedBootstrap()?.settings.id).toBe('demo');

    // Повторный bootstrap без force — server отдаёт из cache, fetch не растёт.
    await remote.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);

    // С force=true — server ходит в сеть.
    await remote.bootstrap({ force: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('multiple content-clients share single billing state on offscreen', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/bootstrap')) {
        return new Response(
          JSON.stringify({ settings: { id: 'shared', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const billing = new BillingClient({
      paywallId: 'shared',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupOffscreenSide(billing);

    // Симулируем две вкладки — каждая со своим content transport, но один
    // server (один offscreen, один BillingClient).
    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const remote1 = new RemoteBillingClient(new TransportClient(() => c1), {
      paywallId: 'shared'
    });
    const remote2 = new RemoteBillingClient(new TransportClient(() => c2), {
      paywallId: 'shared'
    });

    // Первый bootstrap из вкладки 1 — fetch отрабатывает.
    await remote1.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Второй bootstrap из вкладки 2 — должен подхватить тот же cached
    // BillingClient.cachedBootstrap, БЕЗ повторного сетевого запроса.
    // Это и есть главная победа архитектуры: один offscreen-источник правды.
    await remote2.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
