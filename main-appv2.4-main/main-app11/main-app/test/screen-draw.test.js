'use strict';

// Draw on Screen's seams and main/screenDraw.js running with Electron stubbed.
// The failures that matter are silent ones: a full-screen transparent window
// whose page never loads eats every click on the display; one that ignores
// Escape strands someone behind a frozen screenshot; an overlay handed the wide
// app bridge; a page missing from the build.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const moduleSrc = read('main', 'screenDraw.js');
const overlayPreload = read('screen-draw-preload.js');
const overlayJs = read('renderer', 'screen-draw-overlay.js');
const panelJs = read('renderer', 'screen-draw.js');
const preloadSrc = read('preload.js');
const mainSrc = read('main.js');
const coreSrc = read('renderer', 'core.js');
const htmlSrc = read('main.html');
const pkg = require(path.join(ROOT, 'package.json'));

test('the overlay gets its own narrow bridge, and main checks who is talking', () => {
  assert.match(moduleSrc, /preload: path\.join\(appRoot, 'screen-draw-preload\.js'\)/);
  assert.ok(!/'preload\.js'/.test(stripComments(moduleSrc)), 'never the app preload');
  assert.ok(!/electronAPI/.test(stripComments(overlayPreload)), 'not the app bridge');
  const exposed = [...overlayPreload.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exposed, ['close', 'copy', 'freeze', 'hoverUi', 'onState', 'painted', 'passThrough', 'ready', 'reveal', 'save', 'setPrefs', 'unfreeze']);
  for (const ch of ['ready', 'painted', 'close', 'prefs', 'freeze', 'unfreeze', 'pass-through', 'hover-ui', 'save', 'copy', 'reveal']) {
    const at = moduleSrc.indexOf(`'screen-draw:${ch}', `);
    assert.notEqual(at, -1, `screen-draw:${ch} is handled`);
    assert.match(moduleSrc.slice(at, at + 160), /fromOverlay\(event\)/, `screen-draw:${ch} checks its sender`);
  }
  // The overlay may change its tools and toolbar spot, never the hotkeys or the switch.
  const { OVERLAY_PREF_KEYS } = require(path.join(ROOT, 'main', 'screenDraw.js'));
  assert.deepEqual([...OVERLAY_PREF_KEYS].sort(), ['barEdge', 'barX', 'color', 'tool', 'width']);
});

test('the overlay covers the display safely', () => {
  assert.match(moduleSrc, /lockNavigation\(w, logger\)/);
  assert.match(moduleSrc, /transparent: true/);
  assert.match(moduleSrc, /resizable: true/, 'Windows ignores fullscreen on a window that is not resizable');
  assert.match(moduleSrc, /fullscreen: !isMac/, 'the only exact cover of a scaled display');
  assert.match(moduleSrc, /backgroundThrottling: false/);
  assert.match(moduleSrc, /setAlwaysOnTop\(true, 'screen-saver'\)/);
  assert.match(moduleSrc, /before-input-event[\s\S]{0,200}Escape[\s\S]{0,80}close\(\)/, 'Escape works even if the page is broken');
  assert.match(moduleSrc, /did-fail-load[\s\S]{0,200}close\(\)/, 'a page that failed must not sit over the screen');
  assert.match(moduleSrc, /render-process-gone[\s\S]{0,200}close\(\)/);
});

