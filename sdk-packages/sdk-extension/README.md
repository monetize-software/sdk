# @monetize.software/sdk-extension

SDK for Chrome extensions. A single offscreen document holds the BillingClient,
AuthClient and EventTracker — the single source of truth for all tabs, popups,
side panels, and extension pages.

The content-script public API is **drop-in compatible** with `@monetize.software/sdk` —
the host writes `import { PaywallUI } from '@monetize.software/sdk-extension'` and
gets the same class with the same method set.

> ⚠️ **Bundle as an npm dependency. Do not load from a CDN.**
> Chrome Web Store [MV3 policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) forbids remote code execution — every line of JS your extension runs must be reviewable at submission time and ship inside the extension package. `pnpm add @monetize.software/sdk-extension` and bundle it with Vite/Rollup/webpack like any other npm dep. Loading this package (or `@monetize.software/sdk`, or `@monetize.software/sdk-react`) from `esm.sh`/`unpkg`/`jsDelivr` from a content script, popup, or service worker will get the extension rejected by review, or removed retroactively if the policy violation is spotted later. This is also why we publish `sdk-extension` as a separate package — its content-script bundle has all dependencies inlined, no runtime fetch of code.

## Architecture

```
content script (per tab) ──port──▶ service worker ──port──▶ offscreen
        │                              (forwarder)              │
   Shadow DOM modal                                  BillingClient
   RemoteBillingClient                               AuthClient
                                                     EventTracker
                                                     UserWatcher
```

- **content-script:** UI + RemoteBillingClient (proxy over a port into offscreen).
- **service worker:** content↔offscreen router. OAuth uses a popup window opened
  against your `apiOrigin` (custom_domain) — `chrome.identity` is **not** used.
- **offscreen:** the real SDK state, survives tab closes, the sole coordination
  point for auth refresh / trial counter / analytics batching.

## Usage

**In the extension:**

```ts
// service-worker.ts
import { installRouter } from '@monetize.software/sdk-extension/sw';
installRouter({ offscreenUrl: chrome.runtime.getURL('offscreen.html') });
```

```ts
// offscreen.html → offscreen.ts
import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';
startOffscreenServer({ paywallId: '...', apiOrigin: 'https://...' });
```

```ts
// content-script.ts (in every tab)
import { PaywallUI } from '@monetize.software/sdk-extension';
const paywall = new PaywallUI({ paywallId: '...', apiOrigin: '...' });
paywall.open();  // exactly like @monetize.software/sdk
```

**On websites** — keep using `@monetize.software/sdk`, nothing changes.

## Manifest: what to declare in the host extension

The SDK itself does not add anything to the manifest — the host extension picks
permissions to match its own UX. Minimum for the SDK to work:

```json
{
  "permissions": ["offscreen", "storage"],
  "host_permissions": ["https://your-paywall-domain.com/*"],
  "background": { "service_worker": "sw.js", "type": "module" }
}
```

`host_permissions` must list **your `apiOrigin`** — the `custom_domain` configured
for your paywall in the platform (the same value you pass to `new PaywallUI({ apiOrigin })`).
This is the only origin the SDK calls from offscreen / SW / content-script (bootstrap,
checkout, billing, auth). There is no `api.monetize.software` — every customer ships
their own custom domain.

`web_accessible_resources` for `offscreen.html` is **not required** — the document
is created by the service worker via `chrome.offscreen.createDocument`, a Chrome API
that doesn't need WAR. Listing it adds attack surface (any site could `<iframe>` your
offscreen, plus it fingerprints your extension ID).

The SDK does **not** use `chrome.identity` — OAuth runs via a popup window opened
against your `apiOrigin`, so no `"identity"` permission is needed.

### `host_permissions` — what to pick

`host_permissions` control two things: where the extension can `fetch` (from
offscreen / SW / content-script) and which origins the content-script can be
injected into (together with `content_scripts.matches`).

| Scenario | Recommendation |
|---|---|
| **Host extension already needs `<all_urls>`** (recorder, all-sites tool, assistant) | Keep `<all_urls>`. SDK works as-is. **Risk:** Chrome Web Store review for `<all_urls>` is a manual audit and takes longer; AV vendors (Avast/Kaspersky/etc.) are more likely to flag such extensions as PUA. That's the price of broad injection — it's a property of your use case, not an SDK risk. |
| **Host extension only talks to your backend and gates its own features** (popup tool, side-panel app) | Do NOT request `<all_urls>`. Your `apiOrigin` (custom_domain) is enough: `["https://your-paywall-domain.com/*"]`. No content-script injection on every site needed. |
| **Hybrid** — popup tool, but content-script needed on a narrow list of domains | Constrain both `host_permissions` and `content_scripts.matches` to those domains: `["https://*.your-target.com/*", "https://your-paywall-domain.com/*"]`. |

The main signal to CWS/AV: the narrower `host_permissions`, the less suspicion.
Keep `<all_urls>` only when it's genuinely required for your UX, and be ready to
justify it in CWS review (the "Permission justification" field).

## Demo extension: build modes

For self-testing and e2e there's `demo-extension/` — a reference implementation.
Two builds are available:

```bash
pnpm build:demo       # production build (= the template clients can copy)
pnpm build:demo:e2e   # debug build — exposes window.__paywall for Playwright
```

`build:demo` does NOT put `window.__paywall` into the bundle (dead-code-eliminated
via `import.meta.env.MODE !== 'e2e'`). The template clients copy stays clean: any
script on the page could otherwise call `paywall.open()` / `paywall.track()` and
abuse someone else's extension.

`pnpm dev:demo` builds in e2e mode (handy for live debugging from the DevTools console).
