(function () {
  'use strict';

  // Remove service workers and caches left by earlier app installs.
  var script = document.currentScript;
  var appPath = script ? new URL('.', script.src).pathname : null;

  if ('serviceWorker' in navigator && appPath) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
      registrations.forEach(function (registration) {
        try {
          if (new URL(registration.scope).pathname === appPath) registration.unregister();
        } catch (error) { /* Ignore unrelated or invalid registrations. */ }
      });
    }).catch(function () {});
  }

  if ('caches' in window) {
    caches.keys().then(function (keys) {
      keys.filter(function (key) { return key.indexOf('kitui-farm-v') === 0; })
        .forEach(function (key) { caches.delete(key); });
    }).catch(function () {});
  }
})();
