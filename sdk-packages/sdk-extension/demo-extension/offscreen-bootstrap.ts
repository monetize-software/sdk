// The script referenced by offscreen.html. Brings up the real server on top of
// the offscreen document. The config is read from URL parameters (the SW sets
// them when creating the document — chrome.storage is unavailable inside
// offscreen, so the URL is the only channel for initial configuration).
import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';

const params = new URLSearchParams(window.location.search);

startOffscreenServer({
  paywallId: params.get('paywallId') ?? '3',
  apiOrigin: params.get('apiOrigin') ?? 'https://onlineapp.stream',
  // auth: true on the content-side PaywallUI creates a RemoteAuthClient — it
  // sends 'auth.*' requests. If it isn't enabled here, offscreen will respond
  // with "Unknown request kind". Must match the content-script's config.
  auth: true
});
