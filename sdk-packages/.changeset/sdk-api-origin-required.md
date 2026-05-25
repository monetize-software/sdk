---
'@monetize.software/sdk': major
---

BREAKING: `apiOrigin` теперь **обязательное** поле у `BillingClient`, `AuthClient`, `ApiGatewayClient` — передавайте `custom_domain` пейвола, заданный в платформе. Прежний fallback `https://appbox.space` удалён (он использовался только legacy v2 SDK). SDK сверяет `apiOrigin` с `bootstrap.settings.custom_domain` и кидает `invalid_config` при расхождении — защита от опечатки интегратора.

Также:
- Новый layout block `guarantee_badge` (money-back бейдж под CTA, иконка `dollar_shield` или `none`).
- `PaywallSettings.custom_domain` — новое поле в bootstrap, нормализуется через `URL().origin`.
- Default layout теперь включает `guarantee_badge` + `current_session` после CTA.
- PriceGrid: валюта отдельным элементом рядом с amount, plan label в ALL CAPS, чекмарк справа, селектор без radio.
- Modal: Test-mode badge — absolute поверх dialog'а (rounded pill, не баннер сверху), close-button перепозиционирован.
- CtaButton: shimmer-анимация (CSS), rounded-full, более насыщенный градиент с inset glow.
- CurrentSession: ссылки accent-цвета (вместо серых).
- Heading h1: 1.875rem (было 1.625), bold, text-balance.
- TokenizationGate: насыщенный checkmark на accent-фоне.
