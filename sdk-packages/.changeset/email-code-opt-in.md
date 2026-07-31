---
'@monetize.software/sdk': minor
---

"Sign in with a code" is now opt-in

The passwordless email-code route shipped on by default in 3.5.0-rc.0, which put
a second sign-in path next to the password field on every paywall — including the
ones that never asked for it. It is now off unless the `auth_panel` block sets
`allow_email_code: true`.

Worth turning on for a paywall with no custom domain configured: it is the only
email method that works there, since the confirmation link lands on a domain
whose session cannot cross back to the host. The password-reset code entry is a
separate flow and is unaffected.
