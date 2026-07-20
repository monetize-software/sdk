---
'@monetize.software/sdk': patch
---

AuthPanel surfaces the `custom_domain_required` auth error with an actionable message ("the paywall has no custom domain configured") instead of the generic fallback — merchant misconfiguration is visible right in the UI during setup. OAuth redirects and confirmation/recovery email links are built from the paywall's custom domain, so the backend hard-fails auth without it.
