# Paywall SDK — Extension playground

A minimal MV3 extension for manual smoke testing and Playwright e2e.

## Manual smoke test

```bash
cd sdk
pnpm ext:build         # builds playgrounds/extension/dist/
```

Then in Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** →
point to `sdk/playgrounds/extension/dist/`. A "Paywall SDK playground" icon shows up
in the toolbar. Click it → a popup opens with an **Open paywall** button. `fetch`
is mocked, there are no external requests.

After editing the SDK or playground — run `pnpm ext:build` again and hit **Reload**
on the extension card in `chrome://extensions`.

## What's inside

- `manifest.json` — MV3, minimum permissions (`storage`), popup + an empty
  service worker (needed only so Playwright can grab the `extensionId`).
- `src/popup.entry.ts` — imports `PaywallUI`, wires a mocked `fetch` with a
  fixture `PaywallBootstrap`, exposes the instance on `window.__paywall` for
  e2e tests, and renders a small header with open/close buttons.
- `src/background.ts` — empty service worker.
- `vite.config.ts` — emits both entries as ES modules (`formats: ['es']`); all
  Preact / SDK code is inlined (Vite doesn't support IIFE with multiple entries,
  and the CWS-safe requirement — "no remote imports" — is satisfied anyway).

## Why ES modules, not IIFE

Vite's lib mode only supports IIFE **with a single entry**. We have two: popup
and background. ES modules with `<script type="module">` in popup.html and
`"type": "module"` in the manifest for the background give us the same thing —
a self-contained bundle with no remote imports — and let us build both in a
single pass.

## E2E (Playwright)

See [sdk/tests-e2e/extension.spec.ts](../../tests-e2e/extension.spec.ts).
Run with: `pnpm test:e2e` (from `sdk/`). Before each run — `pnpm ext:build`,
otherwise Playwright will pick up a stale `dist/` or fail to find it at all.
