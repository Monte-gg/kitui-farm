(function () {
  'use strict';
  const scriptEl = document.currentScript || document.querySelector('script[src*="brand.js"]');
  const siteRoot = new URL('.', scriptEl ? scriptEl.src : window.location.href);
  const iconUrl = new URL('assets/kitui-farm-emblem.png?v=3', siteRoot).href;
  const appIconUrl = new URL('icons/kitui-app-icon-192.png?v=3', siteRoot).href;

  const createIcon = (className, decorative) => {
    const image = document.createElement('img');
    image.className = className;
    image.src = iconUrl;
    image.alt = decorative ? '' : 'KITUI FARM';
    image.decoding = 'async';
    return image;
  };

  // 1. Keep the signed-in user present while they browse any page.
  let activeSession = null;
  let activeToken = '';
  try {
    activeSession = JSON.parse(sessionStorage.getItem('kituiFarmSession') || localStorage.getItem('kituiFarmSession') || 'null');
    activeToken = sessionStorage.getItem('kituiFarmToken') || localStorage.getItem('kituiFarmToken') || '';
    if (activeSession && activeToken && ['buyer', 'farmer'].includes(activeSession.role)) {
      const heartbeat = () => fetch('/api/chat/presence', { method: 'POST' }).catch(() => {});
      heartbeat();
      window.setInterval(heartbeat, 25_000);
    }
  } catch (error) { /* Presence must never interrupt page rendering. */ }

  // 2. Version the shared theme and emblem from the build stamp.
  const brandStylesheet = document.querySelector('link[data-brand-theme]');
  const versionUrl = new URL('version.json', siteRoot);
  versionUrl.searchParams.set('_', String(Date.now()));
  fetch(versionUrl.href, { cache: 'no-store' }).then((response) => {
    if (!response.ok) return null;
    return response.json();
  }).then((data) => {
    if (!data || typeof data.version !== 'string' || !data.version.trim()) return;
    const version = encodeURIComponent(data.version.trim());
    if (brandStylesheet) {
      brandStylesheet.href = new URL('brand-theme.css?siteVersion=' + version, siteRoot).href;
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = new URL('assets/kitui-farm-emblem.png?siteVersion=' + version, siteRoot).href;
    document.querySelectorAll('.kitui-brand-icon, .kitui-login-emblem, .kitui-avatar-icon').forEach((image) => {
      image.src = new URL('assets/kitui-farm-emblem.png?siteVersion=' + version, siteRoot).href;
    });
  }).catch(() => {});

  // 3. Render the emblem logo + "KITUI FARM" platform name side-by-side in every header
  document.querySelectorAll('.brand').forEach((brand) => {
    const adminLabel = brand.querySelector('#adminLabel');
    const existingSmall = brand.querySelector('small');
    const subtitleText = existingSmall ? existingSmall.textContent.trim() : '';
    const isAdminBrand = /admin/i.test(brand.textContent) && !adminLabel;

    const titleWrap = document.createElement('span');
    titleWrap.className = 'kitui-brand-copy';

    const titleStrong = document.createElement('strong');
    titleStrong.className = 'kitui-brand-name';
    titleStrong.textContent = isAdminBrand ? 'KITUI FARM · Admin' : 'KITUI FARM';
    if (adminLabel) {
      titleStrong.appendChild(document.createTextNode(' '));
      titleStrong.appendChild(adminLabel);
    }
    titleWrap.appendChild(titleStrong);

    if (subtitleText) {
      const sub = document.createElement('small');
      sub.className = 'kitui-brand-sub';
      sub.textContent = subtitleText;
      titleWrap.appendChild(sub);
    }

    brand.replaceChildren(createIcon('kitui-brand-icon', true), titleWrap);
    brand.classList.add('kitui-brand');
    brand.setAttribute('aria-label', 'KITUI FARM');
  });

  const defaultFarmerAvatar = document.getElementById('farmerAvatar');
  if (defaultFarmerAvatar && defaultFarmerAvatar.textContent.trim() === '🌱') {
    defaultFarmerAvatar.replaceChildren(createIcon('kitui-avatar-icon', true));
  }

  const loginHeading = Array.from(document.querySelectorAll('h1')).find((heading) => heading.textContent.trim().toUpperCase() === 'KITUI FARM');
  if (loginHeading) {
    const loginBrand = document.createElement('div');
    loginBrand.className = 'kitui-login-brand';
    const icon = createIcon('kitui-login-emblem', true);
    const title = document.createElement('h1');
    title.className = 'kitui-login-title';
    title.textContent = 'KITUI FARM';
    loginBrand.append(icon, title);
    loginHeading.replaceWith(loginBrand);
  }

  // 4. Real-Time Notifications Bell (Navigates to dedicated notifications.html area)
  function initNotificationsBell() {
    if (!activeSession || !activeToken || !activeSession.userId) return;
    if (!['buyer', 'farmer'].includes(activeSession.role)) return;
    const path = location.pathname.split('/').pop() || 'index.html';
    if (['login.html', 'signup.html', 'forgot-password.html', 'admin-signin.html', 'admin-register.html'].includes(path)) return;

    const topbarContainer = document.querySelector('.header-actions')
      || document.querySelector('.topbar-inner')
      || document.querySelector('.bar');
    if (!topbarContainer || document.getElementById('kfNotifWrap')) return;

    const SEEN_KEY = `kituiFarmNotifSeen_${activeSession.userId}`;
    const SNAP_KEY = `kituiFarmNotifSnap_${activeSession.userId}`;
    const CACHE_KEY = `kituiFarmNotifItems_${activeSession.userId}`;
    let notifications = [];

    const readJson = (key, fallback) => {
      try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
      catch { return fallback; }
    };
    const writeJson = (key, val) => {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
    };

    const wrap = document.createElement('div');
    wrap.id = 'kfNotifWrap';
    wrap.className = 'kf-notif-wrap';
    const isNotifPage = path === 'notifications.html';
    wrap.innerHTML = `
      <a href="notifications.html" class="kf-notif-button ${isNotifPage ? 'active' : ''}" id="kfNotifButton" aria-label="Open notifications page" ${isNotifPage ? 'aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        <span class="kf-notif-badge" id="kfNotifBadge" hidden>0</span>
      </a>
    `;

    const moreMenu = topbarContainer.querySelector('#moreMenu, .kf-menu-wrap');
    if (moreMenu) {
      topbarContainer.insertBefore(wrap, moreMenu);
    } else {
      topbarContainer.appendChild(wrap);
    }

    const button = wrap.querySelector('#kfNotifButton');
    const badge = wrap.querySelector('#kfNotifBadge');

    function showSystemNotification(title, body, url, tag) {
      try {
        if (window.KituiAndroid && typeof window.KituiAndroid.showNotification === 'function') {
          const absUrl = new URL(url || 'notifications.html', siteRoot).href;
          window.KituiAndroid.showNotification(title, body, absUrl);
          return;
        }
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(title, { body, icon: appIconUrl, tag: tag || 'kitui-farm-alert' });
        }
      } catch {}
    }

    function updateBadgeCount() {
      const seenMap = readJson(SEEN_KEY, {});
      const unread = notifications.filter((item) => !seenMap[item.key]);
      const badgeText = unread.length > 99 ? '99+' : String(unread.length);
      badge.hidden = unread.length === 0;
      badge.textContent = badgeText;
      const tabBadge = document.getElementById('kfTabNotifBadge');
      if (tabBadge) {
        tabBadge.hidden = unread.length === 0;
        tabBadge.textContent = badgeText;
      }
      button.setAttribute(
        'aria-label',
        unread.length ? `Open notifications (${unread.length} unread)` : 'Open notifications'
      );
    }

    async function pollNotifications(isFirstRun) {
      if (document.visibilityState === 'hidden' && !isFirstRun) return;
      try {
        const role = activeSession.role === 'farmer' ? 'farmer' : 'buyer';
        const ordersEndpoint = role === 'farmer' ? '/api/orders' : '/api/orders/purchases';
        const [chatRes, ordersRes, walletRes] = await Promise.all([
          fetch('/api/chat/conversations').then((r) => (r.ok ? r.json() : { conversations: [] })).catch(() => ({ conversations: [] })),
          fetch(ordersEndpoint).then((r) => (r.ok ? r.json() : { orders: [] })).catch(() => ({ orders: [] })),
          fetch('/api/wallet').then((r) => (r.ok ? r.json() : { transactions: [] })).catch(() => ({ transactions: [] }))
        ]);

        const items = [];
        const prevSnap = readJson(SNAP_KEY, { initialized: false, keys: {} });
        const nextSnapKeys = { ...(prevSnap.keys || {}) };
        const freshAlerts = [];

        for (const conv of chatRes.conversations || []) {
          if (Number(conv.unreadCount) > 0) {
            const key = `chat:${conv.id}:${conv.updatedAt}:${conv.unreadCount}`;
            const item = {
              key,
              category: 'chat',
              categoryLabel: `Chat · ${conv.unreadCount} unread`,
              icon: '💬',
              title: `${conv.unreadCount} unread message${conv.unreadCount === 1 ? '' : 's'} from ${conv.peerName}`,
              body: conv.lastMessage || `Regarding ${conv.listingName}`,
              time: conv.updatedAt,
              href: 'chat.html'
            };
            items.push(item);
            if (prevSnap.initialized && !prevSnap.keys[key]) freshAlerts.push(item);
            nextSnapKeys[key] = true;
          }
        }

        for (const order of (ordersRes.orders || []).slice(0, 12)) {
          const latestUpdate = Array.isArray(order.deliveryUpdates) && order.deliveryUpdates.length
            ? order.deliveryUpdates[order.deliveryUpdates.length - 1]
            : null;
          const time = (latestUpdate && latestUpdate.createdAt) || order.createdAt;
          const status = order.status || 'Processing';
          const key = `order:${order.id}:${status}:${order.returnRequest ? order.returnRequest.status : ''}`;
          const productNames = Array.isArray(order.items) ? order.items.map((i) => i.name).join(', ') : 'Order';
          const title = role === 'farmer'
            ? `Order ${order.id} · ${status}`
            : `Order ${order.id} is ${status}`;
          const body = latestUpdate && latestUpdate.note
            ? `${productNames} — ${latestUpdate.note}`
            : `${productNames} · KES ${Number(order.total || 0).toLocaleString('en-KE')}`;
          const item = {
            key,
            category: 'order',
            categoryLabel: `Order · ${status}`,
            icon: status === 'Delivered' || status === 'Completed' ? '✅' : '📦',
            title,
            body,
            time,
            href: role === 'farmer' ? 'farmer-dashboard.html' : 'buyer-dashboard.html#orders'
          };
          items.push(item);
          if (prevSnap.initialized && !prevSnap.keys[key]) freshAlerts.push(item);
          nextSnapKeys[key] = true;
        }

        for (const tx of (walletRes.transactions || []).slice(0, 8)) {
          const key = `wallet:${tx.id}:${tx.status}`;
          const sign = tx.direction === 'credit' ? '+' : '−';
          const item = {
            key,
            category: 'wallet',
            categoryLabel: `Wallet · ${tx.status || 'completed'}`,
            icon: tx.direction === 'credit' ? '💰' : '💳',
            title: `Wallet ${tx.type}: ${sign}KES ${Number(tx.amount || 0).toLocaleString('en-KE')}`,
            body: tx.description || 'KITUI FARM Wallet activity',
            time: tx.createdAt,
            href: 'wallet.html'
          };
          items.push(item);
          if (prevSnap.initialized && !prevSnap.keys[key]) freshAlerts.push(item);
          nextSnapKeys[key] = true;
        }

        items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
        notifications = items;
        writeJson(CACHE_KEY, items);
        writeJson(SNAP_KEY, { initialized: true, keys: nextSnapKeys });
        updateBadgeCount();

        if (freshAlerts.length > 0) {
          const top = freshAlerts[0];
          showSystemNotification(top.title, top.body, top.href, top.key);
        }
      } catch (error) {
        /* Never disrupt normal browsing if notification polling fails */
      }
    }

    const cachedItems = readJson(CACHE_KEY, []);
    if (Array.isArray(cachedItems) && cachedItems.length) {
      notifications = cachedItems;
      updateBadgeCount();
    }
    pollNotifications(true);
    window.setInterval(() => pollNotifications(false), 20_000);
    window.addEventListener('focus', () => pollNotifications(false));
  }

  // 5. Direct Native Android APK "Get the app" card (no Chrome PWA prompt, hidden inside native app or once dismissed)
  const APK_DOWNLOAD_URL = 'https://github.com/Monte-gg/kitui-farm/releases/download/v1.0.2/kitui-farm-android-v1.0.2.apk';
  const APK_FILENAME = 'kitui-farm-android-v1.0.2.apk';
  const APK_HIDDEN_KEY = 'kituiFarmApkHidden';
  const isNativeAndroidApp = /KituiFarmAndroidApp/i.test(navigator.userAgent || '')
    || Boolean(window.KituiAndroid);

  // Load dedicated slim & smooth Android App Layout ONLY inside the installed Android APK
  if (isNativeAndroidApp) {
    document.documentElement.classList.add('kf-native-android-app');
    if (!document.querySelector('link[data-android-app-layout]')) {
      const appCss = document.createElement('link');
      appCss.rel = 'stylesheet';
      appCss.href = new URL('android-app-layout.css?v=2', siteRoot).href;
      appCss.dataset.androidAppLayout = 'true';
      document.head.appendChild(appCss);
    }
  }

  // Keep the header identical in height on dashboards & subpages on mobile/app
  // by placing the dashboard search box cleanly at the top of <main>
  if (isNativeAndroidApp || window.innerWidth <= 760) {
    const headerSearch = document.querySelector('.topbar .search-box.header-search');
    const mainEl = document.querySelector('main');
    if (headerSearch && mainEl && !document.querySelector('.kf-app-search-slot')) {
      const slot = document.createElement('div');
      slot.className = 'kf-app-search-slot';
      slot.appendChild(headerSearch);
      mainEl.insertAdjacentElement('afterbegin', slot);
    }
  }

  // Prevent browser PWA install prompt from ever triggering
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
  });

  // Unregister any old PWA service worker so Chrome does not offer PWA installation
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => reg.unregister().catch(() => {}));
    }).catch(() => {});
  }

  function injectAndroidApkCard() {
    if (isNativeAndroidApp) {
      document.documentElement.classList.add('kf-native-android-app');
      return;
    }
    try {
      if (localStorage.getItem(APK_HIDDEN_KEY) === '1') return;
    } catch (e) {}
    if (document.getElementById('kfAndroidApkCard')) return;
    const path = location.pathname.split('/').pop() || 'index.html';
    if ([
      'admin-chat.html', 'wallet-admin.html', 'receipt.html',
      'admin-signin.html', 'admin-register.html', 'admin.html', 'admin-profile.html'
    ].includes(path)) return;

    const main = document.querySelector('main');
    if (!main) return;
    const isAuthCardPage = main.classList.contains('container') || main.classList.contains('card');

    const card = document.createElement('section');
    card.id = 'kfAndroidApkCard';
    card.className = isAuthCardPage ? 'kf-apk-card kf-apk-card--auth' : 'kf-apk-card';
    card.setAttribute('aria-labelledby', 'kfApkCardTitle');
    card.innerHTML = `
      <div class="kf-apk-card__left">
        <img src="${appIconUrl}" alt="KITUI FARM app icon" class="kf-apk-card__icon">
        <div class="kf-apk-card__copy">
          <span class="kf-apk-card__badge">ANDROID APP · v1.0.2</span>
          <h2 id="kfApkCardTitle">Get the app</h2>
          <p>Download the KITUI FARM Android app. After the download finishes, open the APK and allow installation if Android asks.</p>
        </div>
      </div>
      <div class="kf-apk-card__actions">
        <a class="kf-apk-download-btn" href="${APK_DOWNLOAD_URL}" download="${APK_FILENAME}">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M17.523 15.341a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m-11.046 0a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m11.4-6.02 1.997-3.459a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152L17.13 8.951a12.19 12.19 0 0 0-10.26 0L4.846 5.447a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.688 11.186.343 14.658 0 18.761h24c-.344-4.103-2.688-7.575-6.123-9.44"/>
          </svg>
          <span>Download Android app</span>
        </a>
        <div class="kf-apk-card__footer">
          <small class="kf-apk-card__meta">${APK_FILENAME}</small>
          <button type="button" class="kf-apk-dismiss-btn" id="kfDismissApkBtn">Already downloaded? Hide</button>
        </div>
      </div>
    `;

    card.querySelector('#kfDismissApkBtn').addEventListener('click', () => {
      try { localStorage.setItem(APK_HIDDEN_KEY, '1'); } catch (e) {}
      card.remove();
    });

    if (isAuthCardPage) {
      document.body.classList.add('kf-auth-stack');
      main.insertAdjacentElement('beforebegin', card);
    } else {
      main.insertAdjacentElement('afterbegin', card);
    }
  }

  // 6. Native Android App Bottom Bar (Home tab + quick navigation, ONLY inside native Android APK)
  function injectNativeAppTabBar() {
    if (!isNativeAndroidApp) return;
    if (document.getElementById('kfNativeTabBar')) return;
    const path = location.pathname.split('/').pop() || 'index.html';
    const appPages = [
      'buyer-dashboard.html', 'farmer-dashboard.html', 'farmer-store.html',
      'chat.html', 'wallet.html', 'receipts.html', 'profile.html', 'settings.html',
      'notifications.html', 'about-us.html', 'customer-service.html'
    ];
    if (!appPages.includes(path)) return;
    if (location.search.includes('admin=1')) return;

    const role = activeSession?.role === 'farmer' ? 'farmer' : 'buyer';
    const homeHref = role === 'farmer' ? 'farmer-dashboard.html' : 'buyer-dashboard.html';
    const profileHref = activeSession?.userId
      ? `profile.html?accountId=${encodeURIComponent(activeSession.userId)}`
      : 'profile.html';

    const items = [
      { href: homeHref, match: ['buyer-dashboard.html', 'farmer-dashboard.html', 'farmer-store.html'], label: 'Home', icon: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"/>' },
      { href: 'chat.html', match: ['chat.html'], label: 'Messages', icon: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/>' },
      { href: 'wallet.html', match: ['wallet.html'], label: 'Wallet', icon: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h5v3h-5a1.5 1.5 0 0 1 0-3Z"/>' },
      { href: 'notifications.html', match: ['notifications.html'], label: 'Alerts', icon: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>' },
      { href: profileHref, match: ['profile.html', 'settings.html'], label: 'Account', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.8-3.5 5-5.5 8-5.5s6.2 2 8 5.5"/>' }
    ];

    const nav = document.createElement('nav');
    nav.id = 'kfNativeTabBar';
    nav.className = 'kf-native-tabbar';
    nav.setAttribute('aria-label', 'App navigation');
    nav.innerHTML = items.map((item) => {
      const active = item.match.includes(path);
      const isAlerts = item.href === 'notifications.html';
      return `<a href="${item.href}" class="kf-native-tabbar__item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
        ${isAlerts ? '<span class="kf-native-tabbar__badge" id="kfTabNotifBadge" hidden>0</span>' : ''}
        <span>${item.label}</span>
      </a>`;
    }).join('');
    document.body.appendChild(nav);
    document.body.classList.add('kf-has-native-tabbar');
  }

  // 7. Highlight active page + instant touch-press highlighter inside all dropdown menus
  function initDropdownHighlighter() {
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.more-panel a, .more-panel button, .menu-panel a, .menu-panel button, .kf-feature-menu a').forEach((item) => {
      if (item.tagName === 'A') {
        const rawHref = item.getAttribute('href') || '';
        if (rawHref && !rawHref.startsWith('#')) {
          const hrefFile = rawHref.split('?')[0].split('#')[0];
          const isCurrent = hrefFile === currentFile;
          item.classList.toggle('is-current-page', isCurrent);
          if (isCurrent) item.setAttribute('aria-current', 'page');
        }
      }
      item.addEventListener('pointerdown', () => item.classList.add('is-pressed'));
      const clearPress = () => item.classList.remove('is-pressed');
      item.addEventListener('pointerup', clearPress);
      item.addEventListener('pointercancel', clearPress);
      item.addEventListener('pointerleave', clearPress);
    });
  }

  initNotificationsBell();
  injectAndroidApkCard();
  injectNativeAppTabBar();
  initDropdownHighlighter();
})();
