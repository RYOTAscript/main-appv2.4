'use strict';

// main/study.js end to end, with Electron stubbed: what is stored, which
// windows open with what, and who may talk to them. An overlay must only ever
// read its own sheet and change its own look; a message from any other window
// must do nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

// ── The stub Electron: only what the module touches ─────────────────────────

const ipc = { handlers: new Map(), listeners: new Map() };
const windows = [];
const shortcuts = new Map();
let shortcutTaken = new Set();
const dialogs = { save: null, open: null };

class StubWindow {
  constructor(opts) {
    this.opts = opts;
    this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
    this.visible = false;
    this.destroyed = false;
    this.opacity = 1;
    this.ignoreMouse = false;
    this.events = {};
    this.wcEvents = {};
    this.sent = [];
    this.loaded = null;
    this.webContents = {
      send: (channel, payload) => { this.sent.push({ channel, payload }); },
      on: (ev, fn) => { this.wcEvents[ev] = fn; },
      once: (ev, fn) => { this.wcEvents[ev] = fn; },
      setWindowOpenHandler() {},
      getURL: () => ''
    };
    windows.push(this);
  }
  setAlwaysOnTop(on, level) { this.top = [on, level]; }
  setVisibleOnAllWorkspaces() {}
  on(ev, fn) { this.events[ev] = fn; }
  once(ev, fn) { this.events[ev] = fn; }
  loadFile(f) { this.loaded = f; return Promise.resolve(); }
  getBounds() { return Object.assign({}, this.bounds); }
  setBounds(b) { this.bounds = Object.assign({}, b); }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; this.visible = false; if (this.events.closed) this.events.closed(); }
  setOpacity(o) { this.opacity = o; }
  setIgnoreMouseEvents(on) { this.ignoreMouse = !!on; }
  static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
}

const area = { x: 0, y: 0, width: 1920, height: 1040 };
const display = { id: 1, workArea: area, size: { width: 1920, height: 1080 } };
const mainWindow = new StubWindow({ x: 0, y: 0, width: 920, height: 640 });
const electronStub = {
  app: { isPackaged: false },
  ipcMain: {
    handle: (ch, fn) => ipc.handlers.set(ch, fn),
    removeHandler: (ch) => ipc.handlers.delete(ch),
    on: (ch, fn) => ipc.listeners.set(ch, fn),
    removeAllListeners: (ch) => ipc.listeners.delete(ch)
  },
  BrowserWindow: StubWindow,
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  screen: {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    on() {}
  },
  globalShortcut: {
    register: (accel, fn) => { if (shortcutTaken.has(accel)) return false; shortcuts.set(accel, fn); return true; },
    unregister: (accel) => { shortcuts.delete(accel); }
  },
  dialog: {
    showSaveDialog: async () => dialogs.save,
    showOpenDialog: async () => dialogs.open
  }
};
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub
};

const study = require(path.join(ROOT, 'main', 'study.js'));
const E = require(path.join(ROOT, 'renderer', 'study-engine.js'));

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function boot(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-test-'));
  dirs.push(dir);
  if (seed !== undefined) fs.writeFileSync(path.join(dir, 'study.json'), typeof seed === 'string' ? seed : JSON.stringify(seed));
  const logs = [];
  const logger = { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]), log() {} };
  const mod = study.init({ logger, appRoot: ROOT, userDataPath: dir, getMainWindow: () => mainWindow, focusMainWindow() {} });
  const call = (ch, ...args) => ipc.handlers.get(ch)({ sender: mainWindow.webContents }, ...args);
  const fromWin = (win, ch, ...args) => {
    const ev = { sender: win.webContents };
    if (ipc.handlers.has(ch)) return ipc.handlers.get(ch)(ev, ...args);
    return ipc.listeners.get(ch)(ev, ...args);
  };
  const file = () => JSON.parse(fs.readFileSync(path.join(dir, 'study.json'), 'utf8'));
  return { mod, call, fromWin, file, dir, logs };
}

const lastWindow = () => windows[windows.length - 1];

test('a fresh profile starts disabled and empty, and the toggle reaches main', async () => {
  const { mod, call } = boot();
  const s0 = await call('study:get');
  assert.equal(s0.enabled, false);
  assert.deepEqual(s0.sheets, []);
  const s1 = await call('study:set-enabled', true);
  assert.equal(s1.enabled, true);
  mod.teardown();
});

