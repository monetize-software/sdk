// Service worker bootstrap для demo-extension.
// installRouter поднимает forwarder и при первом content-script connect'е
// создаст offscreen.html через chrome.offscreen API.
//
// apiOrigin/paywallId читаются из chrome.storage.local (e2e тесты их там
// устанавливают) и пробрасываются в offscreen через query-параметры —
// у offscreen-документа НЕТ доступа к chrome.storage, поэтому единственный
// канал передачи начальной конфигурации — URL.
import { installRouter } from '@monetize.software/sdk-extension/sw';

// URL offscreen'а ресолвится лениво на каждом connect'е — это позволяет
// конфигурации (apiOrigin/paywallId) меняться через chrome.storage без
// перезагрузки SW. Тесты этим пользуются: фикстура ставит storage ПОСЛЕ
// расширение загрузилось, и первый же content connect подхватывает её.
installRouter({
  offscreenUrl: async () => {
    const cfg = (await chrome.storage.local.get([
      '__demo_paywall_id',
      '__demo_api_origin'
    ])) as { __demo_paywall_id?: string; __demo_api_origin?: string };
    const params = new URLSearchParams({
      paywallId: cfg.__demo_paywall_id ?? '3',
      apiOrigin: cfg.__demo_api_origin ?? 'https://onlineapp.stream'
    });
    return `${chrome.runtime.getURL('offscreen.html')}?${params.toString()}`;
  },
  offscreenReasons: [chrome.offscreen.Reason.LOCAL_STORAGE],
  offscreenJustification:
    'Persist auth session and bootstrap cache across extension surfaces via localStorage, unavailable in service workers.'
});
