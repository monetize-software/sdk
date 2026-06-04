// @vitest-environment jsdom
// P1.1: PaywallUI integration test. We verify the drop-in behavior in an extension:
//  - Constructing with `auth: true` assembles RemoteBillingClient + RemoteAuthClient
//  - bootstrap() is proxied through transport to the server-side BillingClient
//  - paywall.open() emits 'open' (mount-then-load default works)
//  - track() is forwarded to RemoteEventTracker
//  - destroy() cleans up subscriptions
//
// The transport is injected via `_setContentTransportForTests` — we bypass
// chrome.runtime.connect (which does not exist in jsdom).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BillingClient } from '@sdk/core/BillingClient';
import { AuthClient } from '@sdk/core/auth';
import { EventTracker } from '@sdk/core/EventTracker';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import { PaywallUI } from '../src/content/PaywallUI';
import { _setContentTransportForTests } from '../src/content/transport';
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

interface OffscreenStub {
  billing: BillingClient;
  auth: AuthClient;
  tracker: EventTracker;
  flushedEvents: Array<{ type: string }>;
  fetchSpy: ReturnType<typeof vi.fn>;
}

function setupOffscreen(opts: {
  bootstrap?: unknown;
  user?: unknown;
} = {}): { server: TransportServer; stub: OffscreenStub } {
  const flushedEvents: Array<{ type: string }> = [];
  const bootstrapBody = opts.bootstrap ?? {
    settings: { name: 'Test', is_test_mode: false },
    prices: [] as unknown[],
    offers: [] as unknown[],
    layout: { type: 'modal', blocks: [] as unknown[] },
    user: opts.user ?? null
  };

  const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/bootstrap')) {
      return new Response(JSON.stringify(bootstrapBody), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }) as unknown as Response;
    }
    if (u.includes('/events')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.events) flushedEvents.push(...body.events);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }) as unknown as Response;
    }
    return new Response('{}', { status: 200 }) as unknown as Response;
  });

  const auth = new AuthClient({
    paywallId: 'demo',
    apiOrigin: 'https://t.local',
    fetch: fetchSpy as unknown as typeof globalThis.fetch
  });
  const billing = new BillingClient({
    paywallId: 'demo',
    apiOrigin: 'https://t.local',
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
    auth
  });
  const tracker = new EventTracker({
    endpoint: 'https://t.local/events',
    paywallId: 'demo',
    getVisitorId: () => billing.getVisitorId(),
    flushIntervalMs: 25,
    fetch: fetchSpy as unknown as typeof globalThis.fetch
  });

  const server = new TransportServer();
  // Billing
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
  // Auth
  server.on('auth.signInWithEmail', async (p) => auth.signInWithEmail(p));
  server.on('auth.signUp', async (p) => auth.signUp(p));
  server.on('auth.signOut', async () => auth.signOut());
  server.on('auth.refresh', async () => auth.refresh());
  server.on('auth.getCachedSession', () => auth.getCachedSession());
  // Tracker
  server.on('tracker.track', (p) => {
    tracker.track(p.name, p.props);
  });
  // Broadcast bridges
  billing.onUserChange((u) => server.broadcast('userChange', u), { immediate: 'none' });
  billing.onBalanceChange((b) => server.broadcast('balancesChange', b), { immediate: 'none' });
  auth.onAuthChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;
    server.broadcast('authChange', { event, session });
  });

  return { server, stub: { billing, auth, tracker, flushedEvents, fetchSpy } };
}

