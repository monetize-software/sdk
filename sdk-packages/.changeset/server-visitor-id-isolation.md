---
'@monetize.software/sdk': patch
---

Server-side clients no longer share one visitor_id per process

Without `window` and without an explicit `storage` adapter the SDK fell back to a
module-level in-memory map, so every client built in one Node process read and
wrote the same `pw-visitor-id`. The backend reads visitor_id as "the same
device": on sign-in it re-attributes guest purchases made under that id. A
process-wide value therefore let each successive login inherit the purchases of
the users authenticated before it — for a backend that proxies auth through the
SDK, all of its users at once.

Each client now gets its own memory storage when there is no `window`, so a
per-instance visitor_id matches nothing and claims nothing. Pass an explicit
`storage` adapter if a server integration genuinely needs persistence. Browser
behaviour is unchanged, including the shared fallback used when `localStorage` is
unavailable (private mode, sandboxed iframe) — one tab is one user, and
`AuthClient` and `BillingClient` must keep seeing the same visitor_id there.
