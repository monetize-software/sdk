---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
---

Analytics: a purchase is reported once, not on every re-discovery; event buffer capped at the ingest limit

`handlePurchaseDetected` fires whenever an active subscription is discovered — not only right after paying — and emitted `purchase_completed` without `restored`, so the 3.3.1 filter never saw it. Its only guard, `this.purchased`, dedupes within ONE PaywallUI instance, and in an extension the popup is destroyed when it loses focus: every open built a fresh instance and re-reported the subscriber's purchase. Measured over 30 days: 624 events for 339 actual buyers (1.87x in the extension channel, up to 21 events for a single visitor), all with an empty `session_id`. One paywall showed 73 "purchases" against 34 rows in the database.

`purchase_completed` is now keyed on the purchase itself — the checkout session id when present, otherwise the active purchase ids — and reported only the first time that key is seen. A checkout started in the current instance bypasses the dedupe entirely: an already-subscribed user buying again keeps their old purchase ids, so the key would match the one stored for the first subscription and the upgrade would be swallowed. The set of reported keys is mirrored in memory (the check sits on the event path and must stay synchronous, or the tracker's batch would reorder) and persisted to storage, which in an extension is shared across popup, content-script and offscreen — so it survives the instance churn that caused the inflation. Persistence is a serialized read-merge-write: a blind overwrite would drop keys whenever a purchase landed before the mirror warmed, or when two contexts wrote concurrently. A genuinely new purchase (an upgrade, a second subscription) yields a different key and is reported. With nothing stable to key on, the event is reported rather than risk swallowing a real sale.

The public `purchase_completed` event is unchanged — the host still receives it exactly as before; only what reaches analytics is deduplicated.

Also: `HARD_BUFFER_LIMIT` in EventTracker drops from 200 to 100, matching `MAX_EVENTS_PER_BATCH` on the ingest route. A larger buffer could flush a batch the server rejects with 413, and since `flush()` clears the buffer before sending, the whole backlog would vanish silently.
