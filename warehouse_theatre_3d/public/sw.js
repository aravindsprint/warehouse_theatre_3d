/* Warehouse Theatre 3D Service Worker */
const CACHE_NAME = "warehouse-theatre-3d-v3";

// Third-party libraries pinned to a version: safe to serve cache-first.
const LIBS = [
  "https://unpkg.com/vue@3/dist/vue.global.prod.js",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js",
  "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js",
];
// Precache the pages and the core libraries; the scanner and QR libraries are cached on first use.
const SHELL = ["/warehouse-theatre-3d", "/warehouse-scan", ...LIBS.slice(0, 2)];

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

function cachePut(request, response) {
  if (response && response.ok && response.type !== "opaque") {
    const clone = response.clone();
    caches.open(CACHE_NAME).then(c => c.put(request, clone));
  }
  return response;
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // This worker is registered with scope "/", so it sees every request on the site.
  // Only handle this app's page, its own assets and the pinned libraries; everything
  // else (desk pages, other apps' assets, /api) goes straight to the network.
  const sameOrigin = url.origin === self.location.origin;
  const ownCode = sameOrigin &&
    (url.pathname === "/warehouse-theatre-3d" || url.pathname.startsWith("/warehouse-theatre-3d/") ||
     url.pathname === "/warehouse-scan" ||
     url.pathname.startsWith("/assets/warehouse_theatre_3d/"));
  const lib = LIBS.includes(url.href);
  if (!ownCode && !lib) return;

  // The page and the app's own scripts change with every release: try the network
  // first so a deploy is picked up immediately, and fall back to cache when offline.
  if (ownCode) {
    e.respondWith(
      fetch(e.request)
        .then(r => cachePut(e.request, r))
        .catch(() => caches.match(e.request, { ignoreSearch: true })
          .then(cached => cached || new Response("Offline", { status: 503 })))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => cachePut(e.request, r))
        .catch(() => cached || new Response("Offline", { status: 503 }));
    })
  );
});
