// KORASTORE service worker: minimal pass-through, present so notification clicks and
// showNotification() work on mobile browsers. No caching — the site is static files.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification?.data?.link;
  if (link) event.waitUntil(self.clients.openWindow(link));
});
