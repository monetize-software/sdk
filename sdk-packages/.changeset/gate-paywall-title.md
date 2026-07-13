---
'@monetize.software/sdk-react': minor
---

`<PaywallGate paywallTitle="...">` — per-open custom title for opens triggered by the gate

The value is forwarded as `OpenOptions.title` both when `openOnBlocked` auto-opens the modal and when the fallback's `open()` callback fires. A gate wraps a concrete feature, so the modal can say why it appeared ("Unlock export") — same semantics as `<PaywallButton paywallTitle>`. A `paywallTitle` change while the gate is already blocked does not re-trigger an auto-open; the fresh value is picked up on the next open.
