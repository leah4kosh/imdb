// Service worker: shows the notification when the site is closed, and opens the game when it is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "קרב הכתרים", {
    body: d.body || "", icon: d.icon || "/icon-192.png", badge: "/icon-192.png",
    tag: "kk-chat", renotify: true, vibrate: [120, 60, 120], dir: "rtl", lang: "he", data: { url: "/" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("/");
  }));
});
