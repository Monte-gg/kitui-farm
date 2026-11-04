'use strict';
// Replaces the hidden bottom install card with a visible "Get the app" block
// on every page, wired by an inline script so it never depends on install.js.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = [
  'login.html',
  'signup.html',
  'forgot-password.html',
  'payment.html',
  'profile.html',
  'buyer-dashboard.html',
  'farmer-dashboard.html',
  'settings.html',
  'index.html'
];

const CSS_RULES = [
  '.get-app{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin:22px 0 0;padding:16px 18px;border:1px solid #cfe3c6;border-radius:12px;background:#f2f9ee;}',
  '.get-app-icon{flex:0 0 auto;width:46px;height:46px;border-radius:12px;background:#e3f0dc;display:grid;place-items:center;overflow:hidden;}',
  '.get-app-icon img{width:38px;height:38px;display:block;}',
  '.get-app-body{flex:1 1 220px;min-width:0;}',
  '.get-app-title{margin:0 0 3px;color:#2d5a27;font-size:15px;font-weight:700;}',
  '.get-app-desc{margin:0;color:#5c6a58;font-size:12px;line-height:1.45;}',
  '.get-app-steps{margin:7px 0 0;color:#5c6a58;font-size:11.5px;line-height:1.55;}',
  '.get-app-steps strong{color:#2d5a27;}',
  '.get-app-actions{display:flex;flex:0 0 auto;align-self:center;align-items:center;gap:8px;flex-wrap:wrap;}',
  '.get-app-open-btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;background:#4a8c3f;color:#fff;font-weight:650;font-size:13px;padding:10px 16px;text-decoration:none;white-space:nowrap;}',
  '.get-app-open-btn:hover{background:#3a7a2a;}',
  '.get-app-btn{border:1px solid #4a8c3f;border-radius:9px;background:transparent;color:#2d5a27;font-weight:650;font-size:13px;padding:9px 15px;cursor:pointer;white-space:nowrap;}',
  '.get-app-btn:hover{background:#e3f0dc;}',
  ':root[data-theme="dark"] .get-app-btn{color:#d8e6cf;border-color:#6a9d60;}',
  ':root[data-theme="dark"] .get-app-btn:hover{background:#2f4a2f;}',
  '.get-app-btn:disabled{opacity:.65;cursor:default;}',
  '.get-app-status{flex-basis:100%;margin:0;color:#2d5a27;font-size:12px;}',
  ':root[data-theme="dark"] .get-app{background:#263b27;border-color:#3d5a3b;}',
  ':root[data-theme="dark"] .get-app-icon{background:#2f4a2f;}',
  ':root[data-theme="dark"] .get-app-title{color:#d8e6cf;}',
  ':root[data-theme="dark"] .get-app-desc,:root[data-theme="dark"] .get-app-steps{color:#a6b1a3;}',
  ':root[data-theme="dark"] .get-app-steps strong,:root[data-theme="dark"] .get-app-status{color:#d8e6cf;}'
].join('\n');

const BLOCK = [
  '<section class="get-app" id="getAppBlock" aria-label="Get the KITUI FARM app">',
  '  <div class="get-app-icon"><img src="/icons/icon-192x192.png" alt="" width="38" height="38"></div>',
  '  <div class="get-app-body">',
  '    <p class="get-app-title">Get the KITUI FARM app</p>',
  '    <p class="get-app-desc">Add it to your phone\u2019s home screen \u2014 it opens full-screen like an app. No app store needed.</p>',
  '    <p class="get-app-steps"><strong>Android (Chrome):</strong> tap \u22ee \u2192 <strong>Add to Home screen</strong>. <strong>iPhone (Safari):</strong> tap Share \u2192 <strong>Add to Home Screen</strong>.</p>',
  '  </div>',
  '  <div class="get-app-actions"><a class="get-app-open-btn" href="login.html" aria-label="Open KITUI FARM app">Open app</a><button class="get-app-btn" id="getAppBtn" type="button">Install app</button></div>',
  '  <p class="get-app-status" id="getAppStatus" hidden></p>',
  '</section>',
  '<script>',
  '(function(){',
  "  var btn=document.getElementById('getAppBtn');",
  "  var status=document.getElementById('getAppStatus');",
  '  var promptEvent=null;',
  '  if("serviceWorker" in navigator){ navigator.serviceWorker.register("/sw.js",{scope:"/"}).catch(function(){}); }',
  '  window.addEventListener("beforeinstallprompt",function(e){ e.preventDefault(); promptEvent=e; },[]);',
  '  window.addEventListener("appinstalled",function(){',
  '    if(status){ status.hidden=false; status.textContent="KITUI FARM is installed. Open it from your home screen."; }',
  '    if(btn){ btn.disabled=true; btn.textContent="Installed"; }',
  '  });',
  '  if(btn){',
  '    btn.addEventListener("click",function(){',
  '      if(promptEvent){',
  '        promptEvent.prompt().then(function(c){ if(c&&c.outcome==="accepted"&&btn){ btn.textContent="Installing\u2026"; } }).catch(function(){});',
  '        return;',
  '      }',
  '      if(status){ status.hidden=false; status.textContent="Use the steps above: Android Chrome \u2192 menu \u22ee \u2192 Add to Home screen; iPhone Safari \u2192 Share \u2192 Add to Home Screen."; }',
  '    });',
  '  }',
  '})();',
  '</script>'
].join('\n');

function stripBlock(text) {
  // Remove any previously injected Get app block and script together so the
  // generator can safely run again without inserting duplicate controls.
  text = text.replace(/<section class="get-app" id="getAppBlock"[\s\S]*?<\/section>\s*<script>[\s\S]*?<\/script>/g, '');
  text = text.replace(/\s*<style id="kitui-get-app-style">[\s\S]*?<\/style>/g, '');

  // Remove the old hidden install card and its deferred install script.
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '<script src="/install.js" defer></script>') {
      i += 1;
      continue;
    }
    if (trimmed.indexOf('<div class="install-card" id="kitui-install-card"') === 0) {
      let depth = (line.match(/<div/g) || []).length - (line.match(/<\/div>/g) || []).length;
      let j = i + 1;
      while (j < lines.length && depth > 0) {
        depth += (lines[j].match(/<div/g) || []).length - (lines[j].match(/<\/div>/g) || []).length;
        j += 1;
      }
      if (depth === 0) {
        i = j; // drop the whole card block
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join('\n');
}

for (const name of PAGES) {
  const file = path.join(ROOT, name);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  text = stripBlock(text);
  const css = CSS_RULES.split('\n').join(eol);
  const style = '<style id="kitui-get-app-style">' + eol + css + eol + '</style>';

  const block = BLOCK.split('\n').join(eol);
  if (text.indexOf('</main>') !== -1) {
    text = text.replace(/\s*<\/main>/, eol + block + eol + '</main>');
  } else {
    text = text.replace(/\s*<\/body>/, eol + block + eol + '</body>');
  }

  if (text.indexOf('</head>') !== -1) {
    text = text.replace('</head>', style + eol + '</head>');
  } else {
    console.log('WARN: no </head> in ' + name);
  }

  // Normalise back to the file's own line endings.
  if (eol === '\r\n') {
    text = text.replace(/\r?\n/g, '\r\n');
  } else {
    text = text.replace(/\r\n/g, '\n');
  }

  fs.writeFileSync(file, text, 'utf8');
  console.log('updated ' + name);
}
console.log('get-app block injection complete');
