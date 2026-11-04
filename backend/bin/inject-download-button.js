'use strict';
// Replaces the get-app block with a direct install button: clicking it runs the
// browser's real install prompt (no instructional text at all).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PAGES = [
  'login.html', 'signup.html', 'forgot-password.html', 'payment.html',
  'profile.html', 'buyer-dashboard.html', 'farmer-dashboard.html',
  'settings.html', 'index.html'
];

const BLOCK = [
  '<section class="get-app" id="getAppBlock" aria-label="Get the KITUI FARM app">',
  '  <div class="get-app-icon"><img src="icons/icon-192x192.png" alt="" width="38" height="38"></div>',
  '  <div class="get-app-body">',
  '    <p class="get-app-title">Get the KITUI FARM app</p>',
  '    <p class="get-app-desc">Install the app on your phone. It opens full-screen like a store app.</p>',
  '  </div>',
  '  <div class="get-app-actions"><button class="get-app-btn" id="getAppBtn" type="button">Download app</button></div>',
  '</section>',
  '<script>',
  '(function(){',
  "  var btn=document.getElementById('getAppBtn');",
  "  var block=document.getElementById('getAppBlock');",
  '  var promptEvent=null;',
  '  var waiters=[];',
  '  function flush(event){',
  '    promptEvent=event;',
  '    var pending=waiters.splice(0);',
  '    pending.forEach(function(fn){ fn(event); });',
  '  }',
  '  window.addEventListener("beforeinstallprompt",function(event){',
  '    event.preventDefault();',
  '    flush(event);',
  '  },[]);',
  '  window.addEventListener("appinstalled",function(){',
  '    if(btn){ btn.disabled=true; btn.textContent="Installed"; }',
  '  });',
  '  if("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(function(){}); }',
  '  // Already installed as an app: no need to offer the download again.',
  '  try {',
  '    if(window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches&&block){ block.hidden=true; }',
  '  } catch(error) { /* ignore */ }',
  '  function run(event){',
  '    btn.disabled=true;',
  '    btn.textContent="Installing\\u2026";',
  '    event.prompt().then(function(choice){',
  '      if(choice&&choice.outcome==="accepted"){ btn.textContent="Installed"; return; }',
  '      btn.disabled=false; btn.textContent="Download app";',
  '    }).catch(function(){',
  '      btn.disabled=false; btn.textContent="Download app";',
  '    });',
  '  }',
  '  if(btn){',
  '    btn.addEventListener("click",function(){',
  '      if(promptEvent){ run(promptEvent); return; }',
  '      // Chrome hands over the prompt event a moment after load; wait for it.',
  '      var settled=false;',
  '      btn.disabled=true;',
  '      btn.textContent="Preparing\\u2026";',
  '      waiters.push(function(event){',
  '        if(settled){ return; }',
  '        settled=true;',
  '        btn.disabled=false;',
  '        btn.textContent="Download app";',
  '        run(event);',
  '      });',
  '      setTimeout(function(){',
  '        if(settled){ return; }',
  '        settled=true;',
  '        btn.disabled=false;',
  '        btn.textContent="Download app";',
  '      },4000);',
  '    });',
  '  }',
  '})();',
  '</script>'
].join('\n');

for (const name of PAGES) {
  const file = path.join(ROOT, name);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  const start = text.indexOf('<section class="get-app"');
  if (start === -1) {
    console.log('skip (no block): ' + name);
    continue;
  }
  const end = text.indexOf('</script>', text.indexOf('</section>', start));
  if (end === -1) {
    console.log('skip (no script end): ' + name);
    continue;
  }

  text = text.slice(0, start) + BLOCK.split('\n').join(eol) + text.slice(end + '</script>'.length);
  fs.writeFileSync(file, text, 'utf8');
  console.log('updated ' + name);
}
console.log('download button injection complete');
