// Client-side транспорт. Используется в content-script'е (поверх chrome.runtime
// port'а к SW) и в любом другом surface'е, который ходит к offscreen через
// тот же роутер (popup, extension page, side panel).
//
// Контракт:
//  - request<K>(kind, params, signal?) — запрос с типизированным результатом.
//    На disconnect канала pending request'ы reject'аются с reconnect-error;
//    next call воссоздаст канал через ChannelFactory и продолжит работу.
//  - on<K>(kind, handler) — подписка на broadcast от сервера. Переподписки
//    переживают reconnect автоматически — handler'ы хранятся локально, а
//    re-subscribe на сервере не требуется (сервер всегда broadcast'ит всем
//    подключённым каналам).
//
// Reconnect стратегия: lazy. Канал поднимается при первом request/on, мёртвый —
// пересоздаётся в момент следующего запроса. Никаких exponential backoff'ов
// в фоне — extension контекст это не любит (расход CPU + батарея).

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
  /** Уникальный ID клиента — отправляется в handshake'е, server может логировать
   *  для отладки connection-flap'а. */
  private readonly clientId = `c-${Math.random().toString(36).slice(2, 10)}`;

  constructor(private readonly factory: ChannelFactory) {}

  /** Гарантирует наличие живого канала. Lazy — поднимается при первом request.
   *  Сразу после connect'а fire-and-forget шлёт handshake — на mismatch
   *  логируем warning, но не блокируем дальнейшие запросы. */
  private ensureChannel(): MessageChannel {
    if (this.destroyed) throw new Error('TransportClient destroyed');
    if (this.channel) return this.channel;

    const channel = this.factory();
    this.channel = channel;

    const offMsg = channel.onMessage((env) => this.handleMessage(env));
    const offDisc = channel.onDisconnect(() => this.handleDisconnect());
    this.channelDisposers = [offMsg, offDisc];

    // Async, без await: основные запросы могут параллельно идти. На mismatch'е
    // ничего не ломаем — server может быть на другой минорной версии (например,
    // host обновил sdk-extension но не sdk).
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
        // Server без handshake-handler'а или умер — best-effort, не падаем.
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
        // Narrowing на discriminated union с generic'ом теряется в strict-режиме —
        // явный cast стабильнее, ok===false уже проверен.
        pending.reject(reconstructError((envelope as ResponseErr).error));
      }
      return;
    }
    if (envelope.type === 'event') {
      const set = this.listeners.get(envelope.kind);
      if (!set) return;
      // Snapshot, чтобы handler мог отписать сам себя без NaN-итерации.
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
    // Reject все in-flight — они идут с reconnect-кодом, host может ретрайнуть.
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
            // Послать cancel в offscreen чтобы там тоже abort'нуть underlying
            // fetch. Best-effort: канал мог отвалиться — тогда send бросит,
            // но pending уже удалён, юзер уже получил abort error.
            try {
              channel.send({ type: 'cancel', id });
            } catch {
              /* channel dead — server'у уже всё равно */
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

    // Lazy ensureChannel: подписка не требует немедленного канала, но первый
    // event может прилететь только если канал жив. Поднимаем заранее.
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
