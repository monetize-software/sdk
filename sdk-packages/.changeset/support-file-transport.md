---
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk': patch
---

Extension: support-ticket attachments actually reach the ticket; attachment limit is now 5MB per file

- **sdk-extension fix.** `chrome.runtime` ports JSON-serialize messages, so a `File` passed to `createSupportTicket` silently degraded to `{}` in transit — the ticket was created without the attachment and with no error anywhere (the backend filters non-File multipart entries). Attachments now travel as base64: the content side stages each file with its own `billing.stageSupportFile` request (staying clear of the runtime's message size cap), and offscreen rebuilds real `File` objects before calling the backend. Staged files expire after 10 minutes; a stale id fails the ticket loudly instead of dropping the attachment.
- **Limit change.** Max attachment size is now 5MB per file (was 10MB), validated in the SupportGate dropzone, in the extension transport (both sides), and by the backend. The dropzone strings now interpolate the limit (`{size}`) instead of hard-coding it.
