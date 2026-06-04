// Service worker bootstrap for the demo-extension.
// installRouter brings up the forwarder and, on the first content-script connect,
// creates offscreen.html via the chrome.offscreen API.
//
// apiOrigin/paywallId are read from chrome.storage.local (e2e tests set them
// there) and passed into offscreen via query parameters — the offscreen document
// has NO access to chrome.storage, so the only channel for passing the initial
// configuration is the URL.
import { installRouter } from '@monetize.software/sdk-extension/sw';

// The offscreen URL is resolved lazily on each connect — this lets the
// configuration (apiOrigin/paywallId) change via chrome.storage without
// reloading the SW. Tests rely on this: the fixture sets storage AFTER the
// extension has loaded, and the very first content connect picks it up.
installRouter({
  offscreenUrl: async () => {
    const cfg = (await chrome.storage.local.get([
      '__demo_paywall_id',
      '__demo_api_origin'
    ])) as { __demo_paywall_id?: string; __demo_api_origin?: string };
    const params = new URLSearchParams({
      paywallId: cfg.__demo_paywall_id ?? '3',
      apiOrigin: cfg.__demo_api_origin ?? 'https://onlineapp.stream'
    });
    return `${chrome.runtime.getURL('offscreen.html')}?${params.toString()}`;
  },
  offscreenReasons: [chrome.offscreen.Reason.LOCAL_STORAGE],
  offscreenJustification:
    'Persist auth session and bootstrap cache across extension surfaces via localStorage, unavailable in service workers.'
});
