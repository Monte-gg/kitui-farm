(function () {
  'use strict';
  const scriptEl = document.currentScript || document.querySelector('script[src*="brand.js"]');
  const siteRoot = new URL('.', (scriptEl && scriptEl.src) || window.location.href);
  const iconUrl = new URL('assets/kitui-farm-emblem.png', siteRoot).href;
  const appIconUrl = new URL('assets/kitui-farm-app-icon.png', siteRoot).href;
  const isApp = /KituiFarmAndroidApp/i.test(navigator.userAgent || '') || Boolean(window.KituiAndroid);

  const createIcon = (className, decorative) => {
    const image = document.createElement('img');
    image.className = className;
    image.src = iconUrl;
    image.alt = decorative ? '' : 'KITUI FARM';
    image.decoding = 'async';
    return image;
  };

  // Keep the signed-in user present while they browse any page (throttled across page hops).
  try {
    const session = JSON.parse(sessionStorage.getItem('kituiFarmSession') || localStorage.getItem('kituiFarmSession') || 'null');
    const token = sessionStorage.getItem('kituiFarmToken') || localStorage.getItem('kituiFarmToken');
    if (session && token && ['buyer', 'farmer'].includes(session.role)) {
      const heartbeat = () => {
        try {
          const last = Number(sessionStorage.getItem('kfPresenceAt') || 0);
          if (Date.now() - last < 24_000) return;
          sessionStorage.setItem('kfPresenceAt', String(Date.now()));
        } catch (_) {}
        fetch('/api/chat/presence', { method: 'POST' }).catch(() => {});
      };
      heartbeat();
      window.setInterval(() => {
        try { sessionStorage.setItem('kfPresenceAt', String(Date.now())); } catch (_) {}
        fetch('/api/chat/presence', { method: 'POST' }).catch(() => {});
      }, 25_000);
    }
  } catch (error) { /* Presence must never interrupt page rendering. */ }

  // Shared location helper: uses native Android LocationManager inside APK, falls back to browser geolocation.
  window.KITUI_GET_CURRENT_LOCATION = function (onSuccess, onError) {
    if (window.KituiAndroid && typeof window.KituiAndroid.getCurrentLocation === 'function') {
      window.__kituiNativeLocationCallback = function (lat, lon, errMsg) {
        window.__kituiNativeLocationCallback = null;
        if (errMsg || lat === null || lon === null) {
          onError(errMsg || 'Could not determine your location. Make sure GPS is turned on or type your area manually.');
        } else {
          onSuccess({ latitude: Number(lat), longitude: Number(lon) });
        }
      };
      try {
        window.KituiAndroid.getCurrentLocation();
        return;
      } catch (e) {
        window.__kituiNativeLocationCallback = null;
      }
    }
    if (!navigator.geolocation) {
      onError('Location is unavailable on this device. Type your area manually.');
      return;
    }
    if (!window.isSecureContext) {
      onError('Current location needs a secure HTTPS connection. Type your area manually.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => onSuccess({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => {
        const msg = err.code === 1
          ? 'Location permission was denied. Enable Location in Settings or type your area manually.'
          : err.code === 2
            ? 'Your device could not determine its location. Turn on GPS or type your area manually.'
            : 'Location lookup timed out. Try again or type your area manually.';
        onError(msg);
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 }
    );
  };

  // Version the shared theme and emblem from the Jekyll build stamp (throttled to 3 min).
  const brandStylesheet = document.querySelector('link[data-brand-theme]');
  const applyVersion = (data) => {
    if (!data || typeof data.version !== 'string' || !data.version.trim()) return;
    const version = encodeURIComponent(data.version.trim());
    if (brandStylesheet) {
      brandStylesheet.href = new URL('brand-theme.css?siteVersion=' + version, siteRoot).href;
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = iconUrl + '?siteVersion=' + version;
    document.querySelectorAll('.kitui-brand-icon, .kitui-login-emblem, .kitui-avatar-icon').forEach((image) => {
      image.src = iconUrl + '?siteVersion=' + version;
    });
  };

  (function checkSiteVersion() {
    if (isApp) return;
    try {
      const lastCheck = Number(sessionStorage.getItem('kfVerAt') || 0);
      const cached = JSON.parse(sessionStorage.getItem('kfVerData') || 'null');
      if (cached && Date.now() - lastCheck < 180_000) {
        applyVersion(cached);
        return;
      }
    } catch (_) {}

    const versionUrl = new URL('version.json', siteRoot);
    versionUrl.searchParams.set('_', String(Date.now()));
    fetch(versionUrl.href, { cache: 'no-store' }).then((response) => {
      if (!response.ok) return null;
      return response.json();
    }).then((data) => {
      if (!data) return;
      try {
        sessionStorage.setItem('kfVerAt', String(Date.now()));
        sessionStorage.setItem('kfVerData', JSON.stringify(data));
      } catch (_) {}
      applyVersion(data);
    }).catch(() => {});
  })();

  // Brand emblem rendering
  document.querySelectorAll('.brand').forEach((brand) => {
    const adminLabel = brand.querySelector('#adminLabel');
    if (isApp) {
      const isAdminBrand = /admin/i.test(brand.textContent) && !adminLabel;
      const label = document.createElement('span');
      label.className = 'kf-app-brand-title';
      label.textContent = isAdminBrand ? 'KITUI FARM · Admin' : 'KITUI FARM';
      brand.replaceChildren(createIcon('kitui-brand-icon', true), label);
      if (adminLabel) brand.appendChild(adminLabel);
    } else {
      brand.replaceChildren(createIcon('kitui-brand-icon', false));
      if (adminLabel) brand.appendChild(adminLabel);
    }
    brand.classList.add('kitui-brand');
    brand.setAttribute('aria-label', 'KITUI FARM');
  });

  document.querySelectorAll('.brand-mark').forEach((mark) => {
    mark.replaceChildren(createIcon('kitui-brand-icon', true));
    mark.classList.add('kitui-brand-icon');
    mark.removeAttribute('aria-hidden');
  });

  const defaultFarmerAvatar = document.getElementById('farmerAvatar');
  if (defaultFarmerAvatar && defaultFarmerAvatar.textContent.trim() === '🌱') {
    defaultFarmerAvatar.replaceChildren(createIcon('kitui-avatar-icon', true));
  }

  const loginHeading = Array.from(document.querySelectorAll('h1')).find((heading) => heading.textContent.trim().toUpperCase() === 'KITUI FARM');
  if (loginHeading) {
    const icon = createIcon('kitui-login-emblem', false);
    icon.setAttribute('role', 'img');
    loginHeading.replaceWith(icon);
  }

  // Web-only dismissible "Get the KITUI FARM Android App" card (never alters brand-theme.css)
  const APK_DOWNLOAD_URL = 'https://github.com/Monte-gg/kitui-farm/releases/download/v1.0.7/kitui-farm-android-v1.0.7.apk';
  const APK_FILENAME = 'kitui-farm-android-v1.0.7.apk';
  const APK_DISMISSED_KEY = 'kituiFarmApkDismissed_107';

  function injectGetAppCard() {
    if (isApp) return;
    try {
      if (localStorage.getItem(APK_DISMISSED_KEY) === '1') return;
    } catch (_) {}
    if (document.getElementById('kfGetAppCard')) return;

    const path = window.location.pathname.split('/').pop() || 'index.html';
    if ([
      'index.html', 'admin-chat.html', 'wallet-admin.html', 'receipt.html',
      'admin-signin.html', 'admin-register.html', 'admin.html', 'admin-profile.html'
    ].includes(path)) return;

    const main = document.querySelector('main');
    if (!main) return;

    if (!document.getElementById('kfGetAppStyle')) {
      const style = document.createElement('style');
      style.id = 'kfGetAppStyle';
      style.textContent = `
        body.kf-auth-stack {
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          justify-content: flex-start !important;
          gap: 16px !important;
        }
        body.kf-auth-stack > main { width: 100%; }
        .kf-get-app-card {
          box-sizing: border-box;
          width: 100%; max-width: 100%; overflow: hidden;
          display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;
          margin: 0 auto 18px; padding: 14px 18px; border: 1px solid var(--line, #e5dcc6);
          border-radius: 16px; background: var(--surface, #fffdf7); color: var(--ink, #342718);
          box-shadow: 0 4px 18px rgba(20, 45, 24, 0.08);
        }
        .kf-get-app-card--auth { width: 100%; max-width: 500px; margin: 0 auto !important; }
        .kf-get-app-card__left { display: flex; align-items: center; gap: 12px; flex: 1 1 240px; min-width: 0; }
        .kf-get-app-card__icon { width: 48px; height: 48px; border-radius: 12px; object-fit: cover; flex: 0 0 48px; }
        .kf-get-app-card__copy { min-width: 0; }
        .kf-get-app-card__badge {
          display: inline-block; padding: 2px 8px; border-radius: 999px;
          background: var(--green-light, #e5f0d8); color: var(--green-dark, #17472c);
          font-size: 11px; font-weight: 800; letter-spacing: 0.04em;
        }
        .kf-get-app-card__copy h2 { margin: 4px 0 2px; font-size: 16px; color: var(--green-dark, #17472c); }
        .kf-get-app-card__copy p { margin: 0; font-size: 13px; line-height: 1.4; color: var(--muted, #766b53); overflow-wrap: anywhere; word-break: break-word; }
        .kf-get-app-card__actions { display: flex; flex-direction: column; align-items: stretch; gap: 6px; flex: 0 1 auto; }
        .kf-get-app-card__btn {
          box-sizing: border-box;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          width: 100%; min-height: 44px; padding: 10px 16px; border-radius: 10px;
          background: #08723d !important; color: #ffffff !important;
          font-size: 14px; font-weight: 700; text-decoration: none !important; white-space: nowrap;
        }
        .kf-get-app-card__btn:hover { background: #17472c !important; }
        .kf-get-app-card__btn svg { width: 18px; height: 18px; flex: 0 0 18px; }
        .kf-get-app-card__hide {
          border: 0; background: transparent; color: var(--muted, #766b53);
          font: inherit; font-size: 12px; font-weight: 600; text-decoration: underline; cursor: pointer; padding: 4px;
        }
        @media (max-width: 540px) {
          .kf-get-app-card { flex-direction: column; align-items: stretch; padding: 14px; }
          .kf-get-app-card__left { flex: 0 0 auto; }
          .kf-get-app-card__actions { width: 100%; }
        }
      `;
      document.head.appendChild(style);
    }

    const isAuthCardPage = main.classList.contains('container')
      || main.classList.contains('card')
      || ['login.html', 'signup.html', 'forgot-password.html', 'email-verify.html'].includes(path);
    const card = document.createElement('section');
    card.id = 'kfGetAppCard';
    card.className = isAuthCardPage ? 'kf-get-app-card kf-get-app-card--auth' : 'kf-get-app-card';
    card.setAttribute('aria-labelledby', 'kfGetAppTitle');
    card.innerHTML = `
      <div class="kf-get-app-card__left">
        <img src="${appIconUrl}" alt="KITUI FARM Android app icon" class="kf-get-app-card__icon">
        <div class="kf-get-app-card__copy">
          <span class="kf-get-app-card__badge">ANDROID APP · v1.0.7</span>
          <h2 id="kfGetAppTitle">Get the KITUI FARM app</h2>
          <p>Download the KITUI FARM Android APK (${APK_FILENAME}) for a dedicated mobile app experience.</p>
        </div>
      </div>
      <div class="kf-get-app-card__actions">
        <a class="kf-get-app-card__btn" href="${APK_DOWNLOAD_URL}" download="${APK_FILENAME}">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <path d="M17.523 15.341a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m-11.046 0a.96.96 0 0 1-.959-.96.96.96 0 0 1 1.918 0 .96.96 0 0 1-.959.96m11.4-6.02 1.997-3.459a.416.416 0 0 0-.152-.567.416.416 0 0 0-.568.152L17.13 8.951a12.19 12.19 0 0 0-10.26 0L4.846 5.447a.416.416 0 0 0-.568-.152.416.416 0 0 0-.152.567l1.997 3.46C2.688 11.186.343 14.658 0 18.761h24c-.344-4.103-2.688-7.575-6.123-9.44"/>
          </svg>
          <span>Download Android app</span>
        </a>
        <button type="button" class="kf-get-app-card__hide" id="kfDismissGetAppBtn">Already downloaded? Hide</button>
      </div>
    `;

    card.querySelector('#kfDismissGetAppBtn').addEventListener('click', () => {
      try { localStorage.setItem(APK_DISMISSED_KEY, '1'); } catch (_) {}
      document.body.classList.remove('kf-auth-stack');
      card.remove();
    });

    if (isAuthCardPage) {
      document.body.classList.add('kf-auth-stack');
      main.insertAdjacentElement('beforebegin', card);
    } else {
      main.insertAdjacentElement('afterbegin', card);
    }
  }

  injectGetAppCard();
})();
