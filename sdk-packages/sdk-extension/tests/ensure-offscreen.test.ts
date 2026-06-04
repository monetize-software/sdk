// Race test for ensureOffscreen: parallel calls (for example, 5 onConnects
// in a single tick) must be deduped via an in-flight promise — chrome.offscreen
// .createDocument is called exactly once.

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

    // 5 parallel calls in a single tick.
    await Promise.all([
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts),
      ensureOffscreen(opts)
    ]);

    // createDocument fired once — the other four latched onto the inflight promise.
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

    // Must not throw — a race between the check and the create is a normal situation.
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

    // Second call — getContexts returns exists=true, createDocument is not fired.
    await ensureOffscreen(opts);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});
