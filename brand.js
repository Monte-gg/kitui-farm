(function () {
  'use strict';
  const scriptEl = document.currentScript || document.querySelector('script[src*="brand.js"]');
  const siteRoot = new URL('.', scriptEl ? scriptEl.src : window.location.href);
  const iconUrl = new URL('assets/kitui-farm-emblem.png?v=3', siteRoot).href;
  const appIconUrl = new URL('icons/kitui-app-icon-192.png?v=3', siteRoot).href;
  const manifestUrl = new URL('manifest.webmanifest?v=3', siteRoot).href;
  const swUrl = new URL('sw.js', siteRoot).href;
  const APP_INSTALLED_KEY = 'kituiFarmAppInstalled';

  // 1. Ensure PWA manifest & iOS home-screen meta tags exist on every page,
  //    using the exact same emblem as the website icon.
  let manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) {
    manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    document.head.appendChild(manifestLink);
  }
  manifestLink.href = manifestUrl;

  let appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (!appleIcon) {
    appleIcon = document.createElement('link');
    appleIcon.rel = 'apple-touch-icon';
    document.head.appendChild(appleIcon);
  }
  appleIcon.href = appIconUrl;

  const ensureMeta = (name, content) => {
    if (!document.querySelector(`meta[name="${name}"]`)) {
      const m = document.createElement('meta');
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
    }
  };
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-title', 'KITUI FARM');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'default');

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register(swUrl, { scope: siteRoot.pathname }).catch(() => {});
  }

  const createIcon = (className, decorative) => {
    const image = document.createElement('img');
    image.className = className;
    image.src = iconUrl;
    image.alt = decorative ? '' : 'KITUI FARM';
    image.decoding = 'async';
    return image;
  };

  // 2. Keep the signed-in user present while they browse any page.
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

  // 3. Version the shared theme and emblem from the Jekyll build stamp.
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
    if (appleIcon) appleIcon.href = new URL('assets/kitui-farm-emblem.png?siteVersion=' + version, siteRoot).href;
    document.querySelectorAll('.kitui-brand-icon, .kitui-login-emblem, .kitui-avatar-icon').forEach((image) => {
      image.src = new URL('assets/kitui-farm-emblem.png?siteVersion=' + version, siteRoot).href;
    });
  }).catch(() => {});

  // Render the emblem logo + "KITUI FARM" platform name side-by-side in every header
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

  // 4. Separate Web Browser Mode vs Installed Standalone App Mode
  let deferredInstallPrompt = null;

  function isAppInstalled() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('source') === 'pwa') return true;
      if (sessionStorage.getItem('kituiFarmAppMode') === '1') return true;
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.navigator.standalone === true) return true;
      if (document.referrer && document.referrer.startsWith('android-app://')) return true;
    } catch (error) { /* ignore storage errors */ }
    return false;
  }

  function markAppInstalled() {
    try {
      sessionStorage.setItem('kituiFarmAppMode', '1');
    } catch (error) {}
    document.documentElement.classList.remove('kf-can-install');
    document.documentElement.classList.add('kf-is-installed', 'kf-app-mode');
    const section = document.getElementById('kfAppDownloadSection');
    if (section) section.remove();
    const dialog = document.getElementById('kfAppInstallDialog');
    if (dialog && dialog.open) dialog.close();
    injectMobileAppTabBar();
  }

  if (isAppInstalled()) {
    markAppInstalled();
  } else {
    try { localStorage.removeItem(APP_INSTALLED_KEY); } catch (error) {}
    document.documentElement.classList.add('kf-web-mode');
  }

  if (window.matchMedia) {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    if (standaloneMedia.addEventListener) {
      standaloneMedia.addEventListener('change', (event) => {
        if (event.matches) markAppInstalled();
      });
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    try { localStorage.removeItem(APP_INSTALLED_KEY); } catch (error) {}
    document.documentElement.classList.remove('kf-is-installed');
    document.documentElement.classList.add('kf-can-install');
    injectAppDownloadSection();
    document.querySelectorAll('[data-kf-install-status]').forEach((node) => {
      node.textContent = 'Ready for 1-tap install on this device';
    });
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    markAppInstalled();
  });

  function ensureInstallDialog() {
    let dialog = document.getElementById('kfAppInstallDialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'kfAppInstallDialog';
    dialog.className = 'kf-install-dialog';
    dialog.setAttribute('aria-labelledby', 'kfInstallDialogTitle');
    dialog.innerHTML = `
      <div class="kf-install-dialog__head">
        <div class="kf-install-dialog__title-row">
          <img src="${appIconUrl}" alt="" class="kf-install-dialog__icon">
          <div>
            <span class="kf-app-badge">KITUI FARM MOBILE APP</span>
            <h2 id="kfInstallDialogTitle">Install KITUI FARM App</h2>
          </div>
        </div>
        <button type="button" class="button secondary kf-install-close" aria-label="Close install guide">Close</button>
      </div>
      <div class="kf-install-dialog__body">
        <p class="kf-install-lead" id="kfInstallDialogLead">Install the standalone KITUI FARM mobile app with our official emblem icon for full-screen browsing, M-Pesa wallet payments, and real-time notifications — without any browser bar.</p>
        <div class="kf-install-guides">
          <article class="kf-install-guide" data-guide="android">
            <h3><span aria-hidden="true">🤖</span> Android Mobile App</h3>
            <ol>
              <li>Tap <strong>Install App Now</strong> below (or tap your phone menu <strong>⋮</strong> in the top-right corner and choose <strong>Install app</strong>).</li>
              <li>Confirm <strong>Install</strong> when your phone asks to install the <strong>KITUI FARM</strong> package.</li>
              <li>Open <strong>KITUI FARM</strong> from your phone apps screen to launch the full-screen app.</li>
            </ol>
          </article>
          <article class="kf-install-guide" data-guide="ios">
            <h3><span aria-hidden="true">🍎</span> iPhone &amp; iPad (iOS)</h3>
            <ol>
              <li>Tap the <strong>Share</strong> button <span class="kf-ios-icon" aria-hidden="true">⍐</span> at the bottom of your screen.</li>
              <li>Select <strong>Add to Home Screen</strong>, then tap <strong>Add</strong> in the top-right corner.</li>
              <li>Open <strong>KITUI FARM</strong> from your Home Screen for the full-screen iOS app experience.</li>
            </ol>
          </article>
        </div>
        <div class="kf-install-dialog__actions">
          <button type="button" class="button primary" id="kfDialogNativeInstallBtn" hidden>Install App Now</button>
          <button type="button" class="button secondary" id="kfDialogMarkInstalledBtn">I've installed the app</button>
          <button type="button" class="button secondary kf-install-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.querySelectorAll('.kf-install-close').forEach((btn) => {
      btn.addEventListener('click', () => dialog.close());
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    const nativeBtn = dialog.querySelector('#kfDialogNativeInstallBtn');
    nativeBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') markAppInstalled();
      } catch {}
      deferredInstallPrompt = null;
      nativeBtn.hidden = true;
    });
    const markInstalledBtn = dialog.querySelector('#kfDialogMarkInstalledBtn');
    markInstalledBtn.addEventListener('click', () => {
      markAppInstalled();
    });
    return dialog;
  }

  async function triggerAppInstall(platform) {
    if (deferredInstallPrompt && platform === 'android') {
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          deferredInstallPrompt = null;
          markAppInstalled();
          return;
        }
      } catch {}
      deferredInstallPrompt = null;
      return;
    }
    const dialog = ensureInstallDialog();
    const nativeBtn = dialog.querySelector('#kfDialogNativeInstallBtn');
    nativeBtn.hidden = !deferredInstallPrompt;
    dialog.dataset.highlight = platform || 'all';
    if (!dialog.open) dialog.showModal();
  }

  // Build the "Download the KITUI FARM Mobile App (Android & iOS)" section
  // (Only on public/auth & dashboard pages; skipped on restricted admin sign-in/register pages or once installed)
  function injectAppDownloadSection() {
    if (isAppInstalled()) {
      document.documentElement.classList.add('kf-is-installed');
      const existing = document.getElementById('kfAppDownloadSection');
      if (existing) existing.remove();
      return;
    }
    if (document.getElementById('kfAppDownloadSection')) return;
    const path = location.pathname.split('/').pop() || 'index.html';
    if ([
      'admin-chat.html', 'wallet-admin.html', 'receipt.html',
      'admin-signin.html', 'admin-register.html', 'admin.html', 'admin-profile.html'
    ].includes(path)) return;

    const section = document.createElement('section');
    section.id = 'kfAppDownloadSection';
    section.className = 'kf-app-download';
    section.setAttribute('aria-labelledby', 'kfAppDownloadTitle');
    section.innerHTML = `
      <div class="kf-app-download__inner">
        <div class="kf-app-download__copy">
          <span class="kf-app-badge">MOBILE APP · ANDROID &amp; iOS</span>
          <div class="kf-app-download__brand-head">
            <img src="${iconUrl}" alt="KITUI FARM app icon" class="kf-app-download__app-icon kitui-brand-icon">
            <div>
              <h2 id="kfAppDownloadTitle">Get the KITUI FARM App on your phone</h2>
              <p class="kf-app-download__sub">Official KITUI FARM icon · Automatic in-app updates</p>
            </div>
          </div>
          <p class="kf-app-download__lead">Install our lightweight mobile app for a fast, full-screen shopping and farm-management experience on Android and iPhone — no app store wait required.</p>
          <ul class="kf-app-features" aria-label="Mobile app highlights">
            <li><span aria-hidden="true">✓</span> One-tap access with the KITUI FARM emblem on your home screen</li>
            <li><span aria-hidden="true">✓</span> Instant M-Pesa STK Push wallet deposits &amp; payouts</li>
            <li><span aria-hidden="true">✓</span> Live app notifications for messages, orders, and wallet activity</li>
          </ul>
          <div class="kf-store-buttons" role="group" aria-label="Download KITUI FARM app for Android or iOS">
            <button type="button" class="kf-store-btn kf-store-btn--android" data-kf-install="android">
              <svg class="kf-store-btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d="M17.523 15.341a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m-11.046 0a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m11.4-6.02 1.997-3.459a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152L17.13 8.951a12.19 12.19 0 0 0-10.26 0L4.846 5.447a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.688 11.186.343 14.658 0 18.761h24c-.344-4.103-2.688-7.575-6.123-9.44"/>
              </svg>
              <span class="kf-store-btn__text">
                <small data-kf-install-status>Direct Web App Install</small>
                <strong>Download for Android</strong>
              </span>
            </button>
            <button type="button" class="kf-store-btn kf-store-btn--ios" data-kf-install="ios">
              <svg class="kf-store-btn__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.33c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.58.68-1.1 1.79-.96 2.84 1.04.08 2.08-.52 2.72-1.3"/>
              </svg>
              <span class="kf-store-btn__text">
                <small>Add to Home Screen</small>
                <strong>Download for iOS</strong>
              </span>
            </button>
          </div>
        </div>
        <div class="kf-app-download__preview" aria-hidden="true">
          <div class="kf-phone-mockup">
            <div class="kf-phone-mockup__notch"></div>
            <div class="kf-phone-mockup__screen">
              <div class="kf-phone-mockup__head">
                <img src="${iconUrl}" alt="" class="kf-phone-mockup__logo">
                <div>
                  <strong>KITUI FARM</strong>
                  <span>Fresh from local farms</span>
                </div>
              </div>
              <div class="kf-phone-mockup__pill">✓ Verified Kitui Farmers · M-Pesa Wallet</div>
              <div class="kf-phone-mockup__cards">
                <div class="kf-phone-mockup__card"><span>🌾</span><div><strong>Green Grams</strong><small>KES 180 / kg · Mutomo</small></div><b>Buy</b></div>
                <div class="kf-phone-mockup__card"><span>🍉</span><div><strong>Ripe Mangoes</strong><small>KES 90 / kg · Kitui Central</small></div><b>Buy</b></div>
                <div class="kf-phone-mockup__card"><span>🥔</span><div><strong>Fresh Cassava</strong><small>KES 75 / kg · Mwingi</small></div><b>Buy</b></div>
              </div>
              <div class="kf-phone-mockup__bar">
                <span class="active">🏠 Market</span>
                <span>💬 Chat</span>
                <span>💳 Wallet</span>
                <span>👤 Profile</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const main = document.querySelector('main');
    const isAuthCardPage = main && (main.classList.contains('container') || main.classList.contains('card'));
    if (isAuthCardPage) {
      document.body.classList.add('kf-auth-page');
      section.classList.add('kf-app-download--compact');
      main.insertAdjacentElement('afterend', section);
    } else if (main) {
      main.appendChild(section);
    }

    section.querySelectorAll('[data-kf-install]').forEach((button) => {
      button.addEventListener('click', () => triggerAppInstall(button.dataset.kfInstall));
    });
  }

  // 5. Real-Time App Notifications Bell (Navigates to dedicated notifications.html area + Push alerts)
  function initAppNotifications() {
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

    // Place the notification bell right before the 3-dot menu or at the end of the header
    const moreMenu = topbarContainer.querySelector('#moreMenu, .kf-menu-wrap');
    if (moreMenu) {
      topbarContainer.insertBefore(wrap, moreMenu);
    } else {
      topbarContainer.appendChild(wrap);
    }

    const button = wrap.querySelector('#kfNotifButton');
    const badge = wrap.querySelector('#kfNotifBadge');

    function showSystemNotification(title, body, url, tag) {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NOTIFICATION',
            title,
            body,
            url,
            icon: appIconUrl,
            tag: tag || 'kitui-farm-alert'
          });
          return;
        }
        new Notification(title, { body, icon: appIconUrl, tag: tag || 'kitui-farm-alert' });
      } catch {}
    }

    function updateBadgeCount() {
      const seenMap = readJson(SEEN_KEY, {});
      const unread = notifications.filter((item) => !seenMap[item.key]);
      badge.hidden = unread.length === 0;
      badge.textContent = unread.length > 99 ? '99+' : String(unread.length);
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

  // Inject a mobile bottom app navigation bar ONLY when running inside the installed app (App Layout)
  function injectMobileAppTabBar() {
    if (!isAppInstalled()) return;
    if (document.getElementById('kfMobileTabBar')) return;
    const path = location.pathname.split('/').pop() || 'index.html';
    const appPages = [
      'buyer-dashboard.html', 'farmer-dashboard.html', 'farmer-store.html',
      'chat.html', 'wallet.html', 'receipts.html', 'profile.html', 'settings.html', 'notifications.html'
    ];
    if (!appPages.includes(path)) return;
    if (location.search.includes('admin=1')) return;

    const role = activeSession?.role === 'farmer' ? 'farmer' : 'buyer';
    const homeHref = role === 'farmer' ? 'farmer-dashboard.html' : 'buyer-dashboard.html';
    const homeLabel = role === 'farmer' ? 'My Farm' : 'Market';
    const profileHref = activeSession?.userId
      ? `profile.html?accountId=${encodeURIComponent(activeSession.userId)}`
      : 'profile.html';

    const items = role === 'farmer'
      ? [
          { href: homeHref, match: ['farmer-dashboard.html', 'farmer-store.html'], label: homeLabel, icon: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"/>' },
          { href: 'buyer-dashboard.html', match: ['buyer-dashboard.html'], label: 'Shop', icon: '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 7H6"/>' },
          { href: 'chat.html', match: ['chat.html'], label: 'Messages', icon: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/>' },
          { href: 'wallet.html', match: ['wallet.html'], label: 'Wallet', icon: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h5v3h-5a1.5 1.5 0 0 1 0-3Z"/>' },
          { href: profileHref, match: ['profile.html', 'settings.html'], label: 'Account', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.8-3.5 5-5.5 8-5.5s6.2 2 8 5.5"/>' }
        ]
      : [
          { href: homeHref, match: ['buyer-dashboard.html', 'farmer-store.html'], label: homeLabel, icon: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z"/>' },
          { href: 'chat.html', match: ['chat.html'], label: 'Messages', icon: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12Z"/>' },
          { href: 'wallet.html', match: ['wallet.html'], label: 'Wallet', icon: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h5v3h-5a1.5 1.5 0 0 1 0-3Z"/>' },
          { href: 'receipts.html', match: ['receipts.html'], label: 'Receipts', icon: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>' },
          { href: profileHref, match: ['profile.html', 'settings.html'], label: 'Account', icon: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.8-3.5 5-5.5 8-5.5s6.2 2 8 5.5"/>' }
        ];

    const nav = document.createElement('nav');
    nav.id = 'kfMobileTabBar';
    nav.className = 'kf-mobile-tabbar';
    nav.setAttribute('aria-label', 'App navigation');
    nav.innerHTML = items.map((item) => {
      const active = item.match.includes(path);
      return `<a href="${item.href}" class="kf-mobile-tabbar__item ${active ? 'active' : ''}" ${active ? 'aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${item.icon}</svg>
        <span>${item.label}</span>
      </a>`;
    }).join('');
    document.body.appendChild(nav);
    document.body.classList.add('kf-has-tabbar');
  }

  function initDropdownHighlighter() {
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.more-panel a, .menu-panel a, .kf-feature-menu a').forEach((link) => {
      const rawHref = link.getAttribute('href') || '';
      if (!rawHref || rawHref.startsWith('#')) return;
      const hrefFile = rawHref.split('?')[0].split('#')[0];
      const isCurrent = hrefFile === currentFile;
      link.classList.toggle('is-current-page', isCurrent);
      if (isCurrent) link.setAttribute('aria-current', 'page');
    });
  }

  injectAppDownloadSection();
  injectMobileAppTabBar();
  initAppNotifications();
  initDropdownHighlighter();
})();
