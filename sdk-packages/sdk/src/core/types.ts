export interface Identity {
  email?: string;
  userId?: string;
  anonymousId?: string;
}

export interface PaywallPrice {
  id: string;
  currency: string;
  amount: number;
  interval: 'month' | 'year' | 'week' | 'day' | 'lifetime' | null;
  interval_count: number | null;
  trial_days: number | null;
  label?: string | null;
  description?: string | null;
  local?: { currency: string; amount: number } | null;
}

export interface PaywallOffer {
  id: string;
  discount_percent: number | null;
  /** Absolute expiration date (ISO 8601). If set — the countdown runs down to
   *  this moment, and once it passes the offer is considered expired. */
  expires_at: string | null;
  /** Relative timer: how many minutes the offer lives **from this user's first
   *  paywall view**. The start is stored in clientStorage under the key
   *  `pw-offer-{id}-start` and stays there **after** expiry — it's a
   *  forever-marker, so the user can't "farm" the offer (re-opening the paywall
   *  doesn't restart the countdown). Used when the backend wants to show
   *  "remaining time" without strict server-time, computing it relative to the
   *  user's session instead. expires_at takes priority if set. */
  duration_minutes?: number | null;
  price_id: string | null;
  label?: string | null;
}

export interface PaywallSettings {
  id: string;
  name: string;
  brand_color?: string | null;
  custom_css?: string | null;
  locale_default?: string | null;
  /** Origin where the paywall backend lives (the same one the merchant passes
   *  in `BillingClientOptions.apiOrigin` when initializing the SDK). The
   *  backend sends it on every bootstrap, and the SDK checks it against
   *  init.apiOrigin — a mismatch yields `invalid_config` (protection against an
   *  integrator's typo). Without a scheme: "pay.your-domain.com" or
   *  "https://pay.your-domain.com" — both are valid. For new paywalls the field
   *  is always filled (moderation requires custom_domain); for legacy v2 it may
   *  be null/undefined. */
  custom_domain?: string | null;
  runtime_mode?: 'client' | 'hybrid' | 'server' | 'client-native' | 'hybrid-native';
  /** true if the paywall's acquiring is in test-mode — the SDK draws a TEST
   *  MODE badge. */
  is_test_mode?: boolean;
  /** Auth flow relative to checkout. `guest` (default) — no auth before
   *  payment; `preauth` — a click on cta_button=checkout first opens the
   *  AuthPanel gate, and after signIn auto-resumes the original createCheckout.
   *  Field shared with legacy v2. */
  checkout_mode?: 'guest' | 'preauth';
  /** OAuth providers for the preauth gate, in display order. The backend
   *  currently returns a fixed list (google + apple); if the field isn't set —
   *  the gate draws only the email form. Not to be confused with
   *  `block.providers` on the inline auth_panel block. */
  auth_providers?: Array<'google' | 'apple' | 'github' | 'facebook'>;
  /** Whether sign-in without an email — an anonymous user — is allowed.
   *  `paywall.signInAnonymously()` fails with code='anonymous_disabled' if the
   *  flag is false. The field mirrors `paywall_settings.allow_anonymous` from
   *  the DB, the same one used in legacy v2 (PayWallIframeOpener.tsx). Abuse
   *  protection is server-side (Supabase rate-limit per real-IP + CF Bot Fight
   *  Mode); no captcha is used in the SDK. */
  allow_anonymous?: boolean;
  /** Whether the modal can be closed (X button, overlay click, ESC). Defaults
   *  to true. false — the modal is shown until a successful purchase or an
   *  explicit host-close(). v2 analog `allow_close`. */
  allow_close?: boolean;
  /** Auto-fit the font size of the heading block so the title fits into 2
   *  lines. v2 analog `title_auto_fit`. Defaults to false. */
  title_auto_fit?: boolean;
  /** URL to redirect the tab to after a successful purchase (server-confirmed
   *  via UserWatcher). null/undefined — stay in place and show the
   *  PurchaseSuccessView. v2 analog `success_redirect_url`. */
  success_redirect_url?: string | null;
  /** "Back to shop" URL — passed into createCheckout as `shopUrl` for the
   *  Stripe/Paddle payment page. v2 analog `checkout_shop_url`. */
  checkout_shop_url?: string | null;
  /** Product name on the Stripe/Paddle payment page (line_item.name). The
   *  backend uses it when creating the checkout session. v2 analog
   *  `checkout_product_name`. */
  checkout_product_name?: string | null;
  /** Pre-paywall trial config (the paywall isn't shown while the trial is
   *  active). null/undefined — the trial is disabled and `paywall.open()` opens
   *  the modal right away. v2 analog of the `trial` + `trial_payload` pair in
   *  paywall_settings. Not to be confused with the card-trial
   *  (PaywallPrice.trial_days) — that's auto-charging after payment. */
  trial?: TrialConfig | null;
  /** Server-computed targeting gate: whether the current user (country/device)
   *  matches the paywall's targeting settings, plus a global on/off flag.
   *  Before open() the SDK reads `visible`: false → emits `visibility_blocked`
   *  and doesn't mount the modal. country/tier are always provided — hosts use
   *  them for analytics. v2 analog of `visibilityEnabledAndTargetingMatch` +
   *  `detectInvisible` in PaywallClient.tsx + StateService. */
  visibility?: VisibilityStatus;
}

