import { describe, it, expect, vi } from 'vitest';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import type { MessageChannel } from '../src/shared/channel';
import type { Envelope } from '../src/shared/protocol';
import { RemoteBillingClient } from '../src/content/RemoteBillingClient';
import { BillingClient } from '@sdk/core/BillingClient';
import '../src/shared/messages';

// E2E-style test: we exercise the same handler graph as in prod — RemoteBillingClient
// (content-side) → TransportClient → in-memory channel → TransportServer →
// real BillingClient (offscreen-side, mock fetch).
//
// Does not cover the SW forwarder and the chrome.runtime layer (that's in Phase 6 e2e via
// playwright + a loaded extension). Here — that the billing graph works
// with real request serialization over the wire-protocol.

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

    // Before bootstrap cached === null — as in a regular BillingClient.
    expect(remote.getCachedBootstrap()).toBeNull();

    const result = await remote.bootstrap();

    // Got the payload, fetch was called exactly once.
    expect(result.settings.id).toBe('demo');
    expect(fetch).toHaveBeenCalledTimes(1);

    // The sync-cache on the content side — now populated (mirror of server-side).
    expect(remote.getCachedBootstrap()?.settings.id).toBe('demo');

    // A repeat bootstrap without force — the server serves from cache, fetch doesn't grow.
    await remote.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);

    // With force=true — the server goes to the network.
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

    // Simulate two tabs — each with its own content transport, but a single
    // server (one offscreen, one BillingClient).
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

    // The first bootstrap from tab 1 — fetch runs.
    await remote1.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);

    // The second bootstrap from tab 2 — should pick up the same cached
    // BillingClient.cachedBootstrap, WITHOUT a repeat network request.
    // This is the architecture's main win: a single offscreen source of truth.
    await remote2.bootstrap();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
