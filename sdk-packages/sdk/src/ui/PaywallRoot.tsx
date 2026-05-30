import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BillingClient } from '../core/BillingClient';
import type { AuthSession } from '../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { PaywallError } from '../core/types';
import { Modal } from './Modal';
import { AuthGate } from './AuthGate';
import { OfferTopBanner, pickActiveOffer } from './renderer/blocks/OfferBanner';
import { SupportGate } from './SupportGate';
import { Renderer } from './renderer/Renderer';
import { I18nProvider, useI18n } from './i18n';

export type PaywallView = 'layout' | 'support' | 'auth' | 'checkout';

/**
 * Публичный snapshot состояния PaywallUI для host'а. Производится из internal
 * LoadState + GateState + open/purchased флагов. Каждое реальное изменение —
 * один call onState; повторы (`useSyncExternalStore`-friendly).
 */
export interface PaywallStateSnapshot {
  /** Модалка отрендерена и видна. False — closed (или ещё не открывалась). */
  open: boolean;
  /** Что показывается в модалке. null когда `open=false`. */
  view:
    | 'loading'
    | 'error'
    | 'layout'
    | 'auth'
    | 'support'
    | 'awaiting_payment'
    | 'popup_blocked'
    | 'purchased'
    | null;
  /** Заполнено только когда `view === 'error'`. */
  error: PaywallError | null;
}

export interface PaywallRootProps {
  client: BillingClient;
  open: boolean;
  onClose: () => void;
  onEvent: (event: string, payload?: unknown) => void;
  /** Какой view показать при open=true. 'support' стартует сразу с саппорт-формой,
   *  Back/Done закрывают модалку (origin='standalone'). 'checkout' стартует
   *  direct-checkout по `initialCheckoutPriceId` минуя layout (paywall.checkout()).
   *  По умолчанию 'layout'. */
  initialView?: PaywallView;
  /** Mode для AuthPanel когда `initialView='auth'` — 'signin' (дефолт) или
   *  'signup'. Выставляется PaywallUI'ем из openSignup()/openSignin(). */
  initialAuthMode?: 'signin' | 'signup';
  /** Целевая цена для direct-checkout. Используется когда `initialView='checkout'`
   *  (`paywall.checkout(priceId)`): после bootstrap'а сразу триггерим
   *  /start-checkout по этой цене, минуя layout с тарифами. preauth-gate,
   *  popup_blocked и awaiting_payment views переиспользуются как в обычном flow.
   *  Игнорируется при остальных `initialView`. */
  initialCheckoutPriceId?: string | null;
  /** Server-confirmed покупка — показать success-вью с кнопкой Continue.
   *  Управляется снаружи (PaywallUI выставляет true из watcher.onActive),
   *  сбрасывается на open()/close(). Перебивает любые другие view. */
  purchased?: boolean;
  /** Renewal/upgrade flow. true — пропускаем все has_active_subscription
   *  pre-check'и (bootstrap-time + post-auth), и при checkout передаём
   *  `ignoreActivePurchase: true` на бэк, чтобы /start-checkout не вернул
   *  409 для уже подписанного юзера. См. OpenOptions.renew. */
  renew?: boolean;
  /** Публичный state-machine notify. PaywallUI прокидывает сюда колбек, который
   *  кэширует snapshot и эмитит свой `onStateChange`. Если не передан —
   *  state-tracking отключён (нет оверхеда для host'ов, которым не нужно). */
  onState?: (snapshot: PaywallStateSnapshot) => void;
  /** Inline-режим (live-preview редактора админки): передаётся в Modal, чтобы
   *  overlay был absolute-внутри-host'а вместо fixed-viewport'а, и не лочил
   *  body-scroll. По умолчанию false. */
  inline?: boolean;
  /** Explicit-override языка для I18nProvider. Используется live-preview
   *  редактором админки — там browser-locale всегда EN, а нужно показать как
   *  для юзера из выбранной страны. См. I18nProviderProps.forceLocale. */
  locale?: string | null;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: PaywallBootstrap }
  | { status: 'error'; error: PaywallError };