export interface VisibilityStatus {
  /** true — the paywall can be opened. false — some targeting didn't match,
   *  see `reason`. */
  visible: boolean;
  /** Why `visible=false`. null when `visible=true`.
   *  - `disabled` — the owner turned off the visibility flag.
   *  - `country_not_match` — the user's country isn't in the whitelist
   *    (countries_tier + extra_countries).
   *  - `device_not_match` — the extension channel (device_target=true), the
   *    user isn't on macOS. Takes priority over country, because in this
   *    channel the device is the main condition.
   */
  reason: 'country_not_match' | 'device_not_match' | 'disabled' | null;
  /** ISO code of the user's country (by IP). null — couldn't be determined. */
  country: string | null;
  /** Country tier 1/2/3 (see legacy `new_country_code_to_tier`). null — the
   *  country couldn't be determined. All unmapped countries → 3. */
  tier: 1 | 2 | 3 | null;
}

export interface TrialConfig {
  /** `time` — the paywall is hidden for N hours after the first open();
   *  `opens` — the first N open() calls close silently, the (N+1)-th already
   *  shows the paywall. */
  mode: 'time' | 'opens';
  /** Hours for `time`, number of opens for `opens`. */
  payload: number;
  /** Where the trial state lives. `client` — localStorage (default, instant,
   *  the user can reset it by clearing storage). `server` — a server endpoint
   *  (a stub for now; will activate once a server handler exists). */
  storage: 'client' | 'server';
}

/** Trial status at the moment of `paywall.open()`. The SDK emits it in the
 *  payload of `trial_blocked` events, and returns it synchronously from
 *  `paywall.getTrialStatus()`. */
export type TrialStatus =
  | { mode: 'none'; blocked: false }
  | TimeTrialStatus
  | OpensTrialStatus;

export interface TimeTrialStatus {
  mode: 'time';
  /** true — the trial is still active, the paywall isn't shown. */
  blocked: boolean;
  /** Unix ms of the first `open()`. null — the trial hasn't started yet. */
  startedAt: number | null;
  /** Unix ms of the trial's end. null — the trial hasn't started yet. */
  expiresAt: number | null;
  /** How many more ms the trial is active. 0 — expired or not active. */
  remainingMs: number;
  /** Full trial length in ms (payload hours × 3_600_000). */
  totalMs: number;
}

export interface OpensTrialStatus {
  mode: 'opens';
  /** true — the trial is still active, the paywall isn't shown. */
  blocked: boolean;
  /** How many "free" opens are left. 0 — the trial has expired. */
  remainingActions: number;
  /** Total number of "free" opens (payload). */
  totalActions: number;
}

