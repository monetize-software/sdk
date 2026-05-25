// Compile-time structural compatibility test.
// Не исполняется в runtime — только проверяется `tsc --noEmit`. Файл назван
// .test-d.ts, чтобы был хорошо виден в дереве как «type test», и чтобы будущие
// e2e-runner'ы (vitest/jest) его не пытались запускать.
//
// Контракт: RemoteAuthClient — proxy-реализация AuthClient. PaywallUI и
// AuthPanel принимают любой объект, прошедший runtime duck-typing
// (`isAuthClientLike` в PaywallUI), и дёргают на нём public-методы напрямую.
// Если AuthClient получит новый public-метод (например, ещё один OAuth-flow),
// а RemoteAuthClient его не реализует — баг проявится только в runtime'е
// (`auth.X is not a function` в console попапа). Такое уже было с
// `getLastLogin` в alpha.4.
//
// Этот файл — choke-point: добавил public-метод в AuthClient → TS error здесь,
// пока не реализовал в RemoteAuthClient. Метод-исключение (намеренно не
// зеркалится в proxy) — добавляется в EXCLUDED_FROM_PROXY с пояснением.

import type { AuthClient } from '@sdk/core/auth';
import type { RemoteAuthClient } from './RemoteAuthClient';

// Методы, которые НЕ нужно зеркалить в RemoteAuthClient. Каждое исключение
// требует обоснования — иначе по умолчанию любой публичный метод AuthClient'а
// должен быть в proxy.
//
// - upgradeAnonymousToEmail: пока не используется SDK ui-кодом. Когда понадобится —
//   убрать из исключений и реализовать в RemoteAuthClient + добавить в protocol.
// - startOAuthFlow / completeOAuthFlow: split-API наружу не выставляется, popup
//   зовёт только signInWithOAuth, который под капотом делает oauthStart+oauthExchange
//   transport-вызовы. Прямой split нужен только в offscreen'е.
// - isDestroyed: defensive геттер, host-приложение PaywallUI'я этим не пользуется
//   (модалка следит за `destroy()` через свой жизненный цикл).
type ExcludedFromProxy =
  | 'upgradeAnonymousToEmail'
  | 'startOAuthFlow'
  | 'completeOAuthFlow'
  | 'isDestroyed';

type RequiredAuthAPI = Pick<
  AuthClient,
  Exclude<keyof AuthClient, ExcludedFromProxy>
>;

// Если строчка ниже падает с TS2322 — RemoteAuthClient разошёлся с AuthClient.
// Чаще всего: забыт новый метод. Реже: сигнатура разъехалась (тип параметра /
// возврата). Чините RemoteAuthClient (+ протокол + offscreen handler), а не
// исключения — исключения только для намеренного divergence.
declare const _remote: RemoteAuthClient;
const _assertStructuralCompat: RequiredAuthAPI = _remote;
void _assertStructuralCompat;
