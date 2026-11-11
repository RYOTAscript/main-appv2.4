'use strict';

// main/miniPlayer.js end to end, with Electron and Spotify stubbed and the clock
// virtual: what reaches the corner window, and when. Spotify's state lags behind
// its commands, requests fail on flaky connections and songs end between polls,
// and each of those used to show up as the card bouncing or vanishing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

// The stub Electron: only what the module touches.
const ipc = { handlers: new Map(), listeners: new Map() };
const windows = [];
const displays = { scale: 1 };
let reducedMotion = false;

class StubWindow {
  constructor(opts) {
    this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
    this.visible = false;
    this.destroyed = false;
    this.opacity = 1;
    this.events = {};
    this.sent = [];
    this.shows = 0;
    this.hides = 0;
    this.moves = 0;
    this.webContents = {
      send: (channel, payload) => { this.sent.push({ channel, payload }); },
      on() {},
      setWindowOpenHandler() {},
      getURL: () => ''
    };
    windows.push(this);
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  on(ev, fn) { this.events[ev] = fn; }
  loadFile() { return Promise.resolve(); }
  getBounds() { return Object.assign({}, this.bounds); }
  setBounds(b) { this.bounds = Object.assign({}, b); this.moves++; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  showInactive() { this.visible = true; this.shows++; }
  hide() { this.visible = false; this.hides++; }
  destroy() { this.destroyed = true; this.visible = false; }
  setOpacity(o) { this.opacity = o; }
  getOpacity() { return this.opacity; }
  static fromWebContents(wc) { return windows.find((w) => w.webContents === wc) || null; }
}

const area = { x: 0, y: 0, width: 1920, height: 1040 };
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
    getAllDisplays: () => [{ id: 1, workArea: area, scaleFactor: displays.scale }],
    getPrimaryDisplay: () => ({ id: 1, workArea: area, scaleFactor: displays.scale }),
    getDisplayMatching: (b) => ({ id: 1, workArea: area, scaleFactor: b.x > 1500 ? displays.scale : 1 }),
    on() {}
  },
  powerMonitor: { on() {} },
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }) }
};
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub
};

const miniPlayer = require(path.join(ROOT, 'main', 'miniPlayer.js'));
const E = require(path.join(ROOT, 'renderer', 'mini-player-engine.js'));

const SONG = { id: 'a', name: 'Song', artist: 'Artist', album: 'Album', image: '', duration_ms: 200000 };
const OTHER = { id: 'b', name: 'Other', artist: 'Artist', album: 'Album', image: '', duration_ms: 200000 };

// Spotify as main sees it: a song whose position runs on the virtual clock.
function makeSpotify() {
  const s = {
    track: SONG,
    playing: true,
    startedAt: Date.now(),
    baseMs: 60000,
    fail: false,
    polls: 0,
    gate: null,          // a promise holding the next answer back
    commands: [],
    isConnected: () => true,
    position() { return s.playing ? s.baseMs + (Date.now() - s.startedAt) : s.baseMs; },
    place(ms, playing = s.playing) { s.baseMs = ms; s.startedAt = Date.now(); s.playing = playing; },
    async getCurrentTrack() {
      s.polls++;
      if (s.gate) await s.gate;
      if (s.fail) return { connected: false };
      return {
        connected: true,
        is_playing: s.playing,
        track: Object.assign({}, s.track, { progress_ms: Math.min(s.track.duration_ms, s.position()) })
      };
    },
    async control(a) { s.commands.push(a); return { success: true }; },
    async seek(ms) { s.commands.push(['seek', ms]); return { success: true }; }
  };
  return s;
}

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

// Up and showing: Main hidden, one poll answered, the page laid out.
async function start(t, over) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  windows.length = 0;
  ipc.handlers.clear();
  ipc.listeners.clear();
  displays.scale = 1;
  reducedMotion = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-player-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'mini-player.json'), JSON.stringify({ enabled: true }));
  const mainEvents = {};
  const mainWin = {
    visible: false,
    isDestroyed: () => false,
    isVisible: () => mainWin.visible,
    isMinimized: () => false,
    on: (ev, fn) => { mainEvents[ev] = fn; },
    webContents: { send() {} }
  };
  const spotify = Object.assign(makeSpotify(), over);
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const mod = miniPlayer.init(
    { logger: quiet, appRoot: ROOT, userDataPath: dir, getMainWindow: () => mainWin, focusMainWindow() {} },
    { spotify, lyrics: { getLyrics: async () => ({ success: false }) } }
  );
  t.after(() => mod.teardown());
  const tick = async (ms, step = 50) => {
    for (let done = 0; done < ms; done += step) {
      t.mock.timers.tick(Math.min(step, ms - done));
      await flush();
    }
  };
  await tick(1600);
  const win = windows[0];
  assert.ok(win, 'the first poll opened the window');
  const event = { sender: win.webContents };
  const first = ipc.handlers.get('mini-player:ready')(event);
  assert.equal(first.presence, 'out', 'the page starts invisible');
  ipc.listeners.get('mini-player:laid-out')(event, 123);
  assert.equal(win.visible, true);
  const last = () => {
    const states = win.sent.filter((m) => m.channel === 'mini-player:state');
    return states[states.length - 1].payload;
  };
  assert.equal(last().presence, 'in', 'told to arrive once it is showing');
  const act = (a, v) => ipc.handlers.get('mini-player:action')(event, a, v);
  return { spotify, win, tick, last, act, mainWin, mainEvents, event, mod };
}

