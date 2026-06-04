// MV3 service worker. Empty — it exists solely so that Playwright can
// obtain the extensionId via `context.waitForEvent('serviceworker')`.
// There's no real logic in it; popup and potential content scripts work on their own.
self.addEventListener('install', () => {
  // Activate immediately so e2e tests don't wait for the activation timeout.
  (self as unknown as ServiceWorkerGlobalScope).skipWaiting();
});
