(function () {
  'use strict';

  var deferredPrompt = null;
  var installButton = null;
  var dialog = null;
  var isStandalone = false;

  function checkStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true
        || document.referrer.indexOf('android-app://') === 0;
    } catch (error) {
      return false;
    }
  }

  function addStyles() {
    if (document.getElementById('kitui-install-styles')) return;
    var style = document.createElement('style');
    style.id = 'kitui-install-styles';
    style.textContent = [
      '.kf-install-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:9px 14px;border:1px solid #08723d;border-radius:12px;background:#08723d;color:#fff;font:700 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(8,114,61,.2);transition:transform .16s ease,background .16s ease}',
      '.kf-install-button:hover{background:#17472c;transform:translateY(-1px)}',
      '.kf-install-button:focus-visible{outline:3px solid #d77b20;outline-offset:2px}',
      '.kf-install-button[hidden]{display:none}',
      '.kf-install-button--floating{position:fixed;right:16px;bottom:max(16px,env(safe-area-inset-bottom));z-index:1200}',
      '.kf-install-dialog{position:fixed;inset:0;z-index:2147483001;display:grid;place-items:center;padding:20px;background:rgba(23,30,25,.58)}',
      '.kf-install-dialog[hidden]{display:none}',
      '.kf-install-card{width:min(100%,430px);padding:26px;border:1px solid #e5dcc6;border-radius:20px;background:#fffdf7;color:#342718;box-shadow:0 22px 70px rgba(0,0,0,.24);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.kf-install-card h2{margin:0 0 8px;color:#17472c;font-size:24px}',
      '.kf-install-card p{margin:0 0 14px}',
      '.kf-install-card ol{margin:0 0 20px;padding-left:22px}',
      '.kf-install-card li{margin:7px 0}',
      '.kf-install-card__actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}',
      '.kf-install-card__close{min-height:40px;padding:9px 14px;border:1px solid #e5dcc6;border-radius:12px;background:transparent;color:#342718;font:700 14px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}',
      '@media(max-width:600px){.kf-install-button--floating{right:12px;left:12px;width:calc(100% - 24px)}.kf-install-card{padding:22px}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function createDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.className = 'kf-install-dialog';
    dialog.hidden = true;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'kfInstallTitle');
    dialog.innerHTML = '<div class="kf-install-card">'
      + '<h2 id="kfInstallTitle">Get the KITUI FARM app</h2>'
      + '<p>Install KITUI FARM on your phone for faster access from your home screen.</p>'
      + '<ol><li>Open your browser menu.</li><li>Choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</li><li>Confirm the installation.</li></ol>'
      + '<div class="kf-install-card__actions"><button type="button" class="kf-install-card__close">Not now</button></div>'
      + '</div>';
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog || event.target.closest('.kf-install-card__close')) closeDialog();
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function openDialog() {
    createDialog().hidden = false;
    var close = dialog.querySelector('.kf-install-card__close');
    if (close) close.focus();
  }

  function closeDialog() {
    if (dialog) dialog.hidden = true;
  }

  function createButton() {
    if (installButton || isStandalone) return;
    addStyles();
    installButton = document.createElement('button');
    installButton.type = 'button';
    installButton.className = 'kf-install-button kf-install-button--floating';
    installButton.textContent = 'Get the app';
    installButton.setAttribute('aria-label', 'Get the KITUI FARM app');
    installButton.addEventListener('click', async function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        var choice = await deferredPrompt.userChoice.catch(function () { return null; });
        if (choice && choice.outcome === 'accepted') hideButton();
        deferredPrompt = null;
        return;
      }
      openDialog();
    });
    document.body.appendChild(installButton);
  }

  function hideButton() {
    if (installButton) installButton.hidden = true;
  }

  function showButton() {
    if (!isStandalone && installButton) installButton.hidden = false;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var script = new URL('sw.js?v=9', document.baseURI).href;
    navigator.serviceWorker.register(script, { scope: './' }).catch(function () {});
  }

  isStandalone = checkStandalone();
  registerServiceWorker();
  if (!isStandalone) createButton();

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showButton();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    isStandalone = true;
    hideButton();
    try { localStorage.setItem('kituiFarmAppInstalled', '1'); } catch (error) {}
  });

  window.addEventListener('pageshow', function () {
    isStandalone = checkStandalone();
    if (isStandalone) hideButton();
  });
})();
