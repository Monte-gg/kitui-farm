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
      '.kitui-update-banner{position:fixed;top:max(10px,env(safe-area-inset-top));left:0;right:0;z-index:2147483000;box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 16px;background:#17472c;color:#fff2c7;box-shadow:0 3px 16px rgba(20,45,24,.24);font:600 15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.kitui-update-banner[hidden]{display:none}',
      '.kitui-update-banner__text{min-width:0;flex:1;margin:0}',
      '.kitui-update-banner__button{flex:0 0 auto;min-height:40px;padding:8px 14px;border:0;border-radius:9px;background:#fff2c7;color:#17472c;font:700 14px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;cursor:pointer}',
      '.kitui-update-banner__button:focus-visible{outline:3px solid #d77b20;outline-offset:2px}',
      '@media(max-width:520px){.kitui-update-banner{left:12px;right:12px;width:auto;max-width:500px;margin-inline:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;justify-content:initial;gap:10px;padding:11px 12px;border:1px solid rgba(255,242,199,.2);border-radius:13px;font-size:14px;line-height:1.35}.kitui-update-banner__text{overflow-wrap:normal}.kitui-update-banner__button{min-height:42px;padding:8px 11px;font-size:13px}}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function showBanner(version) {
    latestVersion = version;
    if (!banner) {
      addStyles();
      banner = document.createElement('aside');
      banner.className = 'kitui-update-banner';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.innerHTML = '<p class="kitui-update-banner__text">A new website update is available!</p>' +
        '<button class="kitui-update-banner__button" type="button">Refresh Now</button>';
      banner.querySelector('button').addEventListener('click', function () {
        saveStoredVersion(latestVersion);
        baselineVersion = latestVersion;
        var button = banner.querySelector('button');
        button.disabled = true;
        button.textContent = 'Refreshing…';
        // The cache-busting query ensures a fresh document; reload(true) also
        // requests a hard reload in browsers that support the legacy flag.
        var destination = new URL(window.location.href);
        destination.searchParams.set('siteVersion', latestVersion);
        window.history.replaceState(null, '', destination.href);
        window.location.reload(true);
      });
      document.body.insertBefore(banner, document.body.firstChild);
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
        // Set a quiet baseline for first-time visitors. Future deployments
        // notify them when version.json is incremented.
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

  baselineVersion = readStoredVersion();
  checkVersion();
  window.setInterval(checkVersion, CHECK_INTERVAL_MS);
  window.addEventListener('pageshow', checkVersion);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkVersion();
  });
})();
