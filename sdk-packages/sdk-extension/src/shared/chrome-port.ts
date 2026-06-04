// Adapter chrome.runtime.Port → MessageChannel. The single point in the code
// where chrome.* lives — it contains both the client- and server-side
// runtime.connect / onConnect API. Tested only in the extension runtime (e2e);
// the unit tests for shared/transport-*.ts work with an in-memory MessageChannel
// implementation.

import type { MessageChannel } from './channel';
import type { Envelope } from './protocol';

/** Wrap an existing port in a MessageChannel. Used on the server side
 *  (offscreen / SW) — there the port is already created by the onConnect
 *  listener. */
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
        // postMessage throws if the port is already closed. We emulate a
        // disconnect so TransportClient/Server don't hang on in-flight requests.
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
        // Idempotent — late subscribers get the signal immediately.
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

/** Client-side channel factory: open a port to the extension runtime by name.
 *  The receiving side is the service worker (chrome.runtime.onConnect is there). */
export function createRuntimeChannel(portName: string): MessageChannel {
  const port = chrome.runtime.connect({ name: portName });
  return portToChannel(port);
}
