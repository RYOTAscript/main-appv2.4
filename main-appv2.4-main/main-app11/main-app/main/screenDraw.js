// Draw on Screen mini widget — draw over the screen from a hotkey, either LIVE
// (a see-through layer over whatever is running, which keeps moving underneath)
// or on a FROZEN frame (a screenshot taken the moment the hotkey is pressed, so
// the picture holds still while you mark it up).
//
// One overlay at a time, on the display the pointer is on: a frameless,
// transparent, always-on-top window covering that display (screen-draw.html,
// its own narrow screen-draw-preload.js). Frozen or live is only whether the
// page paints the screenshot behind the ink, so switching is instant and the
// drawing survives it. Live mode can also let clicks through to the apps
// underneath while the drawing stays on screen.
//
// Lessons kept from main/areaSelect.js, which covers screens the same way:
// `fullscreen: true` is the only way to cover a scaled display exactly (sized
// by hand it comes out a few pixels off), `resizable` must stay true or
// Windows silently ignores fullscreen, and Escape is handled in the browser
// process so no page error can strand anyone behind a frozen screenshot.
//
// Storage (userData): screen-draw.json, written atomically. Saved drawings go
// to Pictures/main drawings.

const { app, ipcMain, BrowserWindow, screen, globalShortcut, desktopCapturer, clipboard, nativeImage, shell, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lockNavigation } = require('./windowGuard');
const { isMac } = require('./platform');
const E = require('../renderer/draw-engine');

