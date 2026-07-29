// Public types for the SW router. A separate file so forwarder.ts doesn't
// reach into index.ts (a cyclic type-only import is tolerable, but reads poorly).

export interface RouterOptions {
  /** URL of the offscreen page. Can be a static string OR a function —
   *  the function lets you resolve the URL on every connect, which is needed when
   *  parameters (apiOrigin, paywallId, etc.) come from chrome.storage and
   *  may change without reloading the SW. Each lazy resolve can
   *  be async — an async function reads storage and returns the URL.
   *
   *  Simple case: `chrome.runtime.getURL('offscreen.html')`.
   *  With parameters:
   *    `() => chrome.storage.local.get(['k']).then(({ k }) =>
   *      chrome.runtime.getURL('offscreen.html') + '?k=' + k)`
   */
  offscreenUrl: string | (() => string | Promise<string>);
  /** Reasons for chrome.offscreen.createDocument. Default — `['LOCAL_STORAGE']`. */
  offscreenReasons?: chrome.offscreen.Reason[];
  /** Justification for the CWS review. */
  offscreenJustification?: string;
  /**
   * Your paywall's `custom_domain` — the same value passed to `PaywallUI` and
   * `startOffscreenServer`. Accepts a resolver, like `offscreenUrl`, for configs
   * that live in chrome.storage.
   *
   * Supplying it lets the SW finish an OAuth sign-in whose originating surface
   * was destroyed mid-flow — the common case being a toolbar action popup, which
   * Chrome closes as soon as the provider window takes focus. The worker watches
   * for the provider's redirect landing on this origin's callback page and hands
   * the code to offscreen itself.
   *
   * Needs no new manifest permission: the URL is visible to `tabs.onUpdated`
   * through the host permission you already declare for this origin. Omit it and
   * OAuth keeps working exactly as before, but only while the surface that
   * started it stays alive.
   */
  apiOrigin?: string | (() => string | Promise<string>);
}
