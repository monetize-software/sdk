// RemoteEventTracker — a fire-and-forget proxy for analytics. All track() calls
// from all tabs land in the single EventTracker in offscreen, which batches
// them and sends to /events. The win: one batch per extension, one sendBeacon
// on unload, no duplicate `app_opened` events.
//
// The API is deliberately minimal — just track(name, props). The buffer / flush
// / destroy logic lives in offscreen; content doesn't control it.

import { TransportClient } from '../shared/transport-client';

export class RemoteEventTracker {
  constructor(private readonly transport: TransportClient) {}

  /** Send an event. Fire-and-forget — returns no Promise and doesn't throw.
   *  Network/transport errors are logged to the console and don't block the caller. */
  track(name: string, props?: Record<string, unknown>): void {
    if (typeof name !== 'string' || name.length === 0) return;
    this.transport.request('tracker.track', { name, props }).catch((e) => {
      console.warn('[paywall] track failed', e);
    });
  }
}
