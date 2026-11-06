(() => {
    const script = document.currentScript || document.querySelector('script[src*="subpage-nav.js"]');
    if (!script) return;
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = new URL('subpage-nav.css?v=4', script.src).href;
    document.head.append(style);

    const header = document.querySelector('header');
    if (!header) return;
    const container = header.querySelector('.topbar-inner, .bar') || header.firstElementChild;
    if (!container) return;
    const brand = container.querySelector('.brand') || container.firstElementChild;
    if (!brand) return;

    let session = null;
    try {
        session = JSON.parse(sessionStorage.getItem('kituiFarmSession') || localStorage.getItem('kituiFarmSession') || 'null');
    } catch { /* use the customer dashboard as the signed-out fallback */ }
    const role = session?.role === 'farmer' ? 'farmer' : 'buyer';
    const profileHref = session?.userId ? `profile.html?accountId=${encodeURIComponent(session.userId)}` : 'profile.html';
    const dashboardUrl = role === 'farmer' ? 'farmer-dashboard.html' : 'buyer-dashboard.html';
    const dashboardLabel = role === 'farmer' ? 'Farmer dashboard' : 'Customer dashboard';

    header.classList.add('kf-subpage-header');
    const back = container.querySelector('.kf-back-button') || document.createElement('button');
    const menuWrap = container.querySelector('.kf-menu-wrap') || document.createElement('div');
    for (const child of [...container.children]) {
        if (![brand, back, menuWrap].includes(child)) child.classList.add('kf-legacy-controls');
    }

    back.className = 'kf-back-button';
    back.type = 'button';
    back.setAttribute('aria-label', 'Go back to the previous page');
    if (!back.hasChildNodes()) back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"></path><path d="m12 19-7-7 7-7"></path></svg><span>Back</span>';
    back.addEventListener('click', () => {
        if (window.history.length > 1) window.history.back();
        else window.location.assign(dashboardUrl);
    });

    menuWrap.className = 'kf-menu-wrap';
    const toggle = menuWrap.querySelector('.kf-menu-button') || document.createElement('button');
    toggle.className = 'kf-menu-button';
    toggle.type = 'button';
    if (!toggle.textContent.trim()) toggle.textContent = '⋮';
    toggle.setAttribute('aria-label', 'Open KITUI FARM features');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    const menu = menuWrap.querySelector('.kf-feature-menu') || document.createElement('nav');
    menu.className = 'kf-feature-menu';
    if (!menu.id) menu.id = 'kfFeatureMenu';
    toggle.setAttribute('aria-controls', menu.id);
    menu.setAttribute('aria-label', 'KITUI FARM features');
    menu.hidden = true;

    const links = [
        [dashboardLabel, dashboardUrl],
        ['Profile & Account', 'profile.html'],
        ['Wallet & Payments', 'wallet.html'],
        ['Settings', 'settings.html'],
        ['Customer Support', 'customer-service.html'],
        ['About KITUI FARM', 'about-us.html']
    ];
    if (!menu.children.length) {
        for (const [label, href] of links) {
            const link = document.createElement('a');
            link.textContent = label;
            link.href = href;
            menu.append(link);
        }
    }
    const dashboardLink = menu.querySelector('[data-dashboard-link]') || menu.querySelector('a');
    if (dashboardLink) { dashboardLink.href = dashboardUrl; dashboardLink.textContent = dashboardLabel; }
    const profileLink = [...menu.querySelectorAll('a')].find(link => link.textContent.toLowerCase().includes('profile'));
    if (profileLink) profileLink.href = profileHref;

    function closeMenu() {
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open KITUI FARM features');
    }
    toggle.addEventListener('click', () => {
        const open = menu.hidden;
        menu.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close KITUI FARM features' : 'Open KITUI FARM features');
    });
    menu.addEventListener('click', event => {
        if (event.target.closest('a')) closeMenu();
    });
    document.addEventListener('click', event => {
        if (!menuWrap.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) {
            closeMenu();
            toggle.focus();
        }
    });

    menuWrap.append(toggle, menu);
    container.insertBefore(back, brand);
    if (menuWrap.parentElement !== container) container.append(menuWrap);
})();
