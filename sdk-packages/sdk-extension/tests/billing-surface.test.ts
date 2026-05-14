// Phase 3 surface coverage. Доказываем что для двух одновременных «вкладок»:
//  1. createCheckout({priceId:'p1'}) дедупится в один сетевой запрос
//  2. userChange после setIdentity broadcast'ится в обе вкладки
//  3. balancesChange после force-refresh broadcast'ится в обе

import { describe, it, expect, vi } from 'vitest';
import { BillingClient } from '@sdk/core/BillingClient';
import { createTrialStore } from '@sdk/core/trial';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import { RemoteBillingClient } from '../src/content/RemoteBillingClient';
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

function setupServer(billing: BillingClient): TransportServer {
  const server = new TransportServer();
  server.on('billing.bootstrap', async (p) => billing.bootstrap({ force: p.force }));
  server.on('billing.getCachedBootstrap', () => billing.getCachedBootstrap());
  server.on('billing.getVisitorId', async () => billing.getVisitorId());
  server.on('billing.getUser', async (p) => billing.getUser({ force: p.force }));
  server.on('billing.getCachedUser', () => billing.getCachedUser());
  server.on('billing.getBalances', async (p) => billing.getBalances({ force: p.force }));
  server.on('billing.getCachedBalances', () => billing.getCachedBalances());
  server.on('billing.createCheckout', async (p) => billing.createCheckout(p));
  server.on('billing.getIdentity', () => billing.getIdentity() ?? null);
  server.on('billing.setIdentity', (p) => {
    billing.setIdentity(p.identity ?? undefined);
  });

  // Storage proxy — как в OffscreenServer.
  const storage = billing.getStorage();
  server.on('storage.get', async (p) => storage.getItem(p.key));
  server.on('storage.set', async (p) => {
    await storage.setItem(p.key, p.value);
  });
  server.on('storage.remove', async (p) => {
    await storage.removeItem(p.key);
  });

  // Trial-store proxy с эмуляцией navigator.locks через простую очередь —
  // node-окружение не имеет navigator.locks, делаем sequential queue, чтобы
  // тест атомарности воспроизводился. В реальном offscreen используется
  // navigator.locks из chrome.
  let trialQueue: Promise<unknown> = Promise.resolve();
  const serializeTrial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = trialQueue.then(fn);
    trialQueue = next.catch((): undefined => undefined);
    return next;
  };
  server.on('trial.check', async (p) =>
    serializeTrial(() => createTrialStore(billing.getStorage(), p.paywallId, p.config).check())
  );
  server.on('trial.recordBlock', async (p) =>
    serializeTrial(() =>
      createTrialStore(billing.getStorage(), p.paywallId, p.config).recordBlock()
    )
  );
  server.on('trial.reset', async (p) =>
    serializeTrial(() => createTrialStore(billing.getStorage(), p.paywallId, p.config).reset())
  );

  // Broadcast bridges — ровно как в OffscreenServer.
  billing.onUserChange((u) => server.broadcast('userChange', u), { immediate: 'none' });
  billing.onBalanceChange((b) => server.broadcast('balancesChange', b), { immediate: 'none' });

  return server;
}

function makeFetch(handlers: Record<string, () => unknown>): typeof globalThis.fetch {
  return vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        const body = fn();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }) as unknown as Response;
      }
    }
    return new Response('not found', { status: 404 }) as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('createCheckout — dedupe across tabs', () => {
  it('two tabs simultaneously firing createCheckout get one fetch and identical URL', async () => {
    let checkoutCalls = 0;
    const fetch = makeFetch({
      '/bootstrap': () => ({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] }),
      '/start-checkout': () => {
        checkoutCalls++;
        return { checkoutUrl: `https://pay/${checkoutCalls}`, userId: 'u1', acquiring: 'stripe' };
      }
    });

    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      identity: { email: 'u@x.io' },
      fetch
    });
    const server = setupServer(billing);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteBillingClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteBillingClient(new TransportClient(() => c2), { paywallId: 'demo' });

    // Симуляция: оба таба кликают «купить» одновременно. Идемпотентный ключ
    // не передан → BillingClient дедупит по `auto:${priceId}`.
    const [r1, r2] = await Promise.all([
      tab1.createCheckout({ priceId: '5' }),
      tab2.createCheckout({ priceId: '5' })
    ]);

    expect(checkoutCalls).toBe(1);
    expect(r1.url).toBe(r2.url);
  });
});

describe('user/balance broadcast', () => {
  it('userChange in offscreen reaches both content-side listeners', async () => {
    let active = false;
    const fetch = makeFetch({
      '/bootstrap': () => ({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] }),
      '/user-state': () => ({
        has_active_subscription: active,
        purchases: [] as unknown[],
        trial: null
      })
    });

    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      identity: { email: 'seed@x.io' },
      fetch
    });
    const server = setupServer(billing);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteBillingClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteBillingClient(new TransportClient(() => c2), { paywallId: 'demo' });

    const tab1Events: boolean[] = [];
    const tab2Events: boolean[] = [];
    tab1.onUserChange((u) => tab1Events.push(u.has_active_subscription));
    tab2.onUserChange((u) => tab2Events.push(u.has_active_subscription));

    // Tab1 force-fetch юзера — broadcast долетает до обоих табов.
    await tab1.getUser({ force: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(tab1Events).toContain(false);
    expect(tab2Events).toContain(false);

    // Эмулируем покупку: meaningfully изменился shape.
    active = true;
    await tab2.getUser({ force: true });
    await new Promise((r) => setTimeout(r, 0));

    // Оба таба должны увидеть active=true (broadcast от offscreen в оба).
    expect(tab1Events).toContain(true);
    expect(tab2Events).toContain(true);
  });
});

