---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Fix unstyled paywall in sdk-extension (Tailwind not compiled in the extension build)

The sdk-extension build re-bundles the SDK UI from source (`../sdk/src`) but its Vite
config was missing the `@tailwindcss/vite` plugin, so the `styles.css` imported via
`?inline` shipped uncompiled — raw `@import 'tailwindcss'` / `@tailwind` / `@source`
directives that the browser ignores. The paywall mounted in the shadow root with no
styling. Added the Tailwind plugin to the extension build so utility classes are compiled
into the bundle, matching the sdk package build.
