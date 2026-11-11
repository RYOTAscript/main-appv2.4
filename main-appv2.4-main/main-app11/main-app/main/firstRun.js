// First-run welcome window.
//
// Why this exists at all: the NSIS installer cannot be made to look like this
// product. Its pages are stock Win32 controls — system grey, system font, no
// radius, no motion — and no artwork changes that. So the install is made
// invisible (one-click, no wizard) and the moment of welcome moves here, into a
// window whose design we actually own.
//
// Rules it lives by:
//   * It must never be able to keep a new user out of the app. Every failure
//     path ends with the window gone and the launcher running.
//   * It shows once. The marker is written the moment the window opens, not
//     when it closes, so a crash mid-welcome cannot make it reappear forever.
//   * It is not a gate. The main window is already up behind it.

const { BrowserWindow, ipcMain, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { lockNavigation } = require('./windowGuard');
const { SITE_URL } = require('./license');

// The welcome screen is where the user accepts the Terms, so it links to them.
// A closed map rather than a URL the page passes in: the renderer names one of
// these two keys and main resolves it, so the window has no route to open an
// arbitrary URL at all.
const LEGAL_URLS = {
  terms: `${SITE_URL}/terms`,
  privacy: `${SITE_URL}/privacy`,
};

const MARKER = 'first-run.json';

function markerPath() {
  return path.join(app.getPath('userData'), MARKER);
}

// Has this install already said hello? Any error answers "yes": a welcome
// screen shown twice is a papercut, but one that reappears on every launch
// because a disk read keeps failing is a reason to uninstall.
function alreadyWelcomed() {
  try {
    return fs.existsSync(markerPath());
  } catch (e) {
    return true;
  }
}

function markWelcomed(logger) {
  try {
    fs.writeFileSync(markerPath(), JSON.stringify({
      at: new Date().toISOString(),
      version: app.getVersion(),
    }, null, 2));
  } catch (e) {
    logger?.warn?.('[firstRun] could not write marker', e?.message || e);
  }
}

let win = null;

function close() {
  const w = win;
  win = null;
  try {
    if (w && !w.isDestroyed()) w.close();
  } catch (e) {
    /* already gone */
  }
}

function init(ctx) {
  const logger = ctx?.logger;

  // No handler for this existed; the welcome screen is the first thing that
  // wanted it. Registered here rather than in main.js so the module stays
  // self-contained.
  //
  // removeHandler first, not `ipcMain.eventNames().includes(...)`: eventNames()
  // only ever reports channels registered with .on(), and NEVER a channel
  // registered with .handle() — those live in a separate map. So that check was
  // always false, which made it dead code guarding against exactly the case it
  // could not see. A second .handle() on a live channel throws, and it would
  // have thrown here. removeHandler is a no-op when nothing is registered.
  ipcMain.removeHandler('get-app-version');
  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.removeHandler('first-run-done');
  ipcMain.handle('first-run-done', () => {
    close();
    return true;
  });

  ipcMain.removeHandler('first-run:open-legal');
  ipcMain.handle('first-run:open-legal', (_e, which) => {
    const url = LEGAL_URLS[String(which)];
    if (!url) {
      logger?.warn?.('[firstRun] refused unknown legal link', { which: String(which).slice(0, 40) });
      return false;
    }
    shell.openExternal(url);
    return true;
  });

  // Dev builds get it on demand only — otherwise every `npm start` during
  // development opens a welcome screen.
  ipcMain.removeHandler('first-run-show');
  ipcMain.handle('first-run-show', () => {
    show(ctx, true);
    return true;
  });

  if (!app.isPackaged) return;
  if (alreadyWelcomed()) return;
  show(ctx, false);
}

function show(ctx, force) {
  const logger = ctx?.logger;
  if (win && !win.isDestroyed()) {
    try { win.focus(); } catch (e) { /* ignore */ }
    return;
  }
  if (!force && alreadyWelcomed()) return;

  // Written up front, so a crash between here and the click cannot leave the
  // welcome screen greeting the user on every launch forever.
  markWelcomed(logger);

  try {
    win = new BrowserWindow({
      // The shell inside is 720x648; the extra room is the drop shadow, which
      // is part of the design and gets clipped without it.
      width: 820,
      height: 748,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      center: true,
      show: false,
      title: 'Welcome to main',
      backgroundColor: '#00000000',
      webPreferences: {
        // Its own narrow bridge, not the main app's whole electronAPI surface —
        // this window reads a version and a hotkey and closes itself.
        preload: path.join(__dirname, '..', 'first-run-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // The entrance animation is the first thing anyone sees. A window that
        // has not been shown yet is throttled by Chromium, which freezes an
        // animation mid-flight — the same trap the voice overlay hit.
        backgroundThrottling: false,
      },
    });

    lockNavigation(win, logger);
    win.setMenu?.(null);
    win.loadFile(path.join(__dirname, '..', 'first-run.html'));

    // A window whose page fails to load still OPENS — and because this one is
    // transparent, it opens as nothing at all: an invisible rectangle over the
    // desktop with no error anywhere. That is exactly how shipping it without
    // adding first-run.html to package.json's `files` whitelist looked. Never
    // silent again.
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      logger?.error?.('[firstRun] welcome page failed to load', { code, desc, url });
      close();
    });

    win.once('ready-to-show', () => {
      try { win.show(); } catch (e) { /* ignore */ }
    });
    win.on('closed', () => { win = null; });

    // Belt and braces: if the page never signals ready, show anyway rather than
    // leaving an invisible window holding the user's first impression hostage.
    setTimeout(() => {
      try { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); } catch (e) { /* ignore */ }
    }, 2500);

    logger?.info?.('[firstRun] welcome shown');
  } catch (e) {
    logger?.warn?.('[firstRun] could not open welcome window', e?.message || e);
    win = null;
  }
}

module.exports = { init, show, alreadyWelcomed };
