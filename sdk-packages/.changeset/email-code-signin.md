---
'@monetize.software/sdk': minor
---

Passwordless sign-in with an emailed code

`auth_panel` gains a "Sign in with a code" option: the user gets a 6-digit code
by email and enters it in the panel itself. Because the code is verified in
place, the session is minted on the host's own origin — unlike the signup
confirmation link, which lands on the paywall's custom domain and cannot hand a
session back across origins. It also needs no password held in memory while the
user goes to their inbox, and it is the only email method that works for a
paywall without a custom domain configured.

Enabled by default; turn it off per paywall with `allow_email_code: false` on the
`auth_panel` block. The code screen has its own resend, which surfaces rate-limit
errors (the email step stays anti-enumeration and always advances).
