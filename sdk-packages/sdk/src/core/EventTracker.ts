import { SDK_VERSION } from './api';

// The SDK 3.0 analytics tracker. It accepts events (system ones via
// bindEventTracker and custom ones via PaywallUI.track()), accumulates them in a
// buffer, and sends them in a batch to /api/v1/paywall/{id}/events.
//
// Principles:
// - Fire-and-forget. Any POST error must not affect the UX.
// - Backend load is minimal: a batch of ~10-20 events per ~1.5s window.
// - sendBeacon on pagehide/visibilitychange — guarantees "last mile" delivery
//   when the tab is closed.
// - No headers in beacon mode (not allowed by spec) — visitor_id/user_id/sdk
//   metadata are duplicated into the body as a fallback. The server can read them.

export interface TrackedEvent {
  type: string;
  ts: number;
  props?: Record<string, unknown>;
}

export interface EventTrackerOptions {
  endpoint: string;
  paywallId: string;
  capabilities?: string[];
  getVisitorId: () => Promise<string>;
  getCachedVisitorId?: () => string | null;
  getUserId?: () => string | null | undefined;
  enabled?: boolean;
  flushIntervalMs?: number;
  maxBufferSize?: number;
  /** Test override for fetch. */
  fetch?: typeof fetch;
  /** Test override for sendBeacon — lets us verify the unload flow in jsdom. */
  sendBeacon?: (url: string, data: BodyInit) => boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1500;
const DEFAULT_MAX_BUFFER_SIZE = 20;
// Hard cap so the background record doesn't grow indefinitely on a dead network.
const HARD_BUFFER_LIMIT = 200;

export class EventTracker {
  private opts: EventTrackerOptions;
  private buffer: TrackedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private unloadHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  constructor(opts: EventTrackerOptions) {
    this.opts = opts;
    if (this.isEnabled()) this.attachUnloadHandlers();
  }

  private isEnabled(): boolean {
    return this.opts.enabled !== false;
  }

  track(type: string, props?: Record<string, unknown>): void {
    if (this.destroyed || !this.isEnabled()) return;
    if (typeof type !== 'string' || type.length === 0) return;

    this.buffer.push({ type, ts: Date.now(), props });

    const max = this.opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    if (this.buffer.length >= max) {
      void this.flush();
      return;
    }
    if (this.buffer.length > HARD_BUFFER_LIMIT) {
      // Protection against a leak when the server is unavailable: we drop the oldest.
      this.buffer = this.buffer.slice(-HARD_BUFFER_LIMIT);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.destroyed) return;
    const interval = this.opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, interval);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const events = this.buffer;
    this.buffer = [];

    try {
      const visitorId = await this.opts.getVisitorId();
      const userId = this.opts.getUserId?.() ?? null;
      const body = JSON.stringify({ events });
      const fetchImpl = this.opts.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
      if (!fetchImpl) return;

      await fetchImpl(this.opts.endpoint, {
        method: 'POST',
        credentials: 'omit',
        keepalive: true, // if the page closes at this moment — the browser still finishes it
        headers: this.buildHeaders(visitorId, userId),
        body
      });
    } catch {
      /* silent: analytics must not interfere with UX. Losing an event is acceptable. */
    }
  }

  /**
   * Sending via navigator.sendBeacon — for unload/pagehide. Guaranteed to
   * arrive (a POST with keepalive almost is too, but beacon is built exactly for
   * this). Headers can't be set (per spec), so SDK metadata travels in the body
   * as fallback fields that the server reads in addition to headers.
   */
  flushBeacon(): void {
    if (this.buffer.length === 0) return;

    const events = this.buffer;
    this.buffer = [];

    const visitorId = this.opts.getCachedVisitorId?.() ?? null;
    const userId = this.opts.getUserId?.() ?? null;

    // If visitor_id isn't resolved yet (a rare race in the early second of life) —
    // we return the events to the buffer and call the regular flush with a keepalive fetch.
    if (!visitorId) {
      this.buffer.unshift(...events);
      void this.flush();
      return;
    }

    const body = JSON.stringify({
      events,
      // body-level duplicates for the beacon flow, read by the server as a fallback.
      visitor_id: visitorId,
      user_id: userId,
      sdk_version: SDK_VERSION,
      paywall_id: this.opts.paywallId,
      capabilities: this.opts.capabilities?.join(',') ?? ''
    });

    const beacon =
      this.opts.sendBeacon ??
      (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : null);

    if (!beacon) {
      // We return events to the buffer — the regular flush via keepalive picks them up.
      this.buffer.unshift(...events);
      void this.flush();
      return;
    }

    try {
      // text/plain — sendBeacon usually sets this type, the server parses manually.
      const ok = beacon(this.opts.endpoint, body);
      if (!ok) {
        this.buffer.unshift(...events);
        void this.flush();
      }
    } catch {
      this.buffer.unshift(...events);
      void this.flush();
    }
  }

  private buildHeaders(visitorId: string, userId: string | null): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-SDK-Version': SDK_VERSION,
      'X-Paywall-Id': this.opts.paywallId,
      'X-Visitor-Id': visitorId
    };
    if (this.opts.capabilities?.length) {
      h['X-SDK-Capabilities'] = this.opts.capabilities.join(',');
    }
    if (userId) h['X-User-Id'] = userId;
    return h;
  }

  private attachUnloadHandlers(): void {
    if (typeof window === 'undefined') return;

    this.unloadHandler = () => this.flushBeacon();
    this.visibilityHandler = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.flushBeacon();
      }
    };

    // pagehide — the main path (more stable than unload, works in bfcache).
    window.addEventListener('pagehide', this.unloadHandler);
    // visibilitychange/hidden — additional, often the only one on iOS Safari.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  private detachUnloadHandlers(): void {
    if (typeof window === 'undefined') return;
    if (this.unloadHandler) window.removeEventListener('pagehide', this.unloadHandler);
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.unloadHandler = null;
    this.visibilityHandler = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
    this.detachUnloadHandlers();
  }
}
