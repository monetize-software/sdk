// Service worker bootstrap for the demo-extension.
// installRouter brings up the forwarder and, on the first content-script connect,
// creates offscreen.html via the chrome.offscreen API.
//
// apiOrigin/paywallId are read from chrome.storage.local (e2e tests set them
// there) and passed into offscreen via query parameters — the offscreen document
// has NO access to chrome.storage, so the only channel for passing the initial
// configuration is the URL.
import { installRouter } from '@monetize.software/sdk-extension/sw';
import { readDemoConfig, DEMO_CONFIG_HINT } from './demo-config';

// The offscreen URL is resolved lazily on each connect — this lets the
// configuration (apiOrigin/paywallId) change via chrome.storage without
// reloading the SW. Tests rely on this: the fixture sets storage AFTER the
// extension has loaded, and the very first content connect picks it up.
installRouter({
  offscreenUrl: async () => {
    const cfg = await readDemoConfig();
    if (!cfg) throw new Error(DEMO_CONFIG_HINT);
    const params = new URLSearchParams({
      paywallId: cfg.paywallId,
      apiOrigin: cfg.apiOrigin
    });
    return `${chrome.runtime.getURL('offscreen.html')}?${params.toString()}`;
  },
  // Lets the SW finish an OAuth sign-in when the surface that started it is
  // gone — the demo's paywall lives in the action popup, which Chrome destroys
  // the moment the provider window takes focus.
  apiOrigin: async () => (await readDemoConfig())?.apiOrigin ?? '',
  offscreenReasons: [chrome.offscreen.Reason.LOCAL_STORAGE],
  offscreenJustification:
    'Persist auth session and bootstrap cache across extension surfaces via localStorage, unavailable in service workers.'
});
