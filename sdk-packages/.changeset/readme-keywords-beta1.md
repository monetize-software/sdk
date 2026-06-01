---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

docs/meta: README trim + npm keywords

- **sdk**: dropped the "Status: alpha" note from the README.
- **all three**: added `keywords` to `package.json` for npm discoverability (paywall, billing, subscriptions, monetization, checkout, …; plus per-package react / chrome-extension / manifest-v3 terms).
- Monorepo README: removed the CDN "React via import map", "Alternative CDNs" and "Trade-offs" subsections; React-on-website now points at the bundler install path.

No code changes.
