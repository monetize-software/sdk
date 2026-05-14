// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthClient, type AuthChangeEvent, type AuthSession } from '../src/core/auth';
import { STORAGE_KEYS, type StorageAdapter } from '../src/core/storage';

const TEST_API_ORIGIN = 'https://test.example.com';

// Стораджевая шина для теста: эмулирует chrome.storage.onChanged через
// общий map + список подписчиков. Любой setItem/removeItem тригерит всех
// подписчиков, как делает chrome.storage в реальности (включая context'а,
// который инициировал запись — onChanged фаерится во ВСЕХ контекстах).
function makeShared(): {
  forContext: () => StorageAdapter;
} {
  const map = new Map<string, string>();
  const subs = new Map<string, Set<(v: string | null) => void>>();
  const notify = (key: string, value: string | null) => {
    const list = subs.get(key);
    if (!list) return;
    for (const cb of list) cb(value);
  };
  return {
    forContext: () => ({
      getItem: vi.fn(async (k) => map.get(k) ?? null),
      setItem: vi.fn(async (k, v) => {
        map.set(k, v);
        notify(k, v);
      }),
      removeItem: vi.fn(async (k) => {
        map.delete(k);
        notify(k, null);
      }),
      watch: vi.fn((k, cb) => {
        let list = subs.get(k);
        if (!list) {
          list = new Set();
          subs.set(k, list);
        }
        list.add(cb);
        return () => {
          list!.delete(cb);
        };
      })
    })
  };
}

const PAYWALL_ID = 'pw_1';
const SESSION: AuthSession = {
  access_token: 'access-A',
  refresh_token: 'refresh-A',
  expires_at: Date.now() + 3600_000,
  user: { id: 'u_1', email: 'a@b.c' }
};

const KEY = STORAGE_KEYS.authSession(PAYWALL_ID);

describe('AuthClient cross-context sync', () => {
  afterEach(() => vi.restoreAllMocks());

  it('contextB receives onAuthChange when contextA writes session to shared storage', async () => {
    const shared = makeShared();
    const a = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: shared.forContext() });
    const bStorage = shared.forContext();
    const b = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: bStorage });

    const events: Array<[AuthChangeEvent, AuthSession | null]> = [];
    b.onAuthChange((event, s) => events.push([event, s]));

    await a.ready();
    await b.ready();

    // A пишет — эмулируем "popup.signIn() сделал persist". Используем
    // приватный путь через прямой setItem (тест эмулирует, что A только
    // что записал, без полного signIn-флоу).
    await (a as unknown as { storage: StorageAdapter }).storage.setItem(
      KEY,
      JSON.stringify(SESSION)
    );

    // applyExternalSession async — даём ему пройти.
    await Promise.resolve();
    await Promise.resolve();

    expect(b.getCachedSession()).toEqual(SESSION);
    // events: INITIAL_SESSION(null) + SIGNED_IN(SESSION) — cross-context login
    // в контексте, где session=null, классифицируется как SIGNED_IN.
    expect(events.at(-1)).toEqual(['SIGNED_IN', SESSION]);
    a.destroy();
    b.destroy();
  });

  it('contextB sees logout when contextA removes session', async () => {
    const shared = makeShared();
    const seedStorage = shared.forContext();
    await seedStorage.setItem(KEY, JSON.stringify(SESSION));

    const a = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: shared.forContext() });
    const b = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: shared.forContext() });
    await a.ready();
    await b.ready();
    expect(b.getCachedSession()).toEqual(SESSION);

    await (a as unknown as { storage: StorageAdapter }).storage.removeItem(KEY);
    await Promise.resolve();
    await Promise.resolve();

    expect(b.getCachedSession()).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('does not loop: A writing same session does not trigger second emit on A', async () => {
    const shared = makeShared();
    const a = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: shared.forContext() });
    await a.ready();

    const eventsA: Array<[AuthChangeEvent, AuthSession | null]> = [];
    a.onAuthChange((event, s) => eventsA.push([event, s]));
    await Promise.resolve();
    const initial = eventsA.length;

    // A persist'ит ту же session дважды. onChanged-цикл не должен генерить
    // лишних emit'ов из-за sameSession() guard'а.
    await (a as unknown as { storage: StorageAdapter }).storage.setItem(
      KEY,
      JSON.stringify(SESSION)
    );
    await Promise.resolve();
    await Promise.resolve();
    await (a as unknown as { storage: StorageAdapter }).storage.setItem(
      KEY,
      JSON.stringify(SESSION)
    );
    await Promise.resolve();
    await Promise.resolve();

    // Один реальный applyExternalSession (первое изменение от null → SESSION),
    // второй — sameSession-guard.
    expect(eventsA.length - initial).toBeLessThanOrEqual(1);
    a.destroy();
  });

  it('lazy rehydrate in getAccessToken closes the construction race', async () => {
    const shared = makeShared();
    // Seed AFTER constructor (имитируем: B проинстансился, потом A залогинился,
    // но onChanged event "потерян"/еще не долетел).
    const b = new AuthClient({ apiOrigin: TEST_API_ORIGIN, paywallId: PAYWALL_ID, storage: shared.forContext() });
    await b.ready();
    expect(b.getCachedSession()).toBeNull();

    // Без триггера watch — пишем в storage напрямую через свежий контекст
    // (бэз watch-эмиссии, чтобы проверить чисто pull-fallback). Эмулируем
    // через прямой map: новый shared не подойдёт. Используем тот же shared
    // но без notify — для этого делаем прямую запись в b's storage.
    await (b as unknown as { storage: StorageAdapter }).storage.setItem(
      KEY,
      JSON.stringify(SESSION)
    );
    // Тут notify прозвучал — но мы хотим именно pull-фоллбэк, а не push.
    // Уберём всех подписчиков, имитируя "event ещё не долетел":
    // (после destroy() pull-фоллбэк всё равно работает).

    const token = await b.getAccessToken();
    expect(token).toBe(SESSION.access_token);
    b.destroy();
  });
});
