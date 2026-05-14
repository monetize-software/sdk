import { h, render, type ComponentType } from 'preact';
import cssText from './styles.css?inline';

export interface MountHandle {
  update: (props: Record<string, unknown>) => void;
  unmount: () => void;
  shadowRoot: ShadowRoot;
}

// Tailwind v4 определяет утилиты вроде `.border` через `border-style: var(--tw-border-style)`,
// где значение `solid` задаётся реестровой проперти `@property --tw-border-style { initial-value: solid }`.
// В Chromium `@property`-объявления внутри shadow root не регистрируются document-wide, переменная
// остаётся пустой → IACVT → border-style: none → used border-width: 0. Чтобы шорткаты работали в
// shadow scope, регистрируем те же `@property` на уровне document один раз. `inherits: false`
// держит изоляцию: имя проперти видно глобально, но значения на host-страницу не утекают.
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
      // Уже зарегистрирована другим инстансом SDK на той же странице — ок.
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
    /** Inline-режим: host позиционируется `absolute inset:0` (не fixed),
     *  чтобы модалка осталась в границах своего родителя. Используется в
     *  live-preview редактора админки. Родитель ОБЯЗАН быть positioned
     *  (`position: relative|absolute|fixed`), иначе absolute уйдёт выше. */
    inline?: boolean;
  } = {}
): MountHandle {
  if (typeof document === 'undefined') {
    throw new Error('mountShadow called in non-DOM environment');
  }

  ensureTwPropertiesRegistered();

  const host = options.host ?? document.createElement('div');
  host.setAttribute('data-paywall-host', '');
  // Fixed-viewport (production) или absolute-внутри-host'а (inline preview).
  // pointer-events:none — клики проходят сквозь host'овую обёртку к шахмат-
  // ке формы редактора; mountPoint ниже сам себе включит auto.
  host.style.cssText = options.inline
    ? 'all: initial; position: absolute; inset: 0; z-index: 1; pointer-events: none;'
    : 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  // Без host'а из options и без inline — крепим к body. Inline ожидает, что
  // host уже находится в нужном parent'е (платформа передаёт hostRef).
  if (!host.isConnected && !options.inline) document.body.appendChild(host);

  // Дефолт `closed` — изоляция от хост-страницы. В e2e/demo тестах
  // включаем `open` через опцию, иначе Playwright не проходит через
  // shadow boundary accessibility-снапшотом и не кликает по внутренним кнопкам.
  const shadow = host.attachShadow({ mode: options.shadowMode ?? 'closed' });

  // Защита от протечки наследуемых свойств (color, font, letter-spacing, text-transform,
  // cursor, visibility) с host-страницы внутрь shadow через host-элемент. `!important`
  // в shadow перебивает внешний `!important` на host (спека CSS Scoping).
  // Рендер-фильтры (filter, transform, opacity) на ancestors защитить нельзя —
  // они применяются на уровне композитинга.
  const hostReset = `
:host {
  all: initial !important;
  display: block !important;
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
