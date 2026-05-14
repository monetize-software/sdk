// Service worker entry. Тонкий forwarder между content-script'ами и offscreen.
// State не держит — вся правда в offscreen, SW только маршрут. SW может
// умирать в любой момент; следующий content runtime.connect разбудит его и
// pipe пересоздастся.
//
// OAuth не проксируем — auth-flow на extension'е использует тот же
// web-вариант, что и на сайтах: window.open на наш домен → callback в новой
// вкладке передаёт code в offscreen через chrome.runtime сообщение.
// chrome.identity намеренно не используется (требует chrome-extension://
// redirect URL у провайдеров, ломает совместимость с web).
//
// Использование в host'е:
//   import { installRouter } from '@monetize.software/sdk-extension/sw';
//   installRouter({ offscreenUrl: chrome.runtime.getURL('offscreen.html') });

import { installForwarder } from './forwarder';
import type { RouterOptions } from './types';

export type { RouterOptions };

export function installRouter(opts: RouterOptions): void {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('@monetize.software/sdk-extension/sw requires chrome.runtime');
  }
  installForwarder(opts);
}
