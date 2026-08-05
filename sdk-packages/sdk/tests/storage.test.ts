import { describe, it, expect } from 'vitest';
import {
  createStorage,
  ensureVisitorId,
  STORAGE_KEYS,
  type StorageAdapter
} from '../src/core/storage';

// Node context (no `window`): a server SDK process serves many users at once.
// The backend treats a shared visitor_id as "same device" and, on sign-in,
// re-attributes guest purchases made under it — so a process-wide visitor_id
// would let every login inherit the previous users' purchases.
describe('createStorage without window (server SDK)', () => {
  it('does not share state between clients', async () => {
    const first = createStorage();
    const second = createStorage();

    await first.setItem(STORAGE_KEYS.visitorId, 'visitor-of-the-first-client');

    expect(await second.getItem(STORAGE_KEYS.visitorId)).toBeNull();
    expect(await first.getItem(STORAGE_KEYS.visitorId)).toBe(
      'visitor-of-the-first-client'
    );
  });

  it('gives every client its own visitor_id', async () => {
    const first = await ensureVisitorId(createStorage());
    const second = await ensureVisitorId(createStorage());

    expect(first).not.toBe(second);
  });

  it('keeps visitor_id stable within one client', async () => {
    const storage = createStorage();

    expect(await ensureVisitorId(storage)).toBe(await ensureVisitorId(storage));
  });

  it('still prefers an explicitly passed adapter', async () => {
    const map = new Map<string, string>();
    const override: StorageAdapter = {
      async getItem(key) {
        return map.get(key) ?? null;
      },
      async setItem(key, value) {
        map.set(key, value);
      },
      async removeItem(key) {
        map.delete(key);
      }
    };

    await ensureVisitorId(createStorage(override));

    expect(map.get(STORAGE_KEYS.visitorId)).toBeTruthy();
  });
});
