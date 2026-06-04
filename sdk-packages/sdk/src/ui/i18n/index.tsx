/**
 * Static-translations for the SDK v3 UI chrome. The legacy counterpart is
 * `online/components/StaticTranslationContext.tsx` + `online/lang/static-translations.ts`.
 *
 * Architecture:
 *  - EN is hardcoded as a fallback in the components themselves (`t('auth.welcome', 'Welcome back!')`).
 *    If the chunk didn't load — the UI is in English, with no empty strings.
 *  - Non-EN languages are separate modules `./locales/<key>.ts`. Vite splits them
 *    into `chunks/<key>-[hash].js`; the dynamic import loads a single chunk
 *    for the resolved locale.
 *  - Owner-controlled `bootstrap.locales` (layout/prices overrides) is an
 *    independent system; the static chunk is applied only if the owner has any
 *    translations at all (`when-configured` mode, as in legacy). Without
 *    translation intent, the paywall shows plain EN, even if the SDK has `de.ts`.
 *  - The chunk loads in the background and **does not block** `bootstrap()`. Until
 *    it arrives — the UI is in EN; on arrival the provider forces a re-render via
 *    a context update.
 */
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import { BUNDLED_LOCALES, type BundledLocale, type TFn, type TranslationDict } from './keys';
import type { PaywallBootstrap } from '../../core/types';

interface I18nContextValue {
  t: TFn;
  locale: string;
}

const defaultT: TFn = (_key, fallback, params) => format(fallback, params);

const I18nCtx = createContext<I18nContextValue>({ t: defaultT, locale: 'en' });

/** Simple `{name}` → value substitution. Does not escape — all strings go into
 *  textContent via preact, so XSS is impossible. */
