---
'@monetize.software/sdk': minor
'@monetize.software/sdk-extension': minor
---

Auth/extension/i18n fixes:

- **Anonymous sign-in option renamed.** `AuthClient.signInAnonymously({ forceCaptcha })` → `signInAnonymously({ forceNewAnon })`. Same semantics (skip idempotent + resume, force a fresh anon `/signin`), clearer name now that captcha is no longer in the flow. The extension transport (`auth.signInAnonymously`) field is renamed too. **Breaking** for callers that passed `forceCaptcha: true` — search/replace to `forceNewAnon: true`.
- **MV3 onConnect duplicate-handler fix (sdk-extension).** `chrome.runtime.connect` is delivered to *every* extension context with an `onConnect` listener — including offscreen, alongside the SW. With a single shared port name, one `popup.connect()` opened two ports in offscreen (SW relay + direct popup), so each popup → SW send was handled twice. Split into `PORT_NAME` (content/popup → SW) and `RELAY_PORT_NAME` (SW → offscreen); offscreen now accepts only the relay name.
- **AuthPanel double-submit guard.** `useRef` synchronous guard around `onSubmit`/`onOAuth`. `setBusy` is async setState; back-to-back submits in one tick (Enter + click, demo-ext double-mount, transport race) both passed the `if (busy) return` check and fired the network request twice (e.g. double `requestPasswordReset`).
- **i18n: `auth.rate_limited` copy.** "Too many requests. Please try again **later**." (was "in a moment"). More accurate for Supabase rate-limit windows (minutes, not seconds). Translated across all 27 locales.
