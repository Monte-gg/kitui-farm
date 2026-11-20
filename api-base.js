// Points the static site at the API server that runs in the background.
// On Render the API is same-origin; on GitHub Pages (or any other host) every
// /api/ request is forwarded to the Render backend with a bearer token, since
// browsers block third-party cookies for cross-site requests.
(function () {
  'use strict';

  var API_ORIGIN = 'https://kitui-farm.onrender.com';
  var host = location.hostname;
  var sameOriginHost = (/(^|\.)onrender\.com$/i.test(host))
    || host === 'localhost' || host === '127.0.0.1' || host === '';
  var base = sameOriginHost ? '' : API_ORIGIN;
  var isApp = /KituiFarmAndroidApp/i.test(navigator.userAgent || '') || Boolean(window.KituiAndroid);

  var APP_GET_TTL = {
    '/api/auth/me': 180000,
    '/api/wallet/mpesa/config': 600000,
    '/api/wallet/daraja/config': 600000
  };

  window.KITUI_API_BASE = base;
  window.KITUI_TOKEN_KEY = 'kituiFarmToken';

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init ? Object.assign({}, init) : {};
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();

    if (url.indexOf('/api/') === 0 || url.indexOf('api/') === 0) {
      var path = url.charAt(0) === '/' ? url : '/' + url;
      if (base) {
        input = base + path;
        init.credentials = 'omit';
      }
      var headers = new Headers(init.headers || {});
      var token = null;
      // Each browser tab keeps its own signed-in identity. A remembered token is
      // only a fallback for a new tab, never an override for its active session.
      try { token = sessionStorage.getItem('kituiFarmToken') || localStorage.getItem('kituiFarmToken'); } catch (error) { token = null; }
      if (token) headers.set('Authorization', 'Bearer ' + token);
      init.headers = headers;

      if (isApp) {
        var tokenPrefix = token ? token.slice(0, 12) : 'anon';
        var pathOnly = path.split('?')[0];

        // Clear cached identity after mutations to auth or profile
        if (method !== 'GET' && (pathOnly.indexOf('/api/auth/') === 0 || pathOnly.indexOf('/api/profile') === 0)) {
          try { sessionStorage.removeItem('kfApiCache:/api/auth/me:' + tokenPrefix); } catch (e) {}
        }

        var ttl = method === 'GET' && init.cache !== 'no-store' ? APP_GET_TTL[pathOnly] : 0;
        if (ttl && path === pathOnly) {
          var cacheKey = 'kfApiCache:' + pathOnly + ':' + tokenPrefix;
          try {
            var raw = sessionStorage.getItem(cacheKey);
            if (raw) {
              var parsed = JSON.parse(raw);
              if (parsed && (Date.now() - parsed.at) < ttl && typeof parsed.body === 'string') {
                return Promise.resolve(new Response(parsed.body, {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' }
                }));
              }
            }
          } catch (e) {}

          return originalFetch(input, init).then(function (response) {
            if (response && response.ok) {
              response.clone().text().then(function (bodyText) {
                try {
                  sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), body: bodyText }));
                } catch (e) {}
              }).catch(function () {});
            }
            return response;
          });
        }
      }
    }
    return originalFetch(input, init);
  };
})();
