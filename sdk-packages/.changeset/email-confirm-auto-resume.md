---
'@monetize.software/sdk': minor
---

Email-confirm signup flow resumes automatically

- **AuthPanel.** While the "check your email" screen is up, the SDK silently retries `signInWithEmail` with the just-entered credentials — kept in memory only (a ref, never storage) — on tab focus and on a 20s background interval capped at ~10 minutes. The hosted confirmation page now closes its own tab after verifying, focus returns to the host tab, the retry succeeds and the auth-resume flow continues the pending checkout (typically landing on the "Open checkout" button — the browser won't auto-open a payment tab without a fresh user gesture). GoTrue's `email_not_confirmed` rejections are swallowed; leaving the screen ("Back to sign in") drops the credentials immediately.
- The "check your email" subtitle now tells the user they will be signed in automatically once the link is clicked.

Extension popups don't benefit: the popup page dies when the user leaves for their inbox, so the signup_sent state (and the in-memory credentials) are gone; returning users land on sign-in with the email prefilled as before.
