'use strict';

// Stale-While-Revalidate service worker for KITUI FARM (v10) + System Notification handler.
// Delivers instantaneous (0ms) section switching between dashboards, wallet, chat, alerts, and settings.
const CACHE_NAME = 'kitui-farm-shell-v10';
const APP_SHELL_FILES = [
  './',
  './index.html',
  './login.html',
  './buyer-dashboard.html',
  './farmer-dashboard.html',
  './farmer-store.html',
  './chat.html',
  './wallet.html',
  './receipts.html',
  './notifications.html',
  './profile.html',
  './settings.html',
  './about-us.html',
  './customer-service.html',
  './api-base.js',
  './theme-init.js',
  './brand-theme.css',
  './brand.js',
  './mobile-layout.css',
  './android-app-layout.css',
  './subpage-nav.css',
  './subpage-nav.js',
  './manifest.webmanifest',
  './icons/kitui-app-icon-192.png',
  './icons/kitui-app-icon-512.png',
  './assets/kitui-farm-emblem.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        APP_SHELL_FILES.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => {
            if (res && res.ok) return cache.put(url, res);
          })
        )
      )
    ).then(() => self.skipWaiting())
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

self.addEventListener('message', (event) => {
  if (!event.data || typeof event.data !== 'object') return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data.type === 'CLEAR_AND_UPDATE') {
    event.waitUntil(
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith('kitui-farm-')).map((key) => caches.delete(key)))
      ).then(() => self.skipWaiting())
    );
  }
  if (event.data.type === 'SHOW_NOTIFICATION' && self.registration && self.registration.showNotification) {
    const title = String(event.data.title || 'KITUI FARM');
    const options = {
      body: String(event.data.body || ''),
      icon: event.data.icon || 'icons/kitui-app-icon-192.png?v=3',
      badge: event.data.icon || 'icons/kitui-app-icon-192.png?v=3',
      tag: event.data.tag || 'kitui-farm-notification',
      data: { url: event.data.url || './' }
    };
    event.waitUntil(self.registration.showNotification(title, options).catch(() => {}));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/version.json')) return;

  // Stale-While-Revalidate: Return cached app shell immediately for instant section switching!
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
