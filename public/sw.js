// Lock Cash service worker: lets the site install as an app and open offline.
// API responses are NEVER cached (balances must always be live).
const CACHE = 'lockcash-v1';
const SHELL = ['login.html', 'index.html', 'home.html', 'css/app.css', 'js/common.js', 'js/auth.js', 'js/home.js', 'js/pwa.js', 'icons/logo.svg', 'offline.html'];
const OFFLINE = new URL('offline.html', self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match(OFFLINE) : Response.error())))
  );
});
