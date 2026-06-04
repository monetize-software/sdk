// Unit test for the chrome-port adapter. We mock chrome.runtime.Port
// (the minimal interface from @types/chrome) and verify that portToChannel
// correctly bridges it into the MessageChannel abstraction.

import { describe, it, expect, vi } from 'vitest';
import { portToChannel } from '../src/shared/chrome-port';
import type { Envelope } from '../src/shared/protocol';

interface FakePortListener<T> {
  addListener: (cb: T) => void;
  removeListener: (cb: T) => void;
  /** Test utility: fire to all subscribers. Not part of the chrome.runtime.Port API. */
  __fire: (...args: unknown[]) => void;
}

function makeFakePort(): {
  port: chrome.runtime.Port;
  posted: unknown[];
  disconnectCalls: number;
  fireMessage: (msg: unknown) => void;
  fireDisconnect: () => void;
} {
  const messageListeners = new Set<(msg: unknown, port: unknown) => void>();
  const disconnectListeners = new Set<(port: unknown) => void>();
  const posted: unknown[] = [];
  let disconnectCalls = 0;

  const onMessage: FakePortListener<(msg: unknown, port: unknown) => void> = {
    addListener: (cb) => { messageListeners.add(cb); },
    removeListener: (cb) => { messageListeners.delete(cb); },
    __fire: (msg) => {
      for (const cb of messageListeners) cb(msg, port);
    }
  };
  const onDisconnect: FakePortListener<(port: unknown) => void> = {
    addListener: (cb) => { disconnectListeners.add(cb); },
    removeListener: (cb) => { disconnectListeners.delete(cb); },
    __fire: () => {
      for (const cb of disconnectListeners) cb(port);
    }
  };
  const port: chrome.runtime.Port = {
    name: 'test',
    postMessage: (msg: unknown) => { posted.push(msg); },
    disconnect: () => { disconnectCalls++; },
    onMessage: onMessage as unknown as chrome.runtime.Port['onMessage'],
    onDisconnect: onDisconnect as unknown as chrome.runtime.Port['onDisconnect'],
    sender: undefined
  };

  return {
    port,
    posted,
    get disconnectCalls() { return disconnectCalls; },
    fireMessage: (msg) => onMessage.__fire(msg),
    fireDisconnect: () => onDisconnect.__fire()
  };
}

describe('portToChannel adapter', () => {
  it('send() forwards to port.postMessage', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const envelope = { type: 'request', id: '1', kind: 'billing.bootstrap', params: {} } as Envelope;
    channel.send(envelope);
    expect(fake.posted).toEqual([envelope]);
  });

  it('onMessage subscribers receive port messages', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const handler = vi.fn();
    channel.onMessage(handler);

    const env = { type: 'event', kind: 'userChange', payload: {} } as Envelope;
    fake.fireMessage(env);

    expect(handler).toHaveBeenCalledWith(env);
  });

  it('multiple onMessage subscribers all fire', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const a = vi.fn();
    const b = vi.fn();
    channel.onMessage(a);
    channel.onMessage(b);

    fake.fireMessage({ type: 'event', kind: 'userChange', payload: null });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('onMessage unsubscribe stops further calls', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const handler = vi.fn();
    const unsub = channel.onMessage(handler);
    unsub();

    fake.fireMessage({ type: 'event', kind: 'userChange', payload: null });

    expect(handler).not.toHaveBeenCalled();
  });

  it('onDisconnect fires when port disconnects', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const handler = vi.fn();
    channel.onDisconnect(handler);

    fake.fireDisconnect();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disconnect is idempotent — second fire does not double-call handlers', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const handler = vi.fn();
    channel.onDisconnect(handler);

    fake.fireDisconnect();
    fake.fireDisconnect();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('late onDisconnect subscriber after disconnect fires immediately (microtask)', async () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    fake.fireDisconnect();

    const handler = vi.fn();
    channel.onDisconnect(handler);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('close() calls port.disconnect and triggers onDisconnect callbacks', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    const handler = vi.fn();
    channel.onDisconnect(handler);

    channel.close();

    expect(fake.disconnectCalls).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('send() after disconnect is no-op (no throw, no postMessage)', () => {
    const fake = makeFakePort();
    const channel = portToChannel(fake.port);
    fake.fireDisconnect();

    channel.send({ type: 'event', kind: 'userChange', payload: null });

    expect(fake.posted).toHaveLength(0);
  });
});
