(function () {
  'use strict';

  const isApp = /KituiFarmAndroidApp/i.test(navigator.userAgent || '') || Boolean(window.KituiAndroid);
  if (!isApp) return;

  const rootEl = document.documentElement;
  rootEl.classList.add('kf-app');

  const currentScript = document.currentScript || document.querySelector('script[src*="app-shell.js"]');
  const siteRoot = new URL('.', (currentScript && currentScript.src) || window.location.href);
  const emblemUrl = new URL('assets/kitui-farm-emblem.png', siteRoot).href;
  const appIconUrl = new URL('assets/kitui-farm-app-icon.png', siteRoot).href;

  // 1. Register Stale-While-Revalidate Service Worker (APK only) for instant section navigation
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('sw.js', siteRoot).href).catch(() => {});
  }

  // 2. Keep Render backend warm on launch/resume (throttled to 25s)
  let lastWarmAt = 0;
  function warmBackend() {
    const now = Date.now();
    if (now - lastWarmAt < 25_000) return;
    lastWarmAt = now;
    fetch('/api/health', { method: 'GET', cache: 'no-store' }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') warmBackend();
  });

  function bootAppShell() {
  // 3. Session & current route context
  let session = null;
  let token = '';
  try {
    session = JSON.parse(sessionStorage.getItem('kituiFarmSession') || localStorage.getItem('kituiFarmSession') || 'null');
    token = sessionStorage.getItem('kituiFarmToken') || localStorage.getItem('kituiFarmToken') || '';
  } catch (_) {}

  const path = window.location.pathname.split('/').pop() || 'index.html';
  const isAdmin = session?.role === 'admin' || window.location.search.includes('admin=1') || path.startsWith('admin');
  const isSignedInUser = Boolean(session && token && session.userId && ['buyer', 'farmer'].includes(session.role) && !isAdmin);
  const role = session?.role === 'farmer' ? 'farmer' : 'buyer';
  const homeHref = role === 'farmer' ? 'farmer-dashboard.html' : 'buyer-dashboard.html';
  const ordersHref = `${homeHref}#orders`;
  const profileHref = session?.userId
    ? `profile.html?accountId=${encodeURIComponent(session.userId)}`
    : 'profile.html';
  const isDashboardPage = path === 'buyer-dashboard.html' || path === 'farmer-dashboard.html';

  if (['farmer-store.html', 'receipts.html', 'receipt.html', 'payment.html'].includes(path)) {
    rootEl.classList.add('kf-app-show-back');
  }

  // Track Orders View state cleanly (for buyer & farmer dashboards)
  let isOrdersView = isDashboardPage && window.location.hash === '#orders';
  const syncOrdersViewClass = () => {
    isOrdersView = isDashboardPage && window.location.hash === '#orders';
    rootEl.classList.toggle('kf-app-orders-view', isOrdersView);
    const homeBtn = document.getElementById('kfAppHomeBtn');
    if (homeBtn) {
      const homeActive = path === homeHref && !isOrdersView;
      homeBtn.classList.toggle('is-active', homeActive);
      if (homeActive) homeBtn.setAttribute('aria-current', 'page');
      else homeBtn.removeAttribute('aria-current');
    }
    syncBottomBarState();
  };

  function setOrdersView(open) {
    if (!isDashboardPage) {
      window.location.assign(open ? ordersHref : homeHref);
      return;
    }
    if (open) {
      if (window.location.hash !== '#orders') {
        history.pushState({ kfOrders: true }, '', '#orders');
      }
    } else if (window.location.hash === '#orders') {
      history.pushState({ kfOrders: false }, '', path);
    }
    syncOrdersViewClass();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  // 4. Shared helpers
  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch (_) { return fallback; }
  };
  const writeJson = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  };

  function showNavProgress() {
    let bar = document.getElementById('kfNavProgress');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'kfNavProgress';
      bar.className = 'kf-nav-progress';
      bar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(bar);
    }
    bar.classList.add('is-loading');
  }
  window.addEventListener('pageshow', () => {
    document.getElementById('kfNavProgress')?.classList.remove('is-loading');
  });

  function performAppLogout() {
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    try {
      sessionStorage.removeItem('kituiFarmSession');
      sessionStorage.removeItem('kituiFarmToken');
      localStorage.removeItem('kituiFarmSession');
      localStorage.removeItem('kituiFarmToken');
    } catch (_) {}
    window.location.replace('login.html?loggedOut=1');
  }

  // 5. Uniform Top App Bar + Search Slot + Dashboard Quick Actions
  const header = document.querySelector('header');
  const mainEl = document.querySelector('main');

  if (header) {
    const brand = header.querySelector('.brand');
    if (brand) {
      if (!brand.querySelector('.kf-app-brand-title')) {
        const img = document.createElement('img');
        img.className = 'kitui-brand-icon';
        img.src = emblemUrl;
        img.alt = '';
        img.decoding = 'async';
        const title = document.createElement('span');
        title.className = 'kf-app-brand-title';
        title.textContent = isAdmin ? 'KITUI FARM · Admin' : 'KITUI FARM';
        brand.replaceChildren(img, title);
      }
      if (isSignedInUser) {
        brand.addEventListener('click', (e) => {
          if (brand.tagName !== 'A' || isDashboardPage) {
            e.preventDefault();
            setOrdersView(false);
          }
        });
      }
    }

    // Move dashboard search input cleanly out of topbar into <main>
    const headerSearch = header.querySelector('.search-box.header-search');
    if (headerSearch && mainEl && !document.querySelector('.kf-app-search-slot')) {
      const slot = document.createElement('div');
      slot.className = 'kf-app-search-slot';
      slot.appendChild(headerSearch);
      mainEl.insertAdjacentElement('afterbegin', slot);
    }

    // Ensure receipts.html (<header class="top">) gets clean right action buttons + menu sheet
    let actionHost = header.querySelector('.header-actions') || header.querySelector('.topbar-inner') || header.querySelector('.bar');
    if (!actionHost && header.classList.contains('top')) {
      actionHost = document.createElement('div');
      actionHost.className = 'kf-app-header-actions';
      header.appendChild(actionHost);
    }

    if (actionHost && isSignedInUser) {
      const anchorBefore = actionHost.querySelector('#moreMenu, .kf-menu-wrap');

      // Home Icon Button
      if (!document.getElementById('kfAppHomeBtn')) {
        const homeBtn = document.createElement('a');
        homeBtn.id = 'kfAppHomeBtn';
        homeBtn.href = homeHref;
        homeBtn.className = `kf-app-icon-btn ${path === homeHref && !isOrdersView ? 'is-active' : ''}`;
        homeBtn.setAttribute('aria-label', 'Home dashboard');
        homeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"/></svg>';
        homeBtn.addEventListener('click', (e) => {
          if (isDashboardPage && path === homeHref) {
            e.preventDefault();
            setOrdersView(false);
          } else {
            showNavProgress();
          }
        });
        const cartMenu = actionHost.querySelector('#cartMenu');
        if (cartMenu) actionHost.insertBefore(homeBtn, cartMenu);
        else if (anchorBefore) actionHost.insertBefore(homeBtn, anchorBefore);
        else actionHost.appendChild(homeBtn);
      }

      // Notifications Bell Button
      if (!document.getElementById('kfAppBellBtn')) {
        const bellBtn = document.createElement('a');
        bellBtn.id = 'kfAppBellBtn';
        bellBtn.href = 'notifications.html';
        bellBtn.className = `kf-app-icon-btn ${path === 'notifications.html' ? 'is-active' : ''}`;
        bellBtn.setAttribute('aria-label', 'Open notifications');
        if (path === 'notifications.html') bellBtn.setAttribute('aria-current', 'page');
        bellBtn.innerHTML = `
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          <span class="kf-app-badge" id="kfAppBellBadge" hidden>0</span>
        `;
        bellBtn.addEventListener('click', () => {
          if (path !== 'notifications.html') showNavProgress();
        });
        if (anchorBefore) actionHost.insertBefore(bellBtn, anchorBefore);
        else actionHost.appendChild(bellBtn);
      }

      // Fallback Menu Sheet on receipts.html (no subpage-nav)
      if (!actionHost.querySelector('#moreMenu, .kf-menu-wrap')) {
        const wrap = document.createElement('div');
        wrap.className = 'kf-menu-wrap';
        wrap.innerHTML = `
          <button type="button" class="kf-menu-button" id="kfReceiptMenuBtn" aria-label="Open KITUI FARM features" aria-haspopup="true" aria-expanded="false">⋮</button>
          <nav class="kf-feature-menu" id="kfReceiptMenuPanel" aria-label="KITUI FARM features" hidden></nav>
        `;
        actionHost.appendChild(wrap);
        const btn = wrap.querySelector('#kfReceiptMenuBtn');
        const panel = wrap.querySelector('#kfReceiptMenuPanel');
        btn.addEventListener('click', () => {
          const open = panel.hidden;
          panel.hidden = !open;
          btn.setAttribute('aria-expanded', String(open));
        });
        document.addEventListener('click', (e) => {
          if (!wrap.contains(e.target) && !panel.hidden) {
            panel.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
          }
        });
      }
    }
  }

  // 6. Focused Orders Header on Dashboards
  if (isDashboardPage && mainEl) {
    // Focused Orders Header Strip
    if (!document.querySelector('.kf-orders-topbar')) {
      const ordersBar = document.createElement('div');
      ordersBar.className = 'kf-orders-topbar';
      ordersBar.innerHTML = `
        <h1>${path === 'farmer-dashboard.html' ? 'Buyer Orders' : 'My Orders'}</h1>
        <div class="kf-orders-topbar__actions">
          <button type="button" class="button secondary" id="kfOrdersBackBtn">← ${path === 'farmer-dashboard.html' ? 'Back to Farm' : 'Back to Shop'}</button>
          ${path === 'buyer-dashboard.html' ? '<a class="button secondary" href="receipts.html">Receipts</a>' : ''}
        </div>
      `;
      const ordersSection = document.getElementById('orders');
      if (ordersSection) ordersSection.insertAdjacentElement('beforebegin', ordersBar);
      else mainEl.appendChild(ordersBar);

      ordersBar.querySelector('#kfOrdersBackBtn').addEventListener('click', () => setOrdersView(false));
    }
  }

  // 7. 3-Tab Fixed Bottom Navigation Bar (STRICTLY: Orders · Wallet · Messages)
  const appBarPages = [
    'buyer-dashboard.html', 'farmer-dashboard.html', 'farmer-store.html',
    'wallet.html', 'payment.html', 'chat.html', 'notifications.html',
    'profile.html', 'settings.html', 'receipts.html', 'about-us.html', 'customer-service.html'
  ];

  function getActiveBottomKey() {
    if ((isDashboardPage && isOrdersView) || path === 'receipts.html') return 'orders';
    if (path === 'wallet.html' || path === 'payment.html') return 'wallet';
    if (path === 'chat.html') return 'messages';
    return '';
  }

  function syncBottomBarState() {
    const bar = document.getElementById('kfBottomBar');
    if (!bar) return;
    const activeKey = getActiveBottomKey();
    bar.querySelectorAll('.kf-bottom-tab').forEach((tab) => {
      const on = tab.dataset.tab === activeKey;
      tab.classList.toggle('is-active', on);
      if (on) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
  }

  if (isSignedInUser && appBarPages.includes(path) && !document.getElementById('kfBottomBar')) {
    const nav = document.createElement('nav');
    nav.id = 'kfBottomBar';
    nav.className = 'kf-bottom-bar';
    nav.setAttribute('aria-label', 'App navigation');
    nav.innerHTML = `
      <a href="${ordersHref}" class="kf-bottom-tab" data-tab="orders">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16.5 9.4 7.5 4.2"/>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
          <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>
        </svg>
        <span>Orders</span>
      </a>
      <a href="wallet.html" class="kf-bottom-tab" data-tab="wallet">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="6" width="18" height="13" rx="2.5"/>
          <path d="M16 12.5h5v3h-5a1.5 1.5 0 0 1 0-3Z"/>
        </svg>
        <span>Wallet</span>
      </a>
      <a href="chat.html" class="kf-bottom-tab" data-tab="messages">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/>
        </svg>
        <span class="kf-bottom-tab__badge" id="kfMsgTabBadge" hidden>0</span>
        <span>Messages</span>
      </a>
    `;
    document.body.appendChild(nav);
    rootEl.classList.add('kf-has-bottom-bar');

    nav.querySelectorAll('.kf-bottom-tab').forEach((tab) => {
      tab.addEventListener('pointerdown', () => {
        nav.querySelectorAll('.kf-bottom-tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
      }, { passive: true });
      tab.addEventListener('click', (e) => {
        if (tab.dataset.tab === 'orders' && isDashboardPage && path === homeHref) {
          e.preventDefault();
          setOrdersView(true);
          return;
        }
        showNavProgress();
      });
    });

    syncOrdersViewClass();
    window.addEventListener('hashchange', syncOrdersViewClass);
    window.addEventListener('popstate', syncOrdersViewClass);
    window.addEventListener('pageshow', syncOrdersViewClass);

    // Non-blocking prefetch so Orders / Wallet / Messages / Alerts switch instantly
    window.setTimeout(() => {
      [homeHref, 'wallet.html', 'chat.html', 'notifications.html', 'settings.html'].forEach((target) => {
        if (!target || target === path) return;
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.as = 'document';
        link.href = target;
        document.head.appendChild(link);
      });
    }, 350);
  } else {
    syncOrdersViewClass();
  }

  // 8. Enrich Feature Menu, Add Bottom-Sheet Backdrop & Touch Highlighters
  function closeAllHeaderSheets() {
    const morePanel = document.getElementById('morePanel');
    const moreToggle = document.getElementById('moreToggle');
    if (morePanel && !morePanel.hidden) {
      morePanel.hidden = true;
      moreToggle?.setAttribute('aria-expanded', 'false');
    }
    const cartPanel = document.getElementById('cartPanel');
    const cartToggle = document.getElementById('cartToggle');
    if (cartPanel && !cartPanel.hidden) {
      cartPanel.hidden = true;
      cartToggle?.setAttribute('aria-expanded', 'false');
    }
    document.querySelectorAll('.kf-feature-menu').forEach((menu) => {
      if (!menu.hidden) {
        menu.hidden = true;
        menu.closest('.kf-menu-wrap')?.querySelector('.kf-menu-button')?.setAttribute('aria-expanded', 'false');
      }
    });
  }

  let backdrop = document.getElementById('kfSheetBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'kfSheetBackdrop';
    backdrop.className = 'kf-sheet-backdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', closeAllHeaderSheets);
  }

  function syncSheetBackdropAndRefresh() {
    const anyMenuOpen = Array.from(document.querySelectorAll('#morePanel, #cartPanel, .kf-feature-menu'))
      .some((el) => !el.hidden);
    const anyDialogOpen = Boolean(document.querySelector('dialog[open]'));
    backdrop.hidden = !anyMenuOpen;
    if (window.KituiAndroid && typeof window.KituiAndroid.setSwipeRefreshEnabled === 'function') {
      try { window.KituiAndroid.setSwipeRefreshEnabled(!anyMenuOpen && !anyDialogOpen); } catch (_) {}
    }
  }

  const sheetObserver = new MutationObserver(syncSheetBackdropAndRefresh);
  document.querySelectorAll('#morePanel, #cartPanel, .kf-feature-menu, dialog').forEach((node) => {
    sheetObserver.observe(node, { attributes: true, attributeFilter: ['hidden', 'open'] });
  });
  syncSheetBackdropAndRefresh();

  // Enrich dashboard .more-panel links (add Notifications) & subpage .kf-feature-menu links
  const morePanel = document.getElementById('morePanel');
  if (morePanel && isSignedInUser && !morePanel.querySelector('a[href="notifications.html"]')) {
    const notifLink = document.createElement('a');
    notifLink.href = 'notifications.html';
    notifLink.setAttribute('role', 'menuitem');
    notifLink.textContent = 'Notifications';
    const settingsLink = morePanel.querySelector('a[href="settings.html"]');
    if (settingsLink) morePanel.insertBefore(notifLink, settingsLink);
    else morePanel.appendChild(notifLink);
  }

  // Intercept wishlist link on buyer-dashboard so tapping Wishlist exits Orders view cleanly
  document.getElementById('wishlistMenuLink')?.addEventListener('click', () => {
    if (isOrdersView) setOrdersView(false);
  });

  // Ensure subpage .kf-feature-menu gives complete access to every feature + Logout
  document.querySelectorAll('.kf-feature-menu').forEach((menu) => {
    if (!isSignedInUser) return;
    const dashboardLabel = role === 'farmer' ? 'Farmer dashboard' : 'Customer dashboard';
    const fullLinks = [
      [dashboardLabel, homeHref],
      [role === 'farmer' ? 'Buyer orders' : 'My orders', ordersHref],
      ['Messages', 'chat.html'],
      ['Wallet & Payments', 'wallet.html'],
      ['Notifications', 'notifications.html'],
      ...(role === 'buyer'
        ? [['My receipts', 'receipts.html']]
        : [
            ['My store', `farmer-store.html?farmerId=${encodeURIComponent(session.userId)}`],
            ['Buy produce', 'buyer-dashboard.html']
          ]),
      ['Profile & Account', profileHref],
      ['Settings', 'settings.html'],
      ['Customer Support', 'customer-service.html'],
      ['About KITUI FARM', 'about-us.html']
    ];
    menu.replaceChildren();
    fullLinks.forEach(([label, href]) => {
      const a = document.createElement('a');
      a.href = href;
      a.setAttribute('role', 'menuitem');
      a.textContent = label;
      menu.appendChild(a);
    });
    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    divider.setAttribute('role', 'separator');
    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.className = 'menu-logout';
    logoutBtn.setAttribute('role', 'menuitem');
    logoutBtn.textContent = 'Log out';
    logoutBtn.addEventListener('click', performAppLogout);
    menu.append(divider, logoutBtn);
  });

  // Highlight active route & bind instant pointerdown highlight on all dropdown menus
  function markCurrentMenuLinks() {
    document.querySelectorAll('.more-panel a, .kf-feature-menu a').forEach((link) => {
      const raw = link.getAttribute('href') || '';
      if (!raw) return;
      const [file, hash] = raw.split('#');
      const filePart = (file || '').split('?')[0];
      const matchesOrders = hash === 'orders' && isDashboardPage && isOrdersView;
      const matchesPage = filePart === path && (!hash ? !isOrdersView : matchesOrders);
      link.classList.toggle('is-current-page', matchesPage);
      if (matchesPage) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  markCurrentMenuLinks();
  window.addEventListener('hashchange', markCurrentMenuLinks);
  window.addEventListener('popstate', markCurrentMenuLinks);

  // Reliable delegated navigation for all dropdown sheet links (⋮ menu)
  document.addEventListener('click', (e) => {
    const menuPanel = e.target.closest('.more-panel, .kf-feature-menu');
    if (!menuPanel) return;
    const link = e.target.closest('a[href]');
    if (!link) return;

    const rawHref = link.getAttribute('href') || '';
    link.classList.add('is-pressed');

    if (rawHref.endsWith('#orders') && isDashboardPage && path === homeHref) {
      e.preventDefault();
      e.stopPropagation();
      closeAllHeaderSheets();
      setOrdersView(true);
      return;
    }
    if (rawHref === '#wishlist' && path === 'buyer-dashboard.html') {
      e.preventDefault();
      e.stopPropagation();
      if (isOrdersView) setOrdersView(false);
      closeAllHeaderSheets();
      document.getElementById('wishlist')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    showNavProgress();
    closeAllHeaderSheets();
    window.location.assign(link.href);
  });

  // Fast delegated press highlighter across all dropdown menus (including dynamic chat menus)
  document.addEventListener('pointerdown', (e) => {
    const item = e.target.closest('.more-panel a, .more-panel button, .kf-feature-menu a, .kf-feature-menu button, .menu-panel button, .menu-panel a');
    if (item) item.classList.add('is-pressed');
  }, { passive: true });
  ['pointerup', 'pointercancel', 'scroll'].forEach((evt) => {
    document.addEventListener(evt, () => {
      document.querySelectorAll('.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
    }, { passive: true });
  });

  // Dashboard offline-safe logout fallback inside APK
  const dashLogout = document.getElementById('logoutButton');
  if (dashLogout && isDashboardPage) {
    dashLogout.addEventListener('click', () => {
      window.setTimeout(() => {
        if (window.location.pathname.endsWith(path)) {
          performAppLogout();
        }
      }, 1500);
    });
  }

  // 9. Settings Page: App Permissions Card (APK only)
  if (path === 'settings.html' && mainEl && !document.getElementById('kfAppPermissionsCard')) {
    const permCard = document.createElement('section');
    permCard.id = 'kfAppPermissionsCard';
    permCard.className = 'card kf-perm-card';
    permCard.setAttribute('aria-labelledby', 'kfPermTitle');
    permCard.innerHTML = `
      <div class="card-heading">
        <h2 id="kfPermTitle">App permissions</h2>
        <p>Enable Location and Notifications so "Use current location" and real-time order, message, and wallet alerts work on your phone.</p>
      </div>
      <div style="margin: 10px 0 14px;">
        <button type="button" class="button primary" id="kfEnableAllPermsBtn" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
          <span>Enable access to all permissions</span>
        </button>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>Location access</strong>
          <small id="kfPermLocDesc">Used when tapping "Use current location" on your profile or listings.</small>
        </div>
        <div id="kfPermLocAction"></div>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>App notifications</strong>
          <small id="kfPermNotifDesc">Receive phone alerts for messages, order tracking, wallet activity, and APK updates.</small>
        </div>
        <div id="kfPermNotifAction"></div>
      </div>
      <div class="setting-row">
        <div class="setting-copy">
          <strong>Phone permission settings</strong>
          <small>Open Android App Info to change permissions directly on your device.</small>
        </div>
        <button type="button" class="button secondary" id="kfOpenPhoneSettingsBtn">Open settings</button>
      </div>
    `;

    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) settingsForm.insertAdjacentElement('beforebegin', permCard);
    else mainEl.appendChild(permCard);

    const refreshPermUI = () => {
      const hasLoc = Boolean(window.KituiAndroid?.hasLocationPermission?.());
      const hasNotif = Boolean(window.KituiAndroid?.hasNotificationPermission?.());

      const locHost = document.getElementById('kfPermLocAction');
      const notifHost = document.getElementById('kfPermNotifAction');
      const allBtn = document.getElementById('kfEnableAllPermsBtn');

      if (locHost) {
        if (hasLoc) {
          locHost.innerHTML = '<span class="kf-perm-pill">Enabled ✓</span>';
        } else {
          locHost.innerHTML = '<button type="button" class="button secondary" id="kfEnableLocBtn">Enable location</button>';
          locHost.querySelector('#kfEnableLocBtn')?.addEventListener('click', () => {
            window.KituiAndroid?.requestLocationPermission?.();
          });
        }
      }
      if (notifHost) {
        if (hasNotif) {
          notifHost.innerHTML = '<span class="kf-perm-pill">Enabled ✓</span>';
        } else {
          notifHost.innerHTML = '<button type="button" class="button secondary" id="kfEnableNotifBtn">Enable alerts</button>';
          notifHost.querySelector('#kfEnableNotifBtn')?.addEventListener('click', () => {
            window.KituiAndroid?.requestNotificationPermission?.();
          });
        }
      }
      if (allBtn) {
        allBtn.disabled = hasLoc && hasNotif;
        const label = allBtn.querySelector('span');
        if (label) {
          label.textContent = (hasLoc && hasNotif)
            ? 'All app permissions enabled ✓'
            : 'Enable access to all permissions';
        }
      }
    };

    document.getElementById('kfEnableAllPermsBtn')?.addEventListener('click', () => {
      window.KituiAndroid?.enableAllPermissions?.();
    });
    document.getElementById('kfOpenPhoneSettingsBtn')?.addEventListener('click', () => {
      window.KituiAndroid?.openAppSettings?.();
    });

    window.__kituiPermissionsUpdated = refreshPermUI;
    window.addEventListener('focus', refreshPermUI);
    refreshPermUI();
  }

  // 10. Throttled Notifications, Unread Badges (Bell + Messages Tab) & Native Alerts
  if (isSignedInUser && !['login.html', 'signup.html', 'forgot-password.html'].includes(path)) {
    const SEEN_KEY = `kituiFarmNotifSeen_${session.userId}`;
    const SNAP_KEY = `kituiFarmNotifSnap_${session.userId}`;
    const CACHE_KEY = `kituiFarmNotifItems_${session.userId}`;
    const CHAT_UNREAD_KEY = `kituiFarmChatUnread_${session.userId}`;

    const syncBadges = () => {
      const seenMap = readJson(SEEN_KEY, {});
      const items = readJson(CACHE_KEY, []);
      const unreadNotifs = Array.isArray(items) ? items.filter((item) => item && !seenMap[item.key]).length : 0;
      const bellBadge = document.getElementById('kfAppBellBadge');
      if (bellBadge) {
        bellBadge.hidden = unreadNotifs === 0;
        bellBadge.textContent = unreadNotifs > 99 ? '99+' : String(unreadNotifs);
      }

      const unreadMsgs = Number(localStorage.getItem(CHAT_UNREAD_KEY) || 0) || 0;
      const msgBadge = document.getElementById('kfMsgTabBadge');
      if (msgBadge) {
        msgBadge.hidden = unreadMsgs === 0;
        msgBadge.textContent = unreadMsgs > 99 ? '99+' : String(unreadMsgs);
      }
    };
    window.__kituiSyncNotifBadges = syncBadges;
    syncBadges();

    async function pollAppNotifications(force) {
      if (document.visibilityState === 'hidden') return;
      try {
        const lastPoll = Number(sessionStorage.getItem('kfNotifPollAt') || 0);
        if (!force && Date.now() - lastPoll < 45_000) return;
        sessionStorage.setItem('kfNotifPollAt', String(Date.now()));
      } catch (_) {}

      try {
        const ordersEndpoint = role === 'farmer' ? '/api/orders' : '/api/orders/purchases';
        const [chatRes, ordersRes, walletRes] = await Promise.all([
          fetch('/api/chat/conversations').then((r) => (r.ok ? r.json() : { conversations: [] })).catch(() => ({ conversations: [] })),
          fetch(ordersEndpoint).then((r) => (r.ok ? r.json() : { orders: [] })).catch(() => ({ orders: [] })),
          fetch('/api/wallet').then((r) => (r.ok ? r.json() : { transactions: [] })).catch(() => ({ transactions: [] }))
        ]);

        let unreadMsgs = 0;
        const items = [];

        for (const conv of chatRes.conversations || []) {
          const unread = Number(conv.unreadCount) || 0;
          unreadMsgs += unread;
          items.push({
            key: `chat:${conv.id}:${conv.updatedAt}:${unread}`,
            category: 'chat',
            categoryLabel: unread > 0 ? `Chat · ${unread} unread` : 'Chat message',
            icon: '💬',
            title: unread > 0 ? `New message from ${conv.peerName}` : `Conversation with ${conv.peerName}`,
            body: conv.lastMessage || `Regarding ${conv.listingName || 'farm produce'}`,
            time: conv.updatedAt,
            href: 'chat.html'
          });
        }
        try { localStorage.setItem(CHAT_UNREAD_KEY, String(unreadMsgs)); } catch (_) {}

        const ordersList = (ordersRes.orders && ordersRes.orders.length)
          ? ordersRes.orders
          : readJson('kituiFarmOrders', []).filter((o) => role === 'farmer' || o.buyerId === session.userId);

        for (const order of ordersList.slice(0, 20)) {
          const updates = Array.isArray(order.deliveryUpdates) ? order.deliveryUpdates : [];
          const latest = updates.length ? updates[updates.length - 1] : null;
          const status = order.status || 'Processing';
          const names = Array.isArray(order.items) ? order.items.map((i) => i.name).join(', ') : 'Order';
          items.push({
            key: `order:${order.id}:${status}:${order.returnRequest ? order.returnRequest.status : ''}`,
            category: 'order',
            categoryLabel: `Order · ${status}`,
            icon: ['Delivered', 'Completed'].includes(status) ? '✅' : '📦',
            title: role === 'farmer' ? `Order ${order.id} · ${status}` : `Order ${order.id} is ${status}`,
            body: latest && latest.note
              ? `${names} — ${latest.note}`
              : `${names} · KES ${Number(order.total || 0).toLocaleString('en-KE')}`,
            time: (latest && latest.createdAt) || order.createdAt,
            href: ordersHref
          });
        }

        for (const tx of (walletRes.transactions || []).slice(0, 15)) {
          const sign = tx.direction === 'credit' ? '+' : '−';
          items.push({
            key: `wallet:${tx.id}:${tx.status}`,
            category: 'wallet',
            categoryLabel: `Wallet · ${tx.status || 'completed'}`,
            icon: tx.direction === 'credit' ? '💰' : '💳',
            title: `Wallet ${tx.type}: ${sign}KES ${Number(tx.amount || 0).toLocaleString('en-KE')}`,
            body: tx.description || 'KITUI FARM Wallet transaction',
            time: tx.createdAt,
            href: 'wallet.html'
          });
        }

        items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
        writeJson(CACHE_KEY, items);

        const prevSnap = readJson(SNAP_KEY, null);
        const nextSnap = {};
        items.forEach((item) => { nextSnap[item.key] = true; });
        if (prevSnap) {
          const newItems = items.filter((item) => !prevSnap[item.key] && (item.category !== 'chat' || item.categoryLabel.includes('unread')));
          if (newItems.length && window.KituiAndroid && typeof window.KituiAndroid.showNotification === 'function') {
            const top = newItems[0];
            window.KituiAndroid.showNotification(top.title, top.body, new URL(top.href, siteRoot).href);
          }
        }
        writeJson(SNAP_KEY, nextSnap);
        syncBadges();
      } catch (_) {}
    }

    window.setTimeout(() => pollAppNotifications(false), 2500);
    window.setInterval(() => pollAppNotifications(true), 45_000);
    window.addEventListener('focus', () => pollAppNotifications(false));
  }

  // 11. APK Update Check (deferred & throttled to 5 min)
  window.setTimeout(function checkApkUpdate() {
    const compareSemver = (aStr, bStr) => {
      const a = String(aStr || '').split('.').map((n) => Number(n) || 0);
      const b = String(bStr || '').split('.').map((n) => Number(n) || 0);
      for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
      }
      return 0;
    };

    const handleApkData = (data) => {
      if (!data || !data.appVersion || !data.apkUrl) return;
      const uaMatch = /KituiFarmAndroidApp\/(\d+(?:\.\d+)*)/i.exec(navigator.userAgent || '');
      const installed = (window.KituiAndroid && typeof window.KituiAndroid.getAppVersion === 'function')
        ? String(window.KituiAndroid.getAppVersion())
        : (uaMatch ? uaMatch[1] : '1.0.7');
      if (compareSemver(data.appVersion, installed) <= 0) return;

      const notifiedKey = `kituiApkNotif_${data.appVersion}`;
      try {
        if (!localStorage.getItem(notifiedKey)) {
          localStorage.setItem(notifiedKey, '1');
          window.KituiAndroid?.showNotification?.(
            `KITUI FARM Update (v${data.appVersion})`,
            'A newer Android app version is available. Tap to download.',
            data.apkUrl
          );
        }
      } catch (_) {}

      if (mainEl && !document.getElementById('kfApkUpdateCard')) {
        const card = document.createElement('aside');
        card.id = 'kfApkUpdateCard';
        card.className = 'card';
        card.style.marginBottom = '14px';
        card.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
              <img src="${appIconUrl}" alt="" style="width:40px;height:40px;border-radius:10px;flex:0 0 40px;">
              <div style="min-width:0;">
                <strong style="display:block;font-size:15px;">App update v${data.appVersion} ready</strong>
                <small style="color:var(--muted);">Install the latest KITUI FARM Android release.</small>
              </div>
            </div>
            <a class="button primary" href="${data.apkUrl}">Update App</a>
          </div>
        `;
        mainEl.insertAdjacentElement('afterbegin', card);
      }
    };

    try {
      const checkedAt = Number(sessionStorage.getItem('kfApkVerAt') || 0);
      const cached = JSON.parse(sessionStorage.getItem('kfVerData') || 'null');
      if (cached && Date.now() - checkedAt < 300_000) {
        handleApkData(cached);
        return;
      }
    } catch (_) {}

    const url = new URL('version.json', siteRoot);
    url.searchParams.set('_', String(Date.now()));
    fetch(url.href, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        try {
          sessionStorage.setItem('kfApkVerAt', String(Date.now()));
          sessionStorage.setItem('kfVerData', JSON.stringify(data));
        } catch (_) {}
        handleApkData(data);
      })
      .catch(() => {});
  }, 3000);
  }

  if (window.__kfDomReady || document.readyState === 'complete') {
    bootAppShell();
  } else {
    document.addEventListener('DOMContentLoaded', bootAppShell, { once: true });
  }
})();
