// Service worker entry. A thin forwarder between content-scripts and offscreen.
// Holds no state — all truth lives in offscreen, the SW is just a route. The SW can
// die at any moment; the next content runtime.connect wakes it and the
// pipe is recreated.
//
// We don't proxy OAuth — the auth-flow in the extension uses the same
// web variant as on websites: window.open to our domain → the callback in a new
// tab passes the code to offscreen via a chrome.runtime message.
// chrome.identity is deliberately not used (it requires a chrome-extension://
// redirect URL at providers, which breaks compatibility with web).
//
// Usage in the host:
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