export type LayoutBlock =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'text'; text: string }
  | {
      type: 'price_grid';
      priceIds?: string[];
      /** Layout of the price cards:
       *  - `vertical` (default) — a stack of cards top to bottom;
       *  - `compact` — a compact list (one row per price, no card, with a
       *    divider); v2 analog `view: 'telegram'`;
       *  - `horizontal` — several cards side by side in a row; v2-only since
       *    SDK 3.0 (legacy doesn't offer this option in the admin panel). */
      view?: 'vertical' | 'compact' | 'horizontal';
      /** ID of the price marked with the "popular plan" label. v2 analog of the
       *  `price_label_id` + `price_label` pair. */
      popular_price_id?: string;
      /** Text of the "popular plan" label. Defaults to "Most popular".
       *  v2 analog `price_label_text`. Localization is via bootstrap.locales. */
      popular_label?: string;
    }
  | {
      type: 'cta_button';
      /** Text on the button. If not set — the renderer picks it itself based on
       *  the selected price and `trial_days`: "Start N-Day Free Trial",
       *  "Get Lifetime Access", "Get Monthly Plan", etc. */
      label?: string;
      action: 'checkout' | 'close';
      priceId?: string;
    }
  | {
      /** Footer block under cta_button: signed in — draws "Signed in as <email> | Sign out",
       *  otherwise — a "Restore purchases" button that opens the auth-gate without
       *  pendingCheckout (after signIn the gate just collapses and the user sees
       *  their signed-in state). */
      type: 'current_session';
    }
  | {
      type: 'auth_panel';
      /** OAuth providers in display order. Empty/omitted — only the email form. */
      providers?: Array<'google' | 'apple' | 'github' | 'facebook'>;
      /** Show the "Sign up" toggle. Defaults to true. */
      allow_signup?: boolean;
      /** Show the "Forgot password?" link. Defaults to true. */
      allow_password_reset?: boolean;
      /** Hide the panel if the user is already signed in. Defaults to true.
       *  false — show "Signed in as ... [Sign out]" even after login. */
      hide_when_authenticated?: boolean;
      /** Custom heading above the form. If set — shown instead of the default
       *  (determined by mode — "Welcome back!" / "Welcome!" / "Forgot
       *  password?" / ...). Without `submit_label` it's also used as the submit
       *  label for signin (e.g. `heading="Restore Purchases"` → submit is also
       *  "Restore Purchases"). Long headings (like "Sign in to continue your
       *  purchase") fit poorly into the button — set `submit_label` separately. */
      heading?: string;
      /** Subheading under the heading. If omitted — the default text for the
       *  current mode is substituted. Pass an empty string to hide the
       *  subheading. */
      subheading?: string;
      /** Explicit text of the submit button. Takes priority over the heading
       *  echo. Needed for intents with a long descriptive heading (preauth:
       *  "Sign in to continue your purchase" — the button is just "Sign in").
       *  For short action-headings (restore: "Restore Purchases") omit it — the
       *  echo gives the right UX. */
      submit_label?: string;
    }
  | {
      /** List of product features/benefits. v2 analog `features_list` + `features_view`.
       *  Up to 5 items — rendered as a checklist with a title and description. */
      type: 'features_list';
      items: Array<{ id: string; name: string; desc?: string }>;
    }
  | {
      /** Informational list of "what's included in the selected plan" —
       *  rendered under price_grid, non-interactive. v2 analog `tokenization` +
       *  `tokenization_queries`. For each query we show a count multiplied by
       *  the interval multiplier of the selected price (`week=0.25`, `month=1`,
       *  `year=12`) — i.e. the count is stored in the DB as a monthly rate. The
       *  heading reactively reflects the current interval. */
      type: 'tokenization_gate';
      queries: Array<{ id: string; name: string; desc: string; count: number }>;
    }
  | {
      /** Money-back guarantee badge under cta_button: icon + bold title +
       *  small-font explanation + bottom divider that visually joins with
       *  current_session below. v2 analog of the inline block in
       *  `PaywallPricing`. */
      type: 'guarantee_badge';
      /** Bold title. Defaults to "100% Money-Back Guarantee". */
      title?: string;
      /** Subtitle in small gray. Defaults to
       *  "Not satisfied? We'll refund you — no questions asked.". */
      subtitle?: string;
      /** Icon to the left of the title. Defaults to `dollar_shield` —
       *  a green shield with a dollar sign (legacy look). `none` — no icon. */
      icon?: 'dollar_shield' | 'none';
    }
  | {
      /** Urgency banner with a countdown to the end of the offer. Takes the
       *  first offer from `bootstrap.offers` with a valid `expires_at` or
       *  `duration_minutes`. Auto-hides on expiry so it doesn't show
       *  "0d 0h 0m 0s". Placement — usually the first block in the layout
       *  (above the heading). */
      type: 'offer_banner';
      /** ID of a specific offer from bootstrap.offers. If not set — the first
       *  offer with an active timer is taken. */
      offer_id?: string;
      /** Text to the left of the countdown. If omitted — `offer.label` is used,
       *  otherwise the fallback "Limited-time offer". The percentage is
       *  appended to it: "{title} {discount_percent}%" if a discount is set. */
      title?: string;
      /** In the admin preview — ignore the expired state and show the banner
       *  with zeros anyway. Prod mode — false (the banner disappears). */
      force?: boolean;
    };

export interface Layout {
  type: 'modal';
  blocks: LayoutBlock[];
}

/** Localization overrides for a single language. Applied on top of the default
 *  layout/prices when `navigator.language` matches a key in `bootstrap.locales`.
 *  v2 analog of the `translations` JSON field in paywall_settings. */
export interface LocaleOverrides {
  /** Full layout replacement for the language. If omitted — the default
   *  bootstrap.layout is used. */
  layout?: Layout;
  /** Targeted overrides of price text fields. The key is price.id, the values
   *  are applied to label/description. */
  prices?: Record<string, { label?: string; description?: string }>;
}

/** Snapshot of language resolution for syncing the host app's i18n with what
 *  the paywall shows. Returned from `BillingClient.getUserLanguage()` /
 *  `PaywallUI.getUserLanguage()`. */
