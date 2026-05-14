// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventTracker } from '../src/core/EventTracker';
import { SDK_VERSION } from '../src/core/api';

// Helper для конструкции tracker'а с управляемыми зависимостями.
function makeTracker(overrides: Partial<{
  fetch: typeof fetch;
  sendBeacon: (url: string, data: BodyInit) => boolean;
  enabled: boolean;
  flushIntervalMs: number;
  maxBufferSize: number;
  visitorId: string | null;
  cachedVisitorId: string | null;
  userId: string | null;
  capabilities: string[];
}> = {}) {
  const visitorId = overrides.visitorId ?? 'visitor-uuid';
  const cachedRef = { current: overrides.cachedVisitorId ?? null };
  const fetchSpy = overrides.fetch ?? vi.fn(async () => new Response(null, { status: 204 }));
  const beaconSpy = overrides.sendBeacon ?? vi.fn(() => true);

  const tracker = new EventTracker({
    endpoint: 'https://test.example.com/api/v1/paywall/pw_1/events',
    paywallId: 'pw_1',
    capabilities: overrides.capabilities,
    enabled: overrides.enabled,
    flushIntervalMs: overrides.flushIntervalMs ?? 50,
    maxBufferSize: overrides.maxBufferSize ?? 5,
    getVisitorId: vi.fn(async () => {
      cachedRef.current = visitorId;
      return visitorId;
    }),
    getCachedVisitorId: () => cachedRef.current,
    getUserId: () => overrides.userId ?? null,
    fetch: fetchSpy,
    sendBeacon: beaconSpy
  });

  return { tracker, fetchSpy, beaconSpy, cachedRef };
}

describe('EventTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes after flushIntervalMs', async () => {
    const { tracker, fetchSpy } = makeTracker();
    tracker.track('paywall_viewed');

    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://test.example.com/api/v1/paywall/pw_1/events');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].type).toBe('paywall_viewed');
    expect(body.events[0].ts).toBeTypeOf('number');
  });

  it('flushes immediately when buffer hits maxBufferSize', async () => {
    const { tracker, fetchSpy } = makeTracker({ maxBufferSize: 3 });
    tracker.track('a');
    tracker.track('b');
    expect(fetchSpy).not.toHaveBeenCalled();
    tracker.track('c');

    await vi.runOnlyPendingTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.events).toHaveLength(3);
  });

  it('attaches X-Visitor-Id and SDK headers', async () => {
    const { tracker, fetchSpy } = makeTracker({
      capabilities: ['cap-a', 'cap-b'],
      userId: 'user_42'
    });
    tracker.track('paywall_viewed');
    await vi.advanceTimersByTimeAsync(60);

    const init = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers['X-Visitor-Id']).toBe('visitor-uuid');
    expect(init.headers['X-User-Id']).toBe('user_42');
    expect(init.headers['X-SDK-Version']).toBe(SDK_VERSION);
    expect(init.headers['X-Paywall-Id']).toBe('pw_1');
    expect(init.headers['X-SDK-Capabilities']).toBe('cap-a,cap-b');
  });

  it('omits X-User-Id when no userId', async () => {
    const { tracker, fetchSpy } = makeTracker();
    tracker.track('paywall_viewed');
    await vi.advanceTimersByTimeAsync(60);

    const init = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers['X-User-Id']).toBeUndefined();
  });

  it('does nothing when enabled=false', async () => {
    const { tracker, fetchSpy } = makeTracker({ enabled: false });
    tracker.track('paywall_viewed');
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores empty type', async () => {
    const { tracker, fetchSpy } = makeTracker();
    tracker.track('');
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flushBeacon uses navigator.sendBeacon with body-level metadata', () => {
    const { tracker, beaconSpy, fetchSpy } = makeTracker({
      cachedVisitorId: 'cached-vid',
      userId: 'u_1',
      capabilities: ['c1']
    });
    tracker.track('paywall_closed');
    tracker.flushBeacon();

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    const [url, body] = (beaconSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://test.example.com/api/v1/paywall/pw_1/events');
    const payload = JSON.parse(body as string);
    expect(payload.visitor_id).toBe('cached-vid');
    expect(payload.user_id).toBe('u_1');
    expect(payload.sdk_version).toBe(SDK_VERSION);
    expect(payload.paywall_id).toBe('pw_1');
    expect(payload.capabilities).toBe('c1');
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].type).toBe('paywall_closed');
  });

  it('flushBeacon falls back to fetch when visitor_id not yet cached', async () => {
    const { tracker, beaconSpy, fetchSpy } = makeTracker({
      cachedVisitorId: null
    });
    tracker.track('paywall_closed');
    tracker.flushBeacon();

    // beacon не вызывается без visitor_id, события идут через flush()
    expect(beaconSpy).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('flushBeacon noop on empty buffer', () => {
    const { tracker, beaconSpy, fetchSpy } = makeTracker({ cachedVisitorId: 'v' });
    tracker.flushBeacon();
    expect(beaconSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flushBeacon returns events to buffer when sendBeacon returns false', async () => {
    const beaconSpy = vi.fn(() => false);
    const { tracker, fetchSpy } = makeTracker({
      cachedVisitorId: 'cached-vid',
      sendBeacon: beaconSpy
    });
    tracker.track('paywall_closed');
    tracker.flushBeacon();

    expect(beaconSpy).toHaveBeenCalledTimes(1);
    // events улетели через fallback flush → fetch
    await vi.runOnlyPendingTimersAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('survives fetch rejection silently', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const { tracker } = makeTracker({ fetch: failingFetch as unknown as typeof fetch });
    tracker.track('paywall_viewed');
    await vi.advanceTimersByTimeAsync(60);
    expect(failingFetch).toHaveBeenCalledTimes(1);
    // Не падаем — бизнес-логика продолжает работать.
  });

  it('destroy flushes pending and stops timer', async () => {
    const { tracker, fetchSpy } = makeTracker();
    tracker.track('paywall_viewed');
    tracker.destroy();
    // synchronous destroy вызывает flush, дайте microtask отработать
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // После destroy track() — no-op
    tracker.track('paywall_closed');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps buffer to HARD_BUFFER_LIMIT to avoid leaks', async () => {
    // sendBeacon=undefined и failing fetch — simulate offline
    const failingFetch = vi.fn(async () => {
      throw new Error('offline');
    });
    const { tracker } = makeTracker({
      fetch: failingFetch as unknown as typeof fetch,
      maxBufferSize: 1000,
      flushIntervalMs: 100000 // не успеет
    });
    for (let i = 0; i < 250; i++) tracker.track(`evt_${i}`);
    // буфер не должен расти бесконечно
    const internal = tracker as unknown as { buffer: Array<unknown> };
    expect(internal.buffer.length).toBeLessThanOrEqual(200);
  });
});
