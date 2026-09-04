// Settings → Updates section. Talks to the main process via
// window.electronAPI.updates* (see preload.js) and reflects the live
// auto-updater state pushed on the 'updates:state' channel, so the section
// shows checking / up-to-date / downloading (with %) / ready-to-install live.

let __updatesUnsub = null;

function __uSet(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

// ── Human-readable download detail ──
// A percentage alone says nothing useful about a 130MB download: it cannot tell
// you whether to wait or walk away. Size, rate and remaining time can.
function __uBytes(n) {
    const b = Number(n) || 0;
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (b >= 1024 * 1024) return Math.round(b / (1024 * 1024)) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
}

function __uRate(bps) {
    const v = Number(bps) || 0;
    if (v <= 0) return '';
    return __uBytes(v) + '/s';
}

// Time left, phrased the way a person would say it. Returns '' when there is
// not enough information to be honest about it — a made-up estimate is worse
// than none.
function __uEta(transferred, total, bps) {
    const left = (Number(total) || 0) - (Number(transferred) || 0);
    const rate = Number(bps) || 0;
    if (left <= 0 || rate <= 0) return '';
    const secs = Math.round(left / rate);
    if (secs < 5) return 'almost done';
    if (secs < 60) return secs + 's left';
    const mins = Math.round(secs / 60);
    return mins + (mins === 1 ? ' min left' : ' mins left');
}
// The badge's pill comes from .account-badge, which hardcodes a green border
// and fill. Recolouring only the text left "Downloading" sitting in blue inside
// a green pill — a state saying two different things at once. Border, fill and
// text all move together.
function __uTint(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
}

function __uBadge(text, color) {
    const el = document.getElementById('updates-badge');
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
    // Empty string restores the stylesheet's own value, so an unknown colour
    // degrades to the default pill rather than to no pill at all.
    el.style.borderColor = __uTint(color, 0.3);
    el.style.background = __uTint(color, 0.1);
}

function renderUpdatesState(s) {
    if (!s) return;
    __uSet('updates-version', 'v' + (s.current || '—'));

    const checkBtn = document.getElementById('updates-check-btn');
    const installBtn = document.getElementById('updates-install-btn');
    const bar = document.getElementById('updates-progress-bar');

    let status = '', badge = '—', badgeColor = '#a3a3a3';
    let showProgress = false, showInstall = false, checkDisabled = false, checkLabel = 'Check for updates';

    switch (s.status) {
        case 'dev':
            status = 'Updates apply to the installed app — not this dev build.';
            badge = 'Dev'; checkDisabled = true; break;
        case 'disabled':
            status = 'Automatic updates are turned off.'; badge = 'Off'; break;
        case 'checking':
            status = 'Checking for updates…'; badge = 'Checking';
            checkDisabled = true; checkLabel = 'Checking…'; break;
        case 'not-available':
            status = "You're on the latest version."; badge = 'Up to date'; badgeColor = '#34d399'; break;
        case 'available':
            status = 'Update ' + (s.version ? 'v' + s.version + ' ' : '') + 'found — downloading…';
            badge = 'Update'; badgeColor = '#60a5fa'; showProgress = true; checkDisabled = true; break;
        case 'downloading':
            status = 'Downloading update' + (s.version ? ' v' + s.version : '') + '…';
            badge = 'Downloading'; badgeColor = '#60a5fa'; showProgress = true; checkDisabled = true; break;
        case 'downloaded':
            status = (s.version ? 'Version ' + s.version : 'The update') +
                     ' is downloaded and ready. Restarting takes a few seconds.';
            badge = 'Ready'; badgeColor = '#34d399'; showInstall = true; checkDisabled = true; break;
        case 'error':
            status = "Couldn't check for updates. Try again shortly."; badge = 'Error'; badgeColor = '#f87171'; break;
        default: // idle
            status = 'Checking for updates…'; checkDisabled = true; break;
    }

    __uSet('updates-status', status);
    __uBadge(badge, badgeColor);
    if (checkBtn) { checkBtn.disabled = checkDisabled; checkBtn.textContent = checkLabel; checkBtn.classList.toggle('hidden', showInstall); }
    if (installBtn) installBtn.classList.toggle('hidden', !showInstall);

    // A state class on the section, so the styling can respond to what is
    // happening rather than every state looking identical.
    const section = document.getElementById('updates-section');
    if (section) {
        section.classList.remove('u-checking', 'u-downloading', 'u-ready', 'u-error', 'u-current');
        const cls = { checking: 'u-checking', available: 'u-downloading', downloading: 'u-downloading',
                      downloaded: 'u-ready', error: 'u-error', 'not-available': 'u-current' }[s.status];
        if (cls) section.classList.add(cls);
    }

    const wrap = document.getElementById('updates-progress-wrap');
    if (wrap) wrap.classList.toggle('hidden', !showProgress);
    if (showProgress && bar) {
        const pct = Math.max(0, Math.min(100, s.progress || 0));
        bar.style.width = pct + '%';
        // Indeterminate until the first byte lands: a 0% bar that sits still
        // reads as broken, when it is actually still connecting.
        if (wrap) wrap.classList.toggle('u-indeterminate', !s.total);
        __uSet('updates-progress-pct', pct + '%');
        const detail = [];
        if (s.total) detail.push(__uBytes(s.transferred) + ' of ' + __uBytes(s.total));
        const rate = __uRate(s.bytesPerSecond);
        if (rate) detail.push(rate);
        const eta = __uEta(s.transferred, s.total, s.bytesPerSecond);
        if (eta) detail.push(eta);
        __uSet('updates-progress-text', detail.length ? detail.join('  ·  ') : 'Starting download…');
    }

    const msg = document.getElementById('updates-msg');
    if (msg) {
        if (s.status === 'error' && s.error) { msg.style.color = '#f87171'; msg.textContent = s.error; }
        else msg.textContent = '';
    }
}

async function loadUpdatesInfo() {
    if (!window.electronAPI?.updatesGetState) return;
    // Subscribe once so download progress streams in live.
    if (!__updatesUnsub && window.electronAPI.onUpdatesState) {
        __updatesUnsub = window.electronAPI.onUpdatesState((s) => renderUpdatesState(s));
    }
    try {
        renderUpdatesState(await window.electronAPI.updatesGetState());
    } catch (e) { /* ignore */ }
}

async function checkForUpdates() {
    const msg = document.getElementById('updates-msg');
    if (msg) { msg.style.color = '#737373'; msg.textContent = ''; }
    try {
        renderUpdatesState(await window.electronAPI.updatesCheck());
    } catch (e) {
        if (msg) { msg.style.color = '#f87171'; msg.textContent = 'Could not check right now.'; }
    }
}

async function installUpdate() {
    if (typeof showToast === 'function') showToast('Restarting to install the update…');
    const msg = document.getElementById('updates-msg');
    if (msg) { msg.style.color = '#737373'; msg.textContent = 'Restarting to install…'; }
    try { await window.electronAPI.updatesInstall(); } catch (e) { /* app quits on success */ }
}
