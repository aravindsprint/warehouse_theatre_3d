/* Warehouse Theatre 3D Service Worker */
const CACHE_NAME = "warehouse-theatre-3d-v1";

const SHELL = [
  "/warehouse-theatre-3d",
  "https://unpkg.com/vue@3/dist/vue.global.prod.js",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => Promise.allSettled(SHELL.map(url => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.ok && response.type !== "opaque") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => cached || new Response("Offline", { status: 503 }));
    })
  );
});
