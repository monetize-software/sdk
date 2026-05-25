// Compile-time structural compatibility test.
// Не исполняется в runtime — только проверяется `tsc --noEmit`. Парный
// аналог RemoteAuthClient.test-d.ts.
//
// Контракт: RemoteBillingClient — proxy-реализация BillingClient в popup'е
// (через offscreen). PaywallUI / PaywallRoot / SupportGate / AuthGate работают
// с `BillingClient`-типизированным объектом, не зная, что на самом деле под
// капотом — RemoteBillingClient. Если BillingClient получит новый public-метод,
// SDK ui-код начнёт его дёргать, и popup упадёт runtime'ом
// (`r.someMethod is not a function`).
//
// Расходящихся методов у BillingClient/RemoteBillingClient значительно больше,
// чем у пары AuthClient'ов: сигнатуры setIdentity (sync void vs async Promise),
// набор «factory»-методов (createApiGatewayClient) и admin-only (setBootstrap)
// не зеркалятся намеренно. Все такие — в EXCLUDED_FROM_PROXY с обоснованием.

import type { BillingClient } from '@sdk/core/BillingClient';
import type { RemoteBillingClient } from './RemoteBillingClient';

// Методы BillingClient'а, которые НАМЕРЕННО не зеркалятся в RemoteBillingClient.
// Каждое исключение требует обоснования — по умолчанию любой public-метод
// должен быть в proxy.
//
// - capabilities: readonly array, host'у-popup'у не нужен. Если понадобится —
//   добавить getter в RemoteBillingClient и убрать из исключений.
// - setBootstrap: live-preview редактора админки, в extension-канале не нужно.
// - getCachedVisitorId: sync-снапшот visitor_id, у proxy только async getVisitorId
//   через transport — sync mirror не поддерживается.
// - getUserLanguage: пока не реализовано в proxy. Если SDK ui начнёт читать
//   язык — убрать из исключений и реализовать.
// - decrementBalanceLocal / refreshBalances: local-only оптимистические
//   обновления / явный refresh-trigger. В extension'е balance-state живёт в
//   offscreen'е, dec/refresh идут через transport.
// - createApiGatewayClient: factory, host в popup'е делает new ApiGatewayClient
//   напрямую с RemoteAuth (см. popup.ts) — proxy-factory не нужен.
// - getCustomerPortalUrl: не выставлено через transport (TODO когда понадобится).
// - getIdentity / setIdentity: сигнатуры расходятся —
//   BillingClient: setIdentity(Identity | undefined): void;
//                 getIdentity(): Identity | undefined;
//   RemoteBillingClient: setIdentity(Identity | null): Promise<void>;
//                       getIdentity(): Identity | null;
//   Транспортная природа RemoteBillingClient требует async для set, и проектное
//   решение использовать null вместо undefined для wire-friendly JSON. Тестом
//   совместимости НЕ покрываем — но и не маскируем под BillingClient, потому
//   что PaywallUI в extension-канале не вызывает identity-методы напрямую
//   (host через `paywall.billing.setIdentity` получает любой из вариантов).
// - auth: BillingClient выставляет это поле в конструкторе как readonly. В
//   RemoteBillingClient его нет на classе, но PaywallUI-подкласс в extension'е
//   monkey-патчит `billing.auth = auth` (см. content/PaywallUI.ts). Структурно
//   неровно, но фактически PaywallRoot всегда читает auth корректно. TODO:
//   сделать readonly поле в RemoteBillingClient и инициализировать через
//   конструктор.
type ExcludedFromProxy =
  | 'capabilities'
  | 'setBootstrap'
  | 'getCachedVisitorId'
  | 'getUserLanguage'
  | 'decrementBalanceLocal'
  | 'refreshBalances'
  | 'createApiGatewayClient'
  | 'getCustomerPortalUrl'
  | 'getIdentity'
  | 'setIdentity'
  | 'auth';

type RequiredBillingAPI = Pick<
  BillingClient,
  Exclude<keyof BillingClient, ExcludedFromProxy>
>;

// Если строчка ниже падает с TS2322 / TS2741 — RemoteBillingClient разошёлся
// с BillingClient. Чините proxy (+ protocol + offscreen handler), а не
// исключения — исключения только для намеренного divergence с обоснованием.
declare const _remote: RemoteBillingClient;
const _assertStructuralCompat: RequiredBillingAPI = _remote;
void _assertStructuralCompat;
