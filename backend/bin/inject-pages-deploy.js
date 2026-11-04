'use strict';
// Ensures GitHub Pages build artifacts load the API bridge needed by Render.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = [
  'login.html', 'signup.html', 'forgot-password.html', 'payment.html',
  'profile.html', 'buyer-dashboard.html', 'farmer-dashboard.html',
  'settings.html', 'index.html'
];

for (const name of PAGES) {
  const file = path.join(ROOT, name);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;
  if (text.includes('<head>')) {
    const scripts = [
      ['api-base.js', '    <script src="api-base.js"></script>'],
      ['site-only.js', '    <script src="site-only.js" defer></script>']
    ];
    for (const [asset, tag] of scripts) {
      if (!text.includes(asset)) {
        text = text.replace('<head>', '<head>' + eol + tag);
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(file, text, 'utf8');
    console.log('updated ' + name);
  } else {
    console.log('already configured ' + name);
  }
}
