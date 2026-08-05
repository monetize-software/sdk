---
'@monetize.software/sdk-extension': patch
---

The post-payment tab closes again

"Payment Done!" stayed on screen after a purchase, with `Scripts may close only
the windows that were opened by them` in its console. The return pages close
themselves, but a script may only close a window a script opened — and since
rc.4 the checkout tab is opened by the extension, so Chrome refused.

The worker now closes it, on the same ~3.5s schedule the page used, so the
confirmation stays readable. A paywall with `success_redirect_url` navigates
onward instead: the tab's URL is re-checked right before closing, so the
merchant's own page is left alone.

Matched by URL rather than by remembering which tabs we opened — paying takes
minutes and the worker idles out after 30 seconds, so any in-memory list would be
long gone by the time the user comes back.