type GateState =
  | { kind: 'layout' }
  // Direct-checkout (paywall.checkout(priceId)): модалка смонтирована, ждём
  // bootstrap, чтобы триггернуть preauth-gate / createCheckout. На один кадр
  // показывается LoadingView — host явно попросил «сразу в checkout», тарифы
  // не нужны. После bootstrap'а либо closes (already-paid / error), либо
  // переходит в auth_gate.pendingCheckout, либо стартует createCheckout
  // → awaiting_payment / popup_blocked.
  | { kind: 'direct_checkout_pending'; priceId: string }
  // pendingCheckout=undefined, origin='layout' — gate открыт через "Restore purchases"
  // (без последующего checkout-а), после signIn схлопываемся в layout. С
  // pendingCheckout — gate открыт по preauth-flow от cta_button и после signIn
  // auto-resume createCheckout. origin='standalone' — paywall.openAuth(): модалка
  // открыта только для логина, после signIn / Back закрываем модалку, layout
  // вообще не показываем. direct=true — pendingCheckout пришёл из
  // paywall.checkout(priceId): на ошибке/already-paid закрываем модалку
  // вместо setGate('layout'), потому что layout с тарифами в этом flow
  // никогда не должен светиться.
  | {
      kind: 'auth_gate';
      pendingCheckout?: { priceId: string; direct?: boolean };
      origin?: 'layout' | 'standalone';
      /** Контекст открытия — управляет заголовком gate'а
       *  ("Restore Purchases" vs "Welcome back!"). Дефолт — 'preauth'. */
      intent?: 'restore' | 'preauth' | 'standalone';
    }
  // origin='layout' — пришли из current_session-блока, Back возвращает в layout.
  // origin='standalone' — модалка открыта только для саппорта (paywall.openSupport()),
  // Back закрывает модалку.
  | { kind: 'support'; origin: 'layout' | 'standalone' }
  // window.open отдал handle — checkout открылся в новой вкладке. Пейвол остаётся
  // как индикатор: «оплати в той вкладке». priceId храним, чтобы кнопка retry
  // могла пересоздать checkout (URL'ы у Stripe/Paddle expire'ятся). url храним,
  // чтобы fallback-ссылка «Didn't open? Click here» переоткрывала тот же URL без
  // повторного похода в createCheckout — нужно для случая когда window.open
  // отдал handle, но реально таб заблокирован (агрессивные мобильные блокеры).
  | { kind: 'awaiting_payment'; priceId: string; url: string }
  // window.open вернул null — попап заблокирован (бывает после async-резюма
  // post-auth, когда transient activation истёк). НЕ редиректим текущую вкладку:
  // пейвол должен остаться. URL уже выписан — кнопка «Open checkout» дёрнет
  // window.open под фреш-гестуром, без второго похода в createCheckout.
  | { kind: 'popup_blocked'; priceId: string; url: string }
  // Юзер уже залогинен и has_active_subscription — показываем success-view.
  // Срабатывает либо после auth-resume (поллим getUser сразу после signIn),
  // либо когда /start-checkout вернул 409 hasActivePurchase. restored=true
  // меняет текст PurchaseSuccessView на «Subscription restored».
  | { kind: 'purchase_success'; restored: boolean }
  // После signIn ждём getUser({force:true}), пока не узнаем есть ли уже
  // active subscription. Без этого промежуточного state'а юзер видит
  // несколько секунд auth_gate'овский «серый экран» с уже скрытой формой.
  | { kind: 'verifying' };

type AuthPanelBlock = Extract<LayoutBlock, { type: 'auth_panel' }>;

function computePaywallSnapshot(
  open: boolean,
  state: LoadState,
  gate: GateState,
  purchased: boolean | undefined
): PaywallStateSnapshot {
  if (!open) return { open: false, view: null, error: null };
  if (purchased) return { open: true, view: 'purchased', error: null };
  if (state.status === 'idle' || state.status === 'loading') {
    return { open: true, view: 'loading', error: null };
  }
  if (state.status === 'error') {
    return { open: true, view: 'error', error: state.error };
  }
  if (gate.kind === 'support') return { open: true, view: 'support', error: null };
  if (gate.kind === 'auth_gate') return { open: true, view: 'auth', error: null };
  if (gate.kind === 'awaiting_payment') {
    return { open: true, view: 'awaiting_payment', error: null };
  }
  if (gate.kind === 'popup_blocked') {
    return { open: true, view: 'popup_blocked', error: null };
  }
  if (gate.kind === 'purchase_success') {
    return { open: true, view: 'purchased', error: null };
  }
  if (gate.kind === 'verifying' || gate.kind === 'direct_checkout_pending') {
    return { open: true, view: 'loading', error: null };
  }
  return { open: true, view: 'layout', error: null };
}

function sameSnapshot(a: PaywallStateSnapshot, b: PaywallStateSnapshot): boolean {
  return a.open === b.open && a.view === b.view && a.error === b.error;
}

