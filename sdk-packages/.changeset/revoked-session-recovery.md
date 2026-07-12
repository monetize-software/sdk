---
'@monetize.software/sdk': minor
'@monetize.software/sdk-extension': minor
'@monetize.software/sdk-react': minor
---

Recover from server-side revoked sessions instead of dead-ending with an opaque `http_401` "Request failed"

- **Automatic 401 retry.** When a request that carried a Bearer gets a 401, `BillingClient` and `ApiGatewayClient` force one token rotation (`auth.refresh()`) and replay the request with the fresh token. Exactly one replay — a second 401 surfaces to the caller; stream bodies through the gateway are never replayed. If the refresh itself gets a 401 (the session family was revoked — e.g. a refresh-rotation race between two extension pages), the session is cleared, `onAuthChange` fires `SIGNED_OUT`, and the original error surfaces.
- **PaywallUI recovery.** On a `preauth` paywall a checkout that fails with a 401 reopens the auth gate with the checkout still pending: after re-signin the purchase auto-resumes, and an already-paid user lands on the restored success view instead of being charged twice. The `error` event is still emitted so host analytics see the auth failure. Guest-mode paywalls keep the previous generic error path.
- **Error contract.** A slug-shaped `error` field in a backend error body is now accepted as `PaywallError.code` (e.g. `invalid_token`), and a sentence-shaped one becomes `message` — instead of the generic `http_<status>` / "Request failed".
- New optional `ApiClientOptions.onUnauthorized` hook in `@monetize.software/sdk/core` (wired automatically by `BillingClient`; useful for custom clients).
