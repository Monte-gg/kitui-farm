'use strict';
// Prepares the pages for hosting on GitHub Pages (subpath /kitui-farm/) while
// the API keeps running on Render:
//  - relative asset paths
//  - loads api-base.js so /api calls reach the Render backend
//  - replaces the verbose get-app block with a direct download button
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = [
  'login.html', 'signup.html', 'forgot-password.html', 'payment.html',
  'profile.html', 'buyer-dashboard.html', 'farmer-dashboard.html',
  'settings.html', 'index.html'
];

const NEW_BLOCK = [
  '<section class="get-app" id="getAppBlock" aria-label="Get the KITUI FARM app">',
  '  <div class="get-app-icon"><img src="icons/icon-192x192.png" alt="" width="38" height="38"></div>',
  '  <div class="get-app-body">',
  '    <p class="get-app-title">Get the KITUI FARM app</p>',
  '    <p class="get-app-desc">Tap download to install the app on your phone. It opens full-screen like a store app.</p>',
  '  </div>',
  '  <div class="get-app-actions"><button class="get-app-btn" id="getAppBtn" type="button">Download app</button></div>',
  '  <p class="get-app-status" id="getAppStatus" hidden></p>',
  '</section>',
  '<script>',
  '(function(){',
  "  var btn=document.getElementById('getAppBtn');",
  "  var status=document.getElementById('getAppStatus');",
  '  var promptEvent=null;',
  '  if("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(function(){}); }',
  '  window.addEventListener("beforeinstallprompt",function(e){ e.preventDefault(); promptEvent=e; },[]);',
  '  window.addEventListener("appinstalled",function(){',
  '    if(status){ status.hidden=false; status.textContent="KITUI FARM is installed. Open it from your home screen."; }',
  '    if(btn){ btn.disabled=true; btn.textContent="Installed"; }',
  '  });',
  '  if(btn){',
  '    btn.addEventListener("click",function(){',
  '      if(promptEvent){',
  '        promptEvent.prompt().then(function(choice){',
  '          if(choice&&choice.outcome==="accepted"&&btn){ btn.textContent="Installing\\u2026"; }',
  '        }).catch(function(){});',
  '        return;',
  '      }',
  '      if(status){',
  '        status.hidden=false;',
  '        status.textContent="In Chrome (Android) tap the menu \\u22ee then Add to Home screen; in Safari (iPhone) tap Share then Add to Home Screen.";',
  '      }',
  '    });',
  '  }',
  '})();',
  '</script>'
].join('\n');

for (const name of PAGES) {
  const file = path.join(ROOT, name);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  // 1. relative asset paths
  text = text.replace(/="\/icons\//g, '="icons/');
  text = text.replace(/href="\/manifest\.json"/g, 'href="manifest.json"');

  // 2. swap the get-app block for the direct-download version
  const start = text.indexOf('<section class="get-app"');
  if (start !== -1) {
    const end = text.indexOf('</script>', text.indexOf('</section>', start));
    if (end !== -1) {
      text = text.slice(0, start) + NEW_BLOCK.split('\n').join(eol) + text.slice(end + '</script>'.length);
    }
  }

  // 3. load the API client before any page script
  if (text.indexOf('api-base.js') === -1 && text.indexOf('<head>') !== -1) {
    text = text.replace('<head>', '<head>' + eol + '    <script src="api-base.js"></script>');
  }

  fs.writeFileSync(file, text, 'utf8');
  console.log('updated ' + name);
}
console.log('deploy preparation complete');