function format(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/** Cache of loaded dictionaries, so reopening the paywall doesn't fetch the chunk
 *  again (Vite caches the module internally, but a cache on our side avoids a
 *  micro-stall in the Promise chain). */
const dictCache = new Map<BundledLocale, TranslationDict>();

/** Inflight loads, so concurrent mounts (widget + popup) share a single dynamic
 *  import instead of two parallel ones. */
const inflight = new Map<BundledLocale, Promise<TranslationDict>>();

function isBundledLocale(key: string): key is BundledLocale {
  return (BUNDLED_LOCALES as readonly string[]).includes(key);
}

/** Picks the bundled language using the same algorithm as owner-overrides
 *  (`pickLocaleKey` in BillingClient): `navigator.language` → base tag →
 *  `settings.locale_default`. Returns the first key for which we have a chunk
 *  in `BUNDLED_LOCALES`. We don't return EN — that's the inline fallback,
 *  nothing needs to be loaded. */
export function pickStaticLocaleKey(bootstrap: PaywallBootstrap): BundledLocale | null {
  const candidates: string[] = [];
  if (typeof navigator !== 'undefined' && navigator.language) {
    candidates.push(navigator.language);
    const base = navigator.language.split('-')[0];
    if (base && base !== navigator.language) candidates.push(base);
  }
  const fallback = bootstrap.settings.locale_default;
  if (fallback) {
    candidates.push(fallback);
    const base = fallback.split('-')[0];
    if (base && base !== fallback) candidates.push(base);
  }
  for (const c of candidates) {
    if (isBundledLocale(c)) return c;
  }
  return null;
}

/** Mode='when-configured': static is applied only if the owner has a
 *  dynamic override **specifically for the resolved locale**. Without this, the
 *  user would see a mix — static UI in nl + dynamic content (heading/features/banner)
 *  in canonical EN, because the admin only translated to ru. Users in locales
 *  without overrides get plain EN UI + EN content. */
export function hasOwnerTranslationsFor(
  bootstrap: PaywallBootstrap,
  locale: string
): boolean {
  return !!bootstrap.locales && bootstrap.locales[locale] !== undefined;
}

/** Loads the dictionary for the given language. Idempotent: repeated calls
 *  return the same cached Promise. On a network/import error it resolves with
 *  an empty dictionary (the UI stays on the EN fallbacks) — the paywall must
 *  not crash because of an unavailable locale chunk. */
export async function loadLocale(key: BundledLocale): Promise<TranslationDict> {
  const cached = dictCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  // Vite splits this dynamic import by chunkFileNames from vite.config.ts.
  // The template string is needed so the bundler generates all 27 chunks; a
  // static import('./locales/${key}.ts') without a template would collapse into one file.
  const promise = import(`./locales/${key}.ts`)
    .then((mod: { default: TranslationDict }) => {
      const dict = mod.default ?? {};
      dictCache.set(key, dict);
      return dict;
    })
    .catch((err) => {
      console.warn(`[paywall] failed to load locale chunk "${key}"`, err);
      const empty: TranslationDict = {};
      dictCache.set(key, empty);
      return empty;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

interface I18nProviderProps {
  /** The PaywallBootstrap by which the language is resolved. null/undefined — the
   *  provider works in pure EN-fallback mode, the chunk is not loaded. */
  bootstrap: PaywallBootstrap | null | undefined;
  /** Explicit override: forces the language choice, bypassing navigator.language
   *  and the owner-translations check. Used by the admin's live-preview editor
   *  ("Preview as user from <country>") — there the browser locale is always EN, and
   *  bootstrap.locales may be empty (the form isn't saved yet). Pass only bundled
   *  keys from `BUNDLED_LOCALES` — otherwise it falls back to the normal
   *  resolution path. */
  forceLocale?: string | null;
  children: ComponentChildren;
}

/**
 * Mounts the provider, resolves the language from the bootstrap, and fetches the
 * chunk asynchronously. Until the chunk arrives, t() returns the fallbacks from
 * the inline calls (EN). After — setState triggers a re-render of all consumers.
 *
 * The bootstrap may arrive later (loading state in PaywallRoot) — the useEffect
 * runs on bootstrap change and picks it up. The bootstrap may change (revalidate
 * pulled different locales/locale_default) — the useEffect handles it: if the
 * resolved key changed, we load the new chunk, otherwise we stay on the current one.
 */
export function I18nProvider({ bootstrap, forceLocale, children }: I18nProviderProps) {
  const [locale, setLocale] = useState<string>('en');
  const [dict, setDict] = useState<TranslationDict | null>(null);

  useEffect(() => {
    // Explicit override: the admin's preview mode. We load directly — we ignore
    // the owner-check and navigator.language (the browser locale in the admin is always EN).
    const explicit = forceLocale && isBundledLocale(forceLocale) ? forceLocale : null;
    const key = explicit ?? (() => {
      if (!bootstrap) return null;
      const resolved = pickStaticLocaleKey(bootstrap);
      if (!resolved) return null;
      // Per-locale gate: we load static only if there's a dynamic override for
      // the resolved locale. Otherwise fall back to EN — without a mix of NL
      // static + EN dynamic content.
      if (!hasOwnerTranslationsFor(bootstrap, resolved)) return null;
      return resolved;
    })();

    // No resolution (or explicit=null in preview when switching back to an EN
    // country) — we roll back to the canonical-EN fallback from the inline t()
    // calls. Without the reset, the old dict stays in state and the UI stays
    // translated to the previous language — that was exactly the live-preview
    // bug when switching from RU back to US.
    if (!key) {
      if (dict !== null || locale !== 'en') {
        setLocale('en');
        setDict(null);
      }
      return;
    }
    if (key === locale && dict) return;

    let cancelled = false;
    void loadLocale(key).then((d) => {
      if (cancelled) return;
      setLocale(key);
      setDict(d);
    });
    return () => {
      cancelled = true;
    };
  }, [bootstrap, forceLocale]);

  const value: I18nContextValue = {
    locale,
    t: dict
      ? (key, fallback, params) => format(dict[key] ?? fallback, params)
      : defaultT
  };

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

/** Hook for blocks: `const { t } = useI18n(); t('auth.welcome', 'Welcome back!')`.
 *  Outside an I18nProvider it returns defaultT (EN fallback) — allowing blocks to
 *  render in tests/preview without a mandatory wrapper. */
export function useI18n(): I18nContextValue {
  return useContext(I18nCtx);
}

export type { TFn, TranslationDict, BundledLocale };
export { BUNDLED_LOCALES };
