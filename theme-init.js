/* Apply the account's saved theme before the page paints. */
(function () {
    const THEME_KEY = 'kituiFarmTheme';
    const SESSION_KEY = 'kituiFarmSession';
    const TOKEN_KEY = 'kituiFarmToken';
    const isApp = /KituiFarmAndroidApp/i.test(navigator.userAgent || '') || Boolean(window.KituiAndroid);

    if (isApp) {
        try {
            const params = new URLSearchParams(window.location.search);
            const skipRestore = params.get('loggedOut') === '1' || params.get('accountDeleted') === '1';
            if (!skipRestore) {
                if (!sessionStorage.getItem(SESSION_KEY)) {
                    const savedSession = localStorage.getItem(SESSION_KEY);
                    if (savedSession) sessionStorage.setItem(SESSION_KEY, savedSession);
                }
                if (!sessionStorage.getItem(TOKEN_KEY)) {
                    const savedToken = localStorage.getItem(TOKEN_KEY);
                    if (savedToken) sessionStorage.setItem(TOKEN_KEY, savedToken);
                }
            }
        } catch (_) { /* Storage may be restricted on some origins. */ }
    }

    function readStoredTheme() {
        let session = null;
        try {
            session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || 'null');
        } catch (_) { /* A malformed session should not prevent public pages loading. */ }

        if (session) {
            const accountId = session.userId || session.id;
            if (accountId) {
                try {
                    const settings = JSON.parse(localStorage.getItem(`kituiFarmSettings_${accountId}`) || 'null');
                    if (settings && ['system', 'light', 'dark'].includes(settings.theme)) {
                        document.documentElement.dataset.density = settings.density === 'compact' ? 'compact' : 'comfortable';
                        return settings.theme;
                    }
                } catch (_) { /* Fall back to the site-wide preference. */ }
            }
        }

        try {
            const theme = localStorage.getItem(THEME_KEY);
            if (['system', 'light', 'dark'].includes(theme)) return theme;
        } catch (_) { /* Private browsing may disable storage. */ }
        return 'system';
    }

    function applyTheme(theme) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
        document.documentElement.dataset.theme = resolved;
        if (isApp && window.KituiAndroid && typeof window.KituiAndroid.setThemeMode === 'function') {
            try { window.KituiAndroid.setThemeMode(resolved === 'dark'); } catch (_) {}
        }
    }

    applyTheme(readStoredTheme());

    if (isApp) {
        const rootEl = document.documentElement;
        rootEl.classList.add('kf-app');
        document.addEventListener('DOMContentLoaded', () => {
            window.__kfDomReady = true;
        }, { once: true });
        const page = window.location.pathname.split('/').pop() || 'index.html';
        if ((page === 'buyer-dashboard.html' || page === 'farmer-dashboard.html') && window.location.hash === '#orders') {
            rootEl.classList.add('kf-app-orders-view');
        }

        const scriptUrl = (document.currentScript && document.currentScript.src) || window.location.href;
        const siteRoot = new URL('.', scriptUrl);
        const head = document.head || document.getElementsByTagName('head')[0];

        if (head && !document.getElementById('kfAppPrepaint')) {
            const prepaint = document.createElement('style');
            prepaint.id = 'kfAppPrepaint';
            prepaint.textContent = [
                'html.kf-app .topbar .header-search, html.kf-app .kf-get-app-card { display: none !important; }',
                'html.kf-app.kf-app-orders-view main > section:not(#orders), html.kf-app.kf-app-orders-view .kf-app-search-slot, html.kf-app.kf-app-orders-view .kf-quick-strip { display: none !important; }'
            ].join('\n');
            head.appendChild(prepaint);
        }

        if (head && !document.querySelector('link[data-kf-app-css]')) {
            const cssLink = document.createElement('link');
            cssLink.rel = 'stylesheet';
            cssLink.href = new URL('app-layout.css?v=6', siteRoot).href;
            cssLink.dataset.kfAppCss = '1';
            head.appendChild(cssLink);
        }

        if (head && !document.querySelector('script[data-kf-app-shell]')) {
            const shellScript = document.createElement('script');
            shellScript.src = new URL('app-shell.js?v=6', siteRoot).href;
            shellScript.defer = true;
            shellScript.async = false;
            shellScript.dataset.kfAppShell = '1';
            head.appendChild(shellScript);
        }
    }

    window.addEventListener('storage', event => {
        if (event.key === THEME_KEY || (event.key && event.key.startsWith('kituiFarmSettings_'))) {
            applyTheme(readStoredTheme());
        }
    });

    if (window.matchMedia) {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
        systemTheme.addEventListener('change', () => {
            if (readStoredTheme() === 'system') applyTheme('system');
        });
    }
})();
