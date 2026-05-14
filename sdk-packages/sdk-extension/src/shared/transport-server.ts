// Server-side транспорт. Один TransportServer слушает все каналы, которые
// подключаются. В extension'е это offscreen, к которому SW проксирует
// content-script'ы (один offscreen ↔ N каналов от SW, по одному на content).
//
// Контракт:
//  - on<K>(kind, handler) — регистрирует handler для request-типа. Один
//    handler на kind (overrideStatic диспатч): если переопределили — последний
//    выигрывает. Throw'ы ловятся и сериализуются в ResponseErr.
//  - broadcast<K>(kind, payload) — fan-out на все живые каналы. Используется
//    BillingClient'ом / AuthClient'ом, когда состояние меняется.
//  - accept(channel) — добавить канал в активный пул. Не делаем listenTo'у на
//    chrome.runtime.onConnect внутри shared-кода, чтобы тестировать без
//    chrome.* — это делает extension-side adapter (offscreen/sw).

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
  /** AbortSignal, который тригернётся при получении cancel-envelope от клиента.
   *  Handler может пробросить его в underlying fetch для отмены сетевой
   *  операции. Игнорировать тоже OK — старые handler'ы продолжат работать. */
  signal: AbortSignal;
}

export type RequestHandler<K extends RequestKind> = (
  params: RequestParams<K>,
  ctx: RequestContext
) => Promise<RequestResult<K>> | RequestResult<K>;

export class TransportServer {
  private handlers = new Map<RequestKind, RequestHandler<RequestKind>>();
  private channels = new Set<MessageChannel>();
  /** Активные запросы по каналам: channel → id → AbortController. На cancel
   *  envelope ищем controller и abort'им его. На disconnect — abort всех. */
  private active = new WeakMap<MessageChannel, Map<string, AbortController>>();

  constructor() {
    // Built-in handshake handler — отвечает текущей версией протокола.
    // Клиент логирует mismatch на стороне TransportClient.ensureChannel,
    // не блокируем дальнейшие запросы (best-effort версионирование).
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

  /** Подключить канал. Сервер начинает обрабатывать запросы из него и
   *  включает его в broadcast'ы. На disconnect автоматически удаляет +
   *  abort'ит все in-flight handlers для этого канала. */
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

  /** Fan-out события всем подключённым каналам. */
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

  /** Размер активного пула — для health-check / cleanup'а offscreen'а
   *  (если 0, host может закрыть offscreen-документ). */
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
      // Если handler завершился через abort — клиент уже знает (он сам и
      // отменял). Респонс ошибки всё равно шлём; client-side pending уже
      // очищен, ничего не произойдёт. Безопаснее, чем пропустить response.
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
