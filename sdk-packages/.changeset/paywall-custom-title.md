---
'@monetize.software/sdk': minor
'@monetize.software/sdk-extension': minor
'@monetize.software/sdk-react': minor
---

Per-open custom paywall title: `paywall.open({ title: 'Unlock export' })`

`OpenOptions.title` replaces the text of the layout's h1 heading block for that particular open — independent of the title configured in the dashboard and of its locale translations. If the layout has no h1 heading block, the title is rendered as a new heading at the top. The override is scoped to the call: the next `open()` without `title` shows the configured heading again. `openSupport()` / `openSignin()` / `openSignup()` / `checkout()` ignore it — those flows don't render the layout heading.

In sdk-react, `<PaywallButton paywallTitle="...">` forwards the value as `OpenOptions.title` (named `paywallTitle` so the plain `title` prop keeps being the native HTML tooltip attribute). sdk-extension inherits the option as-is.

When a custom title is shown, the `paywall_viewed` analytics event carries `custom_title: true`.
