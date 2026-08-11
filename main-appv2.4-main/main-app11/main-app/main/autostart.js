const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

const MINIMIZE_SCRIPT_VERSION = 1;

// Launch-on-login (autostart) and its companion "minimize other windows on
// startup" option, plus the config files that back both.
function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  const CLOSE_WINDOWS_STARTUP_PATH = path.join(userDataPath, 'close-windows-startup.json');
  const AUTOSTART_CONFIG_PATH = path.join(userDataPath, 'autostart-config.json');
  const MINIMIZE_WINDOWS_SCRIPT = path.join(userDataPath, 'minimize-windows.ps1');
  const STARTUP_MINIMIZE_STATE_PATH = path.join(userDataPath, 'startup-minimize-state.json');

  // System boot time (ms since epoch). Stable across app launches within the same
  // boot session — Date.now() and os.uptime() advance together, so their
  // difference stays ~constant until the next reboot — so it identifies "this boot".
  function getSystemBootTime() {
    return Date.now() - Math.round(os.uptime() * 1000);
  }

  // True only for the FIRST app launch after the PC booted. We persist the boot
  // time we last minimized for; a later (manual) launch in the same session lands
  // within tolerance of it and is skipped — so opening the app mid-session never
  // yanks all your other windows away. Only a fresh login/boot does.
  function isFirstLaunchSinceBoot() {
    const currentBoot = getSystemBootTime();
    let lastBoot = null;
    try {
      if (fs.existsSync(STARTUP_MINIMIZE_STATE_PATH)) {
        lastBoot = JSON.parse(fs.readFileSync(STARTUP_MINIMIZE_STATE_PATH, 'utf8')).bootTime;
      }
    } catch (e) {
      // Unreadable/corrupt → treat as a fresh boot so the feature still works.
    }
    const SAME_BOOT_TOLERANCE_MS = 60 * 1000; // absorb uptime jitter between launches
    return !(typeof lastBoot === 'number' && Math.abs(currentBoot - lastBoot) < SAME_BOOT_TOLERANCE_MS);
  }

  function recordStartupMinimizeDone() {
    try {
      fs.writeFileSync(STARTUP_MINIMIZE_STATE_PATH, JSON.stringify({ bootTime: getSystemBootTime() }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to record startup-minimize state', e);
    }
  }

  function getCloseWindowsStartup() {
    try {
      if (fs.existsSync(CLOSE_WINDOWS_STARTUP_PATH)) {
        return JSON.parse(fs.readFileSync(CLOSE_WINDOWS_STARTUP_PATH, 'utf8')).enabled === true;
      }
    } catch (e) {
      logger.error('Failed to read close-windows-startup config', e);
    }
    return false;
  }

  // Builds the exact { path, args } we register with the OS when autostart is enabled.
  // On Windows, getLoginItemSettings() only reports openAtLogin: true when queried with
  // the SAME path AND args that setLoginItemSettings() used — so apply and detect MUST
  // share this, otherwise the OS check always comes back false. This mismatch was the
  // original bug: registration used args ['--startup'] but the query passed no args.
  function getAutoStartLaunchOptions() {
    const exePath = app.getPath('exe');
    const args = [];
    const isDevElectron = /electron(?:\.exe)?$/i.test(path.basename(exePath));
    if (!app.isPackaged && isDevElectron) {
      args.push(app.getAppPath());
    }
    args.push('--startup');
    return { path: exePath, args };
  }

  // Our own record of whether the user wants autostart on, independent of whatever
  // the OS currently has registered. app.setLoginItemSettings() registers with the OS
  // (Windows Registry Run key / macOS Login Items / Linux autostart entry), which is
  // normally durable on its own — but that registration can still be lost without the
  // app's involvement (e.g. the install path changes after an update, or some other
  // startup-manager/cleanup tool clears it). Keeping our own config means the app can
  // re-assert the OS registration on every launch instead of just trusting it stuck.
  function getAutoStartConfig() {
    try {
      if (fs.existsSync(AUTOSTART_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(AUTOSTART_CONFIG_PATH, 'utf8')).enabled === true;
      }
    } catch (e) {
      logger.error('Failed to read autostart config', e);
    }
    // No config yet (first run after this update, or a fresh install) — fall back to
    // whatever the OS currently has registered instead of assuming "off". Otherwise a
    // user who already had autostart enabled under the old code (which never wrote
    // this file) would have it silently disabled the next time the app launches.
    // Query with the same path/args we register with so the OS match succeeds.
    try {
      return app.getLoginItemSettings(getAutoStartLaunchOptions()).openAtLogin;
    } catch (e) {
      return false;
    }
  }

  function saveAutoStartConfig(enabled) {
    try {
      fs.writeFileSync(AUTOSTART_CONFIG_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save autostart config', e);
    }
  }

  // Actually registers (or unregisters) with the OS. Safe to call repeatedly with the
  // same value — used both when the user toggles the setting and on every app startup
  // to re-assert it from the saved config.
  function applyAutoStartSetting(enabled) {
    try {
      const options = { openAtLogin: enabled, ...getAutoStartLaunchOptions() };
      app.setLoginItemSettings(options);
      logger.success('Auto start applied', { enabled, options });
      return true;
    } catch (e) {
      logger.error('applyAutoStartSetting failed', e, { enabled });
      return false;
    }
  }

  function ensureMinimizeWindowsScript() {
    ensureVersionedScript(
      MINIMIZE_WINDOWS_SCRIPT,
      MINIMIZE_SCRIPT_VERSION,
      `(New-Object -ComObject Shell.Application).MinimizeAll()`
    );
  }

  async function minimizeOtherWindowsOnStartup() {
    ensureMinimizeWindowsScript();
    try {
      setTimeout(() => {
        runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${MINIMIZE_WINDOWS_SCRIPT}"`).then(({ ok, stderr }) => {
          if (!ok) {
            logger.error('Minimize windows on startup failed', new Error(stderr || 'unknown error'));
            return;
          }
          logger.success('Minimized other windows on startup');
          setTimeout(() => {
            const mainWindow = getMainWindow();
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
              logger.success('Main window focused after startup minimization');
            }
          }, 300);
        });
      }, 3000);
    } catch (e) {
      logger.error('Minimize windows on startup failed', e);
    }
  }

  // For a short window right after a boot launch, keep main raised above other
  // windows so late-starting startup apps (VPNs, updaters, chat clients) don't
  // pop in front of it. Temporarily set always-on-top + moveTop WITHOUT stealing
  // keyboard focus, then release it so main behaves like a normal window (and
  // won't float over games) once the boot settles.
  function keepMainInFrontAfterBoot() {
    const DURATION_MS = 14000;
    const start = Date.now();
    const tick = setInterval(() => {
      const w = getMainWindow();
      if (!w || w.isDestroyed()) { clearInterval(tick); return; }
      try {
        if (!w.isVisible()) w.show();
        w.setAlwaysOnTop(true, 'screen-saver');
        w.moveTop();
      } catch (e) { /* ignore */ }
      if (Date.now() - start > DURATION_MS) {
        clearInterval(tick);
        try { w.setAlwaysOnTop(false); } catch (e) { /* ignore */ }
        logger.success('Boot settle complete — main released from always-on-top');
      }
    }, 1200);
  }

  ipcMain.handle('get-close-windows-startup', () => getCloseWindowsStartup());

  ipcMain.handle('set-close-windows-startup', (_event, enabled) => {
    try {
      fs.writeFileSync(CLOSE_WINDOWS_STARTUP_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf8');
      logger.success('Close windows on startup updated', { enabled: !!enabled });
      return true;
    } catch (e) {
      logger.error('set-close-windows-startup failed', e);
      return false;
    }
  });

  // Report our own persisted intent, not a live OS query — see getAutoStartConfig
  // above for why. Re-asserted against the OS on every launch (below).
  ipcMain.handle('get-autostart', () => getAutoStartConfig());

  ipcMain.handle('set-autostart', (_event, enabled) => {
    saveAutoStartConfig(!!enabled);
    const success = applyAutoStartSetting(!!enabled);
    return { success };
  });

  // Minimize other windows ONLY on the first launch after a PC boot — i.e. when
  // the app auto-starts as you log into Windows — so main comes up alone, centered
  // on a clear desktop. It must NOT fire when you open the app manually later in
  // the same session (that would rudely minimize whatever you were doing).
  //   • requires autostart + "minimize on startup" both enabled, and
  //   • isFirstLaunchSinceBoot() — a persisted boot-time check (the old
  //     process.argv '--startup' signal was unreliable via the Windows Run key,
  //     and a plain per-process flag can't tell a boot launch from a manual one).
  // The session flag still guards against an in-process reload re-triggering it.
  if (
    !app.isSessionStartupMinimizeDone &&
    getAutoStartConfig() &&
    isFirstLaunchSinceBoot()
  ) {
    app.isSessionStartupMinimizeDone = true;
    recordStartupMinimizeDone();
    // Clear the desktop only if the user enabled that option…
    if (getCloseWindowsStartup()) {
      minimizeOtherWindowsOnStartup();
    }
    // …but always keep main above other startup apps as they launch.
    keepMainInFrontAfterBoot();
  }

  // Re-assert autostart registration every launch from our own saved config, rather
  // than just trusting whatever the OS currently has — see applyAutoStartSetting/
  // getAutoStartConfig above for why this matters. getAutoStartConfig() falls back to
  // (and this then persists) the live OS state on the very first run after this
  // update, so existing users' prior choice carries over instead of being reset.
  const desiredAutoStart = getAutoStartConfig();
  saveAutoStartConfig(desiredAutoStart);
  applyAutoStartSetting(desiredAutoStart);
}

module.exports = { init };
