// Скрипт, на который ссылается offscreen.html. Поднимает реальный сервер
// поверх offscreen-документа. Конфиг читается из URL-параметров (SW
// проставляет их при создании документа — chrome.storage недоступен внутри
// offscreen, URL — единственный канал начальной конфигурации).
import { startOffscreenServer } from '@monetize.software/sdk-extension/offscreen';

const params = new URLSearchParams(window.location.search);

startOffscreenServer({
  paywallId: params.get('paywallId') ?? '3',
  apiOrigin: params.get('apiOrigin') ?? 'https://onlineapp.stream',
  // auth: true в content-side PaywallUI создаёт RemoteAuthClient — он шлёт
  // request'ы 'auth.*'. Если здесь не включить — offscreen ответит
  // "Unknown request kind". Должно совпадать с конфигом content-script'а.
  auth: true
});
