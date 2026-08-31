const { BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const { lockNavigation } = require('./windowGuard');

// ── Screen area / colour picker overlay ──
// Shared "select something on the screen" surface, used by the Auto Clicker to
// pick a click region and to eyedrop a target colour.
//
// The overlay is NOT a transparent click-through window like the crosshair: it
// takes a real screenshot of every display first and shows that frozen frame,
// then draws the selection UI on top. Freezing buys three things a live
// transparent overlay can't have:
//   • the magnifier/eyedropper can read exact pixels (the overlay itself would
//     otherwise be what any screen read sees),
//   • the picture can't shift under the user mid-drag,
//   • the scrim/highlight treatment can dim everything except the selection.
//
// One window per display (never a single window spanning them): a window that
// straddles two monitors with different DPI scaling renders at one scale and
// the coordinates drift. Per-display windows keep the mapping exact.
//
// Coordinates: the overlay reports CSS px relative to its own window, which is
// DIP relative to that display's origin. We add the display origin to get the
// app-wide DIP coordinates every Electron screen API speaks. Conversion to
// physical pixels (what SendInput / a screen capture need) happens later, in
// the consumer, via screen.dipToScreenPoint.

// A stuck picker hides the launcher, so the safety net has to be short: two
// minutes of a frozen-looking screen with no launcher reads as a crash.
const SELECT_TIMEOUT_MS = 30000;
// Grace period after showing before a blur is treated as "the user left".
// Showing the second display's window blurs the first, so early blurs are ours.
const BLUR_GRACE_MS = 800;

function init(ctx) {
  const { logger, appRoot, getMainWindow } = ctx;

  // { windows: [{ win, display }], settle, timer, restoreMain }
  let session = null;

  function closeSession(result) {
    if (!session) return;
    const s = session;
    session = null;
    clearTimeout(s.timer);
    for (const entry of s.windows) {
      try {
        if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
      } catch (e) { /* already gone */ }
    }
    if (s.restoreMain) {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        try { win.show(); win.focus(); } catch (e) { /* ignore */ }
      }
    }
    s.settle(result);
  }

  // Grab one display at its true pixel size. thumbnailSize is a bounding box and
  // every source in the call is scaled to it, so we ask once per display with
  // that display's own native size — anything else would resample the pixels the
  // eyedropper reads.
  async function captureDisplay(display) {
    const sf = display.scaleFactor || 1;
    const width = Math.max(1, Math.round(display.size.width * sf));
    const height = Math.max(1, Math.round(display.size.height * sf));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (!sources.length) return null;
    const match = sources.find((s) => String(s.display_id) === String(display.id));
    const src = match || sources[0];
    if (!src.thumbnail || src.thumbnail.isEmpty()) return null;
    return src.thumbnail.toDataURL();
  }

  ipcMain.on('area-select:result', (event, payload) => {
    if (!session) return;
    const entry = session.windows.find((w) => w.win && !w.win.isDestroyed() && w.win.webContents.id === event.sender.id);
    if (!entry) {
      // Dropping this silently would hang the picker until the timeout with the
      // launcher hidden — close out instead, and say so in the log.
      logger.warn('Area select: result from an unknown overlay window — cancelling', { senderId: event.sender.id });
      closeSession(null);
      return;
    }
    const b = entry.display.bounds;
    if (payload && payload.kind === 'color') {
      closeSession({ color: payload.color });
      return;
    }
    if (payload && payload.kind === 'point' && payload.point) {
      closeSession({
        point: {
          x: Math.round(b.x + payload.point.x),
          y: Math.round(b.y + payload.point.y)
        }
      });
      return;
    }
    if (payload && payload.kind === 'area' && payload.rect) {
      const r = payload.rect;
      closeSession({
        rect: {
          x: Math.round(b.x + r.x),
          y: Math.round(b.y + r.y),
          w: Math.max(1, Math.round(r.w)),
          h: Math.max(1, Math.round(r.h))
        }
      });
      return;
    }
    closeSession(null);
  });

  ipcMain.on('area-select:cancel', () => closeSession(null));

  /**
   * Opens the overlay and resolves with the user's pick.
   * @param {{ mode?: 'area'|'color'|'point', accent?: string, existingRect?: {x,y,w,h}|null,
   *           ghostLabel?: string }} opts
   * @returns {Promise<{rect?:object, color?:string, point?:object}|null>} null when cancelled.
   */
  async function select(opts) {
    const options = opts || {};
    const mode = ['color', 'point'].includes(options.mode) ? options.mode : 'area';
    closeSession(null); // only one picker at a time

    // The launcher would otherwise be baked into the frozen frame the user is
    // selecting on top of. Hide it first, and give the compositor a moment to
    // actually repaint what's underneath before the capture.
    const mainWin = getMainWindow();
    const restoreMain = !!(mainWin && !mainWin.isDestroyed() && mainWin.isVisible());
    if (restoreMain) {
      try { mainWin.hide(); } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 220));
    }

    let displays = [];
    try {
      displays = screen.getAllDisplays();
    } catch (e) {
      logger.error('Area select: could not enumerate displays', e);
    }
    if (!displays.length) {
      if (restoreMain && mainWin && !mainWin.isDestroyed()) mainWin.show();
      return null;
    }

    const shots = [];
    for (const display of displays) {
      let image = null;
      try {
        image = await captureDisplay(display);
      } catch (e) {
        logger.error('Area select: screen capture failed', e, { display: display.id });
      }
      shots.push({ display, image });
    }
    if (!shots.some((s) => s.image)) {
      if (restoreMain && mainWin && !mainWin.isDestroyed()) mainWin.show();
      logger.error('Area select: no display could be captured', null, {});
      return { error: 'capture-failed' };
    }

    return new Promise((settle) => {
      const windows = [];
      for (const shot of shots) {
        if (!shot.image) continue;
        const b = shot.display.bounds;
        const win = new BrowserWindow({
          // x/y put the window on the right monitor; `fullscreen` then makes it
          // cover that monitor EXACTLY. Sizing it by hand doesn't work: on a
          // scaled display (e.g. 150%) Chromium converts DIP→physical before it
          // knows which monitor the window landed on, so a 1280x800 request
          // becomes ~1284x753 and the overlay leaves live desktop showing at the
          // edges. Re-calling setBounds doesn't converge either — fullscreen is
          // the only reliable way to match a display 1:1.
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          fullscreen: true,
          frame: false,
          transparent: false,
          backgroundColor: '#000000',
          // MUST stay resizable. On Windows `resizable: false` silently defeats
          // fullscreen: isFullScreen() reports true but the window is left at
          // roughly the work-area size, and the full-screen screenshot then gets
          // squashed into it. The window is frameless and fullscreen, so there is
          // no edge to drag anyway — nothing is gained by locking it.
          resizable: true,
          movable: false,
          minimizable: false,
          maximizable: false,
          skipTaskbar: true,
          hasShadow: false,
          show: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(appRoot, 'area-select-overlay-preload.js')
          }
        });
        lockNavigation(win, logger);
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

        // Escape handled in the browser process, BEFORE the page sees it. The
        // page has its own Escape handler, but if its script ever fails to run
        // the user would be stranded on a full-screen frozen screenshot with the
        // launcher hidden — this path cannot be broken by page JS.
        win.webContents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') {
            event.preventDefault();
            logger.log('Area select cancelled with Escape', 'INFO');
            closeSession(null);
          }
        });

        // A page that never loads must not leave the launcher hidden.
        win.webContents.on('did-fail-load', (_e, code, desc) => {
          logger.error('Area select: overlay page failed to load', null, { code, desc });
          closeSession(null);
        });
        win.webContents.on('render-process-gone', (_e, details) => {
          logger.error('Area select: overlay renderer gone', null, details || {});
          closeSession(null);
        });
        win.on('closed', () => closeSession(null));

        // If the user alt-tabs away the overlay is just a frozen picture of their
        // screen — bail out rather than leaving that up with no launcher.
        win.on('blur', () => {
          if (!session || session.shownAt === 0 || Date.now() - session.shownAt < BLUR_GRACE_MS) return;
          const focused = BrowserWindow.getFocusedWindow();
          if (focused && session.windows.some((w) => w.win === focused)) return; // still ours
          logger.log('Area select cancelled — overlay lost focus', 'INFO');
          closeSession(null);
        });

        // Only the display that owns the existing selection should draw it.
        let existing = null;
        if (options.existingRect && Number.isFinite(options.existingRect.x)) {
          const r = options.existingRect;
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          if (cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height) {
            existing = { x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h };
          }
        }

        win.webContents.on('did-finish-load', () => {
          if (win.isDestroyed()) return;
          win.webContents.send('area-select:init', {
            mode,
            image: shot.image,
            width: b.width,
            height: b.height,
            scaleFactor: shot.display.scaleFactor || 1,
            accent: typeof options.accent === 'string' && options.accent ? options.accent : '255, 255, 255',
            existingRect: existing,
            ghostLabel: typeof options.ghostLabel === 'string' && options.ghostLabel ? options.ghostLabel : 'current area',
            displayLabel: shots.length > 1 ? `Display ${shots.indexOf(shot) + 1}` : ''
          });
          // Shown focused, not showInactive: the overlay handles Escape on its
          // own document, which needs keyboard focus. With several displays the
          // last one shown holds it — right-click cancels on any of them, so
          // there is always a way out.
          win.show();
          try { win.focus(); } catch (e) { /* ignore */ }
          if (session) session.shownAt = Date.now();
          logger.log('Area select overlay shown', 'INFO', {
            mode,
            display: shot.display.id,
            visible: win.isVisible(),
            focused: win.isFocused(),
            bounds: win.getBounds()
          });
        });

        win.loadFile(path.join(appRoot, 'area-select-overlay.html')).catch((e) => {
          logger.error('Area select: overlay failed to load', e);
        });

        windows.push({ win, display: shot.display });
      }

      if (!windows.length) {
        if (restoreMain && mainWin && !mainWin.isDestroyed()) mainWin.show();
        settle(null);
        return;
      }

      session = {
        windows,
        settle,
        restoreMain,
        shownAt: 0,
        timer: setTimeout(() => {
          logger.warn('Area select timed out — cancelled', { timeoutMs: SELECT_TIMEOUT_MS });
          closeSession(null);
        }, SELECT_TIMEOUT_MS)
      };
    });
  }

  return {
    select,
    teardown: () => closeSession(null)
  };
}

module.exports = { init };
