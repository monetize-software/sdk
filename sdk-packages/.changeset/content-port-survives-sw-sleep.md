---
'@monetize.software/sdk-extension': patch
---

Content script: the paywall no longer hangs forever after the MV3 service worker goes to sleep

A content script's port reaches every extension context with an `onConnect` listener, so both the service worker and the offscreen document hold an end of it. When the idle service worker is terminated, Chrome closes only the service worker's end. The offscreen document still holds its end, so `onDisconnect` never fires in the content script. `TransportClient` kept sending into that dead port: nothing threw and nothing answered, so `open()` sat on a spinner until the tab was reloaded. Long-lived content scripts hit this after about 30 seconds of inactivity. Popups mostly didn't, because they rarely live long enough.

The transport no longer relies on `onDisconnect` alone:

- A channel that has been silent longer than the service worker's idle window is recreated before the next request. Reconnecting is cheap, and nothing in flight is affected.
- While requests are in flight, a silent channel is probed. If the probe gets no answer, the channel is dropped, the pending requests reject with `TransportDisconnectedError`, and the next request reconnects. So a dead port costs a few seconds instead of an endless spinner. Long-running requests (OAuth, purchase polling) are unaffected because the probe answers while they wait.

Workarounds that wake the service worker and force-close `getContentTransport().channel` before `open()` are no longer needed and can be removed.
