// Phase 5 surface coverage. We prove that:
//  1. track() from two tabs lands in ONE EventTracker buffer on offscreen
//  2. One flush — one POST /events with aggregated events from both tabs
//
// EventTracker is the real one from @sdk/core; we only mock fetch for /events.

import { describe, it, expect, vi } from 'vitest';
import { EventTracker } from '@sdk/core/EventTracker';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import { RemoteEventTracker } from '../src/content/RemoteEventTracker';
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

describe('EventTracker — single batch across tabs', () => {
  it('events from two tabs arrive at single tracker and flush together', async () => {
    const flushedBatches: unknown[][] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body?.events) flushedBatches.push(body.events);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }) as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const tracker = new EventTracker({
      endpoint: 'https://test.local/events',
      paywallId: 'demo',
      getVisitorId: async () => 'v1',
      flushIntervalMs: 25,
      fetch
    });

    const server = new TransportServer();
    server.on('tracker.track', (p) => {
      tracker.track(p.name, p.props);
    });

    const [c1, s1] = pairChannels();
    const [c2, s2] = pairChannels();
    server.accept(s1);
    server.accept(s2);

    const tab1 = new RemoteEventTracker(new TransportClient(() => c1));
    const tab2 = new RemoteEventTracker(new TransportClient(() => c2));

    tab1.track('paywall_viewed', { source: 'tab1' });
    tab2.track('paywall_viewed', { source: 'tab2' });
    tab2.track('price_selected', { price_id: 'p1' });

    // Let the flush run.
    await new Promise((r) => setTimeout(r, 60));

    // One flush with three events — not two separate flushes with
    // partial batches.
    expect(flushedBatches).toHaveLength(1);
    const batch = flushedBatches[0] as Array<{ type: string }>;
    expect(batch).toHaveLength(3);
    expect(batch.map((e) => e.type)).toEqual([
      'paywall_viewed',
      'paywall_viewed',
      'price_selected'
    ]);

    tracker.destroy();
  });
});
