const { ipcMain, dialog, screen, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Custom backgrounds live in %APPDATA%/main-launcher/backgrounds — same
// pattern as custom launcher icons (main/appLauncher.js): copied into
// userData so they survive app reinstalls/updates and never require write
// access to the install directory. The folder on disk is the source of
// truth for the user's background library; the renderer only stores WHICH
// file is currently selected (localStorage), so a deleted file simply
// falls back to a built-in preset instead of breaking anything.

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov']);

function mediaType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;
  const backgroundsFolder = path.join(userDataPath, 'backgrounds');

  function listBackgrounds() {
    try {
      if (!fs.existsSync(backgroundsFolder)) return [];
      return fs.readdirSync(backgroundsFolder)
        .map((file) => {
          const type = mediaType(file);
          if (!type) return null;
          let mtime = 0;
          try { mtime = fs.statSync(path.join(backgroundsFolder, file)).mtimeMs; } catch (e) { /* keep 0 */ }
          return { file, type, mtime };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      logger.error('Failed to list custom backgrounds', e);
      return [];
    }
  }

  ipcMain.handle('background-select', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Choose a background',
      properties: ['openFile'],
      filters: [
        { name: 'Images & Videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm', 'm4v', 'mov'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] },
        { name: 'Videos', extensions: ['mp4', 'webm', 'm4v', 'mov'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;

    const src = result.filePaths[0];
    const type = mediaType(src);
    if (!type) {
      logger.warn('Background rejected — unsupported file type', { src });
      return { error: 'Unsupported file type' };
    }

    try {
      if (!fs.existsSync(backgroundsFolder)) fs.mkdirSync(backgroundsFolder, { recursive: true });
      // De-duplicate names so adding "wall.mp4" twice (from different folders)
      // doesn't silently overwrite the first one.
      const ext = path.extname(src);
      const base = path.basename(src, ext);
      let destName = base + ext;
      let counter = 2;
      while (fs.existsSync(path.join(backgroundsFolder, destName))) {
        destName = `${base}-${counter}${ext}`;
        counter += 1;
      }
      fs.copyFileSync(src, path.join(backgroundsFolder, destName));
      logger.success('Custom background saved', { file: destName, type });
      return { file: destName, type };
    } catch (e) {
      logger.error('Failed to save custom background', e, { src });
      return { error: 'Could not copy the file' };
    }
  });

  ipcMain.handle('background-list', () => listBackgrounds());

  // ── "Frosted transparent" support ──
  // Windows 10 has no supported API to blur the live desktop behind a window
  // (Electron's backgroundMaterial acrylic is Windows 11 only). The renderer
  // instead shows the user's wallpaper, screen-aligned behind the window, and
  // runs the blur/brightness/saturation filters on that — the standard fake-
  // acrylic technique. This handler supplies the wallpaper path plus the
  // window/display geometry needed to align it.
  function getWallpaperPath() {
    return new Promise((resolve) => {
      execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'],
        { windowsHide: true, timeout: 3000 }, (err, stdout) => {
          if (err) {
            logger.warn('Wallpaper registry lookup failed', err);
            resolve(null);
            return;
          }
          const m = /WallPaper\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(stdout || '');
          const p = m && m[1].trim();
          resolve(p && fs.existsSync(p) ? p : null);
        });
    });
  }

  ipcMain.handle('background-desktop-info', async () => {
    const win = getMainWindow();
    const bounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
    return {
      wallpaper: await getWallpaperPath(),
      display: display.bounds,
      window: { x: bounds.x, y: bounds.y }
    };
  });

  // ── Live blur (Transparent preset) ──
  // The compositor-level blur tried in v3.31/3.32 (SetWindowCompositionAttribute)
  // always paints across the window's full RECTANGLE — window regions don't
  // clip it on Electron's composited transparent windows — so its haze stuck
  // out past the app's rounded corners. Instead, the renderer now shows a
  // LIVE video stream of the screen behind the window (blurred with CSS, so
  // it's clipped by the card's own 32px rounded corners). Two things make
  // that possible here:
  //   1. desktopCapturer supplies the screen source id for getUserMedia.
  //   2. setContentProtection(true) excludes this window from the capture
  //      (WDA_EXCLUDEFROMCAPTURE), so the stream shows what's BEHIND the
  //      window rather than the window itself. Side effect while active:
  //      the app won't appear in screenshots or screen recordings.
  let liveCaptureOn = false;
  ipcMain.handle('background-live-capture', async (_event, enabled) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    try {
      if (!enabled) {
        if (liveCaptureOn) {
          win.setContentProtection(false);
          liveCaptureOn = false;
          logger.log('Live background capture stopped', 'INFO');
        }
        return { stopped: true };
      }
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!source) {
        logger.warn('Live background capture: no screen source found');
        return null;
      }
      if (!liveCaptureOn) {
        win.setContentProtection(true);
        liveCaptureOn = true;
        logger.log('Live background capture started', 'INFO');
      }
      return { sourceId: source.id, display: display.bounds, window: { x: bounds.x, y: bounds.y } };
    } catch (e) {
      logger.warn('Live background capture failed — renderer will use wallpaper frost', { error: e.message });
      if (liveCaptureOn) {
        try { win.setContentProtection(false); } catch (e2) { /* window closing */ }
        liveCaptureOn = false;
      }
      return null;
    }
  });

  // The PowerShell helper from the compositor-blur attempt is no longer
  // used — tidy it out of userData.
  for (const stale of ['blur-behind.ps1', 'blur-behind.ps1.version']) {
    try {
      const p = path.join(userDataPath, stale);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { /* best-effort cleanup */ }
  }

  // ── Auto theme on Transparent: what color is behind the window? ──
  // Captures a small thumbnail of the window's display and returns the
  // dominant color of the area around the window (padded outward so the
  // pixels BESIDE the window — pure desktop, not the app's own UI — carry
  // real weight). Weighted toward colorful, bright pixels the same way the
  // renderer samples custom media. Best-effort: any failure returns null
  // and the Auto theme keeps its static color.
  let sampleBehindFailLogged = false;
  ipcMain.handle('background-sample-behind', async () => {
    try {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return null;
      const bounds = win.getBounds();
      const display = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
      const d = display.bounds;
      const thumbW = 320;
      const thumbH = Math.max(1, Math.round(d.height * (thumbW / d.width)));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: thumbW, height: thumbH } });
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!source || source.thumbnail.isEmpty()) return null;
      const img = source.thumbnail;
      const size = img.getSize();
      const sx = size.width / d.width;
      const sy = size.height / d.height;
      const pad = 80;
      const x0 = Math.max(0, Math.floor((bounds.x - d.x - pad) * sx));
      const y0 = Math.max(0, Math.floor((bounds.y - d.y - pad) * sy));
      const x1 = Math.min(size.width, Math.ceil((bounds.x - d.x + bounds.width + pad) * sx));
      const y1 = Math.min(size.height, Math.ceil((bounds.y - d.y + bounds.height + pad) * sy));
      if (x1 - x0 < 2 || y1 - y0 < 2) return null;
      const buf = img.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }).toBitmap(); // BGRA
      let r = 0, g = 0, b = 0, wSum = 0;
      for (let i = 0; i + 3 < buf.length; i += 4) {
        const pb = buf[i], pg = buf[i + 1], pr = buf[i + 2];
        const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
        const w = ((max - min) / 255) * (max / 255) + 0.02; // saturation × brightness
        r += pr * w; g += pg * w; b += pb * w; wSum += w;
      }
      if (!wSum) return null;
      const toHex = (v) => Math.max(0, Math.min(255, Math.round(v / wSum))).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (e) {
      if (!sampleBehindFailLogged) {
        sampleBehindFailLogged = true;
        logger.warn('Behind-window color sampling failed — Auto theme keeps its static color', { error: e.message });
      }
      return null;
    }
  });

  // Keep the renderer's wallpaper/live-capture alignment live while the
  // window is dragged.
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on('move', () => {
      if (mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      mainWindow.webContents.send('window-moved', { x: b.x, y: b.y });
    });
  }

  // Display geometry is NOT stable: games switch the resolution (e.g.
  // 1920×1080 fullscreen on a 3440×1440 ultrawide), monitors connect and
  // disconnect, scale factors change. The backdrop alignment (live capture /
  // wallpaper) is computed from display bounds, so it goes visibly wrong —
  // wrong scale, parts of the window uncovered — unless the renderer
  // re-syncs when that happens.
  const notifyDisplayChanged = () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('display-changed');
  };
  screen.on('display-metrics-changed', notifyDisplayChanged);
  screen.on('display-added', notifyDisplayChanged);
  screen.on('display-removed', notifyDisplayChanged);

  ipcMain.handle('background-delete', (_event, fileName) => {
    // The name comes from the renderer — resolve it and confirm it stays
    // inside the backgrounds folder so a crafted "../" name can't delete
    // anything else.
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || !mediaType(safeName)) return { success: false };
    const target = path.join(backgroundsFolder, safeName);
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      logger.log(`Custom background deleted: ${safeName}`, 'INFO');
      return { success: true };
    } catch (e) {
      logger.error('Failed to delete custom background', e, { file: safeName });
      return { success: false };
    }
  });

  return { listBackgrounds };
}

module.exports = { init };
