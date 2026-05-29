// Service worker forwarder. Stateless по дизайну — единственная задача
// маршрутизировать port'ы content↔offscreen. SW можеть умирать в любой момент
// (после 30с idle); reconnect происходит органически: следующий content
// runtime.connect разбудит SW, тот пересоздаст offscreen (если умер — а он
// обычно нет) и поднимет свежий pipe.

import type { RouterOptions } from './types';
import { ensureOffscreen } from './ensure-offscreen';
import { PORT_NAME, RELAY_PORT_NAME } from '../shared/port-name';

const DEFAULT_REASONS: chrome.offscreen.Reason[] = [chrome.offscreen.Reason.LOCAL_STORAGE];
const DEFAULT_JUSTIFICATION =
  'Persist auth session and bootstrap cache across all extension surfaces ' +
  'via localStorage, which is unavailable in service workers.';

export function installForwarder(opts: RouterOptions): void {
  const reasons = opts.offscreenReasons ?? DEFAULT_REASONS;
  const justification = opts.offscreenJustification ?? DEFAULT_JUSTIFICATION;

  chrome.runtime.onConnect.addListener((contentPort) => {
    if (contentPort.name !== PORT_NAME) return;

    // Поднимаем offscreen и проксируем. ensureOffscreen async — content успел
    // отправить request'ы до её резолва: буферим в queue до создания offscreen
    // port'а. Это лучше чем потерять — content всё равно тащит абсолютно всё
    // через нас.
    void connectAndPipe(contentPort, opts.offscreenUrl, reasons, justification);
  });
}

async function connectAndPipe(
  contentPort: chrome.runtime.Port,
  offscreenUrlOrResolver: string | (() => string | Promise<string>),
  reasons: chrome.offscreen.Reason[],
  justification: string
): Promise<void> {
  const queue: unknown[] = [];
  const queueListener = (msg: unknown): void => {
    queue.push(msg);
  };
  contentPort.onMessage.addListener(queueListener);

  let disconnected = false;
  contentPort.onDisconnect.addListener(() => {
    disconnected = true;
  });

  try {
    const offscreenUrl =
      typeof offscreenUrlOrResolver === 'function'
        ? await offscreenUrlOrResolver()
        : offscreenUrlOrResolver;
    await ensureOffscreen({ url: offscreenUrl, reasons, justification });
  } catch (e) {
    console.error('[sdk-extension/sw] ensureOffscreen failed', e);
    contentPort.disconnect();
    return;
  }

  if (disconnected) return;

  let offscreenPort: chrome.runtime.Port;
  try {
    // Используем отдельное имя relay-порта (не PORT_NAME), чтобы offscreen
    // принимал только SW-relay подключения и игнорировал direct connect'ы
    // от popup/content (которые тоже триггерят onConnect в offscreen — в MV3
    // chrome.runtime.connect доставляется во ВСЕ extension contexts с
    // onConnect listener'ом, не только в SW).
    offscreenPort = chrome.runtime.connect({ name: RELAY_PORT_NAME });
  } catch (e) {
    console.error('[sdk-extension/sw] connect to offscreen failed', e);
    contentPort.disconnect();
    return;
  }

  // Снимаем буфер-listener, ставим прямой forwarder.
  contentPort.onMessage.removeListener(queueListener);
  contentPort.onMessage.addListener((msg) => {
    try {
      offscreenPort.postMessage(msg);
    } catch {
      /* offscreen уже отвалился — disconnect-каскад поднимет content */
    }
  });
  offscreenPort.onMessage.addListener((msg) => {
    try {
      contentPort.postMessage(msg);
    } catch {
      /* content уже отвалился */
    }
  });

  contentPort.onDisconnect.addListener(() => {
    try {
      offscreenPort.disconnect();
    } catch {
      /* ignore */
    }
  });
  offscreenPort.onDisconnect.addListener(() => {
    try {
      contentPort.disconnect();
    } catch {
      /* ignore */
    }
  });

  // Сливаем накопившийся буфер.
  for (const msg of queue) {
    try {
      offscreenPort.postMessage(msg);
    } catch {
      break;
    }
  }
}
