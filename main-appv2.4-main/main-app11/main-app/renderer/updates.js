// Settings → Updates section. Talks to the main process via
// window.electronAPI.updates* (see preload.js) and reflects the live
// auto-updater state pushed on the 'updates:state' channel, so the section
// shows checking / up-to-date / downloading (with %) / ready-to-install live.

let __updatesUnsub = null;

function __uSet(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function __uBadge(text, color) {
    const el = document.getElementById('updates-badge');
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
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
            status = 'Update ' + (s.version ? 'v' + s.version + ' ' : '') + 'ready — restart to install.';
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

    const wrap = document.getElementById('updates-progress-wrap');
    if (wrap) wrap.classList.toggle('hidden', !showProgress);
    if (showProgress && bar) {
        const pct = Math.max(0, Math.min(100, s.progress || 0));
        bar.style.width = pct + '%';
        __uSet('updates-progress-text', 'Downloading… ' + pct + '%');
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
