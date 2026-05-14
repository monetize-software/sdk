// Абстракция дуплекс-канала между двумя рантаймами. Реальные реализации —
// chrome.runtime.Port (extension), MessageChannel (in-tests, для проверки
// логики без браузера). Транспорт ничего не знает про chrome.* — ему
// достаточно `send / onMessage / onDisconnect`.

import type { Envelope } from './protocol';

export interface MessageChannel {
  send(envelope: Envelope): void;
  /** Возвращает unsubscribe. Несколько подписок допустимы. */
  onMessage(cb: (envelope: Envelope) => void): () => void;
  /** Срабатывает один раз — после disconnect канал считается мёртвым. */
  onDisconnect(cb: () => void): () => void;
  /** Закрыть канал со своей стороны. */
  close(): void;
}

/** Фабрика канала — нужна для reconnect: TransportClient на disconnect зовёт
 *  factory заново и получает свежий канал. */
export type ChannelFactory = () => MessageChannel;
