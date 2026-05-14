// Адаптер chrome.runtime.Port → MessageChannel. Единственная точка кода,
// где живёт chrome.* — содержит и client, и server side runtime.connect /
// onConnect API. Тестируется только в extension-runtime (e2e), unit-тесты
// shared/transport-*.ts работают с in-memory MessageChannel реализацией.

import type { MessageChannel } from './channel';
import type { Envelope } from './protocol';

/** Обернуть существующий port в MessageChannel. Используется на server-side
 *  (offscreen / SW) — там port уже создан onConnect-listener'ом. */
export function portToChannel(port: chrome.runtime.Port): MessageChannel {
  let disconnected = false;
  const messageCbs = new Set<(envelope: Envelope) => void>();
  const disconnectCbs = new Set<() => void>();

  const onMessageListener = (msg: unknown): void => {
    for (const cb of messageCbs) cb(msg as Envelope);
  };
  const onDisconnectListener = (): void => {
    if (disconnected) return;
    disconnected = true;
    for (const cb of disconnectCbs) cb();
    port.onMessage.removeListener(onMessageListener);
    port.onDisconnect.removeListener(onDisconnectListener);
  };

  port.onMessage.addListener(onMessageListener);
  port.onDisconnect.addListener(onDisconnectListener);

  return {
    send(envelope) {
      if (disconnected) return;
      try {
        port.postMessage(envelope);
      } catch (e) {
        // postMessage кидает если port уже закрыт. Эмулируем disconnect, чтобы
        // TransportClient/Server не висели на in-flight request'ах.
        onDisconnectListener();
        throw e;
      }
    },
    onMessage(cb) {
      messageCbs.add(cb);
      return () => messageCbs.delete(cb);
    },
    onDisconnect(cb) {
      if (disconnected) {
        // Идемпотентно — late subscribers сразу получают сигнал.
        queueMicrotask(cb);
        return () => {};
      }
      disconnectCbs.add(cb);
      return () => disconnectCbs.delete(cb);
    },
    close() {
      if (disconnected) return;
      port.disconnect();
      onDisconnectListener();
    }
  };
}

/** Client-side фабрика канала: открыть port на extension'овский runtime по имени.
 *  Принимающая сторона — service worker (chrome.runtime.onConnect там). */
export function createRuntimeChannel(portName: string): MessageChannel {
  const port = chrome.runtime.connect({ name: portName });
  return portToChannel(port);
}
