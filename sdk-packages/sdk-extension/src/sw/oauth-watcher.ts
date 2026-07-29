// OAuth rescue path in the service worker.
//
// The normal flow hands the auth code back through `postMessage` to
// `window.opener` — which requires the surface that started sign-in to still be
// alive. A toolbar action popup often isn't: Chrome destroys it the moment the
// provider window takes focus, and whether that happens is decided by the OS
// window manager, so the same extension works on one machine and fails on
// another. When the popup dies its message listener dies with it, the code is
// delivered into a closed window, and the user is left signed out with no error.
//
// The code, however, is also sitting in plain sight — in the URL of the tab that
// the provider redirected to our callback page. A worker can see that navigation
// (`chrome.tabs.onUpdated` delivers `changeInfo.url` for any origin the
// extension already holds a host permission for, which the apiOrigin always is),
// read the code, and hand it to offscreen, which owns the PKCE verifier and can
// finish alone.
//
// Why this over `chrome.identity.launchWebAuthFlow`: no `identity` permission,
// no `chromiumapp.org` redirect to register per extension ID, and it does not
// depend on the worker staying alive for the whole sign-in — `tabs.onUpdated` is
// an event that *wakes* the worker, so a Google login that takes two minutes is
// fine.

import { RELAY_PORT_NAME } from '../shared/port-name';
import { portToChannel } from '../shared/chrome-port';
import { TransportClient } from '../shared/transport-client';
import { ensureOffscreen, offscreenExists } from './ensure-offscreen';

/** Path of the OAuth callback page served from the paywall's custom domain.
 *  Contract shared with `online/app/paywall/v3/auth/callback`. */
const CALLBACK_PATH = '/paywall/v3/auth/callback';

export interface OAuthWatcherOptions {
  apiOrigin: string | (() => string | Promise<string>);
  offscreenUrl: string | (() => string | Promise<string>);
  offscreenReasons: chrome.offscreen.Reason[];
  offscreenJustification: string;
}

/**
 * Returns the auth code if `url` is our OAuth callback for `apiOrigin`, else
 * null.
 *
 * Host matching accepts the edge mirror in both directions: `/oauth/init` builds
 * `redirect_to` with `resolveEdgeAwareOrigin`, so a client that failed over to
 * `edge.<domain>` gets its callback there while its configured apiOrigin is
 * still the canonical host (and vice versa).
 *
 * Only the query string is consulted. GoTrue returns PKCE codes there; it puts
 * *errors* in the fragment, which a worker cannot see at all — those keep
 * surfacing the old way (the window closes without a code and the flow reports
 * a cancellation).
 */
export function matchOAuthCallback(url: string, apiOrigin: string): string | null {
  let target: URL;
  let origin: URL;
  try {
    target = new URL(url);
    origin = new URL(apiOrigin);
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (target.pathname !== CALLBACK_PATH) return null;

  const host = target.hostname;
  const configured = origin.hostname;
  const sameHost =
    host === configured || host === `edge.${configured}` || `edge.${host}` === configured;
  if (!sameHost) return null;

  return target.searchParams.get('code');
}

export function installOAuthWatcher(opts: OAuthWatcherOptions): void {
  // `tabs` is not in our required permission set; the listener exists only when
  // the host extension's manifest happens to grant the API surface.
  if (typeof chrome === 'undefined' || !chrome.tabs?.onUpdated) return;

  // onUpdated fires several times per navigation (loading → complete) and the
  // URL is unchanged across them. A code is single-use at GoTrue, so adopting it
  // twice would burn a perfectly good session.
  const seenCodes = new Set<string>();

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Present only when the extension holds a host permission for the URL —
    // which, for our own apiOrigin, it must.
    if (!changeInfo.url) return;
    void handleNavigation(tabId, changeInfo.url, seenCodes, opts);
  });
}

async function handleNavigation(
  tabId: number,
  url: string,
  seenCodes: Set<string>,
  opts: OAuthWatcherOptions
): Promise<void> {
  let apiOrigin: string;
  try {
    apiOrigin = typeof opts.apiOrigin === 'function' ? await opts.apiOrigin() : opts.apiOrigin;
  } catch {
    return;
  }
  if (!apiOrigin) return;

  const code = matchOAuthCallback(url, apiOrigin);
  if (!code || seenCodes.has(code)) return;
  seenCodes.add(code);
  // Bounded: one entry per completed sign-in, and the worker is torn down long
  // before this could matter. The cap is a belt-and-braces against a page that
  // reloads the callback in a loop.
  if (seenCodes.size > 32) seenCodes.clear();

  // Do NOT spin offscreen up just to ask. A fresh document has no pending flow
  // and no verifier, so it could only answer `no_pending_flow` — and creating it
  // here would race the forwarder's own ensureOffscreen.
  let alive = false;
  try {
    const offscreenUrl =
      typeof opts.offscreenUrl === 'function' ? await opts.offscreenUrl() : opts.offscreenUrl;
    alive = await offscreenExists(offscreenUrl);
    if (!alive) return;
    // Present but possibly mid-teardown; ensureOffscreen is a no-op when it's up.
    await ensureOffscreen({
      url: offscreenUrl,
      reasons: opts.offscreenReasons,
      justification: opts.offscreenJustification
    });
  } catch {
    return;
  }

  const client = new TransportClient(() =>
    portToChannel(chrome.runtime.connect({ name: RELAY_PORT_NAME }))
  );
  try {
    const result = await client.request('auth.oauthAdopt', { code });
    if (!result.adopted) return;
    // Only now is the tab expendable. The callback page usually closes itself,
    // so this is a no-op more often than not.
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already gone */
    }
  } catch {
    // Offscreen died between the check and the request, or the port broke. The
    // user can retry sign-in; nothing here is worth surfacing.
  } finally {
    client.destroy();
  }
}
