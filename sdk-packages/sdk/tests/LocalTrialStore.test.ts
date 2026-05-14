import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTrialStore } from '../src/core/trial/LocalTrialStore';
import type { StorageAdapter } from '../src/core/storage';
import type { TimeTrialStatus, TrialConfig } from '../src/core/types';

function memoryAdapter(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    async getItem(k) {
      return map.get(k) ?? null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    }
  };
}

const PAYWALL = 'pw_1';

describe('LocalTrialStore — opens mode', () => {
  const config: TrialConfig = { mode: 'opens', payload: 3, storage: 'client' };

  it('blocks first N opens, then unblocks (v2-compat semantics)', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, config);

    let s = await store.check();
    expect(s).toMatchObject({ mode: 'opens', blocked: true, remainingActions: 3, totalActions: 3 });

    s = await store.recordBlock();
    expect(s).toMatchObject({ blocked: true, remainingActions: 2 });

    s = await store.recordBlock();
    expect(s).toMatchObject({ blocked: true, remainingActions: 1 });

    s = await store.recordBlock();
    expect(s).toMatchObject({ blocked: false, remainingActions: 0 });

    // Сheck после исчерпания возвращает blocked=false
    s = await store.check();
    expect(s).toMatchObject({ blocked: false, remainingActions: 0 });
  });

  it('reset clears the counter', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, config);
    await store.recordBlock();
    await store.recordBlock();
    await store.reset();
    const s = await store.check();
    expect(s).toMatchObject({ blocked: true, remainingActions: 3 });
  });

  it('reads v2 storage key (legacy compat)', async () => {
    // Юзер мигрировал с v2: в storage уже лежит paywall-${id}-skip-times.
    const adapter = memoryAdapter();
    await adapter.setItem(`paywall-${PAYWALL}-skip-times`, '2');
    const store = new LocalTrialStore(adapter, PAYWALL, config);
    const s = await store.check();
    expect(s).toMatchObject({ blocked: true, remainingActions: 1 });
  });

  it('treats payload=0 as immediately expired', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, {
      mode: 'opens',
      payload: 0,
      storage: 'client'
    });
    const s = await store.check();
    expect(s).toMatchObject({ blocked: false, remainingActions: 0 });
  });
});

describe('LocalTrialStore — time mode', () => {
  const config: TrialConfig = { mode: 'time', payload: 24, storage: 'client' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T10:00:00Z'));
  });

  it('first check before recordBlock: blocked=true, startedAt=null', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, config);
    const s = await store.check();
    expect(s).toMatchObject({
      mode: 'time',
      blocked: true,
      startedAt: null,
      expiresAt: null,
      remainingMs: 24 * 60 * 60 * 1000
    });
  });

  it('recordBlock writes startedAt once and is idempotent', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, config);
    const s1 = (await store.recordBlock()) as TimeTrialStatus;
    expect(s1.startedAt).toBe(Date.now());
    expect(s1.blocked).toBe(true);

    vi.advanceTimersByTime(60 * 60 * 1000); // +1h
    const s2 = (await store.recordBlock()) as TimeTrialStatus;
    // startedAt не перезаписался — окно триала зафиксировано первым open()
    expect(s2.startedAt).toBe(s1.startedAt);
    expect(s2.remainingMs).toBe(23 * 60 * 60 * 1000);
  });

  it('expires after payload hours', async () => {
    const store = new LocalTrialStore(memoryAdapter(), PAYWALL, config);
    await store.recordBlock();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    const s = await store.check();
    expect(s).toMatchObject({ blocked: false, remainingMs: 0 });
  });

  it('reads v2 storage key (legacy compat)', async () => {
    const adapter = memoryAdapter();
    const past = Date.now() - 5 * 60 * 60 * 1000; // 5h ago
    await adapter.setItem(`paywall-${PAYWALL}-trial-time-first-open`, String(past));
    const store = new LocalTrialStore(adapter, PAYWALL, config);
    const s = await store.check();
    expect(s).toMatchObject({
      blocked: true,
      startedAt: past,
      remainingMs: 19 * 60 * 60 * 1000
    });
  });
});
