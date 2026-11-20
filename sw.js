const CACHE_NAME = 'kitui-farm-apk-v1.0.6';

const SHELL_ASSETS = [
  './',
  './app-layout.css',
  './app-shell.js',
  './theme-init.js',
  './brand-theme.css',
  './brand.js',
  './mobile-layout.css',
  './subpage-nav.css',
  './subpage-nav.js',
  './api-base.js',
  './assets/kitui-farm-emblem.png',
  './assets/kitui-farm-app-icon.png',
  './buyer-dashboard.html',
  './farmer-dashboard.html',
  './wallet.html',
  './chat.html',
  './notifications.html',
  './profile.html',
  './settings.html',
  './receipts.html',
  './login.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => {
            if (res && res.ok) return cache.put(url, res);
          }).catch(() => {})
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key.startsWith('kitui-farm-'))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.endsWith('/version.json')) return;

  const isNav = request.mode === 'navigate';
  const matchOpts = isNav ? { ignoreSearch: true } : undefined;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request, matchOpts).then((cached) => {
        const networkPromise = fetch(request)
          .then((res) => {
            if (res && res.ok && res.type === 'basic') {
              cache.put(request, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    )
  );
});
