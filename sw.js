// Ten Days service worker: opens instantly and offline from a cached app shell, and shows push notifications.
// It never caches your data, the server's answers (/v1/…), or anything from AI or other sites.
var SHELL = "td-shell-v11";
var FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "qrcode.js"];

self.addEventListener("install", function (e) {
  // one file at a time, so one missing file can't stop the app from installing
  e.waitUntil(caches.open(SHELL).then(function (c) { return Promise.all(FILES.map(function (f) { return c.add(f).catch(function () {}); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k.indexOf("td-shell-") === 0 && k !== SHELL; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  var base = self.registration.scope, p = url.href.indexOf(base) === 0 ? url.href.slice(base.length).split("?")[0].split("#")[0] : null;
  return p !== null && (p === "" || FILES.indexOf(p) >= 0);
}
// The shell comes from the cache at once; a fresh copy is fetched in the background for next time.
self.addEventListener("fetch", function (e) {
  var req = e.request; if (req.method !== "GET") return;
  var url = new URL(req.url);
  var nav = req.mode === "navigate" && url.origin === self.location.origin;
  if (!nav && !isShell(url)) return;   // everything else goes straight to the network, untouched
  var key = nav ? "index.html" : req;
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(key).then(function (hit) {
      var fresh = fetch(req).then(function (r) { if (r && r.ok && r.type === "basic") c.put(key, r.clone()); return r; }).catch(function () { return hit; });
      if (hit) { e.waitUntil(fresh.catch(function () {})); return hit; }
      return fresh;
    });
  }));
});

// Push: every message shows a visible notification (iPhone requires it) and updates the icon badge.
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "Ten Days", body: e.data ? e.data.text() : "" }; }
  var title = d.title || "Ten Days";
  var opts = { body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./" }, requireInteraction: d.kind === "sos" };
  if (d.kind === "sos" && /call=%2B?\d/.test(d.url || "")) opts.actions = [{ action: "call", title: "Call" }];   // shown where supported; iPhone opens the app's call screen
  var jobs = [self.registration.showNotification(title, opts)];
  if (self.navigator && self.navigator.setAppBadge) jobs.push(self.navigator.setAppBadge(+d.badge || 1).catch(function () {}));
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.registration.scope) === 0 && "focus" in list[i]) { list[i].postMessage({ type: "open", url: url }); return list[i].focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
