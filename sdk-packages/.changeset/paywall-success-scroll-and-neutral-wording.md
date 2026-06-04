---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Правки модалки пейвола и формулировок success-экрана.

**1. Скролл для self-contained статус-вью.** Диалог модалки ограничен по высоте
(`max-h … overflow-hidden`), а скролл-зону (`flex-1 min-h-0 overflow-y-auto`)
настраивали только `Renderer`/`AuthGate`/`SupportGate`. Простые статус-вью
(`PurchaseSuccessView`, `LoadingView`, `ErrorView`, `AwaitingPaymentView`,
`PopupBlockedView`) рендерились без обёртки и при нехватке высоты (маленькие
экраны, extension-попап ~600px) обрезались без возможности проскроллить.
Добавлен общий `Scroll`-враппер для этих вью; `Renderer`/`AuthGate`/`SupportGate`
не оборачиваются — у них свой scroll + закреплённый футер.

**2. Горизонтальные отступы у `PurchaseSuccessView`.** У корня вью были только
вертикальные отступы, а кнопка `Continue` — `w-full`, из-за чего она
растягивалась до краёв диалога, а её glow/shimmer вылезали за край. Добавлен
`px-6 sm:px-8` — как у соседних вью.

**3. Нейтральные формулировки success/restored.** «Your subscription is now
active.» / «Subscription restored» некорректны для lifetime-покупок (это не
подписка). Success-сабтайтл → «You're all set — enjoy!», restored-заголовок →
«Welcome back», restored-сабтайтл → тот же «You're all set — enjoy!». Обновлён
EN-эталон, inline-fallback'и и все 27 локалей (`tools/sdk-translations.mjs` +
регенерация `gen-locales.mjs`).
