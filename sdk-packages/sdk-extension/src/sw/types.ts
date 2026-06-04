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
}
