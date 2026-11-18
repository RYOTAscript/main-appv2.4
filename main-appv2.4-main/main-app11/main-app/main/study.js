// Study mini widget — main-process owner of the formula sheets, the floating
// always-on-top formula overlays and their global hotkeys.
//
// Same split as the Timers: renderer/study-engine.js holds every rule (what a
// sheet may contain, the shorthand → LaTeX converter, window geometry) and is
// shared with the panel and the overlays; this file stores the sheets and runs
// the windows; renderer/study.js is only UI.
//
// Floating sheets: one small frameless, transparent, always-on-top window per
// popped-out sheet (study-float.html). Each has its OWN narrow preload
// (study-float-preload.js) — never the app preload — and main works out which
// sheet a message is about from the sending window, so an overlay can only ever
// read its own sheet and change its own look; editing a sheet's content is
// only reachable from the launcher's panel. Position, size, style, text size,
// opacity and click-through are remembered per sheet, and overlays reopen
// where they were on the next launch. Resizing is a grip in the page (a
// frameless transparent window has no native resize border on Windows), which
// asks main for a size; main clamps it to the screen.
//
// Storage (userData): study.json, written atomically (temp file + rename).

const { ipcMain, BrowserWindow, Menu, screen, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lockNavigation } = require('./windowGuard');
const E = require('../renderer/study-engine');

const EXPORT_FORMAT = 'main-study-sheets';
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
// What an overlay may change about ITSELF. Content edits never come from one.
const FLOAT_PREF_KEYS = ['style', 'scale', 'opacity', 'ghost', 'labels', 'notes'];

