// Service worker: offline-first PWA (spec 2 "Web hosting"). Caches the app
// shell, the WASM, the MediaPipe runtime and the hand model after first load.
const VERSION = 'gsyn-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/models/hand_landmarker.task', '/mediapipe/vision_wasm_internal.js', '/mediapipe/vision_wasm_internal.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // never cache the community API or cross-origin CDN calls that need fresh data
  if (url.origin !== location.origin) {
    if (/mediapipe-models|unpkg\.com\/@ffmpeg/.test(url.href)) {
      e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => (r.ok && c.put(req, r.clone()), r))));
    }
    return;
  }
  // SPA navigation: serve the shell
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const cached = await c.match(req);
      const network = fetch(req)
        .then((r) => {
          if (r.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/models/') || url.pathname.startsWith('/mediapipe/'))) c.put(req, r.clone());
          return r;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
