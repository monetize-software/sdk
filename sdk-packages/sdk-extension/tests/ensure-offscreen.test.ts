// Тест на race в ensureOffscreen: параллельные вызовы (например, 5 onConnect'ов
// в одном tick'е) должны дедупиться через in-flight promise — chrome.offscreen
// .createDocument вызывается ровно один раз.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ChromeStub {
  runtime: {
    getContexts: ReturnType<typeof vi.fn>;
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  };
  offscreen: {
    Reason: { LOCAL_STORAGE: 'LOCAL_STORAGE' };
    createDocument: ReturnType<typeof vi.fn>;
  };
}

function setupChromeMock(opts: {
  initialContextsExist?: boolean;
  createDelay?: number;
} = {}): {
  chrome: ChromeStub;
  setContextsExist: (exist: boolean) => void;
} {
  let exists = opts.initialContextsExist ?? false;
  const delay = opts.createDelay ?? 10;

  const stub: ChromeStub = {
    runtime: {
      getContexts: vi.fn(async () => (exists ? [{} as unknown] : [])),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' as const }
    },
    offscreen: {
      Reason: { LOCAL_STORAGE: 'LOCAL_STORAGE' as const },
      createDocument: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, delay));
        exists = true;
      })
    }
  };

  (globalThis as unknown as { chrome: ChromeStub }).chrome = stub;
  return {
    chrome: stub,
    setContextsExist: (e: boolean) => { exists = e; }
  };
}

describe('ensureOffscreen race protection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('parallel calls dedupe via in-flight promise: createDocument called once', async () => {
    const { chrome } = setupChromeMock({ createDelay: 20 });
    const { ensureOffscreen } = await import('../src/sw/ensure-offscreen');

    const opts = {
      url: 'chrome-extension://x/offscreen.html',
      reasons: [chrome.offscreen.Reason.LOCAL_STORAGE] as unknown as chrome.offscreen.Reason[],
      justification: 'test'
    };

    // 5 параллельных вызовов в одном tick'е.
    await Promise.all([
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts)
    ]);

    // createDocument дёрнулся один раз — остальные четыре подхватили inflight promise.
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('skips create when offscreen already exists', async () => {
    const { chrome } = setupChromeMock({ initialContextsExist: true });
    const { ensureOffscreen } = await import('../src/sw/ensure-offscreen');

    await ensureOffscreen({
      url: 'chrome-extension://x/offscreen.html',
      reasons: [chrome.offscreen.Reason.LOCAL_STORAGE] as unknown as chrome.offscreen.Reason[],
      justification: 'test'
    });

    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('handles "single offscreen document" race error gracefully', async () => {
    const { chrome } = setupChromeMock();
    chrome.offscreen.createDocument = vi.fn(async () => {
      throw new Error('Only a single offscreen document may be created.');
    });
    const { ensureOffscreen } = await import('../src/sw/ensure-offscreen');

    // Не должно бросать — race между check'ом и create'ом нормальная ситуация.
    await expect(
      ensureOffscreen({
        url: 'chrome-extension://x/offscreen.html',
        reasons: [chrome.offscreen.Reason.LOCAL_STORAGE] as unknown as chrome.offscreen.Reason[],
        justification: 'test'
      })
    ).resolves.toBeUndefined();
  });

  it('propagates non-race errors from createDocument', async () => {
    const { chrome } = setupChromeMock();
    chrome.offscreen.createDocument = vi.fn(async () => {
      throw new Error('Permission denied');
    });
    const { ensureOffscreen } = await import('../src/sw/ensure-offscreen');

    await expect(
      ensureOffscreen({
        url: 'chrome-extension://x/offscreen.html',
        reasons: [chrome.offscreen.Reason.LOCAL_STORAGE] as unknown as chrome.offscreen.Reason[],
        justification: 'test'
      })
    ).rejects.toThrow(/permission/i);
  });

  it('after successful create, subsequent calls are no-op (cached check)', async () => {
    const { chrome } = setupChromeMock();
    const { ensureOffscreen } = await import('../src/sw/ensure-offscreen');

    const opts = {
      url: 'chrome-extension://x/offscreen.html',
      reasons: [chrome.offscreen.Reason.LOCAL_STORAGE] as unknown as chrome.offscreen.Reason[],
      justification: 'test'
    };

    await ensureOffscreen(opts);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);

    // Второй вызов — getContexts вернёт exists=true, createDocument не дёрнут.
    await ensureOffscreen(opts);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});
