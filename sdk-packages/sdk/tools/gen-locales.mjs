#!/usr/bin/env node
/**
 * Генератор static-translations для SDK v3. Два источника:
 *  1. Legacy `online/lang/static-translations.ts` (KEY_MAP портирует ключи
 *     с легаси-схемы на v3).
 *  2. `sdk-translations.mjs` (SDK-specific строки, для которых нет легаси).
 *
 * SDK-translations имеют приоритет над legacy при конфликте — это нужно
 * чтобы можно было переопределить кривой legacy-перевод
 * (например `pricing.included_per` для JA/KO/ZH).
 *
 * Использование: `node tools/gen-locales.mjs`
 *
 * Скрипт безопасный: только пишет в `src/ui/i18n/locales/*.ts`. Canonical EN
 * (`src/ui/i18n/canonical-en.ts`) НЕ трогается — source of truth,
 * поддерживается вручную.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_TRANSLATIONS } from './sdk-translations.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const LEGACY_PATH = resolve(REPO_ROOT, 'online/lang/static-translations.ts');
const OUT_DIR = resolve(__dirname, '../src/ui/i18n/locales');

// Маппинг legacy-ключей → SDK v3 ключей. Только те, где смысл совпадает.
// Если legacy-ключа нет в этой таблице — он игнорируется (legacy-онли
// фичи: portal/attachments/overpay/captcha/checkout/finish). Если v3-ключа
// нет в legacy — он останется на EN-fallback'е inline'ом в блоке.
const KEY_MAP = {
  // === modal / support ===
  'modal.support': 'support.heading',

  // === pricing intervals (TokenizationGate "Included per X") ===
  'pricing.interval.week': 'pricing.interval.week',
  'pricing.interval.month': 'pricing.interval.month',
  'pricing.interval.year': 'pricing.interval.year',
  // pricing.included_per: legacy дала только префикс ("Включено за"), v3
  // склеивает с интервалом и двоеточием в одном tфразе. Post-transform
  // ниже добавляет " {interval}:" — корректно для языков с суффиксом
  // (en/ru/de/es/...). Для языков с порядком "{interval}に含まれる" (ja/ko/zh)
  // лучше править вручную после регенерации.
  'pricing.included_per': 'pricing.included_per',

  // === pricing plan labels (PriceGrid header — legacy ключи в singular) ===
  'pricing.plan_label.week': 'pricing.plan_label.weekly',
  'pricing.plan_label.month': 'pricing.plan_label.monthly',
  'pricing.plan_label.year': 'pricing.plan_label.yearly',
  'pricing.plan_label.lifetime': 'pricing.plan_label.lifetime',

  // === pricing money-back guarantee ===
  'pricing.money_back': 'pricing.money_back',

  // === pricing — start trial (interpolation {days}) ===
  'pricing.start_trial': 'cta.start_trial',

  // === payment-awaiting "Ожидание оплаты..." ===
  'pricing.waiting_payment': 'payment.awaiting_title',

  // === auth — OAuth ===
  'auth.continue_with_google': 'auth.continue_with_google',
  'auth.continue_with_apple': 'auth.continue_with_apple',

  // === auth — form fields ===
  'auth.email': 'auth.email',
  'auth.password': 'auth.password',
  'auth.repeat_password': 'auth.repeat_password',

  // === auth — buttons/links ===
  'auth.log_in': 'auth.log_in',
  'auth.sign_up': 'auth.sign_up',
  'auth.send_reset': 'auth.send_reset',
  'auth.forgot_password': 'auth.forgot_password',
  'auth.sign_up_link': 'auth.sign_up_link',
  'auth.log_in_link': 'auth.log_in_link',
  'auth.no_account': 'auth.no_account',
  'auth.have_account': 'auth.have_account',
  'auth.or': 'auth.or',

  // === auth — headings ===
  'auth.welcome': 'auth.welcome',
  'auth.default_subtitle': 'auth.default_subtitle',
  'auth.forgot_password_title': 'auth.forgot_password_title',
  'auth.forgot_subtitle': 'auth.forgot_subtitle',
  'auth.check_inbox': 'auth.check_email_title',

  // === auth — messages ===
  'auth.passwords_mismatch': 'auth.passwords_mismatch',

  // === auth gate (intent: restore / preauth) ===
  'auth.restore_purchases': 'auth.restore_purchases_heading',
  'auth.restore_subtitle': 'auth.restore_purchases_subheading',
  'auth.log_in_continue': 'auth.login_continue_purchase',

  // === support form ===
  'support.fill_form': 'support.instruction',
  'support.email': 'support.email_placeholder',
  'support.subject': 'support.subject_placeholder',
  'support.message': 'support.message_placeholder',
  'support.send': 'support.send_button',
  'support.sending': 'support.sending',
  'support.attachments': 'support.attachments_label',
  'support.request_submitted': 'support.success_heading',
  'support.received_message': 'support.success_message_prefix',
  'support.send_another': 'support.send_another',
  'support.required': 'support.required',
  'support.invalid_email': 'support.invalid_email',
  'support.subject_length': 'support.subject_length',
  'support.message_length': 'support.message_length',
  'support.back': 'nav.back_aria'
};

function parseLegacy(content) {
  // Грубый парсер: ищем top-level блоки вида `<lang>: { ... }` (2-buchstabig + ':' с 2 space-indent).
  // Достаточно для нашего format'а, у нас формат стабильный (Prettier — single quotes, 2-space).
  const out = {};
  const langBlockRe = /^ {2}([a-z]{2}):\s*{$/gm;
  let m;
  while ((m = langBlockRe.exec(content)) !== null) {
    const lang = m[1];
    const start = m.index + m[0].length;
    // Найти закрывающую `}` на 2-space indent
    const closeIdx = content.indexOf('\n  },', start);
    const block = closeIdx === -1
      ? content.slice(start, content.indexOf('\n  }\n}', start))
      : content.slice(start, closeIdx);
    const dict = {};
    const entryRe = /^ {4}'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm;
    let em;
    while ((em = entryRe.exec(block)) !== null) {
      // Unescape \' и \\
      dict[em[1]] = em[2].replace(/\\(['\\])/g, '$1');
    }
    out[lang] = dict;
  }
  return out;
}

function escape(s) {
  // Используем single quotes наружу, эскейпим только их + backslash.
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function emit(lang, dict) {
  const keys = Object.keys(dict).sort();
  if (keys.length === 0) {
    console.warn(`  ${lang}: skipped, no mapped keys`);
    return;
  }
  const lines = keys.map((k) => `  '${k}': '${escape(dict[k])}'`);
  const body =
    `/**
 * Static-translations для ${lang}. Сгенерировано из:
 *  - \`online/lang/static-translations.ts\` (legacy, через KEY_MAP)
 *  - \`tools/sdk-translations.mjs\` (SDK-specific строки)
 *
 * Не править вручную — изменения теряются при следующем \`node tools/gen-locales.mjs\`.
 * Чтобы исправить перевод — править legacy/sdk-translations.mjs и регенерить.
 */
