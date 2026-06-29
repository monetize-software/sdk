---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Fix paywall overlay not showing when an ancestor of the host establishes a containing block

The fullscreen paywall overlay relied on `position: fixed` resolving against the viewport. When any ancestor of the mount host created a containing block for fixed-position descendants (`transform`, `filter`, `perspective`, `will-change`, `contain`, `backdrop-filter`) — common in extension side panels and SPA roots — the overlay collapsed into normal flow and became invisible, leaving blocked users with no way to continue.

The mount host is now promoted into the top layer via the Popover API (`popover="manual"` + `showPopover()`), which detaches it from ancestor containing blocks so it always fills the viewport. Feature-detected with a graceful fallback to the plain fixed overlay on engines without Popover support. Host layout is also asserted in the `:host` rule (where it wins the cascade) instead of relying on the inline style.
