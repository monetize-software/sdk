// Server-side transport. A single TransportServer listens to all channels that
// connect. In the extension this is offscreen, to which the SW proxies
// content-scripts (one offscreen ↔ N channels from the SW, one per content).
//
// Contract:
//  - on<K>(kind, handler) — registers a handler for a request type. One
//    handler per kind (override dispatch): if redefined — the last one
//    wins. Throws are caught and serialized into a ResponseErr.
//  - broadcast<K>(kind, payload) — fan-out to all live channels. Used by
//    BillingClient / AuthClient when state changes.
//  - accept(channel) — add a channel to the active pool. We don't listen on
//    chrome.runtime.onConnect inside shared code, so it can be tested without
//    chrome.* — that's done by the extension-side adapter (offscreen/sw).

import type {
  CancelEnvelope,
  EventEnvelope,
  EventKind,
  EventPayload,
  RequestEnvelope,
  RequestKind,
  RequestParams,
  RequestResult
} from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { serializeError } from './errors';
import type { MessageChannel } from './channel';

export interface RequestContext {
  /** AbortSignal that triggers when a cancel-envelope is received from the client.
   *  A handler can pass it into the underlying fetch to cancel the network
   *  operation. Ignoring it is also OK — older handlers keep working. */
  signal: AbortSignal;
}

export type RequestHandler<K extends RequestKind> = (
  params: RequestParams<K>,
  ctx: RequestContext
) => Promise<RequestResult<K>> | RequestResult<K>;

export class TransportServer {
  private handlers = new Map<RequestKind, RequestHandler<RequestKind>>();
  private channels = new Set<MessageChannel>();
  /** Active requests per channel: channel → id → AbortController. On a cancel
   *  envelope we find the controller and abort it. On disconnect — abort all. */
  private active = new WeakMap<MessageChannel, Map<string, AbortController>>();

  constructor() {
    // Built-in handshake handler — responds with the current protocol version.
    // The client logs the mismatch on the TransportClient.ensureChannel side,
    // we don't block further requests (best-effort versioning).
    this.on('handshake', () => ({
      protocolVersion: PROTOCOL_VERSION,
      offscreenReady: true
    }));
  }

  on<K extends RequestKind>(kind: K, handler: RequestHandler<K>): void {
    this.handlers.set(kind, handler as RequestHandler<RequestKind>);
  }

  off<K extends RequestKind>(kind: K): void {
    this.handlers.delete(kind);
  }

  /** Attach a channel. The server starts handling requests from it and
   *  includes it in broadcasts. On disconnect it automatically removes it and
   *  aborts all in-flight handlers for that channel. */
  accept(channel: MessageChannel): void {
    this.channels.add(channel);
    this.active.set(channel, new Map());
    channel.onMessage((env) => this.dispatch(channel, env));
    channel.onDisconnect(() => {
      this.channels.delete(channel);
      const inFlight = this.active.get(channel);
      if (inFlight) {
        for (const ctrl of inFlight.values()) ctrl.abort();
      }
      this.active.delete(channel);
    });
  }

  /** Fan-out an event to all connected channels. */
  broadcast<K extends EventKind>(kind: K, payload: EventPayload<K>): void {
    const envelope: EventEnvelope<EventPayload<K>> = { type: 'event', kind, payload };
    for (const channel of this.channels) {
      try {
        channel.send(envelope);
      } catch (e) {
        console.error('[sdk-extension] broadcast send failed', e);
      }
    }
  }

  /** Size of the active pool — for health-check / offscreen cleanup
   *  (if 0, the host can close the offscreen document). */
  get connectionCount(): number {
    return this.channels.size;
  }

  private async dispatch(channel: MessageChannel, raw: unknown): Promise<void> {
    if (isCancel(raw)) {
      const inFlight = this.active.get(channel);
      const ctrl = inFlight?.get(raw.id);
      if (ctrl) {
        ctrl.abort();
        inFlight!.delete(raw.id);
      }
      return;
    }
    if (!isRequest(raw)) return;
    const handler = this.handlers.get(raw.kind);
    if (!handler) {
      this.respondErr(channel, raw.id, new Error(`Unknown request kind: ${raw.kind}`));
      return;
    }
    const ctrl = new AbortController();
    const inFlight = this.active.get(channel);
    inFlight?.set(raw.id, ctrl);
    try {
      const result = await handler(raw.params as RequestParams<RequestKind>, {
        signal: ctrl.signal
      });
      this.respondOk(channel, raw.id, result);
    } catch (e) {
      // If the handler finished via abort — the client already knows (it
      // did the cancelling itself). We send the error response anyway; the
      // client-side pending is already cleared, nothing happens. Safer than skipping the response.
      this.respondErr(channel, raw.id, e);
    } finally {
      inFlight?.delete(raw.id);
    }
  }

  private respondOk(channel: MessageChannel, id: string, result: unknown): void {
    try {
      channel.send({ type: 'response', id, ok: true, result });
    } catch (e) {
      console.error('[sdk-extension] respond send failed', e);
    }
  }

  private respondErr(channel: MessageChannel, id: string, error: unknown): void {
    try {
      channel.send({ type: 'response', id, ok: false, error: serializeError(error) });
    } catch (e) {
      console.error('[sdk-extension] respond err send failed', e);
    }
  }
}

function isRequest(value: unknown): value is RequestEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'request';
}

function isCancel(value: unknown): value is CancelEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { type?: unknown }).type === 'cancel';
}
