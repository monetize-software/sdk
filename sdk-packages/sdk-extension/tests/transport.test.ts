import { describe, it, expect, vi } from 'vitest';
import { TransportClient } from '../src/shared/transport-client';
import { TransportServer } from '../src/shared/transport-server';
import type { MessageChannel } from '../src/shared/channel';
import type { Envelope } from '../src/shared/protocol';
// Подгружаем module augmentation для RequestParamsMap/RequestResultMap/EventPayloadMap.
import '../src/shared/messages';

// In-memory дуплекс для тестов: пара каналов, всё что одна сторона отправляет —
// доходит до другой. Имитирует port между двумя контекстами.
function pairChannels(): [MessageChannel, MessageChannel] {
  const aIn = new Set<(env: Envelope) => void>();
  const bIn = new Set<(env: Envelope) => void>();
  const aDisc = new Set<() => void>();
  const bDisc = new Set<() => void>();
  let alive = true;

  const a: MessageChannel = {
    send(env) {
      if (!alive) throw new Error('disconnected');
      for (const cb of bIn) cb(env);
    },
    onMessage(cb) {
      aIn.add(cb);
      return () => aIn.delete(cb);
    },
    onDisconnect(cb) {
      aDisc.add(cb);
      return () => aDisc.delete(cb);
    },
    close() {
      if (!alive) return;
      alive = false;
      for (const cb of [...aDisc, ...bDisc]) cb();
    }
  };
  const b: MessageChannel = {
    send(env) {
      if (!alive) throw new Error('disconnected');
      for (const cb of aIn) cb(env);
    },
    onMessage(cb) {
      bIn.add(cb);
      return () => bIn.delete(cb);
    },
    onDisconnect(cb) {
      bDisc.add(cb);
      return () => bDisc.delete(cb);
    },
    close() {
      if (!alive) return;
      alive = false;
      for (const cb of [...aDisc, ...bDisc]) cb();
    }
  };

  return [a, b];
}

