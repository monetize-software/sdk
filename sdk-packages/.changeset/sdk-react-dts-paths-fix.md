---
'@monetize.software/sdk-react': patch
---

fix(dts): rewrite emitted `.d.ts` imports from the dev-only `../sdk/src`
relative path to the bare `@monetize.software/sdk` specifier.

`vite-plugin-dts` was inlining the tsconfig `paths` alias
(`@monetize.software/sdk → ../sdk`) into every emitted declaration as a
relative path like `from '../../sdk/src'`. That works inside the
monorepo but breaks in the published npm package — consumers don't have
a sibling `sdk/src` directory, so TS silently resolved every imported
type (`OpenOptions`, `PaywallUI`, `PaywallAccessResult`, …) to `any`.
The most visible symptom: `<PaywallButton className="…" renew>` failed
to compile because `Omit<HTMLAttrs, "children" | keyof OpenOptions>`
stripped every attribute when `OpenOptions` resolved to `any`.

A `beforeWriteFile` hook in `vite.config.ts` rewrites these paths back
to the bare specifier at build time. No source changes; only emitted
declarations are affected.