export function PaywallRoot({
  client,
  open,
  onClose,
  onEvent,
  initialView,
  initialAuthMode,
  initialCheckoutPriceId,
  purchased,
  renew,
  onState,
  inline,
  locale
}: PaywallRootProps) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  // session держим в state, чтобы блоки (auth_panel) ре-рендерились на login/logout.
  // Без этого AuthPanel прочитал бы snapshot один раз и не схлопнулся бы после
  // успешного signin'а.
  const [authSession, setAuthSession] = useState<AuthSession | null>(
    () => client.auth?.getCachedSession() ?? null
  );
  const [gate, setGate] = useState<GateState>(() => {
    if (initialView === 'support') return { kind: 'support', origin: 'standalone' };
    if (initialView === 'auth') return { kind: 'auth_gate', origin: 'standalone' };
    if (initialView === 'checkout' && initialCheckoutPriceId) {
      return { kind: 'direct_checkout_pending', priceId: initialCheckoutPriceId };
    }
    return { kind: 'layout' };
  });
  // Стабильный флаг «текущая сессия модалки — direct-checkout». Берётся из
  // initialView на этапе mount/reset и держится до close: на error/already-paid
  // не падаем в layout с тарифами, а закрываем модалку и эмитим событие.
  const isDirectCheckout = initialView === 'checkout';
  // Защита от двойного auto-resume: useEffect ниже зависит от authSession,
  // и подписка onAuthChange может прислать одну и ту же сессию повторно
  // (refresh) — без флага мы дважды дёрнем createCheckout.
  const resumingRef = useRef(false);

  // State-machine bridge: эмитим snapshot когда меняется любое из
  // (open, state, gate, purchased). sameSnapshot гасит no-op'ы — например
  // переход loading→error меняет state.status, но если мы уже в error-вью
  // (иначе невозможно), эмит не повторится.
  const lastSnapshotRef = useRef<PaywallStateSnapshot | null>(null);
  useEffect(() => {
    if (!onState) return;
    const next = computePaywallSnapshot(open, state, gate, purchased);
    const prev = lastSnapshotRef.current;
    if (prev && sameSnapshot(prev, next)) return;
    lastSnapshotRef.current = next;
    onState(next);
  }, [open, state, gate, purchased, onState]);

  useEffect(() => {
    if (!client.auth) return;
    return client.auth.onAuthChange((_event, s) => setAuthSession(s));
  }, [client.auth]);

  // Live-обновление bootstrap'а: BillingClient.setBootstrap (preview-mode в
  // редакторе админки) или cross-tab storage.watch эмитят onBootstrapChange.
  // Перерендериваем модалку, только если она уже в ready-фазе — иначе
  // bootstrap-effect ниже сам подхватит свежий cached на open().
  // Guard: тесты передают stub-клиента без onBootstrapChange — skip silently.
  useEffect(() => {
    if (typeof client.onBootstrapChange !== 'function') return;
    return client.onBootstrapChange((data) => {
      setState((prev) =>
        prev.status === 'ready' ? { status: 'ready', data } : prev
      );
    });
  }, [client]);

  useEffect(() => {
    if (!open) return;
    if (state.status === 'ready' || state.status === 'loading') return;

    let cancelled = false;
    setState({ status: 'loading' });
    client
      .bootstrap()
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data });
        onEvent('ready', data);
        // Юзер уже подписан — host вызвал open() вслепую (без getAccess pre-check'а),
        // или просто из popup'а «Open paywall». Не показываем тарифы — переключаемся
        // в restored success-view. Эмитим purchase_completed чтобы host получил
        // согласованный сигнал, как из любых других путей (UserWatcher, 409 в
        // checkout, auth-resume). renew=true пропускает эту проверку — host явно
        // показывает «Renew»/«Upgrade», тарифы должны быть видны.
        //
        // standalone-flows (openSupport/openAuth/openSignup) пропускают этот
        // блок: host явно открыл саппорт/auth-форму, перетирать gate в restored
        // success — нарушение intent'а. Direct-checkout (paywall.checkout)
        // также проходит сюда — но restored-view там не показываем (headless
        // reject): эмитим purchase_completed{restored:true} и закрываем модалку,
        // host сам решит как сообщить юзеру.
        const isStandaloneView = initialView === 'support' || initialView === 'auth';
        if (data.user?.has_active_subscription && !renew && !isStandaloneView) {
          onEvent('purchase_completed', {
            priceId: initialCheckoutPriceId ?? null,
            sessionId: null,
            restored: true
          });
          if (isDirectCheckout) {
            onClose();
          } else {
            setGate({ kind: 'purchase_success', restored: true });
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const err =
          error instanceof PaywallError
            ? error
            : new PaywallError('unknown', 'Failed to load paywall', { cause: error });
        setState({ status: 'error', error: err });
        onEvent('error', err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  // Закрытие/повторное открытие модалки сбрасывает gate. Standalone-flows
  // (openSupport / openAuth) PaywallUI вызывает на уже смонтированном компоненте
  // через handle.update({initialView: 'support'|'auth'}) — useState-initializer
  // отрабатывает только на первом mount'е, поэтому без этого эффекта gate
  // оставался бы 'layout' (с тарифами) при последующих standalone open'ах.
  //
  // useLayoutEffect (не useEffect): после close gate уходит в 'layout', и при
  // следующем openAuth/openSupport обычный useEffect запускался ПОСЛЕ paint'а,
  // из-за чего юзер на один кадр видел тарифы вместо auth-формы (особенно
  // заметно в extension-popup'е, где RemoteAuth+RemoteBilling добавляют
  // транспортные RTT и main thread чаще yield'ит между render'ами).
  // useLayoutEffect синхронизирует gate ДО paint'а — flicker'а нет.
  useLayoutEffect(() => {
    if (!open) {
      setGate({ kind: 'layout' });
      resumingRef.current = false;
      return;
    }
    if (initialView === 'support') {
      setGate({ kind: 'support', origin: 'standalone' });
    } else if (initialView === 'auth') {
      setGate({ kind: 'auth_gate', origin: 'standalone' });
    } else if (initialView === 'checkout' && initialCheckoutPriceId) {
      setGate({ kind: 'direct_checkout_pending', priceId: initialCheckoutPriceId });
    }
  }, [open, initialView, initialCheckoutPriceId]);

  const runCheckout = async (priceId: string) => {
    try {
      const result = await client.createCheckout({
        priceId,
        ignoreActivePurchase: renew === true
      });
      onEvent('checkout_started', { priceId, url: result.url, acquiring: result.acquiring });
      if (typeof window === 'undefined' || !result.url) return;
      // Без `noopener,noreferrer` в фичах: эти флаги заставляют window.open
      // ВСЕГДА вернуть null (даже когда попап реально открылся), и мы не
      // могли отличить «успех» от «заблокирован». Severance делаем вручную
      // через popup.opener=null после успеха — на checkout-домене (Stripe/
      // Paddle) opener-доступ всё равно cross-origin-restricted, но явный
      // null безопаснее.
      const popup = window.open(result.url, '_blank');
      if (popup) {
        try {
          popup.opener = null;
        } catch {
          /* cross-origin already — ok */
        }
        setGate({ kind: 'awaiting_payment', priceId, url: result.url });
      } else {
        // Попап заблокирован — обычно из-за stale transient activation
        // (auto-resume после async signin). НЕ уносим юзера через
        // location.assign: пейвол должен остаться открытым. Показываем
        // inline retry; клик по кнопке — fresh gesture, попап откроется.
        setGate({ kind: 'popup_blocked', priceId, url: result.url });
      }
    } catch (error) {
      // 409 hasActivePurchase от бэка — это не ошибка чекаута, это «у юзера
      // уже есть активная подписка». Освежаем cache (host'овский userChange
      // должен увидеть has_active_subscription=true), эмитим purchase_completed
      // с restored=true. Для layout-flow переключаемся в success-view; для
      // direct-checkout (paywall.checkout) — headless reject: закрываем
      // модалку, host сам решит как сообщить юзеру.
      if (error instanceof PaywallError && error.code === 'already_purchased') {
        try {
          await client.getUser({ force: true });
        } catch {
          /* offline / 401 — host'у getUser сам отрапортует, тут это не блокирует success-view */
        }
        onEvent('purchase_completed', { priceId, sessionId: null, restored: true });
        if (isDirectCheckout) {
          onClose();
        } else {
          setGate({ kind: 'purchase_success', restored: true });
        }
        return;
      }
      const err =
        error instanceof PaywallError
          ? error
          : new PaywallError('checkout_failed', 'Checkout failed', { cause: error });
      onEvent('error', err);
      // Layout-flow: возвращаем юзера в layout — иначе застрянем в auth_gate
      // (если пришли через preauth-flow) с уже залогиненной сессией.
      // Direct-checkout: layout с тарифами никогда не должен светиться —
      // закрываем модалку, host получит error-эвент и решит как реагировать.
      if (isDirectCheckout) {
        onClose();
      } else {
        setGate({ kind: 'layout' });
      }
    }
  };

  const reopenCheckout = (priceId: string, url: string) => {
    if (typeof window === 'undefined') return;
    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        /* ignore */
      }
      setGate({ kind: 'awaiting_payment', priceId, url });
    }
    // Если и сейчас null — оставляем popup_blocked, юзер кликнет ещё раз.
  };

  // Auto-resume: появилась сессия в открытом gate → продолжаем флоу.
  // Pending preauth-checkout — НЕ схлопываем gate в layout до runCheckout:
  // иначе юзер видит мигание тарифов между submit'ом auth-формы и открытием
  // чекаут-вкладки. runCheckout сам переведёт gate в awaiting_payment /
  // popup_blocked / layout (на ошибке). Restore-flow без pendingCheckout —
  // просто возвращаемся в layout. resumingRef защищает от повторного запуска,
  // если authChange сработает несколько раз за один gate-цикл (refresh).
  useEffect(() => {
    if (gate.kind !== 'auth_gate') return;
    // Анон-сессия не считается логином: юзер пришёл в auth_gate реально
    // залогиниться. Иначе openAuth() при существующем анон-токене мгновенно
    // закрывал бы модалку через auto-resume, и формы он бы не увидел.
    if (!authSession || authSession.user.is_anonymous) return;
    if (resumingRef.current) return;
    resumingRef.current = true;
    const pending = gate.pendingCheckout;
    const origin = gate.origin;
    // Сразу переключаемся в verifying — иначе модалка висит в auth_gate с
    // уже залогиненным юзером (~3с пока getUser ходит к бэку), и юзер видит
    // «пустой серый экран» вместо progress'а. Loader честнее показывает что
    // SDK что-то делает.
    setGate({ kind: 'verifying' });
    void (async () => {
      // Прежде чем продолжать flow (runCheckout / возврат в layout / закрытие
      // модалки), проверяем — может, у юзера уже есть active subscription.
      // Сценарии: Restore-кнопка (он уже платил с другого аккаунта); preauth
      // signIn (юзер вспомнил, что подписка есть); standalone openAuth;
      // direct-checkout с preauth-gate'ом.
      // Без этой проверки юзер увидел бы тарифы и кликнул Buy → 409 от бэка
      // → fallback на already_purchased. Лучше не давать ему этот шаг.
      // renew=true пропускает проверку — host явно делает renewal-flow.
      if (!renew) {
        try {
          const user = await client.getUser({ force: true });
          if (user.has_active_subscription) {
            onEvent('purchase_completed', {
              priceId: pending?.priceId ?? null,
              sessionId: null,
              restored: true
            });
            // Direct-checkout preauth-resume: тарифы не показываем, restored-
            // view тоже (headless reject) — закрываем модалку. Host получит
            // purchase_completed{restored:true} и решит как сообщить юзеру.
            if (pending?.direct) {
              onClose();
            } else {
              setGate({ kind: 'purchase_success', restored: true });
            }
            return;
          }
        } catch {
          /* getUser упал — продолжаем обычный flow, юзер увидит тарифы */
        }
      }
      if (!pending) {
        // openAuth standalone: после signIn закрываем модалку, layout не показываем.
        // Restore-flow (origin='layout' или undefined): возвращаемся в layout.
        if (origin === 'standalone') {
          onClose();
        } else {
          setGate({ kind: 'layout' });
        }
        return;
      }
      await runCheckout(pending.priceId);
    })().finally(() => {
      resumingRef.current = false;
    });
  }, [authSession, gate]);

  // Direct-checkout kick-off: gate в 'direct_checkout_pending' ждёт bootstrap.
  // Как только state.ready — повторяем ту же ветку, что cta_button делает в
  // layout (handleAction('checkout')): preauth-gate если нужен, иначе сразу
  // runCheckout. has_active_subscription уже обработан в bootstrap-эффекте
  // выше (там либо setGate в purchase_success для layout-flow, либо onClose
  // для direct-checkout); сюда мы попадём только если юзер реально нуждается
  // в покупке.
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (gate.kind !== 'direct_checkout_pending') return;
    const priceId = gate.priceId;
    const mode = state.data.settings.checkout_mode ?? 'guest';
    const cachedSession = client.auth?.getCachedSession() ?? null;
    const hasRealSession = !!cachedSession && !cachedSession.user.is_anonymous;
    const needsAuth = mode === 'preauth' && !!client.auth && !hasRealSession;
    if (needsAuth) {
      // direct=true — auth-resume effect выберет onClose вместо purchase_success
      // если юзер окажется уже подписан, и runCheckout (через ошибку) тоже
      // закроет модалку вместо setGate('layout').
      setGate({ kind: 'auth_gate', pendingCheckout: { priceId, direct: true } });
      return;
    }
    void runCheckout(priceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, gate]);

  const handleAction = async (action: string, payload?: unknown) => {
    if (action === 'close') {
      onClose();
      return;
    }
    if (action === 'price_selected') {
      // Пробрасываем как есть — блок уже собрал { priceId, price }.
      onEvent('price_selected', payload);
      return;
    }
    if (action === 'restore') {
      // CurrentSession-блок: гость кликнул "Restore purchases". Открываем
      // gate с intent='restore' — заголовок и submit станут "Restore Purchases".
      // Без AuthClient'а ничего не делаем (managed-auth не подключён).
      // Анон-сессия не считается логином (см. CurrentSession-блок): она
      // существует только для api-gateway-токена, у юзера нет email и
      // ему нужен realsignin чтобы привязать прошлую покупку. Без этой
      // проверки кнопка Restore молча no-op'ила бы как только у юзера
      // появлялся анон-токен (что в extension'ах — почти всегда).
      if (!client.auth) return;
      const session = client.auth.getCachedSession();
      if (session && !session.user.is_anonymous) return;
      setGate({ kind: 'auth_gate', intent: 'restore' });
      return;
    }
    if (action === 'support') {
      // CurrentSession-блок: открыть саппорт-форму. Видна и гостю, и залогиненному.
      // Из layout — Back возвращает к тарифам.
      setGate({ kind: 'support', origin: 'layout' });
      return;
    }
    if (action === 'checkout' && state.status === 'ready') {
      const priceId = (payload as { priceId?: string } | undefined)?.priceId;
      if (!priceId) {
        onEvent('error', new PaywallError('no_price', 'No price selected'));
        return;
      }
      const mode = state.data.settings.checkout_mode ?? 'guest';
      // Анон-сессия не покрывает preauth-требование: чекаут под анон-токеном
      // создаст подписку под аккаунтом без email, который юзер потом не
      // сможет восстановить. Анон считается «нет логина», нужен real signin.
      const cachedSession = client.auth?.getCachedSession() ?? null;
      const hasRealSession = !!cachedSession && !cachedSession.user.is_anonymous;
      const needsAuth = mode === 'preauth' && !!client.auth && !hasRealSession;
      if (needsAuth) {
        setGate({ kind: 'auth_gate', pendingCheckout: { priceId } });
        return;
      }
      await runCheckout(priceId);
    }
  };

  const brand = state.status === 'ready' ? state.data.settings.brand_color : null;
  // allow_close=undefined трактуем как true (default до bootstrap'а — пейвол
  // должен быть закрываемым во время loading/error, иначе юзера запрёт). После
  // ready settings.allow_close=false запретит ESC/overlay/крестик.
  const allowClose =
    state.status === 'ready' ? state.data.settings.allow_close !== false : true;

  // Offer top-tab: только на основном layout-view (цены/фичи). На auth/support
  // экранах banner не имеет смысла — юзер уже за пределами «купить сейчас»
  // flow'а, urgency-таймер только отвлекает. Зеркало легаси PaywallModal,
  // где offer-banner был привязан к route='paywall'.
  const isLayoutView =
    gate.kind === 'layout' && state.status === 'ready';
  const activeOffer = isLayoutView ? pickActiveOffer(state.data.offers) : null;
  const topBanner = activeOffer ? <OfferTopBanner offer={activeOffer} /> : null;

  const gateBlock: AuthPanelBlock = {
    type: 'auth_panel',
    // Заголовок не задаём — AuthGate сам решит по intent'у (restore →
    // "Restore Purchases", остальные → дефолтный "Welcome back!").
    allow_signup: true,
    allow_password_reset: true,
    // Не скрываем при наличии сессии — auto-resume useEffect отрабатывает быстрее,
    // чем хотим показывать "Signed in as ..." промежуточным экраном.
    hide_when_authenticated: false,
    providers: state.status === 'ready' ? state.data.settings.auth_providers : undefined
  };

  // Support-view имеет приоритет над bootstrap-state: standalone-открытие
  // (paywall.openSupport()) должно работать даже если bootstrap ещё грузится
  // или упал — сама форма от settings/prices не зависит. Из layout-режима
  // Back возвращает к тарифам, из standalone — закрывает модалку.
  const supportView =
    gate.kind === 'support' ? (
      <SupportGate
        client={client}
        authSession={authSession}
        origin={gate.origin}
        onBack={() => {
          if (gate.origin === 'standalone') onClose();
          else setGate({ kind: 'layout' });
        }}
      />
    ) : null;

  // В gate-view'ах AuthGate/SupportGate сами рисуют curved Back-кнопку в
  // правом верхнем углу. Modal'овский X-крестик там же — две кнопки накладывались
  // бы друг на друга. ESC/overlay-клик остаются рабочими (если allowClose=true).
  // Standalone openAuth() — AuthGate не рисует Back (модалка открыта только
  // ради signin'а, layout некуда возвращаться); тогда X-крестик нужен, иначе
  // юзеру некуда деться кроме ESC.
  const hideCloseButton =
    (gate.kind === 'auth_gate' && gate.origin !== 'standalone') ||
    gate.kind === 'support';

  const bootstrapForI18n = state.status === 'ready' ? state.data : null;

  return (
    <I18nProvider bootstrap={bootstrapForI18n} forceLocale={locale}>
    <Modal
      open={open}
      onClose={onClose}
      brandColor={brand}
      topBanner={topBanner}
      allowClose={allowClose}
      hideCloseButton={hideCloseButton}
      inline={inline}
      labelledBy="pw-title"
    >
      {purchased ? (
        <PurchaseSuccessView onContinue={onClose} />
      ) : gate.kind === 'purchase_success' ? (
        <PurchaseSuccessView restored={gate.restored} onContinue={onClose} />
      ) : supportView ? (
        supportView
      ) : state.status === 'loading' || state.status === 'idle' || gate.kind === 'verifying' || gate.kind === 'direct_checkout_pending' ? (
        <LoadingView verifying={gate.kind === 'verifying'} />
      ) : state.status === 'error' ? (
        <ErrorView message={state.error.message} />
      ) : gate.kind === 'auth_gate' && client.auth ? (
        <AuthGate
          block={gateBlock}
          bootstrap={state.data}
          auth={client.auth}
          authSession={authSession}
          // standalone (paywall.openAuth()) — модалка открыта только ради
          // signin'а, Back-кнопка дублирует ESC/X. Скрываем. Для preauth/
          // restore-flow Back ведёт обратно в layout — оставляем.
          showBack={gate.origin !== 'standalone'}
          intent={gate.intent ?? (gate.origin === 'standalone' ? 'standalone' : 'preauth')}
          initialMode={gate.origin === 'standalone' ? initialAuthMode : undefined}
          onBack={() => {
            if (gate.origin === 'standalone') onClose();
            else setGate({ kind: 'layout' });
          }}
        />
      ) : gate.kind === 'awaiting_payment' ? (
        <AwaitingPaymentView
          client={client}
          onBack={() => setGate({ kind: 'layout' })}
          onReopen={() => {
            if (typeof window === 'undefined') return;
            const popup = window.open(gate.url, '_blank');
            if (popup) {
              try {
                popup.opener = null;
              } catch {
                /* ignore */
              }
            }
          }}
          onRetry={() => runCheckout(gate.priceId)}
        />
      ) : gate.kind === 'popup_blocked' ? (
        <PopupBlockedView onReopen={() => reopenCheckout(gate.priceId, gate.url)} />
      ) : (
        <Renderer
          layout={state.data.layout!}
          bootstrap={state.data}
          onAction={handleAction}
          auth={client.auth}
          authSession={authSession}
        />
      )}
    </Modal>
    </I18nProvider>
  );
}

