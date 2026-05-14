# @monetize.software/sdk-extension

## 3.0.0-alpha.4

### Patch Changes

- docs: prominent warning that Chrome Web Store MV3 policy forbids loading any `@monetize.software/*` package from a CDN (esm.sh / unpkg / jsDelivr) inside content scripts, popups, or service workers. Extension authors must `pnpm add @monetize.software/sdk-extension` and bundle it like a regular npm dependency — `sdk-extension` exists as a separate package precisely so the content-script build inlines all SDK code at build time and never fetches remote JS at runtime.

  No code changes. README-only update so the warning shows on the npm package page in addition to the GitHub repo.