describe('Transport request/response', () => {
  it('correlates request to response by id', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    server.on('billing.getVisitorId', () => 'visitor-abc');

    const client = new TransportClient(() => clientCh);
    const result = await client.request('billing.getVisitorId', undefined);

    expect(result).toBe('visitor-abc');
  });

  it('handles concurrent requests independently', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);

    let calls = 0;
    server.on('billing.getVisitorId', async () => {
      const id = ++calls;
      await new Promise((r) => setTimeout(r, id === 1 ? 30 : 5));
      return `v${id}`;
    });

    const client = new TransportClient(() => clientCh);
    const [a, b] = await Promise.all([
      client.request('billing.getVisitorId', undefined),
      client.request('billing.getVisitorId', undefined)
    ]);

    // Второй handler tick дёрнется первым (5ms < 30ms), но id'шники должны
    // соответствовать своим request'ам — без cross-talk'а.
    expect(a).toBe('v1');
    expect(b).toBe('v2');
  });

  it('serializes errors back as PaywallError instance', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    server.on('billing.bootstrap', async () => {
      const { PaywallError } = await import('@sdk/core/types');
      throw new PaywallError('rate_limited', 'too many', { status: 429 });
    });

    const client = new TransportClient(() => clientCh);
    const { PaywallError } = await import('@sdk/core/types');

    await expect(client.request('billing.bootstrap', {})).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'too many',
      status: 429
    });

    try {
      await client.request('billing.bootstrap', {});
    } catch (e) {
      expect(e).toBeInstanceOf(PaywallError);
    }
  });

  it('broadcasts events to all subscribed clients', () => {
    const server = new TransportServer();
    const [c1Ch, s1Ch] = pairChannels();
    const [c2Ch, s2Ch] = pairChannels();
    server.accept(s1Ch);
    server.accept(s2Ch);

    const client1 = new TransportClient(() => c1Ch);
    const client2 = new TransportClient(() => c2Ch);

    const handler1 = vi.fn();
    const handler2 = vi.fn();
    client1.on('userChange', handler1);
    client2.on('userChange', handler2);

    const payload = { id: 'u1', email: 'u@x' } as never;
    server.broadcast('userChange', payload);

    expect(handler1).toHaveBeenCalledWith(payload);
    expect(handler2).toHaveBeenCalledWith(payload);
  });

  it('rejects pending requests on disconnect', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    server.on('billing.bootstrap', () =>
      new Promise(() => {}) as never  // never resolves
    );

    const client = new TransportClient(() => clientCh);
    const promise = client.request('billing.bootstrap', {});

    serverCh.close();

    await expect(promise).rejects.toThrow(/disconnected/i);
  });

  it('respects AbortSignal', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    server.on('billing.bootstrap', () => new Promise(() => {}) as never);

    const client = new TransportClient(() => clientCh);
    const ctrl = new AbortController();
    const promise = client.request('billing.bootstrap', {}, { signal: ctrl.signal });
    ctrl.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('handshake auto-sent on first connect, mismatch logs warning', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    // Override handshake to return mismatched version.
    server.on('handshake', () => ({ protocolVersion: 999, offscreenReady: true }));
    server.on('billing.getVisitorId', () => 'v1');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const client = new TransportClient(() => clientCh);
    // Тригерим ensureChannel через любой request.
    await client.request('billing.getVisitorId', undefined);
    // Дать handshake-promise дотечь.
    await new Promise((r) => setTimeout(r, 5));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/protocol version mismatch/i)
    );
    warnSpy.mockRestore();
  });

  it('handshake silently OK when versions match', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);
    server.on('billing.getVisitorId', () => 'v1');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const client = new TransportClient(() => clientCh);
    await client.request('billing.getVisitorId', undefined);
    await new Promise((r) => setTimeout(r, 5));

    // Default handshake handler в TransportServer возвращает текущую версию —
    // matching. Никаких warning'ов.
    const protocolWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('protocol version mismatch')
    );
    expect(protocolWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('AbortSignal propagates to server-side handler via cancel envelope', async () => {
    const [clientCh, serverCh] = pairChannels();
    const server = new TransportServer();
    server.accept(serverCh);

    let serverAborted = false;
    server.on('billing.bootstrap', (_params, ctx) => {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          serverAborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }) as never;
    });

    const client = new TransportClient(() => clientCh);
    const ctrl = new AbortController();
    const promise = client.request('billing.bootstrap', {}, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 0)); // даём request долететь
    ctrl.abort();

    await expect(promise).rejects.toThrow(/abort/i);
    // Дать cancel-envelope долететь до server-side handler'а.
    await new Promise((r) => setTimeout(r, 0));
    expect(serverAborted).toBe(true);
  });

  it('multi-channel: 50 concurrent clients, cleanup on disconnect, broadcast reaches all', async () => {
    const server = new TransportServer();
    server.on('billing.getVisitorId', () => 'shared-v');

    const channels: MessageChannel[] = [];
    const clients: TransportClient[] = [];
    const N = 50;

    for (let i = 0; i < N; i++) {
      const [clientCh, serverCh] = pairChannels();
      server.accept(serverCh);
      channels.push(clientCh);
      clients.push(new TransportClient(() => clientCh));
    }

    // Все клиенты делают request параллельно — никаких race'ов между id'шниками
    // (request_id уникален per client).
    const results = await Promise.all(
      clients.map((c) => c.request('billing.getVisitorId', undefined))
    );
    expect(results).toEqual(Array(N).fill('shared-v'));

    // Server видит все N подключений.
    expect(server.connectionCount).toBe(N);

    // Broadcast достигает всех.
    const received: number[] = [];
    clients.forEach((c, i) => {
      c.on('userChange', () => received.push(i));
    });
    server.broadcast('userChange', { has_active_subscription: true } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(N);

    // Закрываем половину каналов — server должен почистить connectionCount.
    for (let i = 0; i < N / 2; i++) {
      channels[i].close();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(server.connectionCount).toBe(N / 2);

    // Оставшиеся ещё работают.
    const stillAlive = await clients[N - 1].request('billing.getVisitorId', undefined);
    expect(stillAlive).toBe('shared-v');
  });

  it('lazy reconnect: next request after disconnect creates fresh channel via factory', async () => {
    let factoryCalls = 0;
    const server = new TransportServer();

    // Каждый раз factory выдаёт свежую пару, server.accept ловит свою половину.
    const factory = (): MessageChannel => {
      factoryCalls++;
      const [clientCh, serverCh] = pairChannels();
      server.accept(serverCh);
      return clientCh;
    };

    server.on('billing.getVisitorId', () => `v-${factoryCalls}`);

    const client = new TransportClient(factory);

    // Первый запрос — factory зовётся, канал поднимается.
    const r1 = await client.request('billing.getVisitorId', undefined);
    expect(r1).toBe('v-1');
    expect(factoryCalls).toBe(1);

    // Disconnect: эмулируем смерть SW — закрываем сервер-сторону всех
    // активных каналов через broadcast destroy. Простой путь — найти клиент
    // канал и закрыть его (это вызовет onDisconnect у TransportClient).
    // В этой in-memory имплементации canale.close() закроет обе стороны.
    // Дёргаем close через приватку — публичной нет, но destroy не подходит
    // (он блокирует следующие request'ы).
    (client as unknown as { channel: MessageChannel | null }).channel?.close();

    // Pending in-flight нет; следующий запрос должен поднять новый канал.
    const r2 = await client.request('billing.getVisitorId', undefined);
    expect(r2).toBe('v-2');
    expect(factoryCalls).toBe(2);
  });
});