// The longest a data URL from the overlay may be (a 4K PNG is ~20 MB).
const MAX_IMAGE_CHARS = 80 * 1024 * 1024;
const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// The overlay's look and settings it may change; the hotkeys and the on/off
// switch only change from the launcher's panel.
const OVERLAY_PREF_KEYS = ['tool', 'color', 'width', 'barX', 'barEdge'];
// The window shows once the page has painted (frozen frame and all); this long
// at most if it never says so.
const SHOW_FALLBACK_MS = 700;
// Hidden for a screenshot: how long the compositor gets to actually take it
// off the screen first.
const HIDE_FOR_CAPTURE_MS = 140;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function init(ctx) {
  const { logger, appRoot } = ctx;
  const STORE_PATH = path.join(ctx.userDataPath, 'screen-draw.json');

  let prefs = E.sanitizePrefs(readJson(STORE_PATH));
  let saveTimer = null;
  let win = null;
  let session = null;      // { mode, display, image, passThrough, shown }
  let opening = false;
  let showTimer = null;
  let lastSaved = null;    // path of the last saved drawing, for "Show in folder"
  const bound = { hotkey: null, hotkeyAlt: null };

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger.warn('Draw on Screen: unreadable screen-draw.json, starting fresh', { error: e.message });
      return null;
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      const tmp = path.join(path.dirname(STORE_PATH), '.' + path.basename(STORE_PATH) + '.tmp-' + crypto.randomBytes(4).toString('hex'));
      fs.writeFileSync(tmp, JSON.stringify(prefs), 'utf8');
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) {
      logger.error('Draw on Screen: failed to save screen-draw.json', e);
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  function publicPrefs(extra) {
    return Object.assign({
      enabled: prefs.enabled, hotkey: prefs.hotkey, hotkeyAlt: prefs.hotkeyAlt, mode: prefs.mode,
      open: !!(win && !win.isDestroyed()), freezeAvailable: freezeAvailable()
    }, extra || {});
  }

  function sendMain(channel, data) {
    const w = ctx.getMainWindow && ctx.getMainWindow();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, data); } catch (e) { /* window going away */ }
    }
  }

  // ── Screen capture ──────────────────────────────────────────────────────

  // macOS only hands screen pixels over once Screen Recording is allowed;
  // without it a frozen frame would be just the wallpaper.
  function freezeAvailable() {
    if (!isMac) return true;
    try {
      return systemPreferences.getMediaAccessStatus('screen') === 'granted';
    } catch (e) {
      return false;
    }
  }

  // One display at its true pixel size (thumbnailSize is a bounding box, so
  // anything else would resample the picture). Same as main/areaSelect.js.
  async function captureDisplay(display) {
    const sf = display.scaleFactor || 1;
    const width = Math.max(1, Math.round(display.size.width * sf));
    const height = Math.max(1, Math.round(display.size.height * sf));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    if (!sources.length) return null;
    const match = sources.find((s) => String(s.display_id) === String(display.id));
    const src = match || sources[0];
    if (!src.thumbnail || src.thumbnail.isEmpty()) return null;
    return src.thumbnail;
  }

  // The screen as it is with the overlay taken off it for a moment.
  async function captureUnder() {
    if (!session) return null;
    const w = win;
    try { if (w && !w.isDestroyed()) w.setOpacity(0); } catch (e) { /* closing */ }
    await new Promise((r) => setTimeout(r, HIDE_FOR_CAPTURE_MS));
    let shot = null;
    try {
      shot = await captureDisplay(session.display);
    } catch (e) {
      logger.error('Draw on Screen: screen capture failed', e);
    }
    try { if (w && !w.isDestroyed()) w.setOpacity(1); } catch (e) { /* closing */ }
    return shot;
  }

  // ── The overlay ─────────────────────────────────────────────────────────

  async function open(mode) {
    if (opening) return publicPrefs();
    // The hotkey again: back to drawing from click-through, or put it away.
    if (win && !win.isDestroyed()) {
      if (session && session.passThrough) setPassThrough(false);
      else close();
      return publicPrefs();
    }
    opening = true;
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      let want = E.MODES.includes(mode) ? mode : prefs.mode;
      let image = null;
      let note = '';
      if (want === 'freeze') {
        if (!freezeAvailable()) {
          want = 'live';
          note = 'mac-permission';
        } else {
          try {
            const shot = await captureDisplay(display);
            image = shot ? shot.toDataURL() : null;
          } catch (e) {
            logger.error('Draw on Screen: screen capture failed', e);
          }
          if (!image) { want = 'live'; note = 'capture-failed'; }
        }
      }
      session = { mode: want, display, image, passThrough: false, shown: false, note };
      createWindow(display);
    } finally {
      opening = false;
    }
    sendMain('screen-draw:changed', publicPrefs());
    return publicPrefs();
  }

  function createWindow(display) {
    const b = display.bounds;
    const w = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      // Windows: the only exact cover of a (scaled) display. macOS would turn
      // fullscreen into its own Space with an animation, so it gets the
      // display's bounds instead.
      fullscreen: !isMac,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      title: 'Draw on Screen',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: !app.isPackaged,
        // It must keep drawing while another window has focus (click-through).
        backgroundThrottling: false,
        preload: path.join(appRoot, 'screen-draw-preload.js')
      }
    });
    win = w;
    lockNavigation(w, logger);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Escape closes it from the browser process, before the page sees it —
    // a page that broke can't trap anyone behind a frozen screenshot.
    w.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    // A transparent window whose page fails to load still OPENS — as an
    // invisible sheet over the whole screen eating every click.
    w.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Draw on Screen: overlay page failed to load', null, { code, desc });
      close();
    });
    w.webContents.on('render-process-gone', (_e, details) => {
      logger.error('Draw on Screen: overlay renderer gone', null, details || {});
      close();
    });
    w.on('closed', () => {
      if (win !== w) return;
      const restore = !!(session && session.restoreMain);
      win = null;
      session = null;
      if (restore) restoreMainWindow();
      clearTimeout(showTimer);
      sendMain('screen-draw:changed', publicPrefs());
    });
    w.loadFile(path.join(appRoot, 'screen-draw.html')).catch((e) => {
      logger.error('Draw on Screen: failed to load the overlay page', e);
    });
    // Never left invisible if the page misses its cue.
    showTimer = setTimeout(reveal, SHOW_FALLBACK_MS + 800);
  }

  function reveal() {
    clearTimeout(showTimer);
    showTimer = null;
    if (!win || win.isDestroyed() || !session || session.shown) return;
    session.shown = true;
    if (isMac) win.setBounds(session.display.bounds);
    win.show();
    try { win.focus(); } catch (e) { /* ignore */ }
  }

  function close() {
    clearTimeout(showTimer);
    showTimer = null;
    const w = win;
    const restore = !!(session && session.restoreMain);
    win = null;
    session = null;
    if (w && !w.isDestroyed()) w.destroy();
    if (restore) restoreMainWindow();
    sendMain('screen-draw:changed', publicPrefs());
  }

  function restoreMainWindow() {
    const mw = ctx.getMainWindow && ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try { mw.show(); mw.focus(); } catch (e) { /* ignore */ }
    }
  }

  // Live mode only: clicks go through to the apps underneath while the
  // drawing stays up. The toolbar still works — the page asks for the mouse
  // back while the pointer is over it (setHoverUi).
  function setPassThrough(on) {
    if (!win || win.isDestroyed() || !session) return;
    const through = !!on && session.mode === 'live';
    session.passThrough = through;
    try {
      win.setIgnoreMouseEvents(through, through ? { forward: true } : undefined);
      if (!through) win.focus();
    } catch (e) {
      logger.warn('Draw on Screen: could not change click-through', { error: e && e.message });
    }
    try { win.webContents.send('screen-draw:state', { passThrough: through }); } catch (e) { /* closing */ }
  }

  function setHoverUi(over) {
    if (!win || win.isDestroyed() || !session || !session.passThrough) return;
    try { win.setIgnoreMouseEvents(!over, over ? undefined : { forward: true }); } catch (e) { /* closing */ }
  }

  // ── Saving ──────────────────────────────────────────────────────────────

  function imageFrom(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_CHARS || !PNG_URL.test(dataUrl)) return null;
    const img = nativeImage.createFromDataURL(dataUrl);
    return img.isEmpty() ? null : img;
  }

  // A frozen drawing comes from the page (the frame plus the ink); a live one
  // is the screen itself, overlay and all, captured here.
  async function picture(payload) {
    if (payload && payload.live) {
      if (!session) return null;
      try {
        return await captureDisplay(session.display);
      } catch (e) {
        logger.error('Draw on Screen: capture for saving failed', e);
        return null;
      }
    }
    return imageFrom(payload && payload.image);
  }

  async function saveDrawing(payload) {
    const img = await picture(payload);
    if (!img) return { ok: false, error: 'Nothing to save' };
    try {
      const dir = path.join(app.getPath('pictures'), 'main drawings');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Drawing ${stamp(new Date())}.png`);
      fs.writeFileSync(file, img.toPNG());
      lastSaved = file;
      return { ok: true, name: path.basename(file) };
    } catch (e) {
      logger.error('Draw on Screen: could not save the drawing', e);
      return { ok: false, error: 'Could not save' };
    }
  }

  async function copyDrawing(payload) {
    const img = await picture(payload);
    if (!img) return { ok: false, error: 'Nothing to copy' };
    try {
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e) {
      logger.error('Draw on Screen: could not copy the drawing', e);
      return { ok: false, error: 'Could not copy' };
    }
  }

  // ── Hotkeys ─────────────────────────────────────────────────────────────

  function unregisterHotkeys() {
    for (const key of Object.keys(bound)) {
      if (bound[key]) {
        try { globalShortcut.unregister(bound[key]); } catch (e) { /* ignore */ }
        bound[key] = null;
      }
    }
  }

  // Returns which bindings failed (taken by another app, or invalid).
  function registerHotkeys() {
    unregisterHotkeys();
    const failed = [];
    if (!prefs.enabled) return failed;
    const want = {
      hotkey: [prefs.hotkey, () => open(prefs.mode)],
      hotkeyAlt: [prefs.hotkeyAlt, () => open(E.otherMode(prefs.mode))]
    };
    for (const key of Object.keys(want)) {
      const [accel, fn] = want[key];
      if (!accel) continue;
      let ok = false;
      try { ok = globalShortcut.register(accel, fn); } catch (e) { ok = false; }
      if (ok) bound[key] = accel;
      else {
        failed.push(key);
        logger.warn('Draw on Screen: hotkey registration failed', { key, accelerator: accel });
      }
    }
    return failed;
  }

  // ── Settings ────────────────────────────────────────────────────────────

  function setEnabled(on) {
    const enabled = !!on;
    if (prefs.enabled !== enabled) {
      prefs = Object.assign({}, prefs, { enabled });
      saveSoon();
    }
    if (!enabled) close();
    const failed = registerHotkeys();
    return publicPrefs({ failed });
  }

  function setPrefs(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = {};
    for (const k of ['hotkey', 'hotkeyAlt', 'mode']) if (k in p) next[k] = p[k];
    prefs = E.sanitizePrefs(Object.assign({}, prefs, next));
    saveSoon();
    const failed = registerHotkeys();
    sendMain('screen-draw:changed', publicPrefs());
    return publicPrefs({ failed });
  }

  // ── IPC: the launcher's panel ───────────────────────────────────────────

  function handle(channel, fn) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        logger.error(`Draw on Screen: ${channel} failed`, e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('screen-draw:get', () => publicPrefs());
  handle('screen-draw:set-enabled', (on) => setEnabled(on));
  handle('screen-draw:set-prefs', (patch) => setPrefs(patch));
  // From the panel: the launcher steps aside first, so it isn't what gets drawn
  // on (or frozen), and comes back when the drawing is put away.
  handle('screen-draw:open', async (mode) => {
    if (!prefs.enabled) return publicPrefs();
    const mw = ctx.getMainWindow && ctx.getMainWindow();
    let hid = false;
    if (mw && !mw.isDestroyed() && mw.isVisible() && !(win && !win.isDestroyed())) {
      try { mw.hide(); hid = true; } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 220));
    }
    const result = await open(mode);
    if (session) session.restoreMain = hid;
    else if (hid) restoreMainWindow();
    return result;
  });

  // ── IPC: the overlay ────────────────────────────────────────────────────
  // Anything not sent by the live overlay itself is ignored.

  function fromOverlay(event) {
    const w = BrowserWindow.fromWebContents(event.sender);
    return !!(w && win && w === win && !w.isDestroyed());
  }

  ipcMain.removeHandler('screen-draw:ready');
  ipcMain.handle('screen-draw:ready', (event) => {
    if (!fromOverlay(event) || !session) return null;
    return {
      mode: session.mode,
      image: session.image,
      note: session.note,
      prefs: { tool: prefs.tool, color: prefs.color, width: prefs.width, barX: prefs.barX, barEdge: prefs.barEdge, hotkey: prefs.hotkey },
      freezeAvailable: freezeAvailable(),
      isMac
    };
  });
  ipcMain.removeAllListeners('screen-draw:painted');
  ipcMain.on('screen-draw:painted', (event) => { if (fromOverlay(event)) reveal(); });
  ipcMain.removeAllListeners('screen-draw:close');
  ipcMain.on('screen-draw:close', (event) => { if (fromOverlay(event)) close(); });
  ipcMain.removeAllListeners('screen-draw:prefs');
  ipcMain.on('screen-draw:prefs', (event, patch) => {
    if (!fromOverlay(event) || !patch || typeof patch !== 'object') return;
    const next = {};
    for (const k of OVERLAY_PREF_KEYS) if (k in patch) next[k] = patch[k];
    prefs = E.sanitizePrefs(Object.assign({}, prefs, next));
    saveSoon();
  });
  ipcMain.removeHandler('screen-draw:freeze');
  ipcMain.handle('screen-draw:freeze', async (event) => {
    if (!fromOverlay(event) || !session) return { ok: false };
    if (!freezeAvailable()) return { ok: false, note: 'mac-permission' };
    if (session.passThrough) setPassThrough(false);
    const shot = await captureUnder();
    if (!shot || !session) return { ok: false, note: 'capture-failed' };
    session.mode = 'freeze';
    session.image = shot.toDataURL();
    return { ok: true, image: session.image };
  });
  ipcMain.removeAllListeners('screen-draw:unfreeze');
  ipcMain.on('screen-draw:unfreeze', (event) => {
    if (!fromOverlay(event) || !session) return;
    session.mode = 'live';
    session.image = null;
  });
  ipcMain.removeAllListeners('screen-draw:pass-through');
  ipcMain.on('screen-draw:pass-through', (event, on) => { if (fromOverlay(event)) setPassThrough(!!on); });
  ipcMain.removeAllListeners('screen-draw:hover-ui');
  ipcMain.on('screen-draw:hover-ui', (event, over) => { if (fromOverlay(event)) setHoverUi(!!over); });
  ipcMain.removeHandler('screen-draw:save');
  ipcMain.handle('screen-draw:save', (event, payload) => (fromOverlay(event) ? saveDrawing(payload) : { ok: false }));
  ipcMain.removeHandler('screen-draw:copy');
  ipcMain.handle('screen-draw:copy', (event, payload) => (fromOverlay(event) ? copyDrawing(payload) : { ok: false }));
  ipcMain.removeAllListeners('screen-draw:reveal');
  ipcMain.on('screen-draw:reveal', (event) => {
    if (!fromOverlay(event) || !lastSaved) return;
    try { shell.showItemInFolder(lastSaved); } catch (e) { /* ignore */ }
  });

  // Boot: bind the hotkeys if the widget is on.
  registerHotkeys();

  return {
    reapplyHotkeys: () => registerHotkeys(),
    teardown: () => {
      unregisterHotkeys();
      close();
      saveNow();
    }
  };
}

module.exports = { init, OVERLAY_PREF_KEYS };
