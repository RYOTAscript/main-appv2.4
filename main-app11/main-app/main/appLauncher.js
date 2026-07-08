const { ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

const MEDIA_SCRIPT_VERSION = 2;

// Icons the app ships with under its own install directory — these are never
// migrated to userData, since they're reinstalled/updated alongside the app
// itself, not user data.
const BUNDLED_ICON_NAMES = new Set([
  'main.ico', 'player.png', 'chrome.ico', 'discord.ico',
  'fps-optimizer.ico', 'siege.ico', 'spotify.ico', 'valorant.ico'
]);

function isSpotifyPath(fullPath) {
  return /spotify\.exe$/i.test(fullPath.replace(/\\/g, '/'));
}

function init(ctx) {
  const { logger, appRoot, userDataPath, getMainWindow } = ctx;

  const MEDIA_PLAY_SCRIPT = path.join(userDataPath, 'media-play.ps1');
  const userIconsFolder = path.join(userDataPath, 'icons');

  // Custom launcher icons used to be written into the app's own install
  // directory (appRoot/icons) — that needs write access to the install path
  // (a problem under e.g. Program Files) and gets wiped out on reinstall/
  // update, unlike everything else under %APPDATA%/main-launcher. Copy any
  // non-bundled icon found there into userData so it survives going forward.
  // The original is left in place (not moved) since existing pinned apps still
  // reference it by its old relative path and must keep resolving unchanged.
  function migrateLegacyIcons() {
    try {
      const legacyFolder = path.join(appRoot, 'icons');
      if (!fs.existsSync(legacyFolder)) return;
      const legacyFiles = fs.readdirSync(legacyFolder).filter(f => !BUNDLED_ICON_NAMES.has(f));
      if (!legacyFiles.length) return;
      if (!fs.existsSync(userIconsFolder)) fs.mkdirSync(userIconsFolder, { recursive: true });
      for (const file of legacyFiles) {
        const dest = path.join(userIconsFolder, file);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(legacyFolder, file), dest);
      }
      logger.log('Migrated legacy launcher icons to userData', 'INFO', { count: legacyFiles.length });
    } catch (e) {
      logger.error('Legacy icon migration failed', e);
    }
  }
  migrateLegacyIcons();

  function ensureMediaPlayScript() {
    ensureVersionedScript(
      MEDIA_PLAY_SCRIPT,
      MEDIA_SCRIPT_VERSION,
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static void Play() {
    const byte vk = 0xB0;
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
"@
$spotify = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($spotify) { [Win32]::SetForegroundWindow($spotify.MainWindowHandle) }
Start-Sleep -Milliseconds 300
[Win32]::Play()
`
    );
  }

  function triggerSpotifyAutoPlay(delayMs = 2800) {
    ensureMediaPlayScript();
    setTimeout(() => {
      runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${MEDIA_PLAY_SCRIPT}"`).then(({ ok, stderr }) => {
        if (!ok) logger.error('Spotify auto-play failed', new Error(stderr || 'unknown error'), { delayMs });
        else logger.success('Spotify auto-play media key sent', { delayMs });
      });
    }, delayMs);
  }

  ipcMain.handle('select-icon', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['ico', 'png', 'jpg', 'jpeg', 'webp'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;

    const src = result.filePaths[0];
    const destName = path.basename(src);
    if (!fs.existsSync(userIconsFolder)) fs.mkdirSync(userIconsFolder, { recursive: true });

    try {
      fs.copyFileSync(src, path.join(userIconsFolder, destName));
      logger.success('Icon saved', { file: destName });
      // Tagged so the renderer's getIconPath (renderer/ui-utils.js) knows to
      // load this from userData via a file:// URL rather than the app's own
      // install-directory icons/ folder.
      return `custom:${destName}`;
    } catch (error) {
      logger.error('Icon copy failed', error, { src });
      return null;
    }
  });

  ipcMain.handle('launch-app', async (_event, fullPath, options = {}) => {
    if (!fullPath || !fs.existsSync(fullPath)) {
      logger.error('Launch failed — file not found', null, { fullPath });
      return { success: false, error: 'File not found' };
    }

    const result = await shell.openPath(fullPath);
    if (result) {
      logger.error('Launch failed', null, { fullPath, result });
      return { success: false, error: result };
    }

    if (options.autoPlay && isSpotifyPath(fullPath)) {
      const delay = Number(options.autoPlayDelay) === 5000 ? 5000 : 2800;
      triggerSpotifyAutoPlay(delay);
    }

    logger.success('App launched', { fullPath, autoPlay: !!options.autoPlay });
    return { success: true };
  });
}

module.exports = { init };
