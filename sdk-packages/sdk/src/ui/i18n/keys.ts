/**
 * Полный список встроенных static-translations языков. Каждый ключ
 * соответствует файлу в `./locales/<key>.ts`, который Vite разносит в
 * отдельный chunk (`chunks/<key>-[hash].js`).
 *
 * Порядок зеркалит legacy `online/lang/static-translations.ts`: 27 языков,
 * паритет с пейволом на старом стеке. EN — fallback, всегда inline в
 * основной чанк, в этом списке его нет.
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

/** Словарь переводов: ключ → строка. Может содержать `{param}` placeholder'ы,
 *  которые заполняет `t()` через второй аргумент. Отсутствующий ключ → fallback
 *  из inline-вызова `t(key, fallback)`. */
export type TranslationDict = Record<string, string>;

/** Сигнатура translator-функции. Inline fallback — обязательный, чтобы EN
 *  работал даже без загруженного чанка и при отсутствии ключа в словаре. */
export type TFn = (
  key: string,
  fallback: string,
  params?: Record<string, string | number>
) => string;
