import { useEffect, useRef, useState } from 'preact/hooks';
import type { BillingClient } from '../core/BillingClient';
import type { AuthSession } from '../core/auth';
import type { LayoutBlock, PaywallBootstrap } from '../core/types';
import { PaywallError } from '../core/types';
import { Modal } from './Modal';
import { AuthGate } from './AuthGate';
import { AnonGate } from './AnonGate';
import { SupportGate } from './SupportGate';
import { Renderer } from './renderer/Renderer';

export type PaywallView = 'layout' | 'support' | 'auth' | 'anon';

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
    | 'anon'
    | 'support'
    | 'awaiting_payment'
    | 'popup_blocked'
    | 'purchased'
    | null;
  /** Заполнено только когда `view === 'error'`. */
  error: PaywallError | null;
}

// 'anon' — отдельная вью для signInAnonymously (silent resume / fresh signin).
// Не сливается с 'auth', потому что UX разный: auth — формы email/oauth,
// anon — спиннер без интеракции; и flow завершения тоже разный (анон не идёт
// через has_active_subscription pre-check после signin'а).

export interface PaywallRootProps {
  client: BillingClient;
  open: boolean;
  onClose: () => void;
  onEvent: (event: string, payload?: unknown) => void;
  /** Какой view показать при open=true. 'support' стартует сразу с саппорт-формой,
   *  Back/Done закрывают модалку (origin='standalone'). По умолчанию 'layout'. */
  initialView?: PaywallView;
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
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: PaywallBootstrap }
  | { status: 'error'; error: PaywallError };