test('a starter becomes the user\'s own sheet, saved atomically', async () => {
  const { mod, call, file, dir } = boot();
  await call('study:set-enabled', true);
  const res = await call('study:create', { starter: 'mechanics' });
  assert.equal(res.ok, true);
  assert.equal(res.sheet.starter, 'mechanics');
  assert.equal(res.sheet.rows.length, E.STARTERS.find(s => s.id === 'mechanics').rows.length);
  const bad = await call('study:create', { starter: 'nope' });
  assert.equal(bad.ok, false);
  mod.teardown();
  const saved = file();
  assert.equal(saved.sheets.length, 1);
  assert.equal(saved.sheets[0].id, res.sheet.id);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp-')), [], 'no temp file left behind');
});

test('updates are sanitised and an edited starter is no longer a starter', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'algebra' });
  const res = await call('study:update', sheet.id, {
    title: '  My algebra  ',
    color: 'javascript:alert(1)',
    rows: [{ kind: 'formula', label: 'new row, no id', src: 'x^2\n' + 'y'.repeat(2000) }, { id: 'keep', kind: 'heading', label: 'H' }],
    starter: 'forged'
  });
  assert.equal(res.ok, true);
  assert.equal(res.sheet.title, 'My algebra');
  assert.equal(res.sheet.color, sheet.color, 'a bad colour is ignored');
  assert.equal(res.sheet.rows.length, 2);
  assert.ok(res.sheet.rows[0].id, 'a row without an id gets one');
  assert.equal(res.sheet.rows[0].src.length, E.MAX_SRC);
  assert.ok(!res.sheet.rows[0].src.includes('\n'));
  assert.equal(res.sheet.starter, '');
  assert.equal((await call('study:update', 'missing', { title: 'x' })).ok, false);
  mod.teardown();
});

test('popping a sheet out opens a locked-down, always-on-top HUD', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'trig' });
  const before = windows.length;
  assert.equal((await call('study:float-open', sheet.id)).ok, true);
  assert.equal(windows.length, before + 1);
  const win = lastWindow();
  assert.equal(win.opts.frame, false);
  assert.equal(win.opts.transparent, true);
  assert.equal(win.opts.skipTaskbar, true);
  assert.equal(win.opts.webPreferences.contextIsolation, true);
  assert.equal(win.opts.webPreferences.nodeIntegration, false);
  assert.equal(win.opts.webPreferences.backgroundThrottling, false);
  assert.equal(path.basename(win.opts.webPreferences.preload), 'study-float-preload.js');
  assert.deepEqual(win.top, [true, 'screen-saver']);
  assert.equal(path.basename(win.loaded), 'study-float.html');
  // Inside the screen, at the default size, in the top-right corner.
  assert.deepEqual([win.bounds.width, win.bounds.height], [E.FLOAT_DEFAULT.width, E.FLOAT_DEFAULT.height]);
  assert.ok(win.bounds.x + win.bounds.width <= area.width);
  // Opening again just shows the same window.
  await call('study:float-open', sheet.id);
  assert.equal(windows.length, before + 1);
  const state = await call('study:get');
  assert.deepEqual(state.openFloats, [sheet.id]);
  mod.teardown();
});

test('an overlay reads only its own sheet; strangers get nothing', async () => {
  const { mod, call, fromWin } = boot();
  await call('study:set-enabled', true);
  const a = (await call('study:create', { starter: 'algebra' })).sheet;
  const b = (await call('study:create', { starter: 'moles' })).sheet;
  await call('study:float-open', a.id);
  const winA = lastWindow();
  await call('study:float-open', b.id);
  const winB = lastWindow();
  const payloadA = await fromWin(winA, 'study-float:ready');
  assert.equal(payloadA.sheet.id, a.id);
  assert.deepEqual(Object.keys(payloadA.prefs).sort(), ['ghost', 'labels', 'notes', 'opacity', 'scale', 'style']);
  assert.equal((await fromWin(winB, 'study-float:ready')).sheet.id, b.id);
  // The main window (or any other) is not an overlay.
  assert.equal(await fromWin(mainWindow, 'study-float:ready'), null);
  fromWin(mainWindow, 'study-float:close');
  fromWin(mainWindow, 'study-float:zoom', 1);
  assert.equal(winA.destroyed || winB.destroyed, false);
  // Zooming one overlay changes that one only.
  fromWin(winA, 'study-float:zoom', 1);
  const s = await call('study:get');
  assert.equal(s.floats[a.id].scale, 1.1);
  assert.equal(s.floats[b.id].scale, 1);
  // A content change reaches the open overlay.
  winA.sent.length = 0;
  await call('study:update', a.id, { title: 'Renamed' });
  const pushed = winA.sent.filter(m => m.channel === 'study-float:state').pop();
  assert.equal(pushed.payload.sheet.title, 'Renamed');
  // Closing from the overlay itself works.
  fromWin(winB, 'study-float:close');
  assert.equal(winB.destroyed, true);
  mod.teardown();
});

