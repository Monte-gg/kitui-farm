(function () {
  'use strict';
  const siteRoot = new URL('.', document.currentScript.src);
  const iconUrl = new URL('assets/kitui-farm-emblem.png', siteRoot).href;
  const createIcon = (className, decorative) => {
    const image = document.createElement('img');
    image.className = className;
    image.src = iconUrl;
    image.alt = decorative ? '' : 'KITUI FARM';
    image.decoding = 'async';
    return image;
  };

  // Version the shared theme and emblem from the Jekyll build stamp. This
  // prevents browsers from mixing a cached brand stylesheet with new HTML.
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
    if (favicon) favicon.href = iconUrl + '?siteVersion=' + version;
    document.querySelectorAll('.kitui-brand-icon, .kitui-login-emblem, .kitui-avatar-icon').forEach((image) => {
      image.src = iconUrl + '?siteVersion=' + version;
    });
  }).catch(() => {});

  document.querySelectorAll('.brand').forEach((brand) => {
    const adminLabel = brand.querySelector('#adminLabel');
    brand.replaceChildren(createIcon('kitui-brand-icon', false));
    if (adminLabel) brand.appendChild(adminLabel);
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
})();