function LoadingView({ verifying }: { verifying: boolean }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center justify-center gap-3 py-12">
      <span class="inline-block h-7 w-7 animate-spin rounded-full border-[2.5px] border-gray-200 border-t-[var(--pw-accent)]" />
      <span class="text-xs font-medium tracking-wide text-gray-500">
        {verifying
          ? t('modal.verifying_subscription', 'Checking your subscription…')
          : t('modal.loading', 'Loading…')}
      </span>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center gap-2 py-8 text-center">
      <div class="flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 6v5M10 14h.01" stroke="#dc2626" stroke-width="2" stroke-linecap="round" />
          <circle cx="10" cy="10" r="8" stroke="#dc2626" stroke-width="1.75" />
        </svg>
      </div>
      <p class="text-sm font-semibold tracking-tight text-gray-900">
        {t('modal.error_generic', 'Something went wrong')}
      </p>
      <p class="text-xs leading-relaxed text-gray-500">{message}</p>
    </div>
  );
}

function PopupBlockedView({ onReopen }: { onReopen: () => void }) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center gap-3 py-8 text-center">
      <div
        class="flex h-11 w-11 items-center justify-center rounded-full"
        style={{ background: 'color-mix(in srgb, var(--pw-accent) 12%, white)', color: 'var(--pw-accent)' }}
        aria-hidden="true"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M4 5h12v10H4z" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" />
          <path d="M7 9l3 3 4-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <p class="text-sm font-semibold tracking-tight text-gray-900">
        {t('payment.popup_blocked_title', 'Allow popups to continue')}
      </p>
      <p class="max-w-[18rem] text-xs leading-relaxed text-gray-500">
        {t('payment.popup_blocked_message', 'Your browser blocked the checkout tab. Click below to open it.')}
      </p>
      <button
        type="button"
        onClick={onReopen}
        class="mt-1 rounded-xl px-4 py-2 text-xs font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
          boxShadow:
            '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
        }}
      >
        {t('payment.open_checkout_button', 'Open checkout')}
      </button>
    </div>
  );
}

