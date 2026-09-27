/* JobFinder's service worker (PLAN 32): web push, and nothing else.
 *
 * It exists for two events: `push`, which shows the morning alert the server
 * sent, and `notificationclick`, which opens the app where the notification
 * points. There is deliberately NO `fetch` handler and no cache: the network
 * serves every request exactly as it did before this file existed, so a deploy
 * still reaches every open tab and no stale asset can be served from here.
 * check-mirrors 91 pins that.
 *
 * It is registered only when a person turns notifications on in Settings
 * (lib/push.ts), never on page load.
 */

self.addEventListener("install", () => {
  // A new version of this file takes over at once; it holds no cache to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** A path on THIS origin, or "/jobs". The server sends a path; anything that
 * resolves to another origin (or is not a URL at all) opens the matches. */
function safeTarget(raw) {
  try {
    const url = new URL(typeof raw === "string" && raw ? raw : "/jobs", self.location.origin);
    if (url.origin !== self.location.origin) return new URL("/jobs", self.location.origin).href;
    return url.href;
  } catch (e) {
    return new URL("/jobs", self.location.origin).href;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "JobFinder";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: typeof data.tag === "string" && data.tag ? data.tag : "jobfinder",
    lang: data.lang === "he" ? "he" : "en",
    dir: data.dir === "rtl" ? "rtl" : "ltr",
    data: { url: safeTarget(data.url) },
  };
  // userVisibleOnly: every push shows a notification, always.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          // An open JobFinder tab or installed window goes to the target and comes forward.
          const moved = "navigate" in client ? await client.navigate(target) : null;
          const shown = moved || client;
          if ("focus" in shown) await shown.focus();
          return;
        } catch (e) {
          // A tab this worker does not control cannot be navigated; open a new one.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
