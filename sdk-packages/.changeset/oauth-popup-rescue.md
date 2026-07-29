---
'@monetize.software/sdk-extension': minor
---

OAuth survives the surface that started it being destroyed

Signing in from a toolbar action popup could fail silently: Chrome closes an
action popup as soon as the provider window takes focus, and the auth code —
delivered by `postMessage` to that now-dead window — was lost. Whether the popup
dies is decided by the OS window manager, so the same extension worked on one
machine and failed on another, and opening DevTools "fixed" it by keeping the
popup alive.

Pass the new `apiOrigin` option to `installRouter` and the service worker watches
for the provider's redirect landing on your callback page, reads the code from
the URL, and lets the offscreen document — which holds the PKCE verifier —
complete the sign-in on its own. Requires no new manifest permission: the URL is
already visible through the `host_permissions` entry for that origin. Omit the
option and behaviour is unchanged.

Also: one auth code can no longer be exchanged twice when the popup survives and
races the worker (GoTrue burns it on first use), and a window closed by the
rescue path is no longer reported as `oauth_cancelled` when the sign-in in fact
succeeded.

The demo extension no longer falls back to a shared host when its config is
missing — it now refuses to start with an explicit message instead.
