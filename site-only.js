(function () {
  'use strict';

  // Clean up legacy caches (`kitui-farm-v*`) while keeping the modern app shell (`kitui-farm-shell-v1`).
  if ('caches' in window) {
    caches.keys().then(function (keys) {
      keys.filter(function (key) {
        return key.indexOf('kitui-farm-v') === 0;
      }).forEach(function (key) { caches.delete(key); });
    }).catch(function () {});
  }
})();
