(function () {
  'use strict';

  var block = document.getElementById('getAppBlock');
  var installKey = 'kituiFarmAppInstalled';
  var updateBanner;
  var reloading = false;

  function standalone() {
    try {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    } catch (error) { return false; }
  }

  function hideInstall() {
    if (block) block.hidden = true;
    try { localStorage.setItem(installKey, 'yes'); } catch (error) { /* storage may be disabled */ }
  }

  function isInstalled() {
    if (standalone()) {
      hideInstall();
      return true;
    }
    try { return localStorage.getItem(installKey) === 'yes'; } catch (error) { return false; }
  }

  function makeUpdateBanner() {
    if (updateBanner) return updateBanner;
    var style = document.createElement('style');
    style.textContent = '.kitui-update{position:fixed;z-index:1000;left:16px;right:16px;bottom:16px;max-width:620px;margin:auto;padding:14px 16px;display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #d8e4d3;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:14px/1.4 system-ui,sans-serif;color:#253522}.kitui-update[hidden]{display:none}.kitui-update p{margin:0;flex:1}.kitui-update button{border:0;border-radius:9px;padding:10px 15px;background:#4a8c3f;color:#fff;font-weight:700;cursor:pointer;white-space:nowrap}.kitui-update button:disabled{opacity:.65;cursor:wait}@media(prefers-color-scheme:dark){.kitui-update{background:#202820;color:#e8f0e4;border-color:#39453a}}';
    document.head.appendChild(style);
    updateBanner = document.createElement('aside');
    updateBanner.className = 'kitui-update';
    updateBanner.setAttribute('role', 'status');
    updateBanner.setAttribute('aria-live', 'polite');
    updateBanner.innerHTML = '<p>A KITUI FARM update is ready.</p><button type="button">Update</button>';
    updateBanner.querySelector('button').addEventListener('click', function () {
      var registration = window.kituiFarmRegistration;
      if (!registration || !registration.waiting) return;
      this.disabled = true;
      this.textContent = 'Updating…';
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    document.body.appendChild(updateBanner);
    return updateBanner;
  }

  function showUpdate() {
    makeUpdateBanner().hidden = false;
  }

  function watchRegistration(registration) {
    window.kituiFarmRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) showUpdate();
    registration.addEventListener('updatefound', function () {
      var worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', function () {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate();
      });
    });
    if (document.visibilityState === 'visible') registration.update().catch(function () {});
  }

  if (block && isInstalled()) hideInstall();
  window.addEventListener('appinstalled', hideInstall);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(watchRegistration).catch(function () {});
    });
  }
})();