test('the overlay page and its bridge ship, and draw nothing from text as markup', () => {
  for (const f of ['screen-draw.html', 'screen-draw-preload.js']) assert.ok(pkg.build.files.includes(f), `${f} is in build.files`);
  assert.doesNotMatch(stripComments(overlayJs), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  const page = read('screen-draw.html');
  assert.match(page, /<script src="renderer\/draw-engine\.js"><\/script>\s*<script src="renderer\/screen-draw-overlay\.js"><\/script>/);
  assert.doesNotMatch(page, /\son[a-z]+="/i, 'no inline handlers');
  assert.match(page, /\[hidden\] \{ display: none !important; \}/, 'the click-through button really hides in frozen mode');
});

test('the widget is registered, wired to main and switched from its registry pref', () => {
  const entry = coreSrc.slice(coreSrc.indexOf("id: 'screenDraw'"), coreSrc.indexOf("panelRenderer: 'renderScreenDrawPanel'"));
  assert.ok(entry.length > 100, 'registry entry exists');
  assert.ok(!/platforms:/.test(entry), 'Windows and macOS');
  assert.match(panelJs, /function renderScreenDrawPanel\(\)/);
  assert.match(panelJs, /if \(!panel\) return;/);
  assert.match(htmlSrc, /<script src="renderer\/screen-draw\.js"><\/script>/);
  assert.match(read('renderer', 'widgets-settings.js'), /applyScreenDrawEnabled\(!!prefs\.screenDraw\)/);
  assert.match(mainSrc, /screenDrawModule = screenDraw\.init\(ctx\)/);
  assert.match(mainSrc, /if \(screenDrawModule\) screenDrawModule\.teardown\(\)/);
  assert.match(mainSrc, /if \(screenDrawModule\) screenDrawModule\.reapplyHotkeys\(\)/, 're-bound after a hotkey is recorded');
  const handled = new Set([...moduleSrc.matchAll(/handle\('(screen-draw:[^']+)'/g)].map((m) => m[1]));
  const bridged = [...preloadSrc.matchAll(/invoke\('(screen-draw:[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(bridged.sort(), ['screen-draw:get', 'screen-draw:open', 'screen-draw:set-enabled', 'screen-draw:set-prefs']);
  assert.deepEqual(bridged.filter((c) => !handled.has(c)), []);
  const used = new Set([...panelJs.matchAll(/electronAPI\??\.((?:screenDraw|onScreenDraw)[A-Za-z]+)/g)].map((m) => m[1]));
  for (const name of used) assert.match(preloadSrc, new RegExp(`\\b${name}:`), `${name} is in preload.js`);
});

// ── main/screenDraw.js with Electron stubbed ─────────────────────────────────

const shortcuts = new Map();
const windows = [];
let captures = 0;
let accessStatus = 'granted';
let picturesDir = '';
const clipboardWrites = [];
const handlers = new Map();
const listeners = new Map();

class StubImage {
  constructor(png) { this.png = png || Buffer.from('PNG'); }
  isEmpty() { return false; }
  toDataURL() { return 'data:image/png;base64,AAAA'; }
  toPNG() { return this.png; }
}

class StubWindow {
  constructor(opts) {
    this.opts = opts;
    this.visible = false;
    this.destroyed = false;
    this.opacity = 1;
    this.ignore = false;
    this.events = {};
    this.wcEvents = {};
    this.sent = [];
    const self = this;
    this.webContents = {
      on(ev, fn) { self.wcEvents[ev] = fn; },
      send(ch, data) { self.sent.push([ch, data]); },
      setWindowOpenHandler() {},
      getURL: () => ''
    };
    windows.push(this);
  }
  loadFile() { return Promise.resolve(); }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  on(ev, fn) { this.events[ev] = fn; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  setBounds() {}
  setOpacity(o) { this.opacity = o; }
  setIgnoreMouseEvents(on) { this.ignore = on; }
  destroy() { this.destroyed = true; this.visible = false; if (this.events.closed) this.events.closed(); }
  static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
}

const electronStub = {
  app: { isPackaged: false, getPath: () => picturesDir },
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    on: (ch, fn) => listeners.set(ch, fn),
    removeAllListeners: (ch) => listeners.delete(ch)
  },
  BrowserWindow: StubWindow,
  screen: {
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 })
  },
  globalShortcut: {
    register: (accel, fn) => { if (accel === 'Taken+Key') return false; shortcuts.set(accel, fn); return true; },
    unregister: (accel) => shortcuts.delete(accel)
  },
  desktopCapturer: { getSources: async () => { captures++; return [{ display_id: '1', thumbnail: new StubImage() }]; } },
  clipboard: { writeImage: (img) => clipboardWrites.push(img) },
  nativeImage: { createFromDataURL: () => new StubImage(Buffer.from('FROM-PAGE')) },
  shell: { showItemInFolder() {} },
  systemPreferences: { getMediaAccessStatus: () => accessStatus }
};
require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub };
const screenDraw = require(path.join(ROOT, 'main', 'screenDraw.js'));

function start(t, saved) {
  shortcuts.clear();
  windows.length = 0;
  handlers.clear();
  listeners.clear();
  captures = 0;
  clipboardWrites.length = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-draw-'));
  picturesDir = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (saved) fs.writeFileSync(path.join(dir, 'screen-draw.json'), JSON.stringify(saved));
  const mainWin = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, hide() { this.visible = false; }, show() { this.visible = true; }, focus() {}, webContents: { send() {} } };
  const mod = screenDraw.init({
    logger: { warn() {}, error() {}, log() {}, debug() {} },
    appRoot: ROOT, userDataPath: dir, getMainWindow: () => mainWin
  });
  t.after(() => mod.teardown());
  const overlay = () => windows.filter((w) => !w.destroyed).at(-1) || null;
  const ev = (w) => ({ sender: w.webContents });
  return { mod, mainWin, overlay, ev, dir };
}

// The panel's channels go through main's handle() wrapper, which drops the event.
const panel = (ch, ...args) => handlers.get(ch)({ sender: {} }, ...args);

test('off: no hotkey. On: the hotkey opens it, and closes it again', async (t) => {
  const c = start(t);
  assert.equal(shortcuts.size, 0, 'nothing bound while the widget is off');
  const on = await panel('screen-draw:set-enabled', true);
  assert.equal(on.enabled, true);
  assert.ok(shortcuts.has('CommandOrControl+Alt+D'));
  await shortcuts.get('CommandOrControl+Alt+D')();
  const w = c.overlay();
  assert.ok(w, 'overlay opened');
  assert.equal(captures, 0, 'live mode takes no screenshot');
  const init = await handlers.get('screen-draw:ready')(c.ev(w));
  assert.equal(init.mode, 'live');
  assert.equal(init.image, null);
  listeners.get('screen-draw:painted')(c.ev(w));
  assert.equal(w.visible, true, 'shown once painted');
  await shortcuts.get('CommandOrControl+Alt+D')();
  assert.equal(w.destroyed, true, 'the hotkey again puts it away');
  await panel('screen-draw:set-enabled', false);
  assert.equal(shortcuts.size, 0);
});

test('freeze takes the screenshot first; the other hotkey opens the other mode', async (t) => {
  const c = start(t, { enabled: true, mode: 'freeze', hotkeyAlt: 'CommandOrControl+Alt+L' });
  await shortcuts.get('CommandOrControl+Alt+D')();
  const w = c.overlay();
  assert.equal(captures, 1);
  const init = await handlers.get('screen-draw:ready')(c.ev(w));
  assert.equal(init.mode, 'freeze');
  assert.match(init.image, /^data:image\/png/);
  listeners.get('screen-draw:close')(c.ev(w));
  await shortcuts.get('CommandOrControl+Alt+L')();
  const live = await handlers.get('screen-draw:ready')(c.ev(c.overlay()));
  assert.equal(live.mode, 'live');
});

test('without permission to read the screen (macOS), freeze falls back to live and says why', async (t) => {
  const c = start(t, { enabled: true, mode: 'freeze' });
  accessStatus = 'denied';
  t.after(() => { accessStatus = 'granted'; });
  await panel('screen-draw:open', 'freeze');
  const init = await handlers.get('screen-draw:ready')(c.ev(c.overlay()));
  assert.equal(init.mode, process.platform === 'darwin' ? 'live' : 'freeze');
  if (process.platform === 'darwin') assert.equal(init.note, 'mac-permission');
});

test('nobody but the overlay is listened to, and it can only change its own tools', async (t) => {
  const c = start(t, { enabled: true });
  await panel('screen-draw:open', 'live');
  const w = c.overlay();
  const stranger = { sender: { id: 'elsewhere' } };
  assert.equal(await handlers.get('screen-draw:ready')(stranger), null);
  listeners.get('screen-draw:close')(stranger);
  assert.equal(w.destroyed, false, 'a stranger cannot close it');
  listeners.get('screen-draw:prefs')(c.ev(w), { color: '#34c759', width: 12, hotkey: 'Alt+X', enabled: false });
  const after = await panel('screen-draw:get');
  assert.equal(after.hotkey, 'CommandOrControl+Alt+D', 'the hotkey is not the overlay\'s to change');
  assert.equal(after.enabled, true);
  const init = await handlers.get('screen-draw:ready')(c.ev(w));
  assert.equal(init.prefs.color, '#34c759');
  assert.equal(init.prefs.width, 12);
});

test('freezing a live drawing takes the overlay off the screen for the picture', async (t) => {
  const c = start(t, { enabled: true });
  await panel('screen-draw:open', 'live');
  const w = c.overlay();
  const seen = [];
  const original = electronStub.desktopCapturer.getSources;
  electronStub.desktopCapturer.getSources = async () => { seen.push(w.opacity); return original(); };
  t.after(() => { electronStub.desktopCapturer.getSources = original; });
  const r = await handlers.get('screen-draw:freeze')(c.ev(w));
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [0], 'invisible while the screen was captured');
  assert.equal(w.opacity, 1, 'and back afterwards');
});

test('click-through lets the mouse go, the toolbar takes it back, the hotkey resumes drawing', async (t) => {
  const c = start(t, { enabled: true });
  await panel('screen-draw:open', 'live');
  const w = c.overlay();
  listeners.get('screen-draw:pass-through')(c.ev(w), true);
  assert.equal(w.ignore, true);
  assert.deepEqual(w.sent.at(-1), ['screen-draw:state', { passThrough: true }]);
  listeners.get('screen-draw:hover-ui')(c.ev(w), true);
  assert.equal(w.ignore, false, 'over the toolbar');
  listeners.get('screen-draw:hover-ui')(c.ev(w), false);
  assert.equal(w.ignore, true);
  await shortcuts.get('CommandOrControl+Alt+D')();
  assert.equal(w.destroyed, false, 'not closed…');
  assert.equal(w.ignore, false, '…back to drawing');
});

test('a drawing is saved as a PNG in Pictures, or copied', async (t) => {
  const c = start(t, { enabled: true });
  await panel('screen-draw:open', 'live');
  const w = c.overlay();
  const saved = await handlers.get('screen-draw:save')(c.ev(w), { image: 'data:image/png;base64,QUJD' });
  assert.equal(saved.ok, true);
  const dir = path.join(c.dir, 'main drawings');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^Drawing \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), 'FROM-PAGE');
  const bad = await handlers.get('screen-draw:save')(c.ev(w), { image: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.equal(bad.ok, false, 'only a PNG data URL is accepted');
  const live = await handlers.get('screen-draw:copy')(c.ev(w), { live: true });
  assert.equal(live.ok, true);
  assert.equal(clipboardWrites.length, 1, 'a live drawing is the screen itself, captured by main');
});

test('started from the panel, the launcher steps aside and comes back after', async (t) => {
  const c = start(t, { enabled: true });
  const opening = panel('screen-draw:open', 'live');
  assert.equal(c.mainWin.visible, false, 'hidden before the overlay opens');
  await opening;
  listeners.get('screen-draw:close')(c.ev(c.overlay()));
  assert.equal(c.mainWin.visible, true, 'back when the drawing is put away');
});

test('a hotkey another app owns is reported, not silently lost', async (t) => {
  start(t, { enabled: true });
  const r = await panel('screen-draw:set-prefs', { hotkey: 'Taken+Key' });
  assert.deepEqual(r.failed, ['hotkey']);
  assert.equal(shortcuts.has('Taken+Key'), false);
});
