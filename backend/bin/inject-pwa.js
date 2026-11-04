#!/usr/bin/env node
'use strict';

// Add the PWA head block and the install card to every HTML page, and update
// the visible app name to KITUI FARM. Run from the repo root:
//   node backend/bin/inject-pwa.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const pages = [
  'login.html', 'signup.html', 'buyer-dashboard.html', 'farmer-dashboard.html',
  'forgot-password.html', 'payment.html', 'profile.html', 'settings.html', 'index.html'
];

const HEAD_BLOCK =
  '    <meta name="theme-color" content="#4a8c3f">\n' +
  '    <meta name="apple-mobile-web-app-capable" content="yes">\n' +
  '    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n' +
  '    <link rel="manifest" href="/manifest.json">\n' +
  '    <link rel="icon" href="/icons/icon-192x192.png" type="image/png" sizes="192x192">\n' +
  '    <link rel="apple-touch-icon" href="/icons/icon-192x192.png">\n' +
  '    <link rel="mask-icon" href="/icons/icon.svg" color="#4a8c3f">\n' +
  '    <script src="/install.js" defer></script>';

const CARD_DIV =
  '    <div class="install-card" id="kitui-install-card" hidden>\n' +
  '      <div class="install-card-inner">\n' +
  '        <div class="install-card-icon" aria-hidden="true"><img src="/icons/icon-192x192.png" alt="" width="36" height="36"></div>\n' +
  '        <div class="install-card-text">\n' +
  '          <p class="install-card-title">Install KITUI FARM</p>\n' +
  '          <p class="install-card-desc">Get the app on your phone — works like a download, no store needed.</p>\n' +
  '        </div>\n' +
  '        <button class="install-card-btn" id="installAppBtn" type="button">Download app</button>\n' +
  '        <button class="install-card-close" id="installCardClose" type="button" aria-label="Close">×</button>\n' +
  '      </div>\n' +
  '      <ol class="install-card-steps" id="installCardSteps" hidden>\n' +
  '        <li>Open KITUI FARM in your phone\'s browser (Chrome on Android, Safari on iPhone).</li>\n' +
  '        <li>Tap the Share or menu button.</li>\n' +
  '        <li>Choose <strong>"Add to Home Screen"</strong>.</li>\n' +
  '        <li>Open it from your home screen — it runs full-screen like an app.</li>\n' +
  '      </ol>\n' +
  '    </div>';

let updated = 0;
for (const name of pages) {
  const file = path.join(ROOT, name);
  let html = fs.readFileSync(file, 'utf8');
  let changed = false;

  if (html.indexOf('Kitui Farm Enterprise') !== -1) {
    html = html.split('Kitui Farm Enterprise').join('KITUI FARM');
    changed = true;
  }

  let vp = html.match(/(<meta name="viewport"[^>]*>)/);
  if (vp) {
    html = html.replace(vp[1], vp[1] + '\n' + HEAD_BLOCK);
    changed = true;
  }

  let close = html.match(/<\/body>/);
  if (close) {
    html = html.replace(close[0], CARD_DIV + '\n' + close[0]);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(file, html, 'utf8');
    updated++;
    console.log('updated', name);
  } else {
    console.log('skipped', name);
  }
}
console.log('inject complete:', updated, 'pages updated');
