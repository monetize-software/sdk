---
'@monetize.software/sdk': patch
'@monetize.software/sdk-extension': patch
'@monetize.software/sdk-react': patch
---

Фикс зависания awaiting-экрана после оплаты в extension-странице.

Переход awaiting→success был завязан **исключительно** на `UserWatcher.onActive`,
а сам watcher не запускался для всего `chrome-extension://` протокола
(`shouldRunUserWatcher` считал любой такой контекст эфемерным action-popup'ом).
В полноценной extension-странице (side panel / отдельная вкладка), которая
переживает checkout, поллер был выключен, и закрыть awaiting было некому — даже
ручная кнопка «я оплатил» лишь слала `window.postMessage` для пробуждения
несуществующего watcher'а. Покупка проходила, `/user-state` отдавал
`has_active_subscription: true`, а экран висел.

- Переход централизован в идемпотентный `handlePurchaseDetected`, который
  вызывается из `billing.onUserChange` — любой источник свежего active
  user-state (ручной `getUser`, cross-context broadcast, watcher) закрывает
  awaiting. Гейт на checkout-вью (`awaiting_payment`/`popup_blocked`), чтобы
  открытие пейвола уже-подписанному юзеру не давало ложного срабатывания.
- `shouldRunUserWatcher` больше не режет `chrome-extension://` — переживающая
  страница и может, и должна поллить; эфемерный action-popup безвредно
  тёрдаунится вместе с контекстом (детект там покрывает bootstrap при
  следующем открытии).
