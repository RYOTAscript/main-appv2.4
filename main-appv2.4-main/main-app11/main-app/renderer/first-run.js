// First-run welcome — the one screen a new user sees before the app itself.
//
// It exists because the installer cannot be made to look like this. NSIS pages
// are stock Win32 controls: system grey, system font, no radius, no motion. The
// only surface where main's design actually applies is main's own window, so
// the install is made invisible (one-click, no wizard) and the welcome lives
// here instead — in HTML we fully control.
//
// Deliberately inert: it reads two values and closes itself. Nothing here can
// fail in a way that keeps a new user out of the app.
(function () {
    'use strict';

    // first-run-preload.js, not the main app's electronAPI: this window gets a
    // bridge with four methods on it and nothing else.
    const api = window.firstRun || {};

    function close() {
        try {
            if (typeof api.done === 'function') { api.done(); return; }
        } catch (e) { /* fall through */ }
        // If the bridge is missing the window must still go away — a welcome
        // screen that cannot be dismissed is worse than no welcome screen.
        try { window.close(); } catch (e) { /* nothing left to try */ }
    }

    document.getElementById('start')?.addEventListener('click', close);

    // The Terms and Privacy links next to the button. Delegated, and the only
    // thing that crosses the bridge is which of the two was clicked — the page
    // never handles a URL. Opening them must not dismiss the welcome screen:
    // someone who stops to read is not someone who is finished with it.
    document.querySelector('.legal')?.addEventListener('click', (e) => {
        const link = e.target.closest('[data-legal]');
        if (!link) return;
        e.preventDefault();
        try { api.openLegal?.(link.dataset.legal); } catch (err) { /* nothing to do */ }
    });

    // Enter and Escape both mean "I'm done here". Escape is not a cancel: there
    // is nothing to cancel, the app is already installed.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); close(); }
    });

    // The hotkey shown must be the user's actual binding, not the default we
    // happen to ship. Telling someone to press a key that does nothing is worse
    // than telling them nothing.
    (async () => {
        try {
            const accel = await api.getFocusHotkey?.();
            if (typeof accel === 'string' && accel && accel !== '-') {
                const el = document.getElementById('hotkey');
                if (el) el.textContent = accel.replace(/CommandOrControl|Control/gi, 'Ctrl').split('+').join(' + ');
            }
        } catch (e) { /* the default in the markup is a fine fallback */ }
        try {
            const v = await api.getAppVersion?.();
            const el = document.getElementById('version');
            if (el && v) el.textContent = 'main ' + v;
        } catch (e) { /* version is decoration */ }
    })();
})();
