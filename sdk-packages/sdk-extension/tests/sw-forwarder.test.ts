// Unit test for the SW forwarder. We mock chrome.runtime + chrome.offscreen and
// verify that the content-port is correctly bridged to the offscreen-port.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_NAME } from '../src/shared/port-name';

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  fireMessage: (msg: unknown) => void;
  fireDisconnect: () => void;
  __messageListeners: Set<(msg: unknown) => void>;
  __disconnectListeners: Set<() => void>;
}

function makeFakePort(name: string): FakePort {
  const messageListeners = new Set<(msg: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    __messageListeners: messageListeners,
    __disconnectListeners: disconnectListeners,
    fireMessage: (msg) => {
      for (const cb of messageListeners) cb(msg);
    },
    fireDisconnect: () => {
      for (const cb of disconnectListeners) cb();
    }
  };
}

function setupChromeMock(): {
  onConnectFire: (port: FakePort) => void;
  offscreenConnectFactory: () => FakePort;
  createDocumentSpy: ReturnType<typeof vi.fn>;
  setContextsExist: (exist: boolean) => void;
} {
  const onConnectListeners = new Set<(port: FakePort) => void>();
  let offscreenConnectFactoryRef: () => FakePort = () => makeFakePort('offscreen');
  let contextsExist = false;
  const createDocumentSpy = vi.fn(async () => {
    contextsExist = true;
  });

  const chromeStub = {
    runtime: {
      onConnect: {
        addListener: (cb: (port: FakePort) => void) => {
          onConnectListeners.add(cb);
        },
        removeListener: (cb: (port: FakePort) => void) => {
          onConnectListeners.delete(cb);
        }
      },
      connect: vi.fn(({ name: _name }: { name: string }) => offscreenConnectFactoryRef()),
      getContexts: vi.fn(async () => (contextsExist ? [{} as unknown] : [])),
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' as const }
    },
    offscreen: {
      Reason: { LOCAL_STORAGE: 'LOCAL_STORAGE' as const },
      createDocument: createDocumentSpy
    }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;

  // We bind the contentPort listeners to __messageListeners/__disconnectListeners
  // via the standard Chrome API shape — onMessage.addListener etc. But FakePort
  // doesn't have this shape, so we wrap it: we expose onMessage/onDisconnect
  // as native .addListeners that touch our Sets.
  // So we do the wrapping in onConnectFire — we wrap FakePort into something
  // resembling chrome.runtime.Port that installForwarder will see.
  return {
    onConnectFire: (port: FakePort) => {
      const wrapped = {
        name: port.name,
        postMessage: port.postMessage,
        disconnect: port.disconnect,
        onMessage: {
          addListener: (cb: (msg: unknown) => void) => {
            port.__messageListeners.add(cb);
          },
          removeListener: (cb: (msg: unknown) => void) => {
            port.__messageListeners.delete(cb);
          }
        },
        onDisconnect: {
          addListener: (cb: () => void) => {
            port.__disconnectListeners.add(cb);
          },
          removeListener: (cb: () => void) => {
            port.__disconnectListeners.delete(cb);
          }
        }
      };
      for (const listener of onConnectListeners) listener(wrapped as unknown as FakePort);
    },
    offscreenConnectFactory: () => {
      const offPort = makeFakePort('offscreen');
      // chrome.runtime.connect returns a port — we need the same wrapping.
      return {
        ...offPort,
        onMessage: {
          addListener: (cb: (msg: unknown) => void) => {
            offPort.__messageListeners.add(cb);
          },
          removeListener: (cb: (msg: unknown) => void) => {
            offPort.__messageListeners.delete(cb);
          }
        },
        onDisconnect: {
          addListener: (cb: () => void) => {
            offPort.__disconnectListeners.add(cb);
          },
          removeListener: (cb: () => void) => {
            offPort.__disconnectListeners.delete(cb);
          }
        }
      } as unknown as FakePort;
    },
    createDocumentSpy,
    setContextsExist: (exist) => {
      contextsExist = exist;
    }
  };
}

describe('SW forwarder', () => {
  let mock: ReturnType<typeof setupChromeMock>;

  beforeEach(() => {
    mock = setupChromeMock();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    vi.resetModules();
  });

  it('ignores connections with wrong port name', async () => {
    const { installForwarder } = await import('../src/sw/forwarder');
    installForwarder({ offscreenUrl: 'chrome-extension://x/offscreen.html' });

    const wrongPort = makeFakePort('not-our-name');
    mock.onConnectFire(wrongPort);

    // ensureOffscreen must NOT be called.
    expect(mock.createDocumentSpy).not.toHaveBeenCalled();
  });

  it('content connects → ensureOffscreen called → connect to offscreen → pipe established', async () => {
    let offscreenPortRef: FakePort | null = null;
    const factory = mock.offscreenConnectFactory;
    (globalThis as unknown as { chrome: { runtime: { connect: ReturnType<typeof vi.fn> } } }).chrome.runtime.connect = vi.fn(() => {
      offscreenPortRef = factory();
      return offscreenPortRef as unknown as chrome.runtime.Port;
    });

    const { installForwarder } = await import('../src/sw/forwarder');
    installForwarder({ offscreenUrl: 'chrome-extension://x/offscreen.html' });

    const contentPort = makeFakePort(PORT_NAME);
    mock.onConnectFire(contentPort);

    // ensureOffscreen is async. Let it fire.
    await new Promise((r) => setTimeout(r, 5));

    expect(mock.createDocumentSpy).toHaveBeenCalledTimes(1);
    expect(offscreenPortRef).not.toBeNull();

    // Pipe: content → offscreen.
    const msg = { type: 'request', id: '1', kind: 'billing.bootstrap', params: {} };
    contentPort.fireMessage(msg);
    expect(offscreenPortRef!.postMessage).toHaveBeenCalledWith(msg);

    // Pipe: offscreen → content.
    const resp = { type: 'response', id: '1', ok: true, result: {} };
    offscreenPortRef!.fireMessage(resp);
    expect(contentPort.postMessage).toHaveBeenCalledWith(resp);
  });

  it('messages sent before offscreen ready are buffered and flushed', async () => {
    let createResolve!: () => void;
    const createGate = new Promise<void>((r) => {
      createResolve = r;
    });
    let offscreenPortRef: FakePort | null = null;
    const factory = mock.offscreenConnectFactory;
    (globalThis as unknown as { chrome: { runtime: { connect: ReturnType<typeof vi.fn> } } }).chrome.runtime.connect = vi.fn(() => {
      offscreenPortRef = factory();
      return offscreenPortRef as unknown as chrome.runtime.Port;
    });
    (globalThis as unknown as { chrome: { offscreen: { createDocument: ReturnType<typeof vi.fn> } } }).chrome.offscreen.createDocument = vi.fn(async () => {
      await createGate;
    });

    const { installForwarder } = await import('../src/sw/forwarder');
    installForwarder({ offscreenUrl: 'chrome-extension://x/offscreen.html' });

    const contentPort = makeFakePort(PORT_NAME);
    mock.onConnectFire(contentPort);

    // Content manages to send 2 messages while offscreen is still being created.
    const m1 = { type: 'request', id: '1' };
    const m2 = { type: 'request', id: '2' };
    contentPort.fireMessage(m1);
    contentPort.fireMessage(m2);

    // Offscreen is not connected yet.
    expect(offscreenPortRef).toBeNull();

    // Resolve create — the forwarder should come up and drain the buffer.
    createResolve();
    await new Promise((r) => setTimeout(r, 5));

    expect(offscreenPortRef).not.toBeNull();
    // Both messages arrived in the correct order.
    expect(offscreenPortRef!.postMessage).toHaveBeenNthCalledWith(1, m1);
    expect(offscreenPortRef!.postMessage).toHaveBeenNthCalledWith(2, m2);
  });

  it('content disconnects before offscreen ready → cleanup, no offscreen connection', async () => {
    let createResolve!: () => void;
    const createGate = new Promise<void>((r) => {
      createResolve = r;
    });
    const connectSpy = vi.fn(() =>
      mock.offscreenConnectFactory() as unknown as chrome.runtime.Port
    );
    (globalThis as unknown as { chrome: { runtime: { connect: ReturnType<typeof vi.fn> } } }).chrome.runtime.connect = connectSpy;
    (globalThis as unknown as { chrome: { offscreen: { createDocument: ReturnType<typeof vi.fn> } } }).chrome.offscreen.createDocument = vi.fn(async () => {
      await createGate;
    });

    const { installForwarder } = await import('../src/sw/forwarder');
    installForwarder({ offscreenUrl: 'chrome-extension://x/offscreen.html' });

    const contentPort = makeFakePort(PORT_NAME);
    mock.onConnectFire(contentPort);
    contentPort.fireDisconnect();

    createResolve();
    await new Promise((r) => setTimeout(r, 5));

    // Content is already dead — we don't connect.
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
