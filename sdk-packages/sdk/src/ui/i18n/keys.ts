/**
 * The full list of bundled static-translations languages. Each key corresponds
 * to a file in `./locales/<key>.ts`, which Vite splits into a separate chunk
 * (`chunks/<key>-[hash].js`).
 *
 * The order mirrors legacy `online/lang/static-translations.ts`: 27 languages,
 * parity with the paywall on the old stack. EN is the fallback, always inline in
 * the main chunk, and is not in this list.
 */
export const BUNDLED_LOCALES = [
  'ru',
  'uk',
  'de',
  'es',
  'fr',
  'it',
  'pt',
  'pl',
  'cs',
  'hu',
  'ro',
  'nl',
  'sv',
  'da',
  'no',
  'fi',
  'el',
  'tr',
  'id',
  'ar',
  'ja',
  'ko',
  'zh',
  'hi',
  'th',
  'vi',
  'he'
] as const;

export type BundledLocale = (typeof BUNDLED_LOCALES)[number];

/** Translation dictionary: key → string. May contain `{param}` placeholders,
 *  which `t()` fills via its second argument. A missing key → fallback from the
 *  inline call `t(key, fallback)`. */
export type TranslationDict = Record<string, string>;

/** Signature of the translator function. The inline fallback is mandatory, so EN
 *  works even without a loaded chunk and when the key is missing from the dictionary. */
export type TFn = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>
) => string;
