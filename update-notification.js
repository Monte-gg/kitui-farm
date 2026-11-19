(function () {
  'use strict';

  var VERSION_KEY = 'kituiFarmSiteVersion';
  var CHECK_INTERVAL_MS = 15 * 1000;
  var latestVersion = '';
  var baselineVersion = '';
  var banner = null;
  var checkInProgress = false;
  var scriptUrl = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : new URL('update-notification.js', document.baseURI).href;
  var versionUrl = new URL('version.json', scriptUrl);

  function isAppMode() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true
        || localStorage.getItem('kituiFarmAppInstalled') === '1';
    } catch (error) {
      return false;
    }
  }

  function readStoredVersion() {
    try { return localStorage.getItem(VERSION_KEY) || ''; }
    catch (error) { return ''; }
  }

  function saveStoredVersion(version) {
    try { localStorage.setItem(VERSION_KEY, version); }
    catch (error) { /* The banner still works for this page if storage is disabled. */ }
  }

  function parts(version) {
    var match = /^v?(\d+(?:\.\d+){0,2})$/.exec(String(version || '').trim());
    if (!match) return null;
    return match[1].split('.').map(function (part) { return Number(part); });
  }

  function isNewer(serverVersion, storedVersion) {
    var serverParts = parts(serverVersion);
    var storedParts = parts(storedVersion);
    if (!serverParts || !storedParts) return false;
    for (var i = 0; i < 3; i++) {
      var serverPart = serverParts[i] || 0;
      var storedPart = storedParts[i] || 0;
      if (serverPart !== storedPart) return serverPart > storedPart;
    }
    return false;
  }

  function addStyles() {
    if (document.getElementById('kitui-update-styles')) return;
    var style = document.createElement('style');
    style.id = 'kitui-update-styles';
    style.textContent = [
      '.kitui-update-banner{position:fixed;top:max(10px,env(safe-area-inset-top));left:12px;right:12px;z-index:2147483000;box-sizing:border-box;max-width:680px;margin-inline:auto;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 16px;border:1px solid rgba(255,242,199,.25);border-radius:14px;background:#17472c;color:#fff2c7;box-shadow:0 10px 30px rgba(10,25,14,.32);font:600 14.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.kitui-update-banner[hidden]{display:none}',
      '.kitui-update-banner__text{min-width:0;flex:1;margin:0}',
      '.kitui-update-banner__text strong{display:block;color:#fff;font-size:15px}',
      '.kitui-update-banner__text small{display:block;margin-top:2px;color:#e5f0d8;font-weight:500;font-size:12.5px}',
      '.kitui-update-banner__button{flex:0 0 auto;min-height:42px;padding:9px 15px;border:0;border-radius:10px;background:#fff2c7;color:#17472c;font:800 13.5px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.18)}',
      '.kitui-update-banner__button:hover{background:#ffe59d}',
      '.kitui-update-banner__button:disabled{opacity:.75;cursor:wait}',
      '.kitui-update-banner__button:focus-visible{outline:3px solid #d77b20;outline-offset:2px}',
      '@media(max-width:520px){.kitui-update-banner{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:11px 13px;font-size:13.5px}.kitui-update-banner__button{min-height:42px;padding:8px 12px;font-size:13px}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  async function downloadAndApplyUpdate(button) {
    saveStoredVersion(latestVersion);
    baselineVersion = latestVersion;
    if (button) {
      button.disabled = true;
      button.textContent = 'Downloading update…';
    }
    try {
      if ('caches' in window) {
        var keys = await caches.keys();
        await Promise.all(
          keys.filter(function (key) { return key.indexOf('kitui-farm-') === 0; })
            .map(function (key) { return caches.delete(key); })
        );
      }
      if ('serviceWorker' in navigator) {
        var registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(async function (registration) {
          try {
            if (registration.waiting) registration.waiting.postMessage({ type: 'CLEAR_AND_UPDATE' });
            if (registration.active) registration.active.postMessage({ type: 'CLEAR_AND_UPDATE' });
            await registration.update();
          } catch (error) { /* continue to reload */ }
        }));
      }
      await fetch(window.location.href, { cache: 'reload', credentials: 'same-origin' }).catch(function () {});
    } catch (error) {
      /* Even if cache cleanup fails, reload with a cache-busting parameter. */
    }
    if (button) button.textContent = 'Updating app…';
    var destination = new URL(window.location.href);
    destination.searchParams.set('siteVersion', latestVersion);
    window.history.replaceState(null, '', destination.href);
    window.location.reload();
  }

  function showBanner(version) {
    latestVersion = version;
    var appInstalled = isAppMode();
    if (!banner) {
      addStyles();
      banner = document.createElement('aside');
      banner.className = 'kitui-update-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML =
        '<p class="kitui-update-banner__text">' +
          '<strong id="kituiUpdateTitle"></strong>' +
          '<small id="kituiUpdateSub"></small>' +
        '</p>' +
        '<button class="kitui-update-banner__button" type="button" id="kituiUpdateActionBtn"></button>';
      banner.querySelector('button').addEventListener('click', function (event) {
        downloadAndApplyUpdate(event.currentTarget);
      });
      document.body.insertBefore(banner, document.body.firstChild);
    }
    var titleNode = banner.querySelector('#kituiUpdateTitle');
    var subNode = banner.querySelector('#kituiUpdateSub');
    var btnNode = banner.querySelector('#kituiUpdateActionBtn');
    if (titleNode) {
      titleNode.textContent = appInstalled
        ? 'Update available for KITUI FARM App (v' + version + ')'
        : 'A new KITUI FARM update is available (v' + version + ')';
    }
    if (subNode) {
      subNode.textContent = 'Tap to download and install the latest features and fixes.';
    }
    if (btnNode && !btnNode.disabled) {
      btnNode.textContent = 'Download & Update';
    }
    banner.hidden = false;
  }

  async function checkVersion() {
    if (checkInProgress) return;
    checkInProgress = true;
    try {
      var requestUrl = new URL(versionUrl.href);
      requestUrl.searchParams.set('_', String(Date.now()));
      var response = await fetch(requestUrl.href, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      var data = await response.json();
      var serverVersion = typeof data.version === 'string' ? data.version.trim() : '';
      if (!parts(serverVersion)) return;
      var storedVersion = readStoredVersion() || baselineVersion;
      if (!storedVersion) {
        saveStoredVersion(serverVersion);
        baselineVersion = serverVersion;
        return;
      }
      if (isNewer(serverVersion, storedVersion)) showBanner(serverVersion);
      else baselineVersion = storedVersion;
    } catch (error) {
      // Update checks should never interrupt sign-in or normal page use.
    } finally {
      checkInProgress = false;
    }
  }

  window.KITUI_TRIGGER_APP_UPDATE = function () {
    var btn = banner && banner.querySelector('#kituiUpdateActionBtn');
    return downloadAndApplyUpdate(btn);
  };

  baselineVersion = readStoredVersion();
  checkVersion();
  window.setInterval(checkVersion, CHECK_INTERVAL_MS);
  window.addEventListener('pageshow', checkVersion);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkVersion();
  });
})();
