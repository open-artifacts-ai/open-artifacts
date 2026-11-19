// Open Artifacts: browser notifications (#2512 slice 3).
// Served from the app origin root (/sw.js) and registered with a narrow scope
// (/notifications/sw/): it handles push and notification clicks only, never
// fetches. A notification carries the server's fixed text and one same-origin
// link; it never has buttons that answer, approve or merge.

/** A same-origin path: one "/", no scheme, no backslash, no control characters. */
function samePath(href) {
  if (typeof href !== "string" || href.length > 2048) return null;
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\"))
    return null;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return null;
  }
  try {
    const u = new URL(href, self.location.origin);
    return u.origin === self.location.origin
      ? u.pathname + u.search + u.hash
      : null;
  } catch {
    return null;
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let p = null;
  try {
    p = event.data ? event.data.json() : null;
  } catch {
    p = null;
  }
  const ok = p && p.v === 1 && typeof p.title === "string";
  // A push must show something; an unreadable one shows the lock-screen line.
  const title = ok ? p.title : "An agent is waiting for your answer";
  const options = {
    body: ok && typeof p.body === "string" ? p.body : "",
    tag: ok && typeof p.tag === "string" ? p.tag : "oa-inbox",
    renotify: true,
    icon: "/apple-touch-icon.png",
    data: { href: (ok && samePath(p.href)) || "/" },
    // No actions: a notification is information, never a yes.
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = samePath(event.notification.data?.href) || "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const mine = wins.find(
        (w) => new URL(w.url).origin === self.location.origin,
      );
      if (mine) {
        // The app navigates itself (it checks the path again).
        await mine.focus();
        mine.postMessage({ oa: "notification-open", href });
        return;
      }
      await self.clients.openWindow(href);
    })(),
  );
});