type GateState =
  | { kind: 'layout' }
  // pendingCheckout=undefined, origin='layout' — gate открыт через "Restore purchases"
  // (без последующего checkout-а), после signIn схлопываемся в layout. С
  // pendingCheckout — gate открыт по preauth-flow от cta_button и после signIn
  // auto-resume createCheckout. origin='standalone' — paywall.openAuth(): модалка
  // открыта только для логина, после signIn / Back закрываем модалку, layout
  // вообще не показываем.
  | {
      kind: 'auth_gate';
      pendingCheckout?: { priceId: string };
      origin?: 'layout' | 'standalone';
    }
  // origin='standalone' — paywall.openAnonGate(): модалка открыта только ради
  // анонимного логина, после signin'а закрываем модалку. origin='layout' — пока
  // не используется (анон-блока в layout нет), но оставляем для симметрии с
  // auth_gate на случай будущего inline-варианта.
  | {
      kind: 'anon_gate';
      origin: 'layout' | 'standalone';
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
  if (gate.kind === 'anon_gate') return { open: true, view: 'anon', error: null };
  if (gate.kind === 'awaiting_payment') {
    return { open: true, view: 'awaiting_payment', error: null };
  }
  if (gate.kind === 'popup_blocked') {
    return { open: true, view: 'popup_blocked', error: null };
  }
  if (gate.kind === 'purchase_success') {
    return { open: true, view: 'purchased', error: null };
  }
  if (gate.kind === 'verifying') {
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
  purchased,
  renew,
  onState,
  inline
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
    if (initialView === 'anon') return { kind: 'anon_gate', origin: 'standalone' };
    return { kind: 'layout' };
  });
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
        if (data.user?.has_active_subscription && !renew) {
          onEvent('purchase_completed', {
            priceId: null,
            sessionId: null,
            restored: true
          });
          setGate({ kind: 'purchase_success', restored: true });
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
  // отрабатывает только на первом mount'е, поэтому без этого useEffect'а gate
  // оставался бы 'layout' (с тарифами) при последующих standalone open'ах.
  useEffect(() => {
    if (!open) {
      setGate({ kind: 'layout' });
      resumingRef.current = false;
      return;
    }
    if (initialView === 'support') {
      setGate({ kind: 'support', origin: 'standalone' });
    } else if (initialView === 'auth') {
      setGate({ kind: 'auth_gate', origin: 'standalone' });
    } else if (initialView === 'anon') {
      setGate({ kind: 'anon_gate', origin: 'standalone' });
    }
  }, [open, initialView]);

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
      // с restored=true и переключаемся в success-view. Не setGate в layout,
      // не onEvent('error') — иначе host увидит false-negative.
      if (error instanceof PaywallError && error.code === 'already_purchased') {
        try {
          await client.getUser({ force: true });
        } catch {
          /* offline / 401 — host'у getUser сам отрапортует, тут это не блокирует success-view */
        }
        onEvent('purchase_completed', { priceId, sessionId: null, restored: true });
        setGate({ kind: 'purchase_success', restored: true });
        return;
      }
      const err =
        error instanceof PaywallError
          ? error
          : new PaywallError('checkout_failed', 'Checkout failed', { cause: error });
      onEvent('error', err);
      // На ошибке возвращаем юзера в layout — иначе застрянем в auth_gate
      // (если пришли через preauth-flow) с уже залогиненной сессией.
      setGate({ kind: 'layout' });
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
      // signIn (юзер вспомнил, что подписка есть); standalone openAuth.
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
            setGate({ kind: 'purchase_success', restored: true });
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
      // gate без pendingCheckout — после signIn auto-resume просто схлопнётся.
      // Без AuthClient'а ничего не делаем (managed-auth не подключён).
      if (!client.auth) return;
      if (client.auth.getCachedSession()) return;
      setGate({ kind: 'auth_gate' });
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
      const needsAuth = mode === 'preauth' && !!client.auth && !client.auth.getCachedSession();
      if (needsAuth) {
        setGate({ kind: 'auth_gate', pendingCheckout: { priceId } });
        return;
      }
      await runCheckout(priceId);
    }
  };

  const brand = state.status === 'ready' ? state.data.settings.brand_color : null;
  const testMode = state.status === 'ready' ? !!state.data.settings.is_test_mode : false;
  // allow_close=undefined трактуем как true (default до bootstrap'а — пейвол
  // должен быть закрываемым во время loading/error, иначе юзера запрёт). После
  // ready settings.allow_close=false запретит ESC/overlay/крестик.
  const allowClose =
    state.status === 'ready' ? state.data.settings.allow_close !== false : true;

  const gateBlock: AuthPanelBlock = {
    type: 'auth_panel',
    heading: 'Sign in to continue',
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      brandColor={brand}
      testMode={testMode}
      allowClose={allowClose}
      inline={inline}
      labelledBy="pw-title"
    >
      {purchased ? (
        <PurchaseSuccessView onContinue={onClose} />
      ) : gate.kind === 'purchase_success' ? (
        <PurchaseSuccessView restored={gate.restored} onContinue={onClose} />
      ) : supportView ? (
        supportView
      ) : state.status === 'loading' || state.status === 'idle' || gate.kind === 'verifying' ? (
        <div class="flex flex-col items-center justify-center gap-3 py-12">
          <span class="inline-block h-7 w-7 animate-spin rounded-full border-[2.5px] border-gray-200 border-t-[var(--pw-accent)]" />
          <span class="text-xs font-medium tracking-wide text-gray-500">
            {gate.kind === 'verifying' ? 'Checking your subscription…' : 'Loading…'}
          </span>
        </div>
      ) : state.status === 'error' ? (
        <div class="flex flex-col items-center gap-2 py-8 text-center">
          <div class="flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 6v5M10 14h.01"
                stroke="#dc2626"
                stroke-width="2"
                stroke-linecap="round"
              />
              <circle cx="10" cy="10" r="8" stroke="#dc2626" stroke-width="1.75" />
            </svg>
          </div>
          <p class="text-sm font-semibold tracking-tight text-gray-900">Something went wrong</p>
          <p class="text-xs leading-relaxed text-gray-500">{state.error.message}</p>
        </div>
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
          onBack={() => {
            if (gate.origin === 'standalone') onClose();
            else setGate({ kind: 'layout' });
          }}
        />
      ) : gate.kind === 'anon_gate' && client.auth ? (
        <AnonGate
          auth={client.auth}
          // standalone — pure anon-flow (paywall.openAnonGate()). Закрываем
          // модалку после signin'а: host подцепит свежую session через
          // onAuthChange/onUserChange. Для layout-варианта возвращаемся в
          // тарифы; pendingCheckout анону не выписываем (анон по дизайну
          // не покупает — он юзает api-gateway без email).
          onSuccess={() => {
            if (gate.origin === 'standalone') onClose();
            else setGate({ kind: 'layout' });
          }}
          onBack={
            gate.origin === 'standalone'
              ? undefined
              : () => setGate({ kind: 'layout' })
          }
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
        <div class="flex flex-col items-center gap-3 py-8 text-center">
          <div
            class="flex h-11 w-11 items-center justify-center rounded-full"
            style={{ background: 'color-mix(in srgb, var(--pw-accent) 12%, white)', color: 'var(--pw-accent)' }}
            aria-hidden="true"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M4 5h12v10H4z"
                stroke="currentColor"
                stroke-width="1.75"
                stroke-linejoin="round"
              />
              <path d="M7 9l3 3 4-5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <p class="text-sm font-semibold tracking-tight text-gray-900">Allow popups to continue</p>
          <p class="max-w-[18rem] text-xs leading-relaxed text-gray-500">
            Your browser blocked the checkout tab. Click below to open it.
          </p>
          <button
            type="button"
            onClick={() => reopenCheckout(gate.priceId, gate.url)}
            class="mt-1 rounded-xl px-4 py-2 text-xs font-semibold text-white transition-all hover:-translate-y-px hover:brightness-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--pw-accent)]"
            style={{
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--pw-accent) 92%, white), var(--pw-accent))',
              boxShadow:
                '0 1px 2px rgba(15,23,42,0.08), 0 6px 14px -4px color-mix(in srgb, var(--pw-accent) 50%, transparent)'
            }}
          >
            Open checkout
          </button>
        </div>
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
    <div class="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        class="-ml-1 self-start rounded-md px-1.5 py-0.5 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        ← Back
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
        <p class="text-sm font-semibold tracking-tight text-gray-900">Complete payment in the new tab</p>
        <p class="max-w-[20rem] text-xs leading-relaxed text-gray-500">
          We'll detect your payment automatically — or click below once you're done.
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
          {checking ? 'Checking…' : "I've paid"}
        </button>
        {stillPending ? (
          <p class="text-xs leading-relaxed text-gray-500">
            Payment is still being processed. Please try again in a moment.
          </p>
        ) : null}
      </div>
      <div class="rounded-2xl border border-gray-200 bg-gray-50/60 p-3.5">
        <p class="text-xs leading-relaxed text-gray-600">
          Checkout window didn't open or got blocked? Click here to open it again.
        </p>
        <button
          type="button"
          onClick={onReopen}
          class="mt-2.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
        >
          Open checkout again
        </button>
      </div>
      <button
        type="button"
        onClick={onRetry}
        class="self-center rounded-md px-2 py-1 text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pw-accent)]"
      >
        Tab closed? Try again
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
        {restored ? 'Subscription restored' : 'Payment received'}
      </p>
      <p class="text-sm leading-relaxed text-gray-500">
        {restored
          ? 'Welcome back — your subscription is already active.'
          : 'Your subscription is now active.'}
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
        Continue
      </button>
    </div>
  );
}
