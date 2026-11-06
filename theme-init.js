/* Apply the account's saved theme before the page paints. */
(function () {
    const THEME_KEY = 'kituiFarmTheme';
    const SESSION_KEY = 'kituiFarmSession';

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
        document.documentElement.dataset.theme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
    }

    applyTheme(readStoredTheme());

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
