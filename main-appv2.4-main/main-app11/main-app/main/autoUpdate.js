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

const { app, ipcMain, BrowserWindow, Notification, powerMonitor } = require('electron');

let started = false;
let autoUpdater = null;
let log = null;

// status: dev | disabled | idle | checking | available | not-available |
//         downloading | downloaded | error
let state = { status: 'idle', version: null, progress: 0, error: null, errorKind: null,
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
    errorKind: state.errorKind || null,
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

// The percentage to show, from whichever of the event's fields actually
// arrived. Returns the last known value rather than 0 when nothing usable is
// present, so a single odd tick cannot make the bar jump backwards.
function progressPercent(p) {
  const pct = Number(p?.percent);
  if (Number.isFinite(pct) && pct > 0) return Math.max(0, Math.min(100, Math.round(pct)));
  const transferred = Number(p?.transferred);
  const total = Number(p?.total);
  if (Number.isFinite(transferred) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, Math.round((transferred / total) * 100)));
  }
  return state.progress || 0;
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
    setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { log?.warn?.('[autoUpdate] quitAndInstall failed', e); } }, 250);
    return { ok: true };
  });
}

// ── What actually went wrong ──────────────────────────────────────────────
// electron-updater's message is a stack-flavoured string ("net::ERR_..." ,
// "ENOTFOUND", an HTML error page). Shown raw it tells the user nothing, and
// the previous generic "Couldn't check for updates" told them nothing either —
// in particular it could not distinguish "your wifi is off" (their problem, and
// they can fix it) from "the update server is down" (ours, and they cannot).
// This machine sits behind a TLS-inspecting proxy that intercepts HTTPS, so the
// certificate case is a real one here, not a hypothetical.
function classifyError(err) {
  const m = String(err?.message || err || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  const both = code + ' ' + m;
  if (/enotfound|enetunreach|eai_again|err_name_not_resolved|err_internet_disconnected|err_network/.test(both)) {
    return { kind: 'offline', message: 'No internet connection.' };
  }
  if (/cert|ssl|tls|err_cert|self.signed|unable to verify/.test(both)) {
    return { kind: 'blocked', message: 'A security product on this network is blocking the update server.' };
  }
  if (/404|not found/.test(both)) {
    return { kind: 'missing', message: 'No update published yet.' };
  }
  if (/etimedout|timeout|econnreset|econnrefused|socket hang up|err_connection/.test(both)) {
    return { kind: 'unreachable', message: 'Update server did not respond.' };
  }
  if (/signature|invalid_signature/.test(both)) {
    return { kind: 'signature', message: 'That update failed its signature check and was not installed.' };
  }
  return { kind: 'unknown', message: 'Update check failed.' };
}

// ── Retrying, quietly ─────────────────────────────────────────────────────
// A check that fails once is almost never a check that will fail forever: a
// laptop that just woke, a proxy mid-handshake, a CDN blip. The old behaviour
// painted the Updates section red on the first failure and then did nothing
// until the app restarted or the user pressed the button themselves, which is
// the opposite of smooth — the one thing the user could not know is that
// nothing was going to happen.
//
// So failures are absorbed: retried on a widening delay, and kept out of the UI
// until enough of them in a row mean something is genuinely wrong. A signature
// failure is exempt — that one is not transient and must be seen.
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const FAILURES_BEFORE_SURFACING = 3;
let consecutiveFailures = 0;
let retryTimer = null;
let recheck = () => {};

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
    // Why the differential downloader is off.
    // With a .blockmap published beside the installer, electron-updater tries to
    // rebuild the new file from the blocks of the old one. It works, but it
    // reports almost no `download-progress` while doing it — which is why the
    // bar sat at 0% for the whole download and then jumped straight to done.
    // For a 130MB Electron app the saving is small anyway (the asar changes
    // wholesale between builds), and an honest progress bar is worth more than
    // a few MB: a bar stuck at zero is indistinguishable from a broken update.
    autoUpdater.disableDifferentialDownload = true;

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
      consecutiveFailures = 0;
      clearTimeout(retryTimer);
      setState({ status: 'available', version: info?.version || null, error: null, errorKind: null });
      logger?.info?.('[autoUpdate] update available', info?.version);
      const v = info?.version;
      // Once per version, so a restart or a re-check cannot re-nag.
      if (v && notifiedFor !== v) {
        notifiedFor = v;
        notify('main ' + v + ' is available', 'Downloading now — you can keep working.');
      }
    });
    autoUpdater.on('update-not-available', () => {
      consecutiveFailures = 0;
      clearTimeout(retryTimer);
      setState({ status: 'not-available', error: null, errorKind: null });
    });
    autoUpdater.on('download-progress', (p) =>
      setState({
        status: 'downloading',
        // Percent from the event when it gives one, otherwise derived from the
        // byte counts. Never trust a single field to be present: `percent` is
        // absent on some transfer paths, and a missing field must degrade to a
        // real number rather than silently pinning the bar to zero.
        progress: progressPercent(p),
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
          // isSilent: the NSIS wizard has nothing left to ask on an update —
          // install path, shortcuts and licence were all settled the first time.
          // Showing it again puts a grey Windows dialog in front of someone who
          // already chose to install here.
          try { autoUpdater.quitAndInstall(true, true); }
          catch (e) { logger?.warn?.('[autoUpdate] install from notification failed', e?.message || e); }
        }
      );
    });
    autoUpdater.on('error', (err) => {
      const info = classifyError(err);
      consecutiveFailures += 1;
      logger?.warn?.('[autoUpdate] attempt failed',
        { kind: info.kind, attempt: consecutiveFailures, detail: String(err?.message || err).slice(0, 200) });

      // A build that fails verification is a hard stop, not a blip: retrying
      // downloads the same bad bytes again, and the user needs to know their
      // update is not going to arrive.
      const hard = info.kind === 'signature';

      if (hard || consecutiveFailures >= FAILURES_BEFORE_SURFACING) {
        setState({ status: 'error', error: info.message, errorKind: info.kind });
      } else {
        // Below the threshold the section keeps saying whatever it said before.
        // Showing "error" for something we are about to retry in 30 seconds is
        // just flicker with a red badge on it.
        logger?.info?.('[autoUpdate] absorbed, retrying', info.kind);
      }
      if (hard) return;

      const delay = RETRY_DELAYS_MS[Math.min(consecutiveFailures - 1, RETRY_DELAYS_MS.length - 1)];
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => recheck('retry ' + consecutiveFailures, { force: true }), delay);
    });

    // checkForUpdatesAndNotify shows a native "update ready" notification.
    autoUpdater.checkForUpdatesAndNotify().catch((err) =>
      logger?.warn?.('[autoUpdate] initial check failed', err?.message || err),
    );

    // ── How soon a new version is noticed ──
    // This is an always-on launcher: it is normal for it to run untouched for
    // days, so the poll interval IS the latency on every release. Six hours
    // meant a fix could sit published and unseen for most of a day. A check is
    // one conditional GET of a few hundred bytes of YAML on a CDN, so the old
    // interval was not buying anything worth that delay.
    const CHECK_INTERVAL_MS = 30 * 60 * 1000;

    // eslint-disable-next-line no-func-assign
    // Unlocking the screen triggers a check, and locking and unlocking again is
    // something people do many times an hour — without a floor that is a burst
    // of requests at the CDN for an answer that cannot have changed since the
    // last one a minute ago. The retry ladder and the user's own button are
    // exempt: those are deliberate, and a retry that a floor swallowed would
    // stop the ladder dead.
    const MIN_CHECK_GAP_MS = 5 * 60 * 1000;
    // Seeded with now, not 0: the initial checkForUpdatesAndNotify() a few lines
    // above has just gone out, so an unlock in the first minutes of a session
    // would otherwise repeat it for nothing.
    let lastCheckAt = Date.now();

    recheck = function recheck(why, { force = false } = {}) {
      // Nothing to look for once a build is already downloaded and waiting.
      if (state.status === 'downloading' || state.status === 'downloaded') return;
      const now = Date.now();
      if (!force && now - lastCheckAt < MIN_CHECK_GAP_MS) {
        logger?.info?.('[autoUpdate] skipped, checked recently', why);
        return;
      }
      lastCheckAt = now;
      logger?.info?.('[autoUpdate] checking', why);
      // Rejections arrive through the 'error' event as well, which is where the
      // retry lives — swallowing here only stops an unhandled rejection.
      autoUpdater.checkForUpdates().catch(() => {});
    };

    setInterval(() => recheck('interval'), CHECK_INTERVAL_MS);

    // A timer alone is not enough. The two moments a machine is most likely to
    // be behind are the two a fixed interval handles worst: waking from sleep
    // (where the timer may not have advanced at all) and regaining a network
    // after being offline (where every check so far has failed). Both are cheap
    // to observe and both are answered immediately.
    try {
      // A few seconds of grace — the network adapter is rarely up at the instant
      // the OS says the machine resumed, and a check that fails is a check wasted.
      powerMonitor.on('resume', () => setTimeout(() => recheck('resume'), 8000));
      powerMonitor.on('unlock-screen', () => setTimeout(() => recheck('unlock'), 4000));
    } catch (e) {
      logger?.warn?.('[autoUpdate] power events unavailable', e?.message || e);
    }
  } catch (e) {
    setState({ status: 'error', error: 'Updater init failed.' });
    logger?.warn?.('[autoUpdate] init failed', e);
  }
}

module.exports = { initAutoUpdate };
