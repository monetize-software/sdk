// Имя port'а для chrome.runtime.connect. Отсеивает чужие подключения, чтобы
// SW-forwarder и offscreen-server слушали только свои. Если host использует
// runtime.connect для собственной логики — не будет ложных срабатываний.
export const PORT_NAME = '@monetize.software/sdk-extension';
