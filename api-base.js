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

  window.KITUI_API_BASE = base;
  window.KITUI_TOKEN_KEY = 'kituiFarmToken';

  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init ? Object.assign({}, init) : {};
    var url = typeof input === 'string' ? input : ((input && input.url) || '');
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
    }
    return originalFetch(input, init);
  };
})();
