// The script referenced by offscreen.html. Brings up the real server on top of
// the offscreen document. The config is read from URL parameters (the SW sets
// them when creating the document — chrome.storage is unavailable inside
// offscreen, so the URL is the only channel for initial configuration).
import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';

const params = new URLSearchParams(window.location.search);

// No defaults on purpose — the SW only ever builds this URL from a complete
// config (see demo-config.ts). Missing params mean something upstream broke, and
// guessing an origin here would send the whole extension's traffic to the wrong
// host.
const paywallId = params.get('paywallId');
const apiOrigin = params.get('apiOrigin');
if (!paywallId || !apiOrigin) {
  throw new Error(
    'offscreen: paywallId and apiOrigin must be present in the document URL'
  );
}

startOffscreenServer({
  paywallId,
  apiOrigin,
  // auth: true on the content-side PaywallUI creates a RemoteAuthClient — it
  // sends 'auth.*' requests. If it isn't enabled here, offscreen will respond
  // with "Unknown request kind". Must match the content-script's config.
  auth: true
});
