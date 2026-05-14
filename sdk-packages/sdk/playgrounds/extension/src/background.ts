// MV3 service worker. Пустой — существует только для того, чтобы Playwright мог
// получить extensionId через `context.waitForEvent('serviceworker')`.
// Реальной логики в нём нет; popup и потенциальные content scripts работают сами по себе.
self.addEventListener('install', () => {
  // Активируем сразу, чтобы e2e тесты не ждали activation-таймаута.
  (self as unknown as ServiceWorkerGlobalScope).skipWaiting();
});
