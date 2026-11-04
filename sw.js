// Pages are network-first so a new deployment is picked up immediately; static
// assets are served from cache and refreshed in the background. The API lives on
// another origin (Render) and is never intercepted.
const CACHE = 'kitui-farm-v5';
const SHELL = [
  './',
  './login.html',
  './signup.html',
  './buyer-dashboard.html',
  './farmer-dashboard.html',
  './forgot-password.html',
  './payment.html',
  './profile.html',
  './settings.html',
  './manifest.json',
  './icons/icon-192x192.png?v=2',
  './icons/icon-512x512.png?v=2'
];

const BASE = self.location.href;
const SHELL_URLS = SHELL.map(path => new URL(path, BASE).href);
const OFFLINE_PAGE = new URL('./login.html', BASE).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const accept = request.headers.get('accept') || '';
  const isPage = request.mode === 'navigate' || accept.includes('text/html');

  if (isPage) {
    // Network first: never trap users on a stale page after a deploy.
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request).then(cached => cached || caches.match(OFFLINE_PAGE)))
    );
    return;
  }

  if (!SHELL_URLS.includes(url.href)) return;

  // Cache first, then refresh in the background so assets self-heal.
  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
