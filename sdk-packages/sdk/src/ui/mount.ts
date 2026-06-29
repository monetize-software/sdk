import { h, render, type ComponentType } from 'preact';
import cssText from './styles.css?inline';

export interface MountHandle {
  update: (props: Record<string, unknown>) => void;
  unmount: () => void;
  shadowRoot: ShadowRoot;
}

// Tailwind v4 defines utilities like `.border` via `border-style: var(--tw-border-style)`,
// where the `solid` value is supplied by the registered property `@property --tw-border-style { initial-value: solid }`.
// In Chromium, `@property` declarations inside a shadow root are not registered document-wide, so the variable
// stays empty → IACVT → border-style: none → used border-width: 0. To make the shorthands work in the
// shadow scope, we register the same `@property` at the document level once. `inherits: false`
// keeps the isolation: the property name is visible globally, but values don't leak onto the host page.
let twPropertiesRegistered = false;
function ensureTwPropertiesRegistered(): void {
  if (twPropertiesRegistered) return;
  twPropertiesRegistered = true;
  if (typeof CSS === 'undefined' || typeof CSS.registerProperty !== 'function') return;
  let rules: CSSRuleList;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    rules = sheet.cssRules;
  } catch {
    return;
  }
  for (const rule of rules) {
    if (rule.constructor.name !== 'CSSPropertyRule') continue;
    const r = rule as CSSRule & { name: string; syntax: string; inherits: boolean; initialValue: string | null };
    try {
      CSS.registerProperty({
        name: r.name,
        syntax: r.syntax,
        inherits: r.inherits,
        ...(r.initialValue != null ? { initialValue: r.initialValue } : {})
      });
    } catch {
      // Already registered by another SDK instance on the same page — fine.
    }
  }
}

export function mountShadow<P extends object>(
  Component: ComponentType<P>,
  props: P,
  options: {
    host?: HTMLElement;
    injectCss?: string;
    shadowMode?: 'open' | 'closed';
    /** Inline mode: the host is positioned `absolute inset:0` (not fixed),
     *  so the modal stays within the bounds of its parent. Used in the
     *  admin editor's live preview. The parent MUST be positioned
     *  (`position: relative|absolute|fixed`), otherwise absolute escapes upward. */
    inline?: boolean;
  } = {}
): MountHandle {
  if (typeof document === 'undefined') {
    throw new Error('mountShadow called in non-DOM environment');
  }

  ensureTwPropertiesRegistered();

  const host = options.host ?? document.createElement('div');
  host.setAttribute('data-paywall-host', '');
  // `all: initial` neutralises inheritance; the actual layout (position/inset/z-index)
  // is asserted in the `:host` rule below with `!important`. We can NOT rely on these
  // inline declarations: the shadow's `:host { all: initial !important }` is an
  // important author rule and overrides even an `!important` inline style on the host
  // (verified in Chromium) — so without the `:host` layout the host computes to
  // `position: static`. Kept here only as a harmless fallback layer.
  host.style.cssText = options.inline
    ? 'all: initial; position: absolute; inset: 0; z-index: 1; pointer-events: none;'
    : 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  // Without a host from options and without inline — attach to body. Inline expects
  // the host to already be in the right parent (the platform passes hostRef).
  if (!host.isConnected && !options.inline) document.body.appendChild(host);

  // Top layer. `position: fixed` resolves against the viewport ONLY if no ancestor
  // establishes a containing block for fixed descendants (transform / filter /
  // perspective / will-change / contain / backdrop-filter). The host page is arbitrary
  // (content scripts, extension side panels, SPA roots) and such ancestors are common —
  // when present, the fixed overlay collapses into normal flow and the paywall becomes
  // invisible. Promoting the host into the top layer via the Popover API detaches it
  // from ancestor containing blocks entirely, so it always fills the viewport.
  // `manual` — no light-dismiss / Esc-close; the SDK manages its own lifecycle.
  // Feature-detected + try/catch: on older engines we silently fall back to the plain
  // fixed overlay (works on pages without a containing-block trap, the prior behaviour).
  if (!options.inline && host.isConnected && typeof (host as { showPopover?: unknown }).showPopover === 'function') {
    try {
      host.setAttribute('popover', 'manual');
      (host as { showPopover: () => void }).showPopover();
    } catch {
      // Already open, disconnected, or unsupported value — keep the fixed-overlay fallback.
      host.removeAttribute('popover');
    }
  }

  // Default `closed` — isolation from the host page. In e2e/demo tests
  // we enable `open` via the option, otherwise Playwright can't cross the
  // shadow boundary with its accessibility snapshot and can't click inner buttons.
  const shadow = host.attachShadow({ mode: options.shadowMode ?? 'closed' });

  // Guards against inherited properties (color, font, letter-spacing, text-transform,
  // cursor, visibility) leaking from the host page into the shadow via the host element. `!important`
  // in the shadow overrides an external `!important` on the host (CSS Scoping spec).
  // Render filters (filter, transform, opacity) on ancestors can't be guarded —
  // they apply at the compositing level.
  // Layout asserted here (not via the inline style) because `:host { all: initial !important }`
  // is what wins the cascade for the host element. Fixed-viewport in production, or
  // absolute-within-parent in the inline editor preview.
  const hostLayout = options.inline
    ? 'position: absolute !important; inset: 0 !important; z-index: 1 !important; pointer-events: none !important;'
    : 'position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;';
  const hostReset = `
:host {
  all: initial !important;
  display: block !important;
  ${hostLayout}
  color: #111827 !important;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !important;
  font-size: 16px !important;
  font-weight: 400 !important;
  font-style: normal !important;
  line-height: 1.5 !important;
  letter-spacing: normal !important;
  text-transform: none !important;
  text-decoration: none !important;
  text-align: left !important;
  direction: ltr !important;
  cursor: auto !important;
  visibility: visible !important;
}
`;

  const style = document.createElement('style');
  style.textContent = hostReset + cssText + (options.injectCss ?? '');
  shadow.appendChild(style);

  const mountPoint = document.createElement('div');
  mountPoint.style.pointerEvents = 'auto';
  shadow.appendChild(mountPoint);

  let currentProps = props;
  render(h(Component as ComponentType<object>, currentProps), mountPoint);

  return {
    shadowRoot: shadow,
    update(nextProps) {
      currentProps = { ...currentProps, ...nextProps } as P;
      render(h(Component as ComponentType<object>, currentProps), mountPoint);
    },
    unmount() {
      render(null, mountPoint);
      host.remove();
    }
  };
}
