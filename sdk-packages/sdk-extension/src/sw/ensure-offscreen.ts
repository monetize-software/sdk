// Singleton-страж offscreen-документа. Chrome 116+ имеет
// chrome.runtime.getContexts (Promise-overload в MV3); используем его как
// основной путь. Race: несколько параллельных onConnect'ов в одном tick'е
// могут вызвать ensureOffscreen одновременно — запоминаем in-flight promise,
// чтобы каждый следующий ждал общий create.

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
    // Гонка: между нашим check'ом и create'ом другой onConnect успел создать.
    // Chrome бросает 'Only a single offscreen document may be created' — это
    // OK, документ есть. Любая другая ошибка — пробрасываем.
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