function init(ctx) {
  const { logger, appRoot } = ctx;
  const STORE_PATH = path.join(ctx.userDataPath, 'study.json');

  let store = E.sanitizeStore(readJson(STORE_PATH), Date.now(), Math.random());
  let saveTimer = null;
  let tornDown = false;
  // Hidden with the show/hide hotkey: the windows stay alive, just not shown.
  let overlaysHidden = false;
  const floats = new Map(); // sheetId -> BrowserWindow
  const moveSaveTimers = new Map();
  const resizing = new Map(); // sheetId -> bounds at the start of a grip drag
  const boundHotkeys = { toggle: null, ghost: null };

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger.warn('Study: unreadable study.json, starting fresh', { error: e.message });
      // Keep the damaged file for recovery instead of overwriting it.
      try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch (err) { /* best effort */ }
      return null;
    }
  }

  function writeAtomic(file, data) {
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      writeAtomic(STORE_PATH, JSON.stringify(store));
    } catch (e) {
      logger.error('Study: failed to save study.json', e);
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  // ── State out ───────────────────────────────────────────────────────────

  function publicState() {
    return {
      enabled: store.enabled,
      sheets: store.sheets,
      floats: store.floats,
      openFloats: [...floats.keys()],
      hidden: overlaysHidden && floats.size > 0,
      settings: store.settings,
      focusId: store.focusId
    };
  }

  function sendMain(channel, payload) {
    const win = ctx.getMainWindow && ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) { /* window going away */ }
    }
  }

  function findSheet(id) { return store.sheets.find(s => s.id === id) || null; }
  function findIndex(id) { return store.sheets.findIndex(s => s.id === id); }

  function floatPrefs(id) {
    return store.floats[id] || E.sanitizeFloat(null, store.settings);
  }

  function setFloatRecord(id, rec) {
    store = Object.assign({}, store, { floats: Object.assign({}, store.floats, { [id]: rec }) });
  }

  function floatPayload(id) {
    const sheet = findSheet(id);
    if (!sheet) return null;
    const p = floatPrefs(id);
    return {
      sheet,
      prefs: { style: p.style, scale: p.scale, opacity: p.opacity, ghost: p.ghost, labels: p.labels, notes: p.notes }
    };
  }

  function sendFloat(id, channel, payload) {
    const win = floats.get(id);
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) { /* window going away */ }
    }
  }

  function broadcast() {
    sendMain('study:changed', publicState());
    for (const id of floats.keys()) sendFloat(id, 'study-float:state', floatPayload(id));
  }

  function commit() {
    saveSoon();
    broadcast();
  }

  const mintRow = () => E.newId('r', Date.now(), Math.random());

  // ── Sheets ──────────────────────────────────────────────────────────────

  function create(opts) {
    if (store.sheets.length >= E.MAX_SHEETS) return { ok: false, error: `You can keep up to ${E.MAX_SHEETS} sheets — delete one first` };
    const o = opts && typeof opts === 'object' ? opts : {};
    const now = Date.now();
    let sheet;
    if (o.starter) {
      sheet = E.sheetFromStarter(String(o.starter), now, Math.random());
      if (!sheet) return { ok: false, error: 'That starter set no longer exists' };
    } else {
      sheet = E.sanitizeSheet({
        id: E.newId('s', now, Math.random()),
        title: o.title || 'New sheet',
        subject: o.subject || 'Other',
        color: o.color || E.COLORS[store.sheets.length % E.COLORS.length],
        rows: Array.isArray(o.rows) ? o.rows : [],
        createdAt: now,
        updatedAt: now
      }, now, mintRow);
    }
    store = Object.assign({}, store, { sheets: store.sheets.concat(sheet), focusId: sheet.id });
    if (o.float) openFloat(sheet.id, { quiet: true });
    commit();
    return { ok: true, sheet };
  }

  function update(id, patch) {
    const i = findIndex(id);
    if (i < 0) return { ok: false, error: 'That sheet no longer exists' };
    if (!patch || typeof patch !== 'object') return { ok: false };
    const before = store.sheets[i];
    const next = Object.assign({}, before);
    if ('title' in patch) next.title = patch.title;
    if ('subject' in patch) next.subject = patch.subject;
    if ('color' in patch) next.color = E.cleanColor(patch.color, before.color);
    if ('rows' in patch && Array.isArray(patch.rows)) next.rows = patch.rows;
    next.updatedAt = Date.now();
    const sheet = E.sanitizeSheet(next, Date.now(), mintRow);
    if (!sheet) return { ok: false };
    // A copied starter that has been edited is the user's own sheet now.
    if ('rows' in patch) sheet.starter = '';
    const sheets = store.sheets.slice();
    sheets[i] = sheet;
    store = Object.assign({}, store, { sheets, focusId: id });
    commit();
    return { ok: true, sheet };
  }

  function duplicate(id) {
    const src = findSheet(id);
    if (!src) return { ok: false, error: 'That sheet no longer exists' };
    return create({
      title: E.cleanText(src.title + ' (copy)', E.MAX_TITLE),
      subject: src.subject,
      color: src.color,
      rows: src.rows.map(r => ({ kind: r.kind, label: r.label, src: r.src, note: r.note }))
    });
  }

  function remove(id) {
    if (findIndex(id) < 0) return { ok: false };
    closeFloat(id, { remember: false, quiet: true });
    const floatsNext = Object.assign({}, store.floats);
    delete floatsNext[id];
    store = Object.assign({}, store, {
      sheets: store.sheets.filter(s => s.id !== id),
      floats: floatsNext,
      focusId: store.focusId === id ? null : store.focusId
    });
    commit();
    return { ok: true };
  }

  function reorder(ids) {
    if (!Array.isArray(ids)) return { ok: false };
    const rank = new Map(ids.map((id, i) => [String(id), i]));
    const sheets = store.sheets.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
    store = Object.assign({}, store, { sheets });
    commit();
    return { ok: true };
  }

  function setSettings(patch) {
    const settings = E.mergeSettings(store.settings, patch);
    store = Object.assign({}, store, { settings });
    const hotkeys = registerHotkeys();
    // Overlays follow the new default look only where the user hasn't picked
    // one for that overlay — sanitizeFloat fills unset fields from settings.
    commit();
    return { ok: true, settings, hotkeys };
  }

  function setEnabled(enabled) {
    const on = !!enabled;
    const changed = on !== store.enabled;
    store = Object.assign({}, store, { enabled: on });
    if (on) {
      reopenRemembered();
      registerHotkeys();
    } else {
      // Remember which overlays were open, so switching back on restores them.
      for (const id of [...floats.keys()]) closeFloat(id, { remember: true, keepOpenFlag: true, quiet: true });
      unregisterHotkeys();
      overlaysHidden = false;
    }
    if (changed) saveNow();
    broadcast();
    return publicState();
  }

  function reopenRemembered() {
    for (const s of store.sheets) {
      if (store.floats[s.id] && store.floats[s.id].open) openFloat(s.id, { quiet: true });
    }
  }

  // ── Export / import ─────────────────────────────────────────────────────

  async function exportSheets(ids) {
    const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    const sheets = store.sheets.filter(s => !want || want.has(s.id));
    if (!sheets.length) return { ok: false, error: 'No sheets to export' };
    const owner = ctx.getMainWindow && ctx.getMainWindow();
    const name = sheets.length === 1 ? sheets[0].title.replace(/[^\w\- ]+/g, '').trim() || 'formula-sheet' : 'formula-sheets';
    const res = await dialog.showSaveDialog(owner && !owner.isDestroyed() ? owner : undefined, {
      title: 'Export formula sheets',
      defaultPath: name + '.json',
      filters: [{ name: 'Formula sheets', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const data = {
      format: EXPORT_FORMAT,
      version: E.STORE_VERSION,
      sheets: sheets.map(s => ({ title: s.title, subject: s.subject, color: s.color, rows: s.rows.map(r => ({ kind: r.kind, label: r.label, src: r.src, note: r.note })) }))
    };
    try {
      writeAtomic(res.filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error('Study: export failed', e);
      return { ok: false, error: 'Couldn’t write that file' };
    }
    return { ok: true, count: sheets.length };
  }

  async function importSheets() {
    const owner = ctx.getMainWindow && ctx.getMainWindow();
    const res = await dialog.showOpenDialog(owner && !owner.isDestroyed() ? owner : undefined, {
      title: 'Import formula sheets',
      properties: ['openFile'],
      filters: [{ name: 'Formula sheets', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    let data;
    try {
      const stat = fs.statSync(res.filePaths[0]);
      if (stat.size > MAX_IMPORT_BYTES) return { ok: false, error: 'That file is too big to be a formula sheet' };
      data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    } catch (e) {
      return { ok: false, error: 'That isn’t a formula sheet file' };
    }
    const list = data && data.format === EXPORT_FORMAT && Array.isArray(data.sheets) ? data.sheets : null;
    if (!list) return { ok: false, error: 'That isn’t a formula sheet file' };
    const room = E.MAX_SHEETS - store.sheets.length;
    if (room <= 0) return { ok: false, error: `You can keep up to ${E.MAX_SHEETS} sheets — delete one first` };
    const now = Date.now();
    const added = [];
    for (const raw of list.slice(0, room)) {
      // Fresh ids for everything: an import can never collide with, or
      // overwrite, a sheet that already exists.
      const sheet = E.sanitizeSheet(Object.assign({}, raw, {
        id: E.newId('s', now, Math.random()),
        rows: Array.isArray(raw && raw.rows) ? raw.rows.map(r => Object.assign({}, r, { id: '' })) : [],
        starter: '',
        createdAt: now,
        updatedAt: now
      }), now, mintRow);
      if (sheet) added.push(sheet);
    }
    if (!added.length) return { ok: false, error: 'No sheets found in that file' };
    store = Object.assign({}, store, { sheets: store.sheets.concat(added), focusId: added[0].id });
    commit();
    return { ok: true, count: added.length, skipped: Math.max(0, list.length - added.length) };
  }

  // ── Floating windows ────────────────────────────────────────────────────

  function initialBounds(id) {
    const p = floatPrefs(id);
    const dims = { width: p.width, height: p.height };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const b = { x: p.x, y: p.y, width: dims.width, height: dims.height };
      // getDisplayMatching returns the NEAREST display for off-screen bounds,
      // so a sheet left on an unplugged monitor comes back onto a real one.
      return E.clampToArea(b, screen.getDisplayMatching(b).workArea);
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const pos = E.cornerPosition(area, dims, 'top-right', 24);
    // Cascade new overlays so several don't open exactly on top of each other.
    const step = floats.size * 28;
    return E.clampToArea({ x: pos.x - step, y: pos.y + step, width: dims.width, height: dims.height }, area);
  }

  function openFloat(id, opts) {
    const o = opts || {};
    if (!findSheet(id)) return { ok: false, error: 'That sheet no longer exists' };
    if (!store.enabled) return { ok: false, error: 'Turn the Study widget on first' };
    if (overlaysHidden) showAll();
    const existing = floats.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.showInactive();
      return { ok: true };
    }
    if (floats.size >= E.MAX_FLOATS) return { ok: false, error: `Up to ${E.MAX_FLOATS} formula overlays at once` };

    const p = floatPrefs(id);
    const bounds = initialBounds(id);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: 'Formula sheet',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // An always-on-top HUD: a throttled window would stall its first
        // paint and its resize handshake whenever Chromium thinks it's occluded.
        backgroundThrottling: false,
        preload: path.join(appRoot, 'study-float-preload.js')
      }
    });
    lockNavigation(win, logger);
    // 'screen-saver' keeps it above borderless games and other topmost windows.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (p.opacity < 100) win.setOpacity(p.opacity / 100);
    if (p.ghost) win.setIgnoreMouseEvents(true, { forward: true });

    const reveal = () => { if (!win.isDestroyed() && !win.isVisible() && !overlaysHidden) win.showInactive(); };
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
    // A transparent window whose page fails to load still opens — as an
    // invisible rectangle over the desktop. Close it and say so instead.
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Formula overlay page failed to load', null, { code, desc });
      closeFloat(id, { remember: false });
    });
    win.on('moved', () => rememberBounds(id));
    // Right-clicking a drag region on Windows opens the native system menu;
    // show the overlay's own menu instead.
    win.on('system-context-menu', (e) => { e.preventDefault(); popupMenu(id); });
    win.on('closed', () => {
      if (floats.get(id) === win) floats.delete(id);
    });
    win.loadFile(path.join(appRoot, 'study-float.html')).catch((e) => {
      logger.error('Failed to load formula overlay HTML', e);
    });

    floats.set(id, win);
    setFloatRecord(id, Object.assign({}, p, { open: true }));
    store = Object.assign({}, store, { focusId: id });
    if (!o.quiet) commit();
    return { ok: true };
  }

  function closeFloat(id, opts) {
    const o = opts || {};
    const win = floats.get(id);
    floats.delete(id);
    const t = moveSaveTimers.get(id);
    if (t) { clearTimeout(t); moveSaveTimers.delete(id); }
    resizing.delete(id);
    if (win && !win.isDestroyed()) {
      if (o.remember !== false) captureBounds(id, win);
      win.destroy();
    }
    if (store.floats[id] && !o.keepOpenFlag) setFloatRecord(id, Object.assign({}, store.floats[id], { open: false }));
    if (!floats.size) overlaysHidden = false;
    if (!o.quiet) commit();
    return { ok: true };
  }

  function captureBounds(id, win) {
    try {
      const b = win.getBounds();
      setFloatRecord(id, Object.assign({}, floatPrefs(id), { x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch (e) { /* window already gone */ }
  }

  function rememberBounds(id) {
    clearTimeout(moveSaveTimers.get(id));
    moveSaveTimers.set(id, setTimeout(() => {
      moveSaveTimers.delete(id);
      const win = floats.get(id);
      if (!win || win.isDestroyed()) return;
      captureBounds(id, win);
      saveSoon();
    }, 300));
  }

  function setFloatPrefs(id, patch) {
    if (!findSheet(id)) return { ok: false };
    const clean = {};
    for (const k of FLOAT_PREF_KEYS) if (patch && k in patch) clean[k] = patch[k];
    const p = E.sanitizeFloat(Object.assign({}, floatPrefs(id), clean), store.settings);
    // Keep position/size exactly as stored (sanitizeFloat clamps them anyway).
    setFloatRecord(id, p);
    const win = floats.get(id);
    if (win && !win.isDestroyed()) {
      win.setOpacity(p.opacity / 100);
      if (p.ghost) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    }
    commit();
    return { ok: true };
  }

  function zoomFloat(id, dir) {
    const p = floatPrefs(id);
    const d = Number(dir);
    const scale = d === 0 ? 1 : E.roundScale(p.scale + (d > 0 ? 0.1 : -0.1));
    if (scale === p.scale) return;
    setFloatPrefs(id, { scale });
  }

  // The page's resize grip: it reports the size it wants while dragging; main
  // keeps the window's top-left fixed and clamps to the screen it is on.
  function resizeFloat(id, width, height) {
    const win = floats.get(id);
    if (!win || win.isDestroyed()) return;
    if (!resizing.has(id)) resizing.set(id, win.getBounds());
    const start = resizing.get(id);
    const area = screen.getDisplayMatching(start).workArea;
    win.setBounds(E.resizeWithin(start, width, height, area));
  }

  function endResize(id) {
    resizing.delete(id);
    const win = floats.get(id);
    if (!win || win.isDestroyed()) return;
    captureBounds(id, win);
    saveSoon();
  }

  function snapFloat(id, corner) {
    const win = floats.get(id);
    if (!win || win.isDestroyed()) return { ok: false };
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const pos = E.cornerPosition(area, { width: b.width, height: b.height }, corner, 16);
    win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
    captureBounds(id, win);
    saveSoon();
    return { ok: true };
  }

  function moveFloatToDisplay(id, displayId) {
    const win = floats.get(id);
    if (!win || win.isDestroyed()) return { ok: false };
    const target = screen.getAllDisplays().find(d => d.id === displayId);
    if (!target) return { ok: false };
    const b = win.getBounds();
    const from = screen.getDisplayMatching(b).workArea;
    win.setBounds(E.mapToArea(b, from, target.workArea));
    captureBounds(id, win);
    saveSoon();
    return { ok: true };
  }

  // A monitor unplugged or a resolution change must never strand a sheet
  // off-screen.
  function keepFloatsOnScreen() {
    for (const [id, win] of floats) {
      if (win.isDestroyed()) continue;
      const b = win.getBounds();
      const clamped = E.clampToArea(b, screen.getDisplayMatching(b).workArea);
      if (clamped.x !== b.x || clamped.y !== b.y || clamped.width !== b.width || clamped.height !== b.height) {
        win.setBounds(clamped);
        captureBounds(id, win);
      }
    }
    saveSoon();
  }
  screen.on('display-removed', keepFloatsOnScreen);
  screen.on('display-metrics-changed', keepFloatsOnScreen);

  function hideAll() {
    overlaysHidden = true;
    for (const win of floats.values()) if (!win.isDestroyed()) win.hide();
  }

  function showAll() {
    overlaysHidden = false;
    for (const win of floats.values()) if (!win.isDestroyed()) win.showInactive();
  }

  // The show/hide hotkey (and the panel's button): hide every overlay, bring
  // them back, or — when none is open — pop out the sheet used last.
  function toggleOverlays() {
    if (!store.enabled) return publicState();
    if (floats.size) {
      if (overlaysHidden) showAll();
      else hideAll();
    } else {
      const id = findSheet(store.focusId) ? store.focusId : (store.sheets[0] && store.sheets[0].id);
      if (id) openFloat(id, { quiet: true });
    }
    commit();
    return publicState();
  }

  // The click-through hotkey: ghost every open overlay, or — if they all
  // already are — un-ghost them. The only way back from click-through that
  // doesn't need the mouse.
  function toggleGhostAll() {
    if (!floats.size) return;
    const anySolid = [...floats.keys()].some(id => !floatPrefs(id).ghost);
    for (const id of floats.keys()) setFloatPrefs(id, { ghost: anySolid });
  }

  function popupMenu(id) {
    const win = floats.get(id);
    const sheet = findSheet(id);
    if (!win || win.isDestroyed() || !sheet) return;
    const p = floatPrefs(id);
    const radio = (label, key, value) => ({ label, type: 'radio', checked: p[key] === value, click: () => setFloatPrefs(id, { [key]: value }) });
    const items = [
      { label: 'Style', submenu: [radio('Glass', 'style', 'glass'), radio('Paper', 'style', 'paper'), radio('Clear (text only)', 'style', 'clear')] },
      { label: 'Text size', submenu: [0.8, 1, 1.2, 1.4, 1.7, 2].map(v => radio(Math.round(v * 100) + '%', 'scale', v)) },
      { label: 'Opacity', submenu: [100, 85, 70, 55, 40].map(v => radio(v + '%', 'opacity', v)) },
      { label: 'Show labels', type: 'checkbox', checked: p.labels, click: () => setFloatPrefs(id, { labels: !p.labels }) },
      { label: 'Show notes', type: 'checkbox', checked: p.notes, click: () => setFloatPrefs(id, { notes: !p.notes }) },
      { label: 'Click-through (ghost mode)', type: 'checkbox', checked: p.ghost, click: () => setFloatPrefs(id, { ghost: !p.ghost }) },
      { type: 'separator' }
    ];
    const cornerLabels = { 'top-left': 'Top left', 'top-center': 'Top centre', 'top-right': 'Top right', center: 'Centre', 'bottom-left': 'Bottom left', 'bottom-center': 'Bottom centre', 'bottom-right': 'Bottom right' };
    items.push({ label: 'Snap to', submenu: E.CORNERS.map(c => ({ label: cornerLabels[c], click: () => snapFloat(id, c) })) });
    const displays = screen.getAllDisplays();
    const primaryId = screen.getPrimaryDisplay().id;
    const current = screen.getDisplayMatching(win.getBounds()).id;
    items.push({
      label: 'Move to display',
      enabled: displays.length > 1,
      submenu: displays.map((d, i) => ({
        label: `Display ${i + 1} — ${d.size.width}×${d.size.height}${d.id === primaryId ? ' (main)' : ''}`,
        type: 'radio',
        checked: d.id === current,
        click: () => moveFloatToDisplay(id, d.id)
      }))
    });
    items.push({ type: 'separator' });
    items.push({ label: 'Edit this sheet in main', click: () => openInApp(id) });
    items.push({ label: 'Close formula sheet', click: () => closeFloat(id) });
    try {
      Menu.buildFromTemplate(items).popup({ window: win });
    } catch (e) {
      logger.warn('Study: could not open the overlay menu', { error: e && e.message });
    }
  }

  function openInApp(id) {
    try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ }
    sendMain('study:open', { sheetId: id });
  }

  // ── Hotkeys ─────────────────────────────────────────────────────────────

  function unregisterHotkeys() {
    for (const key of Object.keys(boundHotkeys)) {
      if (boundHotkeys[key]) {
        try { globalShortcut.unregister(boundHotkeys[key]); } catch (e) { /* ignore */ }
        boundHotkeys[key] = null;
      }
    }
  }

  // Returns which bindings failed (taken by another app or invalid).
  function registerHotkeys() {
    unregisterHotkeys();
    const failed = [];
    if (!store.enabled) return { failed };
    const want = {
      toggle: [store.settings.hotkeyToggle, () => toggleOverlays()],
      ghost: [store.settings.hotkeyGhost, () => toggleGhostAll()]
    };
    for (const key of Object.keys(want)) {
      const [accel, fn] = want[key];
      if (!accel) continue;
      let ok = false;
      try { ok = globalShortcut.register(accel, fn); } catch (e) { ok = false; }
      if (ok) boundHotkeys[key] = accel;
      else {
        failed.push(key);
        logger.warn('Study: hotkey registration failed', { key, accelerator: accel });
      }
    }
    return { failed };
  }

  // ── IPC: the main app's panel ───────────────────────────────────────────

  function handle(channel, fn) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        logger.error(`Study: ${channel} failed`, e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('study:get', () => publicState());
  handle('study:set-enabled', (enabled) => setEnabled(enabled));
  handle('study:create', (opts) => create(opts));
  handle('study:update', (id, patch) => update(String(id || ''), patch));
  handle('study:duplicate', (id) => duplicate(String(id || '')));
  handle('study:remove', (id) => remove(String(id || '')));
  handle('study:reorder', (ids) => reorder(ids));
  handle('study:set-settings', (patch) => setSettings(patch));
  handle('study:float-open', (id) => openFloat(String(id || '')));
  handle('study:float-close', (id) => closeFloat(String(id || '')));
  handle('study:float-close-all', () => {
    for (const id of [...floats.keys()]) closeFloat(id, { quiet: true });
    commit();
    return { ok: true };
  });
  handle('study:float-prefs', (id, patch) => setFloatPrefs(String(id || ''), patch && typeof patch === 'object' ? patch : {}));
  handle('study:float-snap', (id, corner) => snapFloat(String(id || ''), String(corner || '')));
  handle('study:toggle-overlays', () => toggleOverlays());
  handle('study:export', (ids) => exportSheets(ids));
  handle('study:import', () => importSheets());

  // ── IPC: floating windows ───────────────────────────────────────────────
  // The sender decides which sheet a message is about. A message from any
  // window that isn't a live overlay is ignored.

  function floatIdFor(event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    for (const [id, w] of floats) if (w === win) return id;
    return null;
  }

  ipcMain.removeHandler('study-float:ready');
  ipcMain.handle('study-float:ready', (event) => {
    const id = floatIdFor(event);
    return id ? floatPayload(id) : null;
  });
  ipcMain.removeAllListeners('study-float:menu');
  ipcMain.on('study-float:menu', (event) => {
    const id = floatIdFor(event);
    if (id) popupMenu(id);
  });
  // Ghost mode: the window ignores the mouse, but the page still sees mouse
  // moves (forward: true) and asks to catch clicks while the pointer is over
  // its unlock handle.
  ipcMain.removeAllListeners('study-float:hover-handle');
  ipcMain.on('study-float:hover-handle', (event, over) => {
    const id = floatIdFor(event);
    const win = id && floats.get(id);
    if (!win || win.isDestroyed() || !floatPrefs(id).ghost) return;
    if (over) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.removeAllListeners('study-float:exit-ghost');
  ipcMain.on('study-float:exit-ghost', (event) => {
    const id = floatIdFor(event);
    if (id) setFloatPrefs(id, { ghost: false });
  });
  ipcMain.removeAllListeners('study-float:ghost');
  ipcMain.on('study-float:ghost', (event) => {
    const id = floatIdFor(event);
    if (id) setFloatPrefs(id, { ghost: true });
  });
  ipcMain.removeAllListeners('study-float:zoom');
  ipcMain.on('study-float:zoom', (event, dir) => {
    const id = floatIdFor(event);
    if (id) zoomFloat(id, dir);
  });
  ipcMain.removeAllListeners('study-float:resize-to');
  ipcMain.on('study-float:resize-to', (event, width, height) => {
    const id = floatIdFor(event);
    if (id && !floatPrefs(id).ghost) resizeFloat(id, width, height);
  });
  ipcMain.removeAllListeners('study-float:resize-end');
  ipcMain.on('study-float:resize-end', (event) => {
    const id = floatIdFor(event);
    if (id) endResize(id);
  });
  ipcMain.removeAllListeners('study-float:close');
  ipcMain.on('study-float:close', (event) => {
    const id = floatIdFor(event);
    if (id) closeFloat(id);
  });
  ipcMain.removeAllListeners('study-float:open-app');
  ipcMain.on('study-float:open-app', (event) => {
    const id = floatIdFor(event);
    if (id) openInApp(id);
  });

  // Boot: reopen the overlays that were out last time, bind hotkeys. Deferred
  // a moment so the main window exists to receive the state.
  setTimeout(() => {
    if (tornDown || !store.enabled) return;
    reopenRemembered();
    registerHotkeys();
    broadcast();
  }, 1200);

  return {
    reapplyHotkeys: () => { registerHotkeys(); },
    teardown: () => {
      tornDown = true;
      unregisterHotkeys();
      // Remember where each overlay was; keep their open flags so they come
      // back on the next launch.
      for (const [id, win] of floats) {
        if (!win.isDestroyed()) {
          captureBounds(id, win);
          win.destroy();
        }
      }
      floats.clear();
      saveNow();
    }
  };
}

module.exports = { init };
