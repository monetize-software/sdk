# @monetize.software/sdk-react

React bindings для [`@monetize.software/sdk`](../sdk) — Provider, хуки и декларативные компоненты для пейвола. Работает с web SDK и extension SDK (любой drop-in-совместимый `PaywallUI`).

- **Bundle**: < 2 KB gzip (только bindings, никакого UI — он внутри SDK).
- **React**: >= 18, использует `useSyncExternalStore` для concurrent-safe чтения снимков.
- **SSR**: безопасно. На сервере хуки отдают `null` / `{ status: 'loading' }`, инстанс PaywallUI создаётся только на клиенте.
- **TypeScript**: полный тип-уровень контракт ([`src/contract.ts`](src/contract.ts)) — если в основном SDK поедет публичная поверхность, сборка sdk-react падает на этапе `tsc`.

## Установка

```bash
pnpm add @monetize.software/sdk-react @monetize.software/sdk react
```

## Quick start

```tsx
import {
  PaywallProvider,
  PaywallGate,
  PaywallButton,
  usePaywallUser
} from '@monetize.software/sdk-react';

function App() {
  return (
    <PaywallProvider options={{ paywallId: 'YOUR_ID', auth: true }}>
      <PaywallGate fallback={<UpgradeCTA />}>
        <PremiumFeature />
      </PaywallGate>

      <PaywallButton>Upgrade</PaywallButton>
    </PaywallProvider>
  );
}

function UpgradeCTA() {
  const user = usePaywallUser();
  return <p>Привет, {user?.email ?? 'гость'}! Открой полный доступ.</p>;
}
```

## Provider

`<PaywallProvider>` принимает один из двух пропсов:

```tsx
// Вариант 1 — Provider сам создаёт инстанс
<PaywallProvider options={{ paywallId, apiOrigin, auth: true }}>

// Вариант 2 — готовый инстанс снаружи (extension / shared / тесты)
import { createPaywallUI } from '@monetize.software/sdk-extension';
const paywall = createPaywallUI({ paywallId });

<PaywallProvider instance={paywall}>
```

Если `paywallId` динамически меняется, перемонтируй Provider через `<PaywallProvider key={paywallId} options={...}>` — реактивная пересборка опций намеренно не делается.

## Хуки

| Хук | Возвращает | Когда триггерит rerender |
|---|---|---|
| `usePaywall()` | `PaywallUI \| null` | смена инстанса (редко) |
| `usePaywallState()` | `{ open, view, error }` | любое изменение state-машины |
| `usePaywallUser()` | `PaywallUser \| null` | event `userChange` |
| `usePaywallAccess(opts?)` | `{ status, result }` | `userChange` / `purchase_completed` |
| `usePaywallPrices()` | `{ prices, loading, error }` | bootstrap refresh |
| `usePaywallTrial()` | `TrialStatus \| null` | `trial_blocked` / `trial_expired` |
| `usePaywallVisibility()` | `VisibilityStatus \| null` | `ready` / `visibility_blocked` |
| `usePaywallEvent(event, handler)` | — | подписка с stable-handler-ref |

Все хуки безопасны до mount-а Provider'а (отдают `null` / loading) — можно использовать в SSR без `'use client'`-обёрток на ветке дерева.

## Компоненты

### `<PaywallGate>`

Декларативный гейт: loading → fallback → children.

```tsx
<PaywallGate
  loading={<Skeleton />}
  fallback={({ open }) => <button onClick={open}>Upgrade</button>}
  openOnBlocked={false}  // если true — автоматом дёргает paywall.open()
>
  <PremiumFeature />
</PaywallGate>
```

### `<PaywallButton>` / `<PaywallSupportButton>`

Сахар над `paywall.open()`. По умолчанию рендерится как нативный `<button>` со всеми твоими `className`/`disabled`/`aria-*`. Для кастомного элемента — render-prop:

```tsx
<PaywallButton render={({ open, ready }) => (
  <MyButton onClick={open} disabled={!ready}>Upgrade</MyButton>
)} />
```

`mode` переключает между `open()` / `openSupport()` / `openAuth()` / `openAnonGate()`:

```tsx
<PaywallButton mode="support">Need help?</PaywallButton>
<PaywallButton mode="auth">Sign in</PaywallButton>
```

## SSR / Next.js

```tsx
'use client';  // на Provider, не на дерево потомков

import { PaywallProvider } from '@monetize.software/sdk-react';

export function PaywallProviders({ children }) {
  return (
    <PaywallProvider options={{ paywallId: process.env.NEXT_PUBLIC_PAYWALL_ID! }}>
      {children}
    </PaywallProvider>
  );
}
```

Хуки можно вызывать из server components только при типизированных-null-сценариях (всё равно вернётся `null`/`loading`). Рекомендация — выносить хук-логику в client component.

## Защита от изменений в SDK

`pnpm typecheck` проверяет [`src/contract.ts`](src/contract.ts) — там перечислены все точки опоры на public API SDK (методы PaywallUI, поля snapshot'ов, имена событий). Любое разъезжание в `../sdk` ловится здесь раньше, чем в проде.

После изменений в SDK обнови dist для типов:

```bash
cd ../sdk && pnpm build
cd ../sdk-react && pnpm typecheck
```

## Разработка

```bash
pnpm install
pnpm dev          # → http://localhost:5080/demo/
pnpm typecheck    # TS-валидация + контракт
pnpm test         # vitest + @testing-library/react
pnpm test:e2e     # playwright против демо
pnpm build        # ESM + CJS + d.ts → dist/
```

## API reference

Полные JSDoc-комментарии на каждый публичный экспорт смотри в исходниках:

- [`src/PaywallProvider.tsx`](src/PaywallProvider.tsx) — Provider, lifecycle
- [`src/hooks/`](src/hooks/) — все хуки
- [`src/components/`](src/components/) — декларативные компоненты
- [`src/contract.ts`](src/contract.ts) — точки опоры на SDK