export interface UserLanguageInfo {
  /** Best-guess BCP-47 tag for the host. Priority: `applied` → `browserLanguage`
   *  → `countryLanguage`. null — bootstrap isn't loaded yet and navigator is
   *  unavailable (e.g. an early call in a service worker). */
  tag: string | null;
  /** The key from `bootstrap.locales` that the SDK actually applied to
   *  layout/prices. null = there was no match, the base from layout/prices is
   *  rendered without overrides. */
  applied: string | null;
  /** `navigator.language` — what the browser reports. null in environments
   *  without navigator (a service worker before patching, Node). */
  browserLanguage: string | null;
  /** Server-resolved language by the user's country (IP). Taken from
   *  `bootstrap.settings.locale_default` — AT→de, RU→ru, LV→en, etc. null —
   *  bootstrap isn't loaded yet or the server didn't return the field. */
  countryLanguage: string | null;
}

export interface PaywallUserPurchase {
  id: string;
  status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
}

/** Rich shape from `/api/v1/paywall/[id]/user` for customer-portal UX (cancel,
 *  renew, payment history). Unlike `PaywallUserPurchase` (which comes from
 *  `/user-state` and has the minimum needed for the access gate), this shape
 *  includes price/currency/discount — so the host can draw a subscription list
 *  like in the legacy customer portal. */
export interface PaywallPurchaseDetailed {
  id: string;
  status: string | null;
  cancel_at: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  created: string;
  ended_at: string | null;
  current_period_end: string | null;
  current_period_start: string | null;
  /** Price in minor units (cents). For legacy compatibility — sometimes from
   *  `paywall_internal_prices.unit_amount * 100`, sometimes from local_amount. */
  unit_amount: number;
  currency: string;
  interval: string | null;
  /** Discount percentage from the offer (if one was applied). undefined — no
   *  offer. */
  discount?: number;
}

export interface PaywallUser {
  /** The main flag for most integrations. true if there's an active
   *  subscription OR a paid lifetime OR an active trial. */
  has_active_subscription: boolean;
  purchases: PaywallUserPurchase[];
  trial: { started_at: string | null; expires_at: string | null } | null;
  /** Whether the user has ever had at least one trial on this paywall
   *  (including expired and cancelled ones). An anti-abuse flag for the UI:
   *  CtaButton hides "Start N-Day Free Trial" if true. Server enforcement in
   *  `/start-checkout` duplicates it — even if the UI is tricked, the backend
   *  won't pass trial_days to Stripe/Paddle. */
  had_previous_trial: boolean;
}

export interface PaywallBootstrap {
  settings: PaywallSettings;
  prices: PaywallPrice[];
  offers: PaywallOffer[];
  layout?: Layout;
  /** User-state snapshot at the moment of bootstrap. Without identity (guest)
   *  — everything is empty. Then updated via BillingClient.getUser() /
   *  PaywallUI.onUserChange. */
  user?: PaywallUser;
  /** Localization overrides by BCP-47 codes (`en`, `en-US`, `ru`, ...).
   *  BillingClient.bootstrap() matches `navigator.language` with a fallback to
   *  `settings.locale_default` and applies overrides on top of layout/prices. */
  locales?: Record<string, LocaleOverrides>;
  /** Stable content-hash of the structural part of bootstrap (without user).
   *  The SDK persists the payload in StorageAdapter and sends `?if_version=<v>`
   *  on revalidation — the backend responds `{unchanged:true, version, user}`
   *  without the full payload if the version matches. Optional for
   *  compatibility with old backends. */
  version?: string;
}

export type Acquiring = 'stripe' | 'paddle' | 'chargebee' | 'overpay' | 'freemius';

export interface CheckoutResult {
  url: string;
  sessionId?: string;
  /** The payment processor the checkout went to. Useful for conversion
   *  analytics by acquiring (the host can branch UX by acquiring). */
  acquiring?: Acquiring;
}

export class PaywallError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(code: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'PaywallError';
    this.code = code;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

/** Balances of the paywall's AI providers: one element per `query_type` from
 *  `paywall_settings.tokenization_queries`. count = available calls. */
export interface Balance {
  type: string;
  count: number;
}

/** 402 from the api-gateway: the quota ran out. The UI catches it and opens the
 *  paywall; a headless caller handles it itself. balances/queryType/currentBalance
 *  are the same as the backend returns in `details`. */
export class QuotaExceededError extends PaywallError {
  readonly balances: Balance[];
  readonly queryType: string;
  readonly currentBalance: Balance | null;

  constructor(input: {
    balances: Balance[];
    queryType: string;
    currentBalance: Balance | null;
    message?: string;
  }) {
    super('not_enough_queries', input.message ?? 'Not enough queries', {
      status: 402
    });
    this.name = 'QuotaExceededError';
    this.balances = input.balances;
    this.queryType = input.queryType;
    this.currentBalance = input.currentBalance;
  }
}