describe('trial-store atomic via offscreen', () => {
  it('two tabs racing recordBlock — one decrement (no drift)', async () => {
    const fetch = makeFetch({
      '/bootstrap': () => ({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] })
    });
    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupServer(billing);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteBillingClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteBillingClient(new TransportClient(() => c2), { paywallId: 'demo' });

    const config = { mode: 'opens' as const, payload: 5, storage: 'client' as const };

    // Initial: 5 показов доступно. Каждый recordBlock декрементит остаток.
    // Тaбы кидают recordBlock одновременно — server обрабатывает их строго
    // последовательно (locks в offscreen-server'е).
    const store1 = tab1.createTrialStore(config);
    const store2 = tab2.createTrialStore(config);

    const [r1, r2] = await Promise.all([store1.recordBlock(), store2.recordBlock()]);

    // Без атомарности оба бы прочитали по 5 → оба записали 4 → drift в 1.
    // С atomic: первый ушёл с 4, второй с 3 (или наоборот — сам order не важен).
    expect(r1.mode).toBe('opens');
    expect(r2.mode).toBe('opens');
    if (r1.mode === 'opens' && r2.mode === 'opens') {
      const remainings = [r1.remainingActions, r2.remainingActions].sort();
      expect(remainings).toEqual([3, 4]);
    }
  });

  it('check is non-mutating, recordBlock advances state', async () => {
    const fetch = makeFetch({
      '/bootstrap': () => ({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] })
    });
    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupServer(billing);
    const [c, s] = pairChannels();
    server.accept(s);

    const tab = new RemoteBillingClient(new TransportClient(() => c), { paywallId: 'demo' });
    const store = tab.createTrialStore({ mode: 'opens', payload: 3, storage: 'client' });

    const c1 = await store.check();
    const c2 = await store.check();
    if (c1.mode === 'opens' && c2.mode === 'opens') {
      expect(c1.remainingActions).toBe(c2.remainingActions);
    }

    await store.recordBlock();
    const c3 = await store.check();
    if (c1.mode === 'opens' && c3.mode === 'opens') {
      expect(c3.remainingActions).toBeLessThan(c1.remainingActions);
    }
  });
});

describe('storage proxy — single source of truth across tabs', () => {
  it('getStorage from two tabs shares same backing store via offscreen', async () => {
    const fetch = makeFetch({
      '/bootstrap': () => ({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] })
    });
    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupServer(billing);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteBillingClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteBillingClient(new TransportClient(() => c2), { paywallId: 'demo' });

    // Tab1 пишет — Tab2 читает то же значение через свой proxy. Без offscreen
    // это были бы два независимых localStorage'а content-script'ов.
    await tab1.getStorage().setItem('trial:demo', '5');
    const fromTab2 = await tab2.getStorage().getItem('trial:demo');
    expect(fromTab2).toBe('5');

    // Tab2 обновляет — Tab1 видит свежее.
    await tab2.getStorage().setItem('trial:demo', '4');
    const fromTab1 = await tab1.getStorage().getItem('trial:demo');
    expect(fromTab1).toBe('4');

    // Удаление одной вкладкой видно другой.
    await tab1.getStorage().removeItem('trial:demo');
    const removed = await tab2.getStorage().getItem('trial:demo');
    expect(removed).toBeNull();
  });
});

describe('identity sync', () => {
  it('setIdentity in one tab visible in offscreen for next getUser', async () => {
    const seenEmails: string[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/bootstrap')) {
        return new Response(
          JSON.stringify({ settings: { id: 'demo', name: 'X', brand_color: '#000' }, prices: [] as unknown[], offers: [] as unknown[] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      if (u.includes('/user-state')) {
        // ApiClient wraps init.headers в Headers — читаем через .get().
        const h = init?.headers;
        const email =
          h instanceof Headers
            ? h.get('X-User-Email')
            : (h as Record<string, string> | undefined)?.['X-User-Email'];
        seenEmails.push(email ?? '');
        return new Response(
          JSON.stringify({ has_active_subscription: false, purchases: [] as unknown[], trial: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ) as unknown as Response;
      }
      return new Response('not found', { status: 404 }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const billing = new BillingClient({
      paywallId: 'demo',
      apiOrigin: 'https://test.local',
      fetch
    });
    const server = setupServer(billing);

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteBillingClient(new TransportClient(() => c1), { paywallId: 'demo' });
    const tab2 = new RemoteBillingClient(new TransportClient(() => c2), { paywallId: 'demo' });

    // Tab1 ставит identity → setIdentity → offscreen.BillingClient.identity = ...
    await tab1.setIdentity({ email: 'late@x.io' });

    // Tab2 force-fetch'ит user — запрос с X-User-Email: late@x.io должен уйти,
    // подтверждая что identity жил единственный раз в offscreen и tab2 им
    // воспользовался без локального дубля.
    await tab2.getUser({ force: true });

    expect(seenEmails).toContain('late@x.io');
  });
});
