(function () {
  'use strict';

  var capturedPrompt = null;
  var installed = false;

  function installStyle() {
    if (document.getElementById('kitui-farm-install-style')) return;
    var s = document.createElement('style');
    s.id = 'kitui-farm-install-style';
    s.textContent =
      '.install-card{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #e4e9e1;box-shadow:0 -6px 22px rgba(0,0,0,.10);z-index:60;}' +
      ':root[data-theme="dark"] .install-card{background:#202820;border-top-color:#39453a;}' +
      '.install-card.hidden{display:none !important;}' +
      '.install-card-inner{display:flex;align-items:center;gap:12px;max-width:1180px;margin:auto;padding:13px 16px;}' +
      '.install-card-icon{width:42px;height:42px;border-radius:11px;background:#edf5e9;display:grid;place-items:center;flex-shrink:0;}' +
      ':root[data-theme="dark"] .install-card-icon{background:#263b27;}' +
      '.install-card-icon img{width:32px;height:32px;}' +
      '.install-card-text{flex:1;min-width:0;}' +
      '.install-card-title{margin:0 0 2px;font-weight:650;color:#2d5a27;font-size:14px;line-height:1.3;}' +
      ':root[data-theme="dark"] .install-card-title{color:#d8e6cf;}' +
      '.install-card-desc{margin:0;color:#6d776c;font-size:12px;line-height:1.4;}' +
      ':root[data-theme="dark"] .install-card-desc{color:#a6b1a3;}' +
      '.install-card-btn{flex-shrink:0;border:0;border-radius:10px;padding:10px 16px;background:#4a8c3f;color:#fff;font-weight:650;font-size:14px;cursor:pointer;white-space:nowrap;}' +
      '.install-card-btn:hover{background:#3a7a2a;}' +
      '.install-card-btn:disabled{opacity:.7;cursor:default;}' +
      '.install-card-close{flex-shrink:0;background:none;border:0;color:#6d776c;cursor:pointer;font-size:22px;line-height:1;padding:0 4px;border-radius:6px;}' +
      '.install-card-close:hover{color:#2d5a27;background:#eef3e9;}' +
      ':root[data-theme="dark"] .install-card-close:hover{color:#d8e6cf;background:#2c3a2c;}' +
      '.install-card-steps{margin:0;padding:0;list-style:none;}' +
      '.install-card-steps li{padding:3px 0;font-size:12px;color:#6d776c;line-height:1.45;}' +
      ':root[data-theme="dark"] .install-card-steps li{color:#a6b1a3;}' +
      '.install-card-steps li strong{color:#2d5a27;}' +
      ':root[data-theme="dark"] .install-card-steps li strong{color:#d8e6cf;}' +
      'body.kitui-install-body-pad{padding-bottom:82px;}';
    document.head.appendChild(s);
  }

  function isStandalone() {
    try { return window.matchMedia && window.matchMedia('(display-mode: standalone)').matches; }
    catch (e) { return false; }
  }

  function reveal() {
    var card = document.getElementById('kitui-install-card');
    if (!card) return;
    installStyle();
    if (isStandalone()) { card.classList.add('hidden'); return; }
    document.body.classList.add('kitui-install-body-pad');
    card.classList.remove('hidden');
    var btn = document.getElementById('installAppBtn');
    var steps = document.getElementById('installCardSteps');
    var close = document.getElementById('installCardClose');
    var ua = navigator.userAgent || '';
    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var hasPrompt = !!(window.kituiFarmInstallPrompt || (window.kituiFarmSw && window.kituiFarmSw.installing));

    if (isAndroid && hasPrompt && btn) {
      btn.textContent = 'Install app';
      btn.onclick = function () {
        if (window.kituiFarmInstallPrompt) {
          window.kituiFarmInstallPrompt.prompt().then(function (choice) {
            if (choice && choice.outcome === 'accepted') {
              card.classList.add('hidden');
              document.body.classList.remove('kitui-install-body-pad');
            }
          }).catch(function () {});
        }
      };
      if (steps) steps.classList.add('hidden');
    } else if (isIOS && btn) {
      btn.textContent = 'Add to Home Screen';
      btn.onclick = null;
      if (steps) steps.classList.remove('hidden');
    } else if (btn) {
      btn.textContent = 'Open website';
      btn.onclick = function () { window.location.href = window.location.href; };
      if (steps) steps.classList.add('hidden');
    }
    if (close) close.onclick = function () {
      card.classList.add('hidden');
      document.body.classList.remove('kitui-install-body-pad');
    };
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(function (registration) {
          window.kituiFarmSw = registration;
          if (registration.installing) {
            registration.installing.addEventListener('statechange', function () {
              if (registration.installing && registration.installing.state === 'installed') {
                setTimeout(reveal, 400);
              }
            });
          }
          setTimeout(reveal, 600);
        })
        .catch(function () { setTimeout(reveal, 600); });
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      capturedPrompt = e;
      window.kituiFarmInstallPrompt = e;
    });
    window.addEventListener('appinstalled', function () {
      capturedPrompt = null;
      window.kituiFarmInstallPrompt = null;
      installed = true;
      var card = document.getElementById('kitui-install-card');
      if (card) { card.classList.add('hidden'); document.body.classList.remove('kitui-install-body-pad'); }
    });
  } else {
    setTimeout(reveal, 400);
  }
  if (document.readyState === 'complete') reveal();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reveal);
  else reveal();
})();