// Экран ожидания после window.open(checkoutUrl). UserWatcher в PaywallUI уже
// poll'ит user-state раз в 5s (visible вкладка) — этот экран только UI-обёртка.
//
// «I've paid» — для нетерпеливых: форсим getUser({force:true}), чтобы cache
// обновился сразу, и постим внутрь окна 'paywall_purchase' message — этого
// ждёт UserWatcher.handleMessage и сразу же тригерит свой check(). Если
// подписка ещё не активна (webhook не дошёл), показываем inline-таймаут на 5s.
//
// «Open checkout again» — fallback для случая «window.open отдал handle, но таб
// заблокирован» (агрессивные мобильные блокеры). Дёргает existing URL без
// похода в createCheckout, не сбивая awaiting_payment state.
//
// «Tab closed? Try again» — крайний случай: URL у Stripe/Paddle/etc. может
// expire'нуться, поэтому пересоздаём checkout. Менее prominent кнопка.
function AwaitingPaymentView({
  client,
  onBack,
  onReopen,
  onRetry
}: {
  client: BillingClient;
  onBack: () => void;
  onReopen: () => void;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  const [stillPending, setStillPending] = useState(false);
  const stillPendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (stillPendingTimerRef.current !== null) {
        clearTimeout(stillPendingTimerRef.current);
      }
    };
  }, []);

  const handleVerify = async () => {
    if (checking) return;
    setChecking(true);
    setStillPending(false);
    try {
      const user = await client.getUser({ force: true });
      if (user.has_active_subscription) {
        // Будит UserWatcher — он сразу же сделает check(), увидит fresh active
        // user из cache и эмитит purchase_completed (PaywallUI переведёт в
        // PurchaseSuccessView). Не эмитим purchase_completed напрямую отсюда —
        // single source of truth остаётся в watcher.onActive.
        if (typeof window !== 'undefined') {
          window.postMessage({ type: 'paywall_purchase' }, '*');
        }
        return;
      }
      // Webhook ещё не дошёл — показываем подсказку и через 5s сворачиваем,
      // чтобы юзер мог нажать ещё раз. setTimeout cancel'нется на unmount.
      setStillPending(true);
      if (stillPendingTimerRef.current !== null) {
        clearTimeout(stillPendingTimerRef.current);
      }
      stillPendingTimerRef.current = setTimeout(() => {
        setStillPending(false);
        stillPendingTimerRef.current = null;
      }, 5000);
    } catch {
      setStillPending(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div class="flex flex-col gap-3 px-6 pb-6 pt-4 sm:px-8 sm:pb-8 sm:pt-5">
      <button
        type="button"
        onClick={onBack}
        class="-ml-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {t('nav.back', '← Back')}
      </button>
      <div class="flex flex-col items-center gap-3 py-6 text-center">
        <div class="relative flex h-12 w-12 items-center justify-center">
          <span
            class="absolute inset-0 animate-ping rounded-full opacity-40"
            style={{ background: 'color-mix(in srgb, var(--pw-accent) 30%, transparent)' }}
            aria-hidden="true"
          />
          <span class="relative inline-block h-7 w-7 animate-spin rounded-full border-[2.5px] border-gray-200 border-t-[var(--pw-accent)]" />
        </div>
        <p class="text-sm font-semibold tracking-tight text-gray-900">
          {t('payment.awaiting_title', 'Complete payment in the new tab')}
        </p>
        <p class="max-w-[20rem] text-xs leading-relaxed text-gray-500">
          {t(
            'payment.awaiting_subtitle',
            "We'll detect your payment automatically — or click below once you're done."
          )}
        </p>
        <button
          type="button"
          onClick={handleVerify}
          disabled={checking}
          class="mt-1 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:brightness-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
          style={{
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
            boxShadow:
              '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
          }}
        >
          {checking ? t('payment.checking', 'Checking…') : t('payment.ive_paid', "I've paid")}
        </button>
        {stillPending ? (
          <p class="text-xs leading-relaxed text-gray-500">
            {t('payment.still_processing', 'Payment is still being processed. Please try again in a moment.')}
          </p>
        ) : null}
      </div>
      <div class="rounded-2xl border border-gray-200 bg-gray-50/60 p-3.5">
        <p class="text-xs leading-relaxed text-gray-600">
          {t('payment.popup_help_text', "Checkout window didn't open or got blocked? Click here to open it again.")}
        </p>
        <button
          type="button"
          onClick={onReopen}
          class="mt-2.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          {t('payment.open_checkout_again', 'Open checkout again')}
        </button>
      </div>
      <button
        type="button"
        onClick={onRetry}
        class="self-center rounded-md px-2 py-1 text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        {t('payment.tab_closed_retry', 'Tab closed? Try again')}
      </button>
    </div>
  );
}

function PurchaseSuccessView({
  onContinue,
  restored = false
}: {
  onContinue: () => void;
  /** true — у юзера уже была активная подписка на момент попытки checkout
   *  (или после signIn выяснилось, что подписка есть). Меняет heading на
   *  «Subscription restored» — без этого юзер думает, что только что
   *  оплатил. */
  restored?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center gap-3 py-8 text-center">
      <div
        class="flex h-14 w-14 items-center justify-center rounded-full ring-8"
        style={{
          background: 'linear-gradient(135deg, #4ade80, #16a34a)',
          color: '#fff',
          // emerald ring with low alpha for a halo effect
          boxShadow: '0 0 0 8px rgba(74,222,128,0.12), 0 8px 20px -6px rgba(22,163,74,0.45)'
        }}
        aria-hidden="true"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13l4 4L19 7"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <p id="pw-title" class="mt-1 text-lg font-semibold tracking-tight text-gray-900">
        {restored
          ? t('modal.purchase_restored_title', 'Subscription restored')
          : t('modal.purchase_success_title', 'Payment received')}
      </p>
      <p class="text-sm leading-relaxed text-gray-500">
        {restored
          ? t(
              'modal.purchase_restored_subtitle',
              'Welcome back — your subscription is already active.'
            )
          : t('modal.purchase_success_subtitle', 'Your subscription is now active.')}
      </p>
      <button
        type="button"
        onClick={onContinue}
        class="mt-3 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
          boxShadow:
            '0 1px 2px rgba(15,23,42,0.08), 0 8px 20px -6px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
        }}
      >
        {t('modal.continue', 'Continue')}
      </button>
    </div>
  );
}
