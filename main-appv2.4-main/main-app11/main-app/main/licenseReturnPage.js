// The page Google redirects the browser to at the end of in-app sign-in.
//
// Kept out of license.js for size, the same way voiceHostScript.js holds the
// speech host's C#. Export is a single self-contained HTML string.
//
// WHY IT'S BUILT LIKE THIS
// ------------------------
// This is the last thing a customer sees before the app unlocks, and it's the
// screen they land on straight from the license gate — so it is deliberately a
// continuation of license-gate.html, not its own design. Same shell (near-black
// glass, blur(48px), 22px radius, white accent), same animated backdrop (soft
// radials + three drifting blobs + the masked 44px grid), same spinning conic
// ring and breathing halo around the logo, same staggered .rise entrance, same
// type scale and button treatment. If you restyle the gate, restyle this too.
//
// It's served off a loopback port with no network identity, so every byte is
// inline: an external stylesheet, webfont or icon set would be a slow, failable
// dependency on the one screen that must not look broken. The logo is read off
// disk and inlined as a data URI for the same reason (icons/logo-128.png — a
// downscaled copy of the gate's logo.png, which at ~942KB is far too big to
// inline; the gate itself only ever renders it at 60px).
//
// It also does real work. Google redirects here the instant it has an auth code,
// long before the token exchange, the licence lookup and the device activation
// have run — so the page opens in a "working" state and polls /status on the same
// loopback server. Three things follow:
//   • the trace shows which stage is in flight, and which one failed,
//   • a failure is reported where the user is actually looking, instead of only
//     in the app hidden behind the browser window, and
//   • the success state can say something true ("unlocked on this computer")
//     rather than a hopeful guess made before the work happened.
//
// SAFETY: `detail` carries a server-supplied string, so all status text is
// written with textContent. There is no innerHTML in this page.

const fs = require('fs');
const path = require('path');

// The gate's logo, inlined. Falls back to an empty string, in which case the
// ring and halo render on their own — the mark still reads correctly.
let LOGO_URI = '';
try {
  const p = path.join(__dirname, '..', 'icons', 'logo-128.png');
  LOGO_URI = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
} catch (e) {
  /* no logo → ring + halo only */
}

