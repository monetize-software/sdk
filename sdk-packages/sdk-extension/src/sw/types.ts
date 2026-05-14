// Public types для SW-роутера. Отдельный файл, чтобы forwarder.ts не
// ходил в index.ts (циклический type-only import терпим, но плохо читается).

export interface RouterOptions {
  /** URL offscreen-страницы. Может быть статической строкой ИЛИ функцией —
   *  функция позволяет resolve'ить URL на каждом connect'е, что нужно когда
   *  параметры (apiOrigin, paywallId, etc.) приходят из chrome.storage и
   *  могут поменяться без перезагрузки SW. Каждый ленивый resolve может
   *  быть async — функция async читает storage и возвращает URL.
   *
   *  Простой случай: `chrome.runtime.getURL('offscreen.html')`.
   *  С параметрами:
   *    `() => chrome.storage.local.get(['k']).then(({ k }) =>
   *      chrome.runtime.getURL('offscreen.html') + '?k=' + k)`
   */
  offscreenUrl: string | (() => string | Promise<string>);
  /** Reasons для chrome.offscreen.createDocument. Дефолт — `['LOCAL_STORAGE']`. */
  offscreenReasons?: chrome.offscreen.Reason[];
  /** Justification для CWS ревью. */
  offscreenJustification?: string;
}
