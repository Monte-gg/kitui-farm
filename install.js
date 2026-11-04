(function () {
  'use strict';

  var APP_VERSION = '1.0.1'; // Increment this when publishing a new release.
  var legacyInstallCard = document.getElementById('getAppBlock');
  if (legacyInstallCard) legacyInstallCard.remove();

  var installedKey = 'kituiFarmAppInstalled';
  var updateDismissKey = 'kituiFarmDismissedUpdate';
  var installPrompt = null;
  var installCard = null;
  var updateScreen = null;
  var reloading = false;

  function standalone() {
    try {
      return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    } catch (error) { return false; }
  }

  function readStorage(key, session) {
    try { return (session ? sessionStorage : localStorage).getItem(key); } catch (error) { return null; }
  }

  function writeStorage(key, value, session) {
    try { (session ? sessionStorage : localStorage).setItem(key, value); } catch (error) { /* storage may be disabled */ }
  }

  function markInstalled() {
    writeStorage(installedKey, 'yes', false);
    if (installCard) installCard.remove();
    installCard = null;
  }

  function isInstalled() {
    if (standalone()) {
      markInstalled();
      return true;
    }
    return readStorage(installedKey, false) === 'yes';
  }

  function installGuide() {
    var description = installCard.querySelector('.kitui-install-pop-desc');
    var button = installCard.querySelector('.kitui-install-action');
    description.textContent = 'In Chrome, tap ⋮, then choose “Install app” or “Add to Home screen”.';
    button.textContent = 'Close';
    button.onclick = function () {
      if (installCard) installCard.remove();
      installCard = null;
    };
  }

  function showInstallCard() {
    if (installCard || isInstalled() || !/Android/i.test(navigator.userAgent || '')) return;
    if (!document.getElementById('kitui-pwa-ui-style')) {
      var style = document.createElement('style');
      style.id = 'kitui-pwa-ui-style';
      style.textContent = '.kitui-install-pop{position:fixed;z-index:999;right:14px;bottom:18px;width:min(330px,calc(100vw - 28px));box-sizing:border-box;padding:13px 14px;background:#fff;border:1px solid #d8e8d2;border-radius:14px;box-shadow:0 8px 28px rgba(20,45,18,.22);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#263126}.kitui-install-pop[hidden],.kitui-update-screen[hidden]{display:none!important}.kitui-install-pop-row{display:flex;align-items:center;gap:11px}.kitui-install-pop img{width:38px;height:38px;border-radius:9px;flex:none}.kitui-install-pop-copy{flex:1;min-width:0}.kitui-install-pop-title{display:block;margin:0 0 2px;font-weight:750;color:#2d5a27}.kitui-install-pop-desc{margin:0;color:#62705f;font-size:12px}.kitui-install-pop-actions{display:flex;align-items:center;gap:8px;margin-top:10px}.kitui-install-pop button{border:0;border-radius:8px;padding:9px 13px;background:#4a8c3f;color:white;font-weight:700;font-size:13px;cursor:pointer}.kitui-install-dismiss{padding:5px 8px!important;background:transparent!important;color:#667263!important;font-size:20px!important;line-height:1}.kitui-update-screen{position:fixed;z-index:2000;inset:0;overflow-y:auto;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));background:#101222;color:#f7f8ff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}.kitui-update-screen[hidden]{display:none!important}.kitui-update-inner{width:min(100%,520px);text-align:center;margin:auto}.kitui-update-mark{width:110px;height:110px;margin:0 auto 28px;border-radius:28px;display:grid;place-items:center;background:#1837bd;box-shadow:0 0 38px rgba(194,226,0,.12)}.kitui-update-mark img{width:76px;height:76px;object-fit:contain}.kitui-update-title{margin:0 0 10px;font-size:clamp(28px,7vw,38px);line-height:1.15;font-weight:800;color:#fff}.kitui-update-version{margin:0 0 28px;color:#d4e500;font-size:19px;font-weight:800;letter-spacing:.03em}.kitui-update-note{margin:0 0 26px;padding:22px 20px;border:1px solid #2b3048;border-radius:22px;background:#191d30;color:#b8bed3;font-size:16px}.kitui-update-error{display:none;margin:0 0 18px;padding:16px;border:1px solid #833945;border-radius:16px;background:#321c29;color:#ff9aa4;font-size:14px}.kitui-update-error.is-visible{display:block}.kitui-update-primary{width:100%;min-height:62px;margin:0 0 20px;padding:14px 18px;border:0;border-radius:18px;background:#d6e900;color:#111421;font-size:17px;font-weight:850;letter-spacing:.02em;cursor:pointer}.kitui-update-primary:disabled{opacity:.72;cursor:wait}.kitui-update-secondary{display:block;width:100%;margin:0 0 20px;padding:10px;border:0;background:transparent;color:#a9baff;font-size:15px;font-weight:650;cursor:pointer}.kitui-update-copy{display:block;margin:0 auto 38px;padding:8px 12px;border:0;background:transparent;color:#858da6;font-size:14px;cursor:pointer}.kitui-update-enter{display:block;width:100%;min-height:58px;margin:0 0 18px;padding:14px;border:2px solid #d6e900;border-radius:18px;background:transparent;color:#e0ed16;font-size:15px;font-weight:750;cursor:pointer}.kitui-update-skip{border:0;background:transparent;color:#aeb4c7;text-decoration:underline;text-underline-offset:3px;font-size:14px;cursor:pointer}.kitui-update-screen button:focus-visible{outline:3px solid #fff;outline-offset:3px}@media(max-height:700px){.kitui-update-mark{width:76px;height:76px;margin-bottom:16px}.kitui-update-mark img{width:54px;height:54px}.kitui-update-version{margin-bottom:16px}.kitui-update-note{margin-bottom:16px;padding:15px}.kitui-update-copy{margin-bottom:20px}}@media(prefers-color-scheme:light){.kitui-install-pop{background:#fff}}';
      document.head.appendChild(style);
    }

    installCard = document.createElement('aside');
    installCard.className = 'kitui-install-pop';
    installCard.setAttribute('aria-label', 'Install KITUI FARM');
    installCard.innerHTML = '<div class="kitui-install-pop-row"><img src="icons/icon-192x192.png?v=2" alt=""><div class="kitui-install-pop-copy"><strong class="kitui-install-pop-title">Get KITUI FARM</strong><p class="kitui-install-pop-desc">Install the app for quick access.</p></div></div><div class="kitui-install-pop-actions"><button class="kitui-install-action" type="button">Install app</button><button class="kitui-install-dismiss" type="button" aria-label="Dismiss">×</button></div>';
    var installButton = installCard.querySelector('.kitui-install-action');
    if (installPrompt) installButton.textContent = 'Download app';
    installButton.addEventListener('click', function () {
      if (!installPrompt) { installGuide(); return; }
      var prompt = installPrompt;
      installPrompt = null;
      installButton.disabled = true;
      installButton.textContent = 'Opening…';
      prompt.prompt().then(function () { return prompt.userChoice; }).then(function (choice) {
        if (choice && choice.outcome === 'accepted') markInstalled();
        else if (installCard) { installButton.disabled = false; installButton.textContent = 'Install app'; installGuide(); }
      }).catch(function () { installButton.disabled = false; installButton.textContent = 'Install app'; });
    });
    installCard.querySelector('.kitui-install-dismiss').addEventListener('click', function () {
      installCard.remove();
      installCard = null;
    });
    document.body.appendChild(installCard);
  }

  function dismissUpdate(registration) {
    writeStorage(updateDismissKey, APP_VERSION, true);
    if (updateScreen) updateScreen.remove();
    updateScreen = null;
    if (registration && document.visibilityState === 'visible') registration.update().catch(function () {});
  }

  function showUpdateScreen(registration) {
    if (!registration || !registration.waiting || readStorage(updateDismissKey, true) === APP_VERSION) return;
    if (installCard) { installCard.remove(); installCard = null; }
    if (updateScreen) return;

    var style = document.getElementById('kitui-pwa-ui-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'kitui-pwa-ui-style';
      style.textContent = '.kitui-update-screen{position:fixed;z-index:2000;inset:0;overflow-y:auto;box-sizing:border-box;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));background:#101222;color:#f7f8ff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}.kitui-update-screen[hidden]{display:none!important}.kitui-update-inner{width:min(100%,520px);text-align:center;margin:auto}.kitui-update-mark{width:110px;height:110px;margin:0 auto 28px;border-radius:28px;display:grid;place-items:center;background:#1837bd;box-shadow:0 0 38px rgba(194,226,0,.12)}.kitui-update-mark img{width:76px;height:76px;object-fit:contain}.kitui-update-title{margin:0 0 10px;font-size:clamp(28px,7vw,38px);line-height:1.15;font-weight:800;color:#fff}.kitui-update-version{margin:0 0 28px;color:#d4e500;font-size:19px;font-weight:800;letter-spacing:.03em}.kitui-update-note{margin:0 0 26px;padding:22px 20px;border:1px solid #2b3048;border-radius:22px;background:#191d30;color:#b8bed3;font-size:16px}.kitui-update-error{display:none;margin:0 0 18px;padding:16px;border:1px solid #833945;border-radius:16px;background:#321c29;color:#ff9aa4;font-size:14px}.kitui-update-error.is-visible{display:block}.kitui-update-primary{width:100%;min-height:62px;margin:0 0 20px;padding:14px 18px;border:0;border-radius:18px;background:#d6e900;color:#111421;font-size:17px;font-weight:850;letter-spacing:.02em;cursor:pointer}.kitui-update-primary:disabled{opacity:.72;cursor:wait}.kitui-update-secondary{display:block;width:100%;margin:0 0 20px;padding:10px;border:0;background:transparent;color:#a9baff;font-size:15px;font-weight:650;cursor:pointer}.kitui-update-copy{display:block;margin:0 auto 38px;padding:8px 12px;border:0;background:transparent;color:#858da6;font-size:14px;cursor:pointer}.kitui-update-enter{display:block;width:100%;min-height:58px;margin:0 0 18px;padding:14px;border:2px solid #d6e900;border-radius:18px;background:transparent;color:#e0ed16;font-size:15px;font-weight:750;cursor:pointer}.kitui-update-skip{border:0;background:transparent;color:#aeb4c7;text-decoration:underline;text-underline-offset:3px;font-size:14px;cursor:pointer}.kitui-update-screen button:focus-visible{outline:3px solid #fff;outline-offset:3px}@media(max-height:700px){.kitui-update-mark{width:76px;height:76px;margin-bottom:16px}.kitui-update-mark img{width:54px;height:54px}.kitui-update-version{margin-bottom:16px}.kitui-update-note{margin-bottom:16px;padding:15px}.kitui-update-copy{margin-bottom:20px}}';
      document.head.appendChild(style);
    }

    updateScreen = document.createElement('section');
    updateScreen.className = 'kitui-update-screen';
    updateScreen.setAttribute('role', 'dialog');
    updateScreen.setAttribute('aria-modal', 'true');
    updateScreen.setAttribute('aria-labelledby', 'kituiUpdateTitle');
    updateScreen.innerHTML = '<div class="kitui-update-inner"><div class="kitui-update-mark"><img src="icons/icon-512x512.png?v=2" alt="KITUI FARM"></div><h1 class="kitui-update-title" id="kituiUpdateTitle">Update available</h1><p class="kitui-update-version">KITUI FARM v' + APP_VERSION + '</p><p class="kitui-update-note">A new KITUI FARM update is ready. Install it now for the latest improvements and a smoother experience.</p><p class="kitui-update-error" role="status"></p><button class="kitui-update-primary" type="button">DOWNLOAD &amp; INSTALL UPDATE</button><button class="kitui-update-secondary" type="button">Copy app link</button><button class="kitui-update-enter" type="button">Already updated? Tap to enter KITUI FARM</button><button class="kitui-update-skip" type="button">Skip &amp; continue</button></div>';

    var primary = updateScreen.querySelector('.kitui-update-primary');
    function activateUpdate() {
      if (!registration.waiting) { dismissUpdate(registration); return; }
      primary.disabled = true;
      primary.textContent = 'INSTALLING UPDATE…';
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    primary.addEventListener('click', activateUpdate);
    updateScreen.querySelector('.kitui-update-enter').addEventListener('click', function () {
      registration.update().then(function () {
        if (registration.waiting) activateUpdate();
        else dismissUpdate(registration);
      }).catch(function () {
        var error = updateScreen && updateScreen.querySelector('.kitui-update-error');
        if (error) { error.textContent = 'Could not check for an update. Check your connection and try again.'; error.classList.add('is-visible'); }
      });
    });
    updateScreen.querySelector('.kitui-update-skip').addEventListener('click', function () { dismissUpdate(registration); });
    updateScreen.querySelector('.kitui-update-secondary').addEventListener('click', function () {
      var copy = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(window.location.origin + window.location.pathname) : Promise.reject(new Error('Clipboard unavailable'));
      copy.then(function () { this.textContent = 'App link copied'; }.bind(this)).catch(function () {
        var error = updateScreen && updateScreen.querySelector('.kitui-update-error');
        if (error) { error.textContent = 'Copy is unavailable here. You can share the address in your browser bar.'; error.classList.add('is-visible'); }
      });
    });
    document.body.appendChild(updateScreen);
  }

  function watchRegistration(registration) {
    window.kituiFarmRegistration = registration;
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateScreen(registration);
    registration.addEventListener('updatefound', function () {
      var worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', function () {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateScreen(registration);
      });
    });
    if (document.visibilityState === 'visible') registration.update().catch(function () {});
    window.setInterval(function () {
      if (document.visibilityState === 'visible') registration.update().catch(function () {});
    }, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') registration.update().catch(function () {});
    });
  }

  window.setTimeout(showInstallCard, 900);
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    if (!/Android/i.test(navigator.userAgent || '') || isInstalled()) return;
    installPrompt = event;
    if (!installCard) showInstallCard();
    if (installCard) installCard.querySelector('.kitui-install-action').textContent = 'Download app';
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
