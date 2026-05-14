export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Опционально: подписка на изменение `key` извне (другая вкладка /
   * background-контекст extension'а). Возвращает unsubscribe.
   *
   * Контракт callback'а:
   *  - `value` — новое значение (string) или `null` (удалили / нет).
   *  - Вызывается ТОЛЬКО для cross-context изменений; собственный setItem
   *    / removeItem callback дёргать НЕ обязан (для chrome.storage.onChanged
   *    он дёрнется и так — потребитель обязан фильтровать сам).
   *
   * Адаптеры без поддержки (memory) опускают это поле, потребитель должен
   * проверять `typeof storage.watch === 'function'`.
   */
  watch?(key: string, cb: (value: string | null) => void): () => void;
}

interface ChromeStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

declare const chrome: {
  storage?: {
    local?: {
      get(keys: string[], cb: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, cb?: () => void): void;
      remove(keys: string[], cb?: () => void): void;
    };
    onChanged?: {
      addListener(
        cb: (changes: Record<string, ChromeStorageChange>, area: string) => void
      ): void;
      removeListener(
        cb: (changes: Record<string, ChromeStorageChange>, area: string) => void
      ): void;
    };
  };
  runtime?: { id?: string };
} | undefined;

function hasChromeStorage(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome?.storage?.local &&
    !!chrome?.runtime?.id
  );
}

const chromeLocal: StorageAdapter = {
  getItem(key) {
    return new Promise((resolve) => {
      chrome!.storage!.local!.get([key], (items) => {
        const v = items[key];
        resolve(typeof v === 'string' ? v : null);
      });
    });
  },
  setItem(key, value) {
    return new Promise((resolve) => {
      chrome!.storage!.local!.set({ [key]: value }, () => resolve());
    });
  },
  removeItem(key) {
    return new Promise((resolve) => {
      chrome!.storage!.local!.remove([key], () => resolve());
    });
  },
  watch(key, cb) {
    const onChanged = chrome?.storage?.onChanged;
    if (!onChanged) return () => {};
    // chrome.storage.onChanged fires across все контексты расширения
    // (popup / background / options / content script с storage-permission).
    // Для popup'а и background'а подписка идёт на один и тот же event
    // emitter; defence через own-write filter — на стороне consumer'а
    // (AuthClient сравнит content hash).
    const handler = (
      changes: Record<string, ChromeStorageChange>,
      area: string
    ) => {
      if (area !== 'local') return;
      const change = changes[key];
      if (!change) return;
      cb(typeof change.newValue === 'string' ? change.newValue : null);
    };
    onChanged.addListener(handler);
    return () => onChanged.removeListener(handler);
  }
};

const webLocal: StorageAdapter = {
  async getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* quota / disabled */
    }
  },
  async removeItem(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  watch(key, cb) {
    if (typeof window === 'undefined') return () => {};
    // Native `storage` event фаерится только в ДРУГИХ вкладках того же
    // origin'а — собственная вкладка свой setItem не получает (это и нужно
    // для cross-tab sync, без петель).
    const handler = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage) return;
      if (e.key !== key) return;
      cb(e.newValue);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }
};

const memoryMap = new Map<string, string>();
const memoryLocal: StorageAdapter = {
  async getItem(key) {
    return memoryMap.get(key) ?? null;
  },
  async setItem(key, value) {
    memoryMap.set(key, value);
  },
  async removeItem(key) {
    memoryMap.delete(key);
  }
};

export function createStorage(override?: StorageAdapter): StorageAdapter {
  if (override) return override;
  if (hasChromeStorage()) return chromeLocal;
  if (typeof window !== 'undefined' && 'localStorage' in window) return webLocal;
  return memoryLocal;
}

export const STORAGE_KEYS = {
  visitorId: 'pw-visitor-id',
  lastLoginMethod: (paywallId: string) => `pw-${paywallId}-last-login-method`,
  lastLoginEmail: (paywallId: string) => `pw-${paywallId}-last-login-email`,
  // last-known PaywallUser. Используется как offline-fallback на старте, пока
  // первый getUser() не вернётся. Ключ зависит от paywallId+identity hash —
  // переключение identity не должно отдавать чужой user.
  userState: (paywallId: string, identityKey: string) =>
    `pw-${paywallId}-${identityKey}-user-v1`,
  // Persisted auth bundle (access_token, refresh_token, expires_at, user) для
  // одного пейвола. Ключ привязан к paywallId — мульти-пейвольное приложение
  // не пересекает сессии. Bump '-v1' на breaking shape change.
  authSession: (paywallId: string) => `pw-${paywallId}-auth-v1`,
  // Refresh-token последнего анонимного юзера. Хранится отдельно от authSession,
  // потому что должен пережить signOut: после signOut() юзер может опять
  // зайти как тот же аноним — без капчи, через этот токен. signIn другим
  // методом (email/oauth) тоже его не трогает. Чистится только явным
  // signOut({forgetAnonymous: true}) или 401 от refresh-эндпоинта (значит
  // токен отозван, дальше держать бессмысленно).
  anonRefreshToken: (paywallId: string) => `pw-${paywallId}-anon-rt-v1`,
  // Persisted bootstrap (settings/prices/offers/layout/locales/version) для
  // stale-while-revalidate. Не зависит от identity — layout одинаков для всех
  // юзеров одного пейвола; user-state живёт отдельно под `userState(...)`.
  // Bump '-v1' на breaking shape change.
  bootstrap: (paywallId: string) => `pw-${paywallId}-bootstrap-v1`,
  // Persisted balances (AI-провайдеры × tokenization_queries). Identity-bound,
  // т.к. balance считается per-Bearer-юзеру; при re-login ключ меняется и
  // чужие balances не видны. Меняются после оплаты (бэк) и API-вызовов
  // (оптимистично через `decrementBalanceLocal`).
  balances: (paywallId: string, identityKey: string) =>
    `pw-${paywallId}-${identityKey}-balances-v1`
};

// UUID v4 — stable visitor identifier для аналитики. Не PII, не привязан к
// identity/email. Используется в EventTracker. Fallback на Math.random нужен
// для старых рантаймов без crypto.randomUUID (редко, но бывает в e2e-моках).
export function generateVisitorId(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Резолвит stable visitor_id: читает из storage по ключу STORAGE_KEYS.visitorId,
// генерит и сохраняет если его там нет. Promise — потому что storage async
// (chrome.storage.local — callback-based).
export async function ensureVisitorId(storage: StorageAdapter): Promise<string> {
  try {
    const existing = await storage.getItem(STORAGE_KEYS.visitorId);
    if (existing && typeof existing === 'string' && existing.length >= 16) return existing;
  } catch {
    /* fall through to generation */
  }
  const id = generateVisitorId();
  try {
    await storage.setItem(STORAGE_KEYS.visitorId, id);
  } catch {
    /* quota / disabled — id всё равно используем в этой сессии */
  }
  return id;
}
