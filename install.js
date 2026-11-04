(function () {
  'use strict';

  var legacyInstallCard = document.getElementById('getAppBlock');
  if (legacyInstallCard) legacyInstallCard.remove();

  var installedKey = 'kituiFarmAppInstalled';
  var dismissedKey = 'kituiFarmInstallDismissedUntil';
  var installPrompt = null;
  var installCard = null;
  var updateBanner = null;
  var reloading = false;

  function standalone() {
    try {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    } catch (error) { return false; }
  }

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* storage may be disabled */ }
  }

  function markInstalled() {
    writeStorage(installedKey, 'yes');
    if (installCard) installCard.remove();
    installCard = null;
  }

  function isInstalled() {
    if (standalone()) {
      markInstalled();
      return true;
    }
    return readStorage(installedKey) === 'yes';
  }

  function showInstallCard() {
    if (installCard || isInstalled() || !/Android/i.test(navigator.userAgent || '')) return;
    var dismissedUntil = Number(readStorage(dismissedKey) || 0);
    if (dismissedUntil > Date.now()) return;

    if (!document.getElementById('kitui-pwa-ui-style')) {
      var style = document.createElement('style');
      style.id = 'kitui-pwa-ui-style';
      style.textContent = '.kitui-install-pop{position:fixed;z-index:999;right:14px;bottom:18px;width:min(330px,calc(100vw - 28px));box-sizing:border-box;padding:13px 14px;background:#fff;border:1px solid #d8e8d2;border-radius:14px;box-shadow:0 8px 28px rgba(20,45,18,.22);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#263126}.kitui-install-pop[hidden],.kitui-update[hidden]{display:none!important}.kitui-install-pop-row{display:flex;align-items:center;gap:11px}.kitui-install-pop img{width:38px;height:38px;border-radius:9px;flex:none}.kitui-install-pop-copy{flex:1;min-width:0}.kitui-install-pop-title{display:block;margin:0 0 2px;font-weight:750;color:#2d5a27}.kitui-install-pop-desc{margin:0;color:#62705f;font-size:12px}.kitui-install-pop-actions{display:flex;align-items:center;gap:8px;margin-top:10px}.kitui-install-pop button{border:0;border-radius:8px;padding:9px 13px;background:#4a8c3f;color:white;font-weight:700;font-size:13px;cursor:pointer}.kitui-install-pop button:disabled{opacity:.65;cursor:wait}.kitui-install-dismiss{padding:5px 8px!important;background:transparent!important;color:#667263!important;font-size:20px!important;line-height:1}.kitui-update{position:fixed;z-index:1000;left:16px;right:16px;bottom:16px;max-width:620px;margin:auto;padding:14px 16px;display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #d8e4d3;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:14px/1.4 system-ui,sans-serif;color:#253522}.kitui-update p{margin:0;flex:1}.kitui-update button{border:0;border-radius:9px;padding:10px 15px;background:#4a8c3f;color:#fff;font-weight:700;cursor:pointer;white-space:nowrap}.kitui-update button:disabled{opacity:.65;cursor:wait}@media(prefers-color-scheme:dark){.kitui-install-pop,.kitui-update{background:#202820;color:#e8f0e4;border-color:#39453a}.kitui-install-pop-title{color:#d8e6cf}.kitui-install-pop-desc{color:#b5c1b2}}';
      document.head.appendChild(style);
    }

    installCard = document.createElement('aside');
    installCard.className = 'kitui-install-pop';
    installCard.setAttribute('aria-label', 'Install KITUI FARM');
    installCard.innerHTML = '<div class="kitui-install-pop-row"><img src="icons/icon-192x192.png?v=2" alt=""><div class="kitui-install-pop-copy"><strong class="kitui-install-pop-title">Get KITUI FARM</strong><p class="kitui-install-pop-desc">Install the app for quick access.</p></div></div><div class="kitui-install-pop-actions"><button class="kitui-install-action" type="button">Download app</button><button class="kitui-install-dismiss" type="button" aria-label="Dismiss">×</button></div>';
    installCard.querySelector('.kitui-install-action').addEventListener('click', function () {
      if (!installPrompt) return;
      var button = this;
      button.disabled = true;
      button.textContent = 'Opening…';
      installPrompt.prompt().then(function () {
        return installPrompt.userChoice;
      }).then(function (choice) {
        installPrompt = null;
        if (choice && choice.outcome === 'accepted') {
          markInstalled();
        } else {
          if (installCard) installCard.remove();
          installCard = null;
          writeStorage(dismissedKey, String(Date.now() + 24 * 60 * 60 * 1000));
        }
      }).catch(function () {
        button.disabled = false;
        button.textContent = 'Download app';
      });
    });
    installCard.querySelector('.kitui-install-dismiss').addEventListener('click', function () {
      installCard.remove();
      installCard = null;
      writeStorage(dismissedKey, String(Date.now() + 24 * 60 * 60 * 1000));
    });
    document.body.appendChild(installCard);
  }

  function makeUpdateBanner() {
    if (updateBanner) return updateBanner;
    var style = document.getElementById('kitui-pwa-ui-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'kitui-pwa-ui-style';
      style.textContent = '.kitui-update{position:fixed;z-index:1000;left:16px;right:16px;bottom:16px;max-width:620px;margin:auto;padding:14px 16px;display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #d8e4d3;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:14px/1.4 system-ui,sans-serif;color:#253522}.kitui-update[hidden]{display:none!important}.kitui-update p{margin:0;flex:1}.kitui-update button{border:0;border-radius:9px;padding:10px 15px;background:#4a8c3f;color:#fff;font-weight:700;cursor:pointer;white-space:nowrap}';
      document.head.appendChild(style);
    }
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

  function watchRegistration(registration) {
    window.kituiFarmRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) makeUpdateBanner().hidden = false;
    registration.addEventListener('updatefound', function () {
      var worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', function () {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) makeUpdateBanner().hidden = false;
      });
    });
    if (document.visibilityState === 'visible') registration.update().catch(function () {});
  }

  if (isInstalled()) markInstalled();
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    if (!/Android/i.test(navigator.userAgent || '') || isInstalled()) return;
    installPrompt = event;
    showInstallCard();
  });
  window.addEventListener('appinstalled', markInstalled);

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
