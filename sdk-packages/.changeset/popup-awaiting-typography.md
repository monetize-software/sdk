---
'@monetize.software/sdk': patch
---

Modal: typography hierarchy fix for `PopupBlockedView` and
`AwaitingPaymentView`; better popup-blocked icon.

Both views had a flat hierarchy — title (`text-sm`) and subtitle (`text-xs`)
read as the same weight, so users couldn't see at a glance what the
screen was about. Aligned with `PurchaseSuccessView` (the canonical
"outcome view" template): `text-lg` semibold title with `id="pw-title"`
for modal `aria-labelledby`, `text-sm` leading-relaxed subtitle, a
larger `h-14 w-14` icon container so the visual anchor reads as a
primary status indicator rather than an inline accent.

`PopupBlockedView` also gets a more meaningful icon — an external-link
arrow (window with arrow up-right) instead of the previous check-in-box,
which read as "saved/done" and didn't convey "allow popups".
