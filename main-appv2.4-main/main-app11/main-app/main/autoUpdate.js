// Auto-update via electron-updater.
//
// Checks the generic update feed configured in package.json > build.publish
// (a `latest.yml` + installer hosted at that URL), downloads a newer version in
// the background, and installs it on the next app quit. A native notification
// tells the user an update is ready.
//
// It also drives the Settings → Updates section: it tracks a small state object
// (status + versions + download progress), answers on-demand IPC for the UI
// (updates:get-state / updates:check / updates:install), and pushes live state
// to the renderer (updates:state) so the section reflects progress in realtime.
//
// Deliberately defensive: the auto-updater only runs in a packaged build, never
// throws into the caller, and can be turned off with DISABLE_AUTO_UPDATE=1 (or
// pointed at a different feed with UPDATE_FEED_URL). The IPC surface is always
// registered — even in dev — so the Updates section can at least show the
// current version and a clear "updates only in the installed build" state.

const { app, ipcMain, BrowserWindow, Notification } = require('electron');

let started = false;
let autoUpdater = null;
let log = null;

// status: dev | disabled | idle | checking | available | not-available |
//         downloading | downloaded | error
let state = { status: 'idle', version: null, progress: 0, error: null,
  // electron-updater reports these on every progress tick and they were all
  // being thrown away, leaving the UI with nothing to say but a percentage.
  transferred: 0, total: 0, bytesPerSecond: 0 };

function publicState() {
  return {
    current: app.getVersion(),
    packaged: app.isPackaged,
    status: state.status,
    version: state.version,
    progress: state.progress,
    transferred: state.transferred,
    total: state.total,
    bytesPerSecond: state.bytesPerSecond,
    error: state.error,
  };
}

function broadcast() {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w && !w.isDestroyed()) w.webContents.send('updates:state', publicState());
    }
  } catch (e) {
    /* windows may be tearing down — ignore */
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  broadcast();
}

function registerIpc() {
  ipcMain.handle('updates:get-state', () => publicState());

  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) { setState({ status: 'dev' }); return publicState(); }
    if (!autoUpdater) { setState({ status: 'error', error: 'Updater unavailable.' }); return publicState(); }
    // If an update is already downloaded, nothing to re-check.
    if (state.status === 'downloaded') return publicState();
    setState({ status: 'checking', error: null });
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      setState({ status: 'error', error: e?.message || 'Update check failed.' });
    }
    return publicState();
  });

  ipcMain.handle('updates:install', () => {
    if (state.status !== 'downloaded' || !autoUpdater) return { ok: false };
    // Give the renderer a beat to show its "restarting…" state before we quit.
    setTimeout(() => { try { autoUpdater.quitAndInstall(); } catch (e) { log?.warn?.('[autoUpdate] quitAndInstall failed', e); } }, 250);
    return { ok: true };
  });
}

function initAutoUpdate(logger) {
  if (started) return;
  started = true;
  log = logger;

  // Always expose the IPC surface so the Updates section works everywhere.
  registerIpc();

  // electron-updater only works from an installed build; in `electron .` dev it
  // has no app-update.yml and would throw.
  if (!app.isPackaged) {
    setState({ status: 'dev' });
    logger?.info?.('[autoUpdate] skipped — not a packaged build');
    return;
  }
  if (process.env.DISABLE_AUTO_UPDATE === '1') {
    setState({ status: 'disabled' });
    logger?.info?.('[autoUpdate] disabled via DISABLE_AUTO_UPDATE');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    setState({ status: 'error', error: 'Updater unavailable.' });
    logger?.warn?.('[autoUpdate] electron-updater not available', e);
    return;
  }

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // Allow the feed URL to be overridden at runtime (e.g. once the site moves
    // off the beta domain) without rebuilding.
    if (process.env.UPDATE_FEED_URL) {
      autoUpdater.setFeedURL({ provider: 'generic', url: process.env.UPDATE_FEED_URL });
    }

    if (logger) {
      autoUpdater.logger = {
        info: (m) => logger.info?.('[autoUpdate]', m),
        warn: (m) => logger.warn?.('[autoUpdate]', m),
        error: (m) => logger.error?.('[autoUpdate]', m),
        debug: () => {},
      };
    }

    autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
  // ── Telling the user ──
  // The updates section only exists inside Settings, so an update could download
  // and sit waiting indefinitely without the user ever knowing. A notification is
  // the only channel that reaches someone who is not looking at the app.
  //
  // Deliberately two, and no more: one when a version starts downloading and one
  // when it is ready to install. Anything chattier is an app nagging about
  // itself. `silent` because an update is not worth a sound.
  let notifiedFor = null;

  function notify(title, body, onClick) {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent: true, icon: appIconPath() });
      if (typeof onClick === 'function') n.on('click', onClick);
      n.show();
    } catch (e) {
      // A notification failing must never affect the update itself.
      logger?.warn?.('[autoUpdate] notification failed', e?.message || e);
    }
  }

  function appIconPath() {
    try { return require('path').join(__dirname, '..', 'icons', 'main.ico'); }
    catch (e) { return undefined; }
  }

    autoUpdater.on('update-available', (info) => {
      setState({ status: 'available', version: info?.version || null });
      logger?.info?.('[autoUpdate] update available', info?.version);
      const v = info?.version;
      // Once per version, so a restart or a re-check cannot re-nag.
      if (v && notifiedFor !== v) {
        notifiedFor = v;
        notify('main ' + v + ' is available', 'Downloading now — you can keep working.');
      }
    });
    autoUpdater.on('update-not-available', () => setState({ status: 'not-available' }));
    autoUpdater.on('download-progress', (p) =>
      setState({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, Math.round(p?.percent || 0))),
        // Carried through so the UI can show how much of what, how fast, and
        // how much longer — a bare percentage on a 130MB download tells the
        // user almost nothing about whether it is worth waiting for.
        transferred: Number(p?.transferred) || 0,
        total: Number(p?.total) || 0,
        bytesPerSecond: Number(p?.bytesPerSecond) || 0
      }),
    );
    autoUpdater.on('update-downloaded', (info) => {
      setState({ status: 'downloaded', version: info?.version || state.version, progress: 100 });
      logger?.success?.('[autoUpdate] update downloaded — installs on quit', info?.version);
      const v = info?.version || state.version || '';
      notify(
        'main ' + v + ' is ready',
        'Click here to restart and install, or it will apply next time you quit.',
        () => {
          // Same path the Settings button uses, so there is one way to install.
          try { autoUpdater.quitAndInstall(false, true); }
          catch (e) { logger?.warn?.('[autoUpdate] install from notification failed', e?.message || e); }
        }
      );
    });
    autoUpdater.on('error', (err) => {
      setState({ status: 'error', error: err?.message || 'Update error.' });
      logger?.warn?.('[autoUpdate] check failed', err?.message || err);
    });

    // checkForUpdatesAndNotify shows a native "update ready" notification.
    autoUpdater.checkForUpdatesAndNotify().catch((err) =>
      logger?.warn?.('[autoUpdate] initial check failed', err?.message || err),
    );

    // Re-check every 6 hours for long-running sessions (the app is always-on).
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } catch (e) {
    setState({ status: 'error', error: 'Updater init failed.' });
    logger?.warn?.('[autoUpdate] init failed', e);
  }
}

module.exports = { initAutoUpdate };
