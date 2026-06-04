export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Optional: subscribe to external changes of `key` (another tab /
   * the extension's background context). Returns an unsubscribe function.
   *
   * Callback contract:
   *  - `value` — the new value (string) or `null` (removed / absent).
   *  - Called ONLY for cross-context changes; it is NOT required to fire on
   *    the own setItem / removeItem callback (for chrome.storage.onChanged it
   *    fires anyway — the consumer must filter it out itself).
   *
   * Adapters without support (memory) omit this field; the consumer must
   * check `typeof storage.watch === 'function'`.
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
    // chrome.storage.onChanged fires across all extension contexts
    // (popup / background / options / content script with storage-permission).
    // For the popup and background the subscription goes to the same event
    // emitter; the defence via own-write filter is on the consumer side
    // (AuthClient compares the content hash).
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
    // The native `storage` event fires only in OTHER tabs of the same
    // origin — the own tab does not receive its own setItem (which is exactly
    // what we want for cross-tab sync, without loops).
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
  // last-known PaywallUser. Used as an offline fallback on startup, until the
  // first getUser() returns. The key depends on paywallId+identity hash —
  // switching identity must not hand back another user.
  userState: (paywallId: string, identityKey: string) =>
    `pw-${paywallId}-${identityKey}-user-v1`,
  // Persisted auth bundle (access_token, refresh_token, expires_at, user) for
  // a single paywall. The key is tied to paywallId — a multi-paywall app
  // doesn't cross sessions. Bump '-v1' on a breaking shape change.
  authSession: (paywallId: string) => `pw-${paywallId}-auth-v1`,
  // Refresh token of the last anonymous user. Stored separately from
  // authSession, because it must survive signOut: after signOut() the user can
  // sign in again as the same anonymous — without a captcha, via this token.
  // signIn by another method (email/oauth) doesn't touch it either. Cleared
  // only by an explicit signOut({forgetAnonymous: true}) or a 401 from the
  // refresh endpoint (meaning the token was revoked, so there's no point
  // keeping it).
  anonRefreshToken: (paywallId: string) => `pw-${paywallId}-anon-rt-v1`,
  // Persisted bootstrap (settings/prices/offers/layout/locales/version) for
  // stale-while-revalidate. Independent of identity — the layout is the same
  // for all users of one paywall; user-state lives separately under
  // `userState(...)`. Bump '-v1' on a breaking shape change.
  bootstrap: (paywallId: string) => `pw-${paywallId}-bootstrap-v1`,
  // Persisted balances (AI providers × tokenization_queries). Identity-bound,
  // since balance is counted per-Bearer-user; on re-login the key changes and
  // other users' balances aren't visible. They change after payment (backend)
  // and API calls (optimistically via `decrementBalanceLocal`).
  balances: (paywallId: string, identityKey: string) =>
    `pw-${paywallId}-${identityKey}-balances-v1`
};

// UUID v4 — a stable visitor identifier for analytics. Not PII, not tied to
// identity/email. Used in EventTracker. The fallback to Math.random is needed
// for old runtimes without crypto.randomUUID (rare, but happens in e2e mocks).
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

// Resolves a stable visitor_id: reads it from storage by the
// STORAGE_KEYS.visitorId key, generates and saves it if absent. A Promise
// because storage is async (chrome.storage.local is callback-based).
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
    /* quota / disabled — we use the id in this session anyway */
  }
  return id;
}