test('resizing from the grip is clamped, saved, and ignored in ghost mode', async () => {
  const { mod, call, fromWin } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'derivatives' });
  await call('study:float-open', sheet.id);
  const win = lastWindow();
  const start = win.getBounds();
  fromWin(win, 'study-float:resize-to', 10, 10);
  assert.deepEqual([win.bounds.width, win.bounds.height], [E.FLOAT_MIN.width, E.FLOAT_MIN.height]);
  assert.deepEqual([win.bounds.x, win.bounds.y], [start.x, start.y], 'the top-left corner stays put');
  fromWin(win, 'study-float:resize-to', 99999, 99999);
  assert.ok(win.bounds.x + win.bounds.width <= area.x + area.width);
  assert.ok(win.bounds.y + win.bounds.height <= area.y + area.height);
  fromWin(win, 'study-float:resize-to', 500, 600);
  fromWin(win, 'study-float:resize-end');
  let s = await call('study:get');
  // It opened in the top-right corner, so it can only grow as far as the edge.
  const width = Math.min(500, area.x + area.width - start.x);
  assert.deepEqual([s.floats[sheet.id].width, s.floats[sheet.id].height], [width, 600]);
  assert.ok(width < 500, 'the clamp really applied');
  // Ghost: clicks pass through, and the grip can't resize.
  fromWin(win, 'study-float:ghost');
  assert.equal(win.ignoreMouse, true);
  fromWin(win, 'study-float:resize-to', 300, 300);
  assert.equal(win.bounds.width, width);
  // Hovering the unlock handle catches clicks again; leaving it lets them through.
  fromWin(win, 'study-float:hover-handle', true);
  assert.equal(win.ignoreMouse, false);
  fromWin(win, 'study-float:hover-handle', false);
  assert.equal(win.ignoreMouse, true);
  fromWin(win, 'study-float:exit-ghost');
  assert.equal(win.ignoreMouse, false);
  s = await call('study:get');
  assert.equal(s.floats[sheet.id].ghost, false);
  mod.teardown();
});

test('an overlay may only change its look, never its position or content', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'integrals' });
  await call('study:float-open', sheet.id);
  const win = lastWindow();
  await call('study:float-prefs', sheet.id, { opacity: 40, style: 'paper', x: -9999, open: false, width: 10 });
  const s = await call('study:get');
  const f = s.floats[sheet.id];
  assert.equal(f.opacity, 40);
  assert.equal(f.style, 'paper');
  assert.equal(f.open, true, 'not a look field');
  assert.notEqual(f.x, -9999);
  assert.equal(win.opacity, 0.4);
  mod.teardown();
});

test('the show/hide toggle hides, restores, and with nothing open pops out the last sheet', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'physics2' });
  let s = await call('study:toggle-overlays');
  assert.deepEqual(s.openFloats, [sheet.id], 'opened the sheet used last');
  const win = lastWindow();
  win.visible = true;
  s = await call('study:toggle-overlays');
  assert.equal(s.hidden, true);
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false, 'hidden, not closed');
  s = await call('study:toggle-overlays');
  assert.equal(s.hidden, false);
  assert.equal(win.visible, true);
  mod.teardown();
});

