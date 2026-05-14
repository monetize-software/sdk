// Offscreen page entry. Owns real BillingClient (и в Phase 4+ — AuthClient,
// EventTracker) — единственный source of truth для всего расширения.
//
// Импортируется в `offscreen.html`:
//   <script type="module">
//     import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';
//     startOffscreenServer({ paywallId: '123', apiOrigin: 'https://...' });
//   </script>

import { OffscreenServer } from './server';

export interface OffscreenServerOptions {
  paywallId: string;
  apiOrigin?: string;
  /** Если true — offscreen-server создаёт собственный AuthClient и
   *  подключает его к BillingClient для Bearer-авторизации. Сессия
   *  хранится в offscreen'овском localStorage и шарится между всеми
   *  surface'ами расширения через broadcast authChange. */
  auth?: boolean;
  /** Аналитика. По умолчанию включена; передай false чтобы отключить
   *  целиком. Объект — кастомные параметры (endpoint, batch). EventTracker
   *  один на расширение, все content track() forward'ятся в него. */
  analytics?:
    | boolean
    | {
        endpoint?: string;
        flushIntervalMs?: number;
        maxBufferSize?: number;
      };
}

let active: OffscreenServer | null = null;

export function startOffscreenServer(opts: OffscreenServerOptions): OffscreenServer {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('@monetize.software/sdk-extension/offscreen requires chrome.runtime');
  }
  if (active) {
    // Двойной запуск — может случиться, если host подгружает offscreen-bootstrap
    // дважды (HMR в dev, или ошибка с двойным <script>). Возвращаем существующий
    // инстанс — re-creating дёрнул бы повторный listener на runtime.onConnect.
    return active;
  }
  active = new OffscreenServer(opts);
  active.start();
  return active;
}

export type { OffscreenServer };
