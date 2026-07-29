// Service worker entry. A thin forwarder between content-scripts and offscreen.
// Holds no state — all truth lives in offscreen, the SW is just a route. The SW can
// die at any moment; the next content runtime.connect wakes it and the
// pipe is recreated.
//
// OAuth uses the same web flow as on websites — window.open to our domain, the
// callback page posting the code back to its opener. chrome.identity is
// deliberately not used (it needs a chrome-extension:// redirect URL registered
// at the provider, which breaks parity with web).
//
// Pass `apiOrigin` and the SW additionally watches for that callback landing in
// a tab, so a sign-in survives its originating surface being destroyed — see
// ./oauth-watcher. Without it, behaviour is unchanged.
//
// Usage in the host:
//   import { installRouter } from '@monetize.software/sdk-extension/sw';
//   installRouter({
//     offscreenUrl: chrome.runtime.getURL('offscreen.html'),
//     apiOrigin: 'https://your-custom-domain.com'
//   });

import { installForwarder } from './forwarder';
import type { RouterOptions } from './types';

export type { RouterOptions };
export { matchOAuthCallback } from './oauth-watcher';

export function installRouter(opts: RouterOptions): void {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    throw new Error('@monetize.software/sdk-extension/sw requires chrome.runtime');
  }
  installForwarder(opts);
}
