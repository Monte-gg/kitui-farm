// Caches only the app shell. The API lives on another origin (Render) and is
// always fetched from the network so listings, orders and checkout stay current.
const CACHE = 'kitui-farm-v3';
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
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

const BASE = self.location.href;
const SHELL_URLS = SHELL.map(path => new URL(path, BASE).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
  if (!SHELL_URLS.includes(url.href)) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
