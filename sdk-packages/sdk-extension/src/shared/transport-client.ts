// Client-side transport. Used in the content-script (on top of the chrome.runtime
// port to the SW) and in any other surface that talks to offscreen through
// the same router (popup, extension page, side panel).
//
// Contract:
//  - request<K>(kind, params, signal?) — a request with a typed result.
//    On channel disconnect pending requests are rejected with a reconnect-error;
//    the next call recreates the channel via ChannelFactory and resumes work.
//  - on<K>(kind, handler) — subscribe to a broadcast from the server. Subscriptions
//    survive reconnect automatically — handlers are stored locally, and
//    re-subscribing on the server is not required (the server always broadcasts to all
//    connected channels).
//
// Reconnect strategy: lazy. The channel is brought up on the first request/on, a dead one
// is recreated at the moment of the next request. No exponential backoffs
// in the background — the extension context dislikes that (CPU + battery drain).

import type {
  EventEnvelope,
  EventKind,
  EventPayload,
  RequestEnvelope,
  RequestKind,
  RequestParams,
  RequestResult,
  ResponseEnvelope,
  ResponseErr
} from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { reconstructError } from './errors';
import type { ChannelFactory, MessageChannel } from './channel';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  abortListener?: () => void;
  signal?: AbortSignal;
}

export class TransportClient {
  private channel: MessageChannel | null = null;
  private channelDisposers: Array<() => void> = [];
  private pending = new Map<string, PendingRequest>();
  private listeners = new Map<EventKind, Set<(payload: unknown) => void>>();
  private destroyed = false;
  private nextId = 0;
  /** Unique client ID — sent in the handshake, the server can log it
   *  for debugging connection-flap. */
  private readonly clientId = `c-${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly factory: ChannelFactory) {}

  /** Ensures a live channel exists. Lazy — brought up on the first request.
   *  Right after connect it fire-and-forget sends a handshake — on mismatch
   *  we log a warning but do not block further requests. */
  private ensureChannel(): MessageChannel {
    if (this.destroyed) throw new Error('TransportClient destroyed');
    if (this.channel) return this.channel;

    const channel = this.factory();
    this.channel = channel;

    const offMsg = channel.onMessage((env) => this.handleMessage(env));
    const offDisc = channel.onDisconnect(() => this.handleDisconnect());
    this.channelDisposers = [offMsg, offDisc];

    // Async, without await: the main requests can proceed in parallel. On a mismatch
    // we break nothing — the server may be on a different minor version (e.g.,
    // the host updated sdk-extension but not sdk).
    void this.request('handshake', {
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.clientId
    })
      .then((res) => {
        if (res.protocolVersion !== PROTOCOL_VERSION) {
          console.warn(
            `[sdk-extension] protocol version mismatch: client=${PROTOCOL_VERSION}, ` +
              `offscreen=${res.protocolVersion}. Update host's @monetize.software/sdk-extension.`
          );
        }
      })
      .catch(() => {
        // Server without a handshake-handler or dead — best-effort, we don't fail.
      });

    return channel;
  }

  private handleMessage(envelope: unknown): void {
    if (!isEnvelope(envelope)) return;
    if (envelope.type === 'response') {
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      pending.signal?.removeEventListener('abort', pending.abortListener!);
      if (envelope.ok) {
        pending.resolve(envelope.result);
      } else {
        // Narrowing on a discriminated union with a generic is lost in strict mode —
        // an explicit cast is more reliable, ok===false is already checked.
        pending.reject(reconstructError((envelope as ResponseErr).error));
      }
      return;
    }
    if (envelope.type === 'event') {
      const set = this.listeners.get(envelope.kind);
      if (!set) return;
      // Snapshot, so a handler can unsubscribe itself without breaking iteration.
      for (const handler of [...set]) {
        try {
          handler(envelope.payload);
        } catch (e) {
          console.error('[sdk-extension] event handler threw', e);
        }
      }
    }
  }

  private handleDisconnect(): void {
    for (const fn of this.channelDisposers) fn();
    this.channelDisposers = [];
    this.channel = null;
    // Reject all in-flight — they carry a reconnect-code, the host can retry.
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) {
      p.signal?.removeEventListener('abort', p.abortListener!);
      p.reject(new TransportDisconnectedError());
    }
  }

  request<K extends RequestKind>(
    kind: K,
    params: RequestParams<K>,
    opts: { signal?: AbortSignal } = {}
  ): Promise<RequestResult<K>> {
    if (this.destroyed) {
      return Promise.reject(new Error('TransportClient destroyed'));
    }
    if (opts.signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const channel = this.ensureChannel();
    const id = `r${++this.nextId}`;

    return new Promise<RequestResult<K>>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
        signal: opts.signal
      };

      if (opts.signal) {
        pending.abortListener = () => {
          if (this.pending.delete(id)) {
            reject(new DOMException('Aborted', 'AbortError'));
            // Send cancel to offscreen so it aborts the underlying
            // fetch there too. Best-effort: the channel may have dropped — then send throws,
            // but pending is already removed, the user already got the abort error.
            try {
              channel.send({ type: 'cancel', id });
            } catch {
              /* channel dead — the server no longer cares */
            }
          }
        };
        opts.signal.addEventListener('abort', pending.abortListener);
      }

      this.pending.set(id, pending);

      const envelope: RequestEnvelope<RequestParams<K>> = {
        type: 'request',
        id,
        kind,
        params
      };
      try {
        channel.send(envelope);
      } catch (e) {
        this.pending.delete(id);
        opts.signal?.removeEventListener('abort', pending.abortListener!);
        reject(e);
      }
    });
  }

  on<K extends EventKind>(
    kind: K,
    handler: (payload: EventPayload<K>) => void
  ): () => void {
    let set = this.listeners.get(kind);
    if (!set) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    const wrapped = handler as (payload: unknown) => void;
    set.add(wrapped);

    // Lazy ensureChannel: a subscription does not require an immediate channel, but the first
    // event can only arrive if the channel is alive. Bring it up ahead of time.
    this.ensureChannel();

    return () => {
      set!.delete(wrapped);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of this.channelDisposers) fn();
    this.channelDisposers = [];
    this.listeners.clear();
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) {
      p.signal?.removeEventListener('abort', p.abortListener!);
      p.reject(new Error('TransportClient destroyed'));
    }
    this.channel?.close();
    this.channel = null;
  }
}

export class TransportDisconnectedError extends Error {
  readonly code = 'transport_disconnected';
  constructor() {
    super('Transport channel disconnected mid-request');
    this.name = 'TransportDisconnectedError';
  }
}

function isEnvelope(value: unknown): value is RequestEnvelope | ResponseEnvelope | EventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === 'request' || t === 'response' || t === 'event';
}
