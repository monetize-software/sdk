/**
 * Static-translations для UI-chrome SDK v3. Legacy-аналог —
 * `online/components/StaticTranslationContext.tsx` + `online/lang/static-translations.ts`.
 *
 * Архитектура:
 *  - EN захардкожен fallback'ом в самих компонентах (`t('auth.welcome', 'Welcome back!')`).
 *    Если чанк не загрузился — UI на английском, без пустых строк.
 *  - Не-EN языки — отдельные модули `./locales/<key>.ts`. Vite разносит их в
 *    `chunks/<key>-[hash].js`, динамический import грузит один чанк
 *    по resolved-locale.
 *  - Owner-controlled `bootstrap.locales` (layout/prices оверрайды) — независимая
 *    система; static-чанк применяется только если у owner'а вообще есть
 *    переводы (`when-configured` режим, как в legacy). Без translation-intent
 *    у пейвола показывается чистый EN, даже если в SDK есть `de.ts`.
 *  - Чанк грузится в фоне, **не блокирует** `bootstrap()`. До прибытия —
 *    UI на EN; на arrival провайдер форсит re-render через context-update.
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

/** Простая подстановка `{name}` → value. Не делает escape — все строки уходят
 *  в textContent через preact, XSS невозможен. */
function format(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/** Кеш загруженных словарей, чтобы переоткрытие пейвола не ходило за чанком
 *  повторно (Vite кеширует module внутри себя, но cache на нашей стороне
 *  избавляет от микро-затыка в Promise-цепочке). */
const dictCache = new Map<BundledLocale, TranslationDict>();

/** Inflight-load'ы, чтобы конкурентные mount'ы (виджет + popup) делили один
 *  динамический import вместо двух параллельных. */
const inflight = new Map<BundledLocale, Promise<TranslationDict>>();

function isBundledLocale(key: string): key is BundledLocale {
  return (BUNDLED_LOCALES as readonly string[]).includes(key);
}

/** Подбирает встроенный язык по тому же алгоритму, что owner-overrides
 *  (`pickLocaleKey` в BillingClient): `navigator.language` → base-tag →
 *  `settings.locale_default`. Возвращает первый ключ, для которого у нас
 *  есть чанк в `BUNDLED_LOCALES`. EN не возвращаем — это inline fallback,
 *  загружать ничего не надо. */
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

/** Mode='when-configured' (как legacy): static применяется только если у
 *  owner'а есть хоть один локаль-оверрайд в `bootstrap.locales`. Это маркер
 *  «пейвол i18n-aware» — без него тянуть static нет смысла (host рисует
 *  английский UI вокруг, перевод модалки выглядит инородно). */
export function hasOwnerTranslations(bootstrap: PaywallBootstrap): boolean {
  return !!bootstrap.locales && Object.keys(bootstrap.locales).length > 0;
}

/** Грузит словарь для указанного языка. Идемпотентно: повторные вызовы
 *  отдают тот же кешированный Promise. На сетевой/импорт-ошибке резолвится
 *  пустым словарём (UI останется на EN-fallback'ах) — пейвол не должен
 *  падать из-за недоступного locale-чанка. */
export async function loadLocale(key: BundledLocale): Promise<TranslationDict> {
  const cached = dictCache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  // Vite разносит этот dynamic import по chunkFileNames из vite.config.ts.
  // Шаблонная строка нужна, чтобы bundler сгенерил все 27 чанков; статичный
  // import('./locales/${key}.ts') без шаблона свернётся в один файл.
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
  /** PaywallBootstrap, по которому резолвится язык. null/undefined — провайдер
   *  работает в чистом EN-fallback режиме, чанк не грузится. */
  bootstrap: PaywallBootstrap | null | undefined;
  /** Explicit-override: форсит выбор языка минуя navigator.language и
   *  owner-translations check. Используется live-preview редактором админки
   *  («Preview as user from <country>») — там browser-locale всегда EN, а
   *  bootstrap.locales может быть пустым (форма ещё не сохранена). Передавай
   *  только bundled-ключи из `BUNDLED_LOCALES` — иначе fallback на обычный
   *  путь резолвинга. */
  forceLocale?: string | null;
  children: ComponentChildren;
}

/**
 * Mount'ит provider, резолвит язык по bootstrap'у и асинхронно тянет чанк.
 * До прибытия чанка t() отдаёт fallback'и из inline-вызовов (EN). После —
 * setState триггерит re-render всех consumer'ов.
 *
 * Bootstrap может прийти позже (loading state в PaywallRoot) — useEffect
 * запустится на bootstrap-change и подхватит. Bootstrap может смениться
 * (revalidate подтянул другие locales/locale_default) — useEffect разрулит:
 * если resolved key изменился, грузим новый чанк, иначе остаёмся на текущем.
 */
export function I18nProvider({ bootstrap, forceLocale, children }: I18nProviderProps) {
  const [locale, setLocale] = useState<string>('en');
  const [dict, setDict] = useState<TranslationDict | null>(null);

  useEffect(() => {
    // Explicit-override: preview-режим админки. Грузим напрямую — owner-check
    // и navigator.language игнорируем (browser-locale в админке всегда EN).
    const explicit = forceLocale && isBundledLocale(forceLocale) ? forceLocale : null;
    const key = explicit ?? (() => {
      if (!bootstrap) return null;
      if (!hasOwnerTranslations(bootstrap)) return null;
      return pickStaticLocaleKey(bootstrap);
    })();

    // Нет резолва (или explicit=null в preview при возврате на EN-страну) —
    // откатываемся на canonical-EN fallback из inline t()-вызовов. Без сброса
    // старый dict остаётся в state и UI остаётся переведённым на предыдущий
    // язык — это и был баг live-preview при переключении со RU обратно на US.
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

/** Хук для блоков: `const { t } = useI18n(); t('auth.welcome', 'Welcome back!')`.
 *  Вне I18nProvider'а возвращает defaultT (EN-fallback) — позволяет блокам
 *  рендериться в тестах/preview без обязательного wrapper'а. */
export function useI18n(): I18nContextValue {
  return useContext(I18nCtx);
}

export type { TFn, TranslationDict, BundledLocale };
export { BUNDLED_LOCALES };