const ${lang} = {
${lines.join(',\n')}
} as const;

export default ${lang};
`;
  writeFileSync(resolve(OUT_DIR, `${lang}.ts`), body, 'utf8');
  console.log(`  ${lang}: ${keys.length} keys`);
}

/** Извлекает SDK-translations для конкретного языка. Структура источника —
 *  `{ key: { lang: "value", ... }, ... }`, инвертируем в `{ key: "value" }`
 *  только для нашего lang. Пропускаем ключи без перевода под этот lang. */
function sdkForLang(lang) {
  const out = {};
  for (const [key, langMap] of Object.entries(SDK_TRANSLATIONS)) {
    if (langMap[lang]) out[key] = langMap[lang];
  }
  return out;
}

function main() {
  const content = readFileSync(LEGACY_PATH, 'utf8');
  const legacy = parseLegacy(content);
  const langs = Object.keys(legacy);
  console.log(`Parsed ${langs.length} languages from legacy: ${langs.join(', ')}`);

  for (const lang of langs) {
    if (lang === 'en') continue;
    const fromLegacy = {};
    for (const [legacyKey, v3Key] of Object.entries(KEY_MAP)) {
      const val = legacy[lang][legacyKey];
      if (val) fromLegacy[v3Key] = val;
    }
    // pricing.included_per — legacy без суффикса/placeholder'а; добиваем
    // до v3-формата "{prefix} {interval}:". Если уже содержит {interval}
    // (например, sdk-translations override) — не трогаем.
    if (fromLegacy['pricing.included_per'] && !fromLegacy['pricing.included_per'].includes('{interval}')) {
      fromLegacy['pricing.included_per'] = `${fromLegacy['pricing.included_per']} {interval}:`;
    }
    // SDK-translations имеют приоритет — спред'имся после legacy. Это
    // позволяет override'ить криво портированные ключи (например
    // ja/ko/zh `pricing.included_per` со словарным порядком, отличным от EN).
    const merged = { ...fromLegacy, ...sdkForLang(lang) };
    emit(lang, merged);
  }
}

main();
