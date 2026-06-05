---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Версия SDK инжектится из package.json при сборке, а не хардкодится.

`SDK_VERSION` торчал захардкоженным литералом `'3.0.0-alpha.0'` через все
релизы (alpha.x → beta.x) — его ни разу не подняли. Он уходит в `X-SDK-Version`
на всех запросах, в `sdk_version` каждого события аналитики (ClickHouse) и в
ApiGateway, поэтому вся аналитика по версиям была слепой: события всех релизов
писались как одна версия.

Теперь версия прокидывается из package.json через vite `define`
(`__SDK_VERSION__`) — в бандле строковый литерал, в `.d.ts` остаётся
`const SDK_VERSION: string`. `define` продублирован в vitest.config (он не
наследует vite.config), иначе токен не замещался бы в тестах.