test('a poll that has not caught up does not undo a pause', async (t) => {
  const c = await start(t);
  await c.act('toggle');
  assert.equal(c.last().playing, false, 'answers at once');
  // Spotify keeps saying "playing" for a moment.
  await c.tick(1500);
  assert.ok(c.spotify.polls >= 2);
  assert.equal(c.last().playing, false, 'and the stale answer changes nothing');
  // It never did pause, in the end: after the hold, Spotify is believed.
  await c.tick(E.POLL_IDLE_MS);
  assert.equal(c.last().playing, true);
});

test('a poll that has not caught up does not undo a seek', async (t) => {
  const c = await start(t);
  await c.act('seek', 150000);
  await c.tick(1500);
  const held = E.positionAt(c.last(), Date.now());
  assert.ok(Math.abs(held - 151500) < 100, `still at the seek (${held})`);
  await c.tick(4000);
  const real = E.positionAt(c.last(), Date.now());
  assert.ok(real < 80000, `Spotify is believed again after the hold (${real})`);
});

test('a failed seek lets go of its hold straight away', async (t) => {
  const c = await start(t, { seek: async () => ({ success: false }) });
  await c.act('seek', 150000);
  await c.tick(800);
  assert.ok(E.positionAt(c.last(), Date.now()) < 80000);
});

test('a failed poll or two does not hide the card', async (t) => {
  const c = await start(t);
  c.spotify.fail = true;
  await c.tick(E.POLL_PLAYING_MS * 3 - 200);
  assert.equal(c.win.hides, 0, 'it carries on through a flaky moment');
  assert.ok(c.last().track, 'with the song still showing');
  await c.tick(E.POLL_PLAYING_MS * 2);
  assert.equal(c.last().track, null, 'until it really has gone');
  await c.tick(500);
  assert.equal(c.win.hides, 1);

  c.spotify.fail = false;
  await c.tick(E.POLL_OFFLINE_MS);
  assert.equal(c.win.visible, true, 'and it comes back');
  assert.equal(c.last().presence, 'in');
});

test('a skip is chased at a quicker pace until the new song shows', async (t) => {
  const c = await start(t);
  await c.tick(100);
  const before = c.spotify.polls;
  await c.act('next');
  await c.tick(2000);
  const chased = c.spotify.polls - before;
  assert.ok(chased >= 3, `looked ${chased} times in 2s, not just once`);
  assert.equal(c.last().track.id, 'a');
  c.spotify.track = OTHER;
  c.spotify.place(0);
  await c.tick(600);
  assert.equal(c.last().track.id, 'b', 'the new song lands quickly');
  const settled = c.spotify.polls;
  await c.tick(E.POLL_PLAYING_MS * 2);
  assert.ok(c.spotify.polls - settled <= 2, 'and the pace goes back to normal');
});

test('the next song lands right after this one ends, and a stuck state stops the rush', async (t) => {
  const c = await start(t);
  c.spotify.place(199000);
  await c.tick(E.POLL_PLAYING_MS);   // a poll hears we're near the end
  c.spotify.track = OTHER;
  c.spotify.place(0);
  await c.tick(E.POLL_EDGE_MIN_MS + 200);
  assert.equal(c.last().track.id, 'b', 'far sooner than a whole poll late');

  // A song that claims to be ending and never does.
  c.spotify.track = SONG;
  c.spotify.place(199900, false);
  c.spotify.getCurrentTrack = async () => {
    c.spotify.polls++;
    return { connected: true, is_playing: true, track: Object.assign({}, SONG, { progress_ms: 199950 }) };
  };
  await c.tick(E.POLL_PLAYING_MS + 100);
  const before = c.spotify.polls;
  await c.tick(30000);
  const polls = c.spotify.polls - before;
  assert.ok(polls <= 6 + 13, `${polls} polls in 30s: quick polls are a moment, not a habit`);
});

