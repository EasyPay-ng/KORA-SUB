// KORASTORE service worker. No caching: the site is static files.
// Browser notifications and push: OneSignal's worker is imported so closed-browser push
// (see push-config.js) and this site's own notification clicks share one service worker.
// Guarded so a blocked OneSignal CDN cannot stop the rest of this worker from installing.
try { importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDKWorker.js"); } catch (error) { /* push disabled */ }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification?.data?.link;
  if (link) event.waitUntil(self.clients.openWindow(link));
});