describe('PaywallUI integration (extension)', () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    for (const fn of cleanup) {
      try { fn(); } catch { /* ignore */ }
    }
    _setContentTransportForTests(null);
  });

  function bootstrapPaywall(opts?: { auth?: boolean; analytics?: boolean }): {
    paywall: PaywallUI;
    stub: OffscreenStub;
  } {
    const { server, stub } = setupOffscreen();
    const [contentCh, serverCh] = pairChannels();
    server.accept(serverCh);

    const transport = new TransportClient(() => contentCh);
    _setContentTransportForTests(transport);

    const paywall = new PaywallUI({
      paywallId: 'demo',
      apiOrigin: 'https://t.local',
      // auth: undefined → hybrid mode without an AuthClient; true → RemoteAuthClient.
      ...(opts?.auth === false ? {} : { auth: true as const }),
      analytics: opts?.analytics
    });
    cleanup.push(() => paywall.destroy());
    cleanup.push(() => stub.tracker.destroy());
    return { paywall, stub };
  }

  it('constructs with auth:true → has billing + auth', () => {
    const { paywall } = bootstrapPaywall();
    expect(paywall.billing).toBeDefined();
    expect(paywall.auth).toBeDefined();
    expect(paywall.billing.paywallId).toBe('demo');
  });

  it('constructs without auth → has billing only', () => {
    const { paywall } = bootstrapPaywall({ auth: false });
    expect(paywall.billing).toBeDefined();
    expect(paywall.auth).toBeUndefined();
  });

  it('regression: billing.auth points to same RemoteAuthClient as paywall.auth', () => {
    // Previously RemoteBillingClient.auth was undefined → PaywallRoot read
    // client.auth and fell into a no-op for the restore-flow / preauth-checkout.
    // PaywallRoot reads billing.auth, not paywall.auth — so the wiring
    // MUST be wired up after the Remote* constructor.
    const { paywall } = bootstrapPaywall({ auth: true });
    expect(paywall.auth).toBeDefined();
    expect(paywall.billing.auth).toBeDefined();
    // The same instance — otherwise the onAuthChange listeners would diverge.
    expect(paywall.billing.auth).toBe(paywall.auth);
  });

  it('bootstrap() proxies through transport to server-side BillingClient (1 fetch)', async () => {
    const { paywall, stub } = bootstrapPaywall();
    const result = await paywall.billing.bootstrap();
    expect(result.settings.name).toBe('Test');
    // A single HTTP request (offscreen-side BillingClient).
    expect(stub.fetchSpy.mock.calls.filter(([u]) => String(u).includes('/bootstrap'))).toHaveLength(1);
  });

  it('open() emits "open" synchronously (mount-then-load default)', async () => {
    const { paywall } = bootstrapPaywall();
    const onOpen = vi.fn();
    paywall.on('open', onOpen);
    paywall.open();
    // Cold bootstrap, but mount-then-load → open is emitted immediately.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('track() forwards events to offscreen EventTracker batch', async () => {
    const { paywall, stub } = bootstrapPaywall();
    paywall.track('host:custom_event', { foo: 'bar' });
    paywall.track('host:another', { x: 1 });
    // Give the tracker flushIntervalMs (25ms).
    await new Promise((r) => setTimeout(r, 60));
    const types = stub.flushedEvents.map((e) => e.type);
    expect(types).toContain('host:custom_event');
    expect(types).toContain('host:another');
  });

  it('auto-tracking: ready emits "paywall_viewed" via offscreen tracker', async () => {
    const { paywall, stub } = bootstrapPaywall();
    paywall.open();
    // 'open' is no longer tracked — the impression records 'viewed' on 'ready'
    // (after bootstrap loads), so we wait for the async resolution of bootstrap.
    await new Promise((r) => setTimeout(r, 60));
    const types = stub.flushedEvents.map((e) => e.type);
    expect(types).toContain('paywall_viewed');
    expect(types).not.toContain('paywall_opened');
  });

  it('analytics:false → track() and auto-events do not reach offscreen tracker', async () => {
    const { paywall, stub } = bootstrapPaywall({ analytics: false });
    paywall.track('should_not_arrive');
    paywall.open();
    await new Promise((r) => setTimeout(r, 60));
    expect(stub.flushedEvents).toHaveLength(0);
  });

  it('open() with trial config in bootstrap does not crash (getStorage proxy works)', async () => {
    // Regression: PaywallUI.ensureTrialStore calls this.billing.getStorage().
    // Previously RemoteBillingClient was missing this method, and open() with a
    // trial config crashed with "getStorage is not a function".
    const { server, stub } = setupOffscreen({
      bootstrap: {
        settings: {
          name: 'Test',
          is_test_mode: false,
          trial: { mode: 'opens', payload: 3, storage: 'client' }
        },
        prices: [] as unknown[],
        offers: [] as unknown[],
        layout: { type: 'modal', blocks: [] as unknown[] },
        user: null
      }
    });
    const [contentCh, serverCh] = pairChannels();
    server.accept(serverCh);

    const transport = new TransportClient(() => contentCh);
    _setContentTransportForTests(transport);

    const paywall = new PaywallUI({
      paywallId: 'demo',
      apiOrigin: 'https://t.local',
      auth: true
    });
    cleanup.push(() => paywall.destroy());
    cleanup.push(() => stub.tracker.destroy());

    // Must not throw.
    expect(() => paywall.open()).not.toThrow();
    // mount-then-load: the modal mounts immediately, gates are applied after
    // bootstrap — we let the microtasks fire to make sure
    // gateThroughTrial → ensureTrialStore passed without an exception.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('destroy() cleans up: tracker bindings stop firing', async () => {
    const { paywall, stub } = bootstrapPaywall();
    paywall.open();
    await new Promise((r) => setTimeout(r, 60));
    const beforeDestroy = stub.flushedEvents.length;
    paywall.destroy();

    // After destroy, any public methods produce no side effects on the tracker
    // (RemoteEventTracker has been detached).
    paywall.track('post_destroy');
    await new Promise((r) => setTimeout(r, 60));
    // It's acceptable for 'paywall_closed' to arrive on destroy → close, so we
    // allow a small discrepancy, but 'post_destroy' definitely must not.
    const types = stub.flushedEvents.map((e) => e.type);
    expect(types).not.toContain('post_destroy');
    expect(stub.flushedEvents.length).toBeLessThanOrEqual(beforeDestroy + 1); // +1 for a possible 'paywall_closed'
  });
});