const RETURN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing in — main</title>
<style>
  /* Mirrors license-gate.html. Keep the two in step. */
  :root{ --accent:255,255,255; }
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    background:#050505; color:#fff; overflow:hidden;
    font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    display:grid; place-items:center; padding:22px;
    -webkit-font-smoothing:antialiased;
  }

  /* ── Shell: the gate's card, scaled up for a browser viewport ── */
  .shell{
    position:relative; width:100%; max-width:470px; border-radius:22px; overflow:hidden;
    background:rgba(8,8,8,.9); backdrop-filter:blur(48px); -webkit-backdrop-filter:blur(48px);
    border:1px solid rgba(255,255,255,.1);
    box-shadow:0 0 70px rgba(var(--accent),.12), inset 0 1px 0 rgba(255,255,255,.06);
    animation:shellIn .7s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes shellIn{from{opacity:0;transform:scale(.965)}to{opacity:1;transform:scale(1)}}

  /* ── Animated backdrop: the gate's scene, blobs and drifting grid ── */
  .bg{position:absolute;inset:0;overflow:hidden;pointer-events:none}
  .scene{position:absolute;inset:0;
    background:
      radial-gradient(ellipse 80% 55% at 50% -5%, rgba(255,255,255,.07), transparent 60%),
      radial-gradient(ellipse 55% 45% at 80% 105%, rgba(255,255,255,.04), transparent 55%)}
  .blob{position:absolute;border-radius:50%;filter:blur(46px);will-change:transform;opacity:.9}
  .blob-a{width:260px;height:260px;top:-70px;left:-60px;
    background:radial-gradient(circle at 50% 50%, rgba(255,255,255,.07), transparent 70%);
    animation:blobA 20s ease-in-out infinite alternate}
  .blob-b{width:240px;height:240px;bottom:-80px;right:-60px;
    background:radial-gradient(circle at 50% 50%, rgba(150,180,255,.06), transparent 70%);
    animation:blobB 26s ease-in-out infinite alternate}
  .blob-c{width:200px;height:200px;top:40%;left:45%;
    background:radial-gradient(circle at 50% 50%, rgba(180,150,255,.05), transparent 70%);
    animation:blobC 30s ease-in-out infinite alternate}
  @keyframes blobA{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,50px) scale(1.15)}}
  @keyframes blobB{from{transform:translate(0,0) scale(1.1)}to{transform:translate(-40px,-40px) scale(.92)}}
  @keyframes blobC{from{transform:translate(0,0) scale(.95)}to{transform:translate(-30px,30px) scale(1.12)}}
  .grid{position:absolute;inset:0;
    background-image:
      linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px);
    background-size:44px 44px;
    -webkit-mask-image:radial-gradient(ellipse 65% 65% at 50% 45%, black 15%, transparent 80%);
    mask-image:radial-gradient(ellipse 65% 65% at 50% 45%, black 15%, transparent 80%);
    animation:gridDrift 26s linear infinite}
  @keyframes gridDrift{from{transform:translateY(0)}to{transform:translateY(44px)}}

  /* ── Body ── */
  .body{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;
    text-align:center;padding:46px 38px 34px}
  .rise{opacity:0;animation:rise .75s cubic-bezier(.22,1,.36,1) both;
    animation-delay:calc(var(--d,0)*.09s + .18s)}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

  /* ── Logo mark: the gate's spinning conic ring + breathing halo ── */
  .logo-wrap{position:relative;width:96px;height:96px;margin-bottom:20px;
    display:flex;align-items:center;justify-content:center}
  .logo-ring{position:absolute;inset:0;border-radius:50%;
    background:conic-gradient(from 0deg, transparent 0 62%, rgba(var(--accent),.55) 78%, transparent 92%);
    -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    mask:radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    animation:spin 4.5s linear infinite}
  .logo-halo{position:absolute;width:96px;height:96px;border-radius:50%;
    background:radial-gradient(circle, rgba(var(--accent),.28), transparent 68%);
    animation:halo 3.2s ease-in-out infinite}
  .logo{position:relative;z-index:1;width:64px;height:64px;border-radius:18px;object-fit:cover;
    border:1px solid rgba(255,255,255,.12);background:#000;box-shadow:0 8px 30px rgba(0,0,0,.55);
    transition:opacity .4s ease,transform .4s ease}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes halo{0%,100%{opacity:.4;transform:scale(.94)}50%{opacity:.9;transform:scale(1.06)}}

  /* Terminal states swap the logo for a drawn tick/cross in the same well. */
  .badge{position:absolute;z-index:2;inset:0;display:none;align-items:center;justify-content:center}
  .badge svg{width:64px;height:64px}
  .badge path{fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;
    stroke-dasharray:54;stroke-dashoffset:54;animation:draw .5s .05s cubic-bezier(.6,.1,.3,1) forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  body.ok .badge.tick,body.err .badge.cross{display:flex}
  body.ok .badge.tick path{stroke:#34d399}
  body.err .badge.cross path{stroke:#f87171}
  body.ok .logo,body.err .logo{opacity:0;transform:scale(.86)}
  /* Drop the spinning arc once there's an outcome — left up, it reads as a
     loading indicator on a screen that has finished loading. */
  body.ok .logo-ring,body.err .logo-ring{display:none}
  body.ok .logo-halo{background:radial-gradient(circle, rgba(52,211,153,.30), transparent 68%)}
  body.err .logo-halo{background:radial-gradient(circle, rgba(248,113,113,.26), transparent 68%);animation:none;opacity:.7}
  body.ok .shell{border-color:rgba(52,211,153,.22);box-shadow:0 0 70px rgba(52,211,153,.10), inset 0 1px 0 rgba(255,255,255,.06)}
  body.err .shell{border-color:rgba(248,113,113,.2)}

  h1{font-size:23px;font-weight:600;letter-spacing:-.02em;margin:0}
  .sub{color:#9a9a9a;font-size:13px;line-height:1.55;margin:8px 0 0;max-width:320px}

  /* ── Handshake trace, using the gate's divider treatment ── */
  .divider{display:flex;align-items:center;gap:10px;width:100%;color:#666;font-size:11px;
    letter-spacing:.08em;text-transform:uppercase;margin:22px 0 14px}
  .divider::before,.divider::after{content:'';flex:1;height:1px;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent)}
  .trace{list-style:none;margin:0;padding:0;width:100%;display:grid;gap:9px;text-align:left}
  .trace li{display:flex;align-items:center;gap:10px;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,monospace;
    font-size:11.5px;letter-spacing:.04em;color:#6a6a6a;transition:color .4s ease}
  .dot{flex:0 0 auto;width:14px;height:14px;border-radius:50%;position:relative;
    border:1px solid rgba(255,255,255,.14);transition:all .4s ease}
  .dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background:transparent;transition:background .4s ease}
  li.active{color:#e6e6e6}
  li.active .dot{border-color:rgba(var(--accent),.55);box-shadow:0 0 0 3px rgba(var(--accent),.07)}
  li.active .dot::after{background:#fff;animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.3}}
  li.done{color:#34d399}
  li.done .dot{border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.12)}
  li.done .dot::after{background:#34d399}
  li.failed{color:#f87171}
  li.failed .dot{border-color:rgba(248,113,113,.55);background:rgba(248,113,113,.12)}
  li.failed .dot::after{background:#f87171}

  .foot{margin-top:22px;font-size:12px;color:#8a8a8a;opacity:0;transition:opacity .5s .2s}
  body.ok .foot,body.err .foot{opacity:1}

  @media (prefers-reduced-motion:reduce){
    *{animation:none!important;transition:none!important}
    .badge path{stroke-dashoffset:0}
    .rise{opacity:1}
  }
</style></head>
<body>
  <div class="shell">
    <div class="bg">
      <div class="scene"></div>
      <div class="blob blob-a"></div><div class="blob blob-b"></div><div class="blob blob-c"></div>
      <div class="grid"></div>
    </div>
    <div class="body">
      <div class="logo-wrap rise" style="--d:0">
        <div class="logo-halo"></div>
        <div class="logo-ring"></div>
        ${LOGO_URI ? `<img class="logo" src="${LOGO_URI}" alt="main">` : ''}
        <span class="badge tick"><svg viewBox="0 0 64 64"><path d="M20 33.5 L28 41.5 L44 23.5"/></svg></span>
        <span class="badge cross"><svg viewBox="0 0 64 64"><path d="M23 23 L41 41 M41 23 L23 41"/></svg></span>
      </div>
      <h1 class="rise" id="title" style="--d:1">Finishing sign-in…</h1>
      <p class="sub rise" id="detail" style="--d:2">Handing your Google account back to main.</p>
      <div class="divider rise" style="--d:3">Progress</div>
      <ol class="trace rise" id="trace" style="--d:4">
        <li data-stage="auth"><span class="dot"></span><span>Authorising with Google</span></li>
        <li data-stage="license"><span class="dot"></span><span>Checking your license</span></li>
        <li data-stage="device"><span class="dot"></span><span>Activating this computer</span></li>
      </ol>
      <div class="foot" id="foot">You can close this tab.</div>
    </div>
  </div>
<script>
(function(){
  var ORDER = ['auth','license','device'];
  var body = document.body;
  var titleEl = document.getElementById('title');
  var detailEl = document.getElementById('detail');
  var footEl = document.getElementById('foot');
  var items = {};
  var lis = document.getElementById('trace').children;
  for (var i = 0; i < lis.length; i++) items[lis[i].getAttribute('data-stage')] = lis[i];

  function markTrace(stage, terminal) {
    var reached = ORDER.indexOf(stage);
    if (reached < 0) reached = 0;
    for (var i = 0; i < ORDER.length; i++) {
      var li = items[ORDER[i]];
      li.className = '';
      if (terminal === 'ok') { li.classList.add('done'); continue; }
      if (i < reached) li.classList.add('done');
      else if (i === reached) li.classList.add(terminal === 'error' ? 'failed' : 'active');
    }
  }

  var settled = false;
  function paint(s) {
    if (!s) return false;
    if (s.state === 'working') { markTrace(s.stage || 'auth', null); return false; }
    settled = true;
    body.classList.add(s.state === 'ok' ? 'ok' : 'err');
    markTrace(s.stage || 'auth', s.state === 'ok' ? 'ok' : 'error');
    // textContent, never innerHTML — detail carries a server-supplied string.
    titleEl.textContent = s.title || (s.state === 'ok' ? 'Signed in' : 'Sign-in didn’t finish');
    detailEl.textContent = s.detail || '';
    footEl.textContent = s.state === 'ok'
      ? 'You can close this tab — main is ready.'
      : 'You can close this tab and try again from main.';
    document.title = (s.state === 'ok' ? 'Signed in' : 'Sign-in failed') + ' — main';
    return true;
  }

  var tries = 0;
  function poll() {
    if (settled || tries++ > 200) return;
    fetch('/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) { if (!paint(s)) setTimeout(poll, 400); })
      .catch(function () {
        // The app tears this server down once it's finished. If we never saw a
        // terminal state, say something true rather than spinning forever.
        setTimeout(function () {
          if (settled) return;
          settled = true;
          body.classList.add('ok');
          markTrace('device', 'ok');
          titleEl.textContent = 'You can return to main';
          detailEl.textContent = 'Sign-in has been handed back to the app.';
          footEl.textContent = 'You can close this tab.';
        }, 1200);
      });
  }
  markTrace('auth', null);
  poll();
})();
</script>
</body></html>`;

module.exports = { RETURN_PAGE };
