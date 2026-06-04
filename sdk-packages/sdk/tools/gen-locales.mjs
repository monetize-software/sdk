#!/usr/bin/env node
/**
 * static-translations generator for SDK v3. Two sources:
 *  1. Legacy `online/lang/static-translations.ts` (KEY_MAP ports keys from the
 *     legacy schema to v3).
 *  2. `sdk-translations.mjs` (SDK-specific strings with no legacy counterpart).
 *
 * SDK-translations take priority over legacy on conflict — this is needed so a
 * broken legacy translation can be overridden
 * (e.g. `pricing.included_per` for JA/KO/ZH).
 *
 * Usage: `node tools/gen-locales.mjs`
 *
 * The script is safe: it only writes to `src/ui/i18n/locales/*.ts`. Canonical EN
 * (`src/ui/i18n/canonical-en.ts`) is NOT touched — it is the source of truth,
 * maintained by hand.
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

// Mapping of legacy keys → SDK v3 keys. Only those where the meaning matches.
// If a legacy key is not in this table, it is ignored (legacy-only features:
// portal/attachments/overpay/captcha/checkout/finish). If a v3 key has no
// legacy counterpart, it stays on its inline EN fallback in the block.
const KEY_MAP = {
  // === modal / support ===
  'modal.support': 'support.heading',

  // === pricing intervals (TokenizationGate "Included per X") ===
  'pricing.interval.week': 'pricing.interval.week',
  'pricing.interval.month': 'pricing.interval.month',
  'pricing.interval.year': 'pricing.interval.year',
  // pricing.included_per: legacy provided only the prefix ("Included for"), while
  // v3 joins it with the interval and a colon in a single phrase. The post-transform
  // below appends " {interval}:" — correct for languages with a suffix
  // (en/ru/de/es/...). For languages with the "{interval}に含まれる" order (ja/ko/zh)
  // it is better to edit by hand after regeneration.
  'pricing.included_per': 'pricing.included_per',

  // === pricing plan labels (PriceGrid header — legacy keys are singular) ===
  'pricing.plan_label.week': 'pricing.plan_label.weekly',
  'pricing.plan_label.month': 'pricing.plan_label.monthly',
  'pricing.plan_label.year': 'pricing.plan_label.yearly',
  'pricing.plan_label.lifetime': 'pricing.plan_label.lifetime',

  // === pricing money-back guarantee ===
  'pricing.money_back': 'pricing.money_back',

  // === pricing — start trial (interpolation {days}) ===
  'pricing.start_trial': 'cta.start_trial',

  // === payment-awaiting "Awaiting payment..." ===
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
  // Rough parser: look for top-level blocks of the form `<lang>: { ... }` (2-letter + ':' at 2-space indent).
  // Good enough for our format, which is stable (Prettier — single quotes, 2-space).
  const out = {};
  const langBlockRe = /^ {2}([a-z]{2}):\s*{$/gm;
  let m;
  while ((m = langBlockRe.exec(content)) !== null) {
    const lang = m[1];
    const start = m.index + m[0].length;
    // Find the closing `}` at 2-space indent
    const closeIdx = content.indexOf('\n  },', start);
    const block = closeIdx === -1
      ? content.slice(start, content.indexOf('\n  }\n}', start))
      : content.slice(start, closeIdx);
    const dict = {};
    const entryRe = /^ {4}'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm;
    let em;
    while ((em = entryRe.exec(block)) !== null) {
      // Unescape \' and \\
      dict[em[1]] = em[2].replace(/\\(['\\])/g, '$1');
    }
    out[lang] = dict;
  }
  return out;
}

function escape(s) {
  // Use single quotes on the outside, escape only those + the backslash.
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
 * Static-translations for ${lang}. Generated from:
 *  - \`online/lang/static-translations.ts\` (legacy, via KEY_MAP)
 *  - \`tools/sdk-translations.mjs\` (SDK-specific strings)
 *
 * Do not edit by hand — changes are lost on the next \`node tools/gen-locales.mjs\`.
 * To fix a translation, edit legacy/sdk-translations.mjs and regenerate.
 */
const ${lang} = {
${lines.join(',\n')}
} as const;

export default ${lang};
`;
  writeFileSync(resolve(OUT_DIR, `${lang}.ts`), body, 'utf8');
  console.log(`  ${lang}: ${keys.length} keys`);
}

/** Extracts SDK-translations for a specific language. The source structure is
 *  `{ key: { lang: "value", ... }, ... }`, which we invert into `{ key: "value" }`
 *  for our lang only. Keys without a translation for this lang are skipped. */
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
    // pricing.included_per — legacy has no suffix/placeholder; we pad it up to
    // the v3 format "{prefix} {interval}:". If it already contains {interval}
    // (e.g. an sdk-translations override), leave it alone.
    if (fromLegacy['pricing.included_per'] && !fromLegacy['pricing.included_per'].includes('{interval}')) {
      fromLegacy['pricing.included_per'] = `${fromLegacy['pricing.included_per']} {interval}:`;
    }
    // SDK-translations take priority — we spread after legacy. This allows
    // overriding poorly ported keys (e.g. ja/ko/zh `pricing.included_per` with a
    // word order different from EN).
    const merged = { ...fromLegacy, ...sdkForLang(lang) };
    emit(lang, merged);
  }
}

main();
