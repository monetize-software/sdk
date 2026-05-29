// Имя port'а для chrome.runtime.connect. Отсеивает чужие подключения, чтобы
// SW-forwarder и offscreen-server слушали только свои. Если host использует
// runtime.connect для собственной логики — не будет ложных срабатываний.
export const PORT_NAME = '@monetize.software/sdk-extension';

// Отдельное имя для SW→offscreen relay-port'а. Нужно, потому что
// chrome.runtime.connect от popup/extension-page доставляется во ВСЕ
// extension contexts с onConnect listener'ом — в т.ч. в offscreen напрямую,
// минуя SW. Без разделения имён один popup.connect() создаёт ДВА port'а в
// offscreen (SW relay + direct), один send из popup приходит дважды → handler
// дублируется. Offscreen accept'ит только RELAY_PORT_NAME, direct PORT_NAME
// connects к нему игнорируются.
export const RELAY_PORT_NAME = '@monetize.software/sdk-extension/relay';
