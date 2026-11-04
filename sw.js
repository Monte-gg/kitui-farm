const CACHE = 'kitui-farm-v1';
const SHELL = [
  '/',
  '/login.html',
  '/signup.html',
  '/buyer-dashboard.html',
  '/farmer-dashboard.html',
  '/forgot-password.html',
  '/payment.html',
  '/profile.html',
  '/settings.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Only the static app shell is cached; everything under /api always hits the
  // network so listings, orders and checkout stay current.
  const url = new URL(event.request.url, self.location.origin);
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
