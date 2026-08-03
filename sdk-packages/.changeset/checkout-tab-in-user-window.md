---
'@monetize.software/sdk-extension': patch
---

The resumed checkout actually opens

3.5.0-rc.2 sent the payment page into the tab the provider had redirected — which
never worked in the field, because our callback page closes itself ~50ms after it
loads. Creating the checkout takes two network round-trips, so by the time the
worker navigated that tab it was long gone and the user was left signed in with
nothing to pay on. Sign-in was unaffected (the code is read from the URL the
moment the navigation is seen), which is exactly how this hid.

The checkout now opens as a new tab in the last focused normal window — where the
user is actually working. The provider window was the wrong target regardless: it
is a 480×640 popup meant to be thrown away, not somewhere to enter card details.

Two more fixes behind the same flow:

- No second checkout when the surface survives. A live popup receives the code by
  `postMessage` and continues the purchase itself, so its exchange now consumes
  the pending flow, and the worker waits briefly before stepping in — previously
  both could create a checkout for one sign-in.
- The worker no longer leaves `Unchecked runtime.lastError: Could not establish
  connection` in the console when offscreen disappears mid-connect.
