// Singleton guard for the offscreen document. Chrome 116+ has
// chrome.runtime.getContexts (Promise-overload in MV3); we use it as
// the primary path. Race: several parallel onConnects in the same tick
// may call ensureOffscreen simultaneously — we remember the in-flight promise,
// so each subsequent one waits on the shared create.

interface EnsureOffscreenOptions {
  url: string;
  reasons: chrome.offscreen.Reason[];
  justification: string;
}

let inflight: Promise<void> | null = null;

export async function ensureOffscreen(opts: EnsureOffscreenOptions): Promise<void> {
  if (inflight) return inflight;
  inflight = doEnsure(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doEnsure(opts: EnsureOffscreenOptions): Promise<void> {
  if (await offscreenExists(opts.url)) return;
  try {
    await chrome.offscreen.createDocument({
      url: opts.url,
      reasons: opts.reasons,
      justification: opts.justification
    });
  } catch (e) {
    // Race: between our check and create another onConnect managed to create it.
    // Chrome throws 'Only a single offscreen document may be created' — that's
    // OK, the document exists. Any other error — rethrow.
    if (e instanceof Error && /single offscreen document/i.test(e.message)) return;
    throw e;
  }
}

async function offscreenExists(url: string): Promise<boolean> {
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url]
    });
    return contexts.length > 0;
  }
  return false;
}
