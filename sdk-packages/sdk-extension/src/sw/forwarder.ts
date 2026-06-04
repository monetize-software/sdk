// Service worker forwarder. Stateless by design — its only job is to
// route content↔offscreen ports. The SW can die at any moment
// (after 30s idle); reconnect happens organically: the next content
// runtime.connect wakes the SW, which recreates offscreen (if it died — though it
// usually hasn't) and brings up a fresh pipe.

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

    // Bring up offscreen and proxy. ensureOffscreen is async — content may
    // send requests before it resolves: we buffer them in a queue until the offscreen
    // port is created. Better than dropping them — content routes absolutely everything
    // through us anyway.
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
    // We use a separate relay-port name (not PORT_NAME), so offscreen
    // accepts only SW-relay connections and ignores direct connects
    // from popup/content (which also trigger onConnect in offscreen — in MV3
    // chrome.runtime.connect is delivered to ALL extension contexts with an
    // onConnect listener, not just the SW).
    offscreenPort = chrome.runtime.connect({ name: RELAY_PORT_NAME });
  } catch (e) {
    console.error('[sdk-extension/sw] connect to offscreen failed', e);
    contentPort.disconnect();
    return;
  }

  // Remove the buffer-listener, install the direct forwarder.
  contentPort.onMessage.removeListener(queueListener);
  contentPort.onMessage.addListener((msg) => {
    try {
      offscreenPort.postMessage(msg);
    } catch {
      /* offscreen already dropped — the disconnect cascade will tear down content */
    }
  });
  offscreenPort.onMessage.addListener((msg) => {
    try {
      contentPort.postMessage(msg);
    } catch {
      /* content already dropped */
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

  // Flush the accumulated buffer.
  for (const msg of queue) {
    try {
      offscreenPort.postMessage(msg);
    } catch {
      break;
    }
  }
}