test('hotkeys bind from settings, report a clash, and are released when disabled', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  shortcutTaken = new Set(['CommandOrControl+Alt+G']);
  const res = await call('study:set-settings', { hotkeyToggle: 'CommandOrControl+Alt+F', hotkeyGhost: 'CommandOrControl+Alt+G' });
  assert.deepEqual(res.hotkeys.failed, ['ghost']);
  assert.ok(shortcuts.has('CommandOrControl+Alt+F'));
  await call('study:set-enabled', false);
  assert.ok(!shortcuts.has('CommandOrControl+Alt+F'), 'off means off');
  await call('study:set-enabled', true);
  assert.ok(shortcuts.has('CommandOrControl+Alt+F'));
  mod.reapplyHotkeys();
  assert.ok(shortcuts.has('CommandOrControl+Alt+F'));
  shortcutTaken = new Set();
  mod.teardown();
  assert.ok(!shortcuts.has('CommandOrControl+Alt+F'));
});

test('switching off closes the overlays but remembers them for next time', async () => {
  const { mod, call, file } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'equilibria' });
  await call('study:float-open', sheet.id);
  const win = lastWindow();
  await call('study:set-enabled', false);
  assert.equal(win.destroyed, true);
  assert.equal(file().floats[sheet.id].open, true, 'the open flag survives');
  assert.equal((await call('study:float-open', sheet.id)).ok, false, 'nothing opens while off');
  const before = windows.length;
  await call('study:set-enabled', true);
  assert.equal(windows.length, before + 1, 'reopened');
  mod.teardown();
});

test('deleting a sheet closes its overlay and forgets its window', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'algebra' });
  await call('study:float-open', sheet.id);
  const win = lastWindow();
  await call('study:remove', sheet.id);
  assert.equal(win.destroyed, true);
  const s = await call('study:get');
  assert.deepEqual(s.sheets, []);
  assert.deepEqual(s.floats, {});
  mod.teardown();
});

test('there is a cap on overlays at once', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const ids = [];
  for (let i = 0; i <= E.MAX_FLOATS; i++) ids.push((await call('study:create', { title: 'S' + i })).sheet.id);
  for (let i = 0; i < E.MAX_FLOATS; i++) assert.equal((await call('study:float-open', ids[i])).ok, true);
  const res = await call('study:float-open', ids[E.MAX_FLOATS]);
  assert.equal(res.ok, false);
  assert.match(res.error, /at once/);
  mod.teardown();
});

test('a page that fails to load never lingers as an invisible window', async () => {
  const { mod, call } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { title: 'x' });
  await call('study:float-open', sheet.id);
  const win = lastWindow();
  win.wcEvents['did-fail-load']({}, -6, 'ERR_FILE_NOT_FOUND');
  assert.equal(win.destroyed, true);
  assert.deepEqual((await call('study:get')).openFloats, []);
  mod.teardown();
});

test('a damaged study.json is kept aside, not overwritten', async () => {
  const { mod, call, dir } = boot('{ not json');
  const s = await call('study:get');
  assert.deepEqual(s.sheets, []);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('study.json.corrupt-')));
  mod.teardown();
});

test('export and import round-trip, with fresh ids and nothing trusted', async () => {
  const { mod, call, dir } = boot();
  await call('study:set-enabled', true);
  const { sheet } = await call('study:create', { starter: 'moles' });
  const out = path.join(dir, 'shared.json');
  dialogs.save = { canceled: false, filePath: out };
  const ex = await call('study:export', [sheet.id]);
  assert.equal(ex.ok, true);
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(data.format, 'main-study-sheets');
  assert.equal(data.sheets[0].id, undefined, 'ids are not exported');
  // Tamper with it the way a hostile file could.
  data.sheets[0].rows.push({ id: sheet.rows[0].id, kind: 'formula', src: '<script>', extra: 'x' });
  data.sheets.push({ title: 'Second', rows: 'nope' });
  fs.writeFileSync(out, JSON.stringify(data));
  dialogs.open = { canceled: false, filePaths: [out] };
  const im = await call('study:import');
  assert.equal(im.ok, true);
  assert.equal(im.count, 2);
  const s = await call('study:get');
  assert.equal(s.sheets.length, 3);
  const copy = s.sheets[1];
  assert.notEqual(copy.id, sheet.id);
  assert.ok(!copy.rows.some(r => sheet.rows.some(o => o.id === r.id)), 'no row id carried over');
  assert.equal(copy.rows[copy.rows.length - 1].extra, undefined);
  // Not a sheet file at all.
  fs.writeFileSync(out, JSON.stringify({ hello: 'world' }));
  assert.equal((await call('study:import')).ok, false);
  dialogs.open = { canceled: true, filePaths: [] };
  assert.equal((await call('study:import')).canceled, true);
  mod.teardown();
});