test('leaving plays out before the window hides, and coming back cancels it', async (t) => {
  const c = await start(t);
  c.mainWin.visible = true;
  c.mainEvents.show();
  assert.equal(c.last().presence, 'out', 'told at once');
  assert.equal(c.win.visible, true, 'still up while the exit plays');
  await c.tick(150);
  assert.equal(c.win.visible, true);
  await c.tick(100);
  assert.equal(c.win.visible, false);
  assert.equal(c.win.hides, 1);

  // And when Main goes away again mid-exit, it stays.
  c.mainWin.visible = false;
  c.mainEvents.hide();
  await c.tick(1000);
  assert.equal(c.win.visible, true);
  assert.equal(c.last().presence, 'in');
  c.mainWin.visible = true;
  c.mainEvents.show();
  await c.tick(50);
  c.mainWin.visible = false;
  c.mainEvents.hide();
  await c.tick(1000);
  assert.equal(c.win.hides, 1, 'the pending hide was cancelled');
  assert.equal(c.win.visible, true);
  assert.equal(c.last().presence, 'in');

  // Wanted again mid-exit while Spotify is slow to answer: the window must not
  // sit there with an invisible card in it until the answer lands.
  c.mainWin.visible = true;
  c.mainEvents.show();
  await c.tick(50);
  c.spotify.gate = new Promise(() => {});
  c.mainWin.visible = false;
  c.mainEvents.hide();
  assert.equal(c.last().presence, 'out', 'mid-exit');
  await c.tick(200);
  assert.equal(c.win.visible, true);
  assert.equal(c.last().presence, 'in', 'back as soon as the exit would have ended');
  assert.equal(c.win.hides, 1);
});

test('coming into view waits for an up-to-date song, but not for long', async (t) => {
  const c = await start(t);
  c.mainWin.visible = true;
  c.mainEvents.show();
  await c.tick(400);
  assert.equal(c.win.visible, false);
  // The song changes while Main is open and nobody polls.
  c.spotify.track = OTHER;
  c.spotify.place(5000);
  let release;
  c.spotify.gate = new Promise((r) => { release = r; });
  c.mainWin.visible = false;
  c.mainEvents.hide();
  await c.tick(300);
  assert.equal(c.win.visible, false, 'not with the old song');
  release();
  c.spotify.gate = null;
  await c.tick(50);
  assert.equal(c.win.visible, true);
  assert.equal(c.last().track.id, 'b', 'arrives with the new one');
  assert.equal(c.last().presence, 'in');

  // A network that never answers doesn't keep it away.
  c.mainWin.visible = true;
  c.mainEvents.show();
  await c.tick(400);
  c.spotify.gate = new Promise(() => {});
  c.mainWin.visible = false;
  c.mainEvents.hide();
  await c.tick(1000);
  assert.equal(c.win.visible, true);
});

test('the position is timed from the middle of the request', async (t) => {
  const c = await start(t);
  let release;
  c.spotify.gate = new Promise((r) => { release = r; });
  const answer = c.spotify.getCurrentTrack;
  let asked = null;
  c.spotify.getCurrentTrack = () => { asked = Date.now(); return answer(); };
  await c.tick(E.POLL_PLAYING_MS);
  assert.ok(asked, 'the poll has gone out');
  await c.tick(800);
  release();
  c.spotify.gate = null;
  await flush();
  assert.equal(c.last().at, asked + (Date.now() - asked) / 2, 'not when the answer landed');
});

test('let go of it and it eases into the corner, except where it can\'t', async (t) => {
  const c = await start(t);
  const home = c.win.getBounds();
  c.win.bounds = Object.assign({}, home, { x: home.x - 300, y: home.y - 200 });
  c.win.moves = 0;
  c.win.events.moved();
  await c.tick(120, 16);
  assert.ok(c.win.moves >= 3, 'in steps');
  assert.notEqual(c.win.getBounds().x, home.x, 'still on its way');
  await c.tick(200, 16);
  assert.deepEqual(c.win.getBounds(), home, 'and lands exactly');
  const steps = c.win.moves;
  await c.tick(200, 16);
  assert.equal(c.win.moves, steps, 'then stops');

  reducedMotion = true;
  c.win.bounds = Object.assign({}, home, { x: home.x - 300 });
  c.win.moves = 0;
  c.win.events.moved();
  assert.equal(c.win.moves, 1, 'reduced motion: one step');
  assert.deepEqual(c.win.getBounds(), home);
  reducedMotion = false;

  displays.scale = 1.5;       // the corner sits on a monitor of another scale
  c.win.bounds = Object.assign({}, home, { x: 200 });
  c.win.moves = 0;
  c.win.events.moved();
  assert.equal(c.win.moves <= 1, true, 'crossing scales: one step');
});
