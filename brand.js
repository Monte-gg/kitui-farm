(function () {
  'use strict';
  const iconUrl = new URL('assets/kitui-farm-emblem.png', document.currentScript.src).href;
  const createIcon = (className, decorative) => {
    const image = document.createElement('img');
    image.className = className;
    image.src = iconUrl;
    image.alt = decorative ? '' : 'KITUI FARM';
    image.decoding = 'async';
    return image;
  };

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
