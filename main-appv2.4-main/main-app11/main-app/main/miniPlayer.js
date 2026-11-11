// Corner Player mini widget — a tiny always-on-top Spotify player that tucks
// into a screen corner, with an optional live lyric line.
//
// Why main owns it: the launcher's own Spotify polling runs in the renderer,
// and a hidden BrowserWindow throttles its timers (see CLAUDE.md) — but the
// corner player matters most exactly while the launcher sits hidden in the
// tray. So this module polls Spotify itself, through the same functions the
// renderer's IPC uses (main/spotify.js), and only while the corner player
// could be on screen. Lyrics come from main/lyrics.js and share its cache.
//
// The corner window has its OWN narrow preload (mini-player-preload.js), never
// the app preload. Every message it sends is checked to come from that window,
// and it can only ask for MINI_ACTIONS. Placement, visibility and lyric timing
// come from renderer/mini-player-engine.js, which the window's page shares.
//
// Storage (userData): mini-player.json, written atomically (temp file + rename).

const { app, ipcMain, BrowserWindow, Menu, screen, powerMonitor, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lockNavigation } = require('./windowGuard');
const { isMac } = require('./platform');
const E = require('../renderer/mini-player-engine');

// What the corner window may ask for. Settings change from the launcher's
// panel, or from the window's right-click menu, which main builds itself.
const MINI_ACTIONS = new Set(['toggle', 'next', 'previous', 'seek']);
// A command's result outlives a poll that hasn't caught up (see applyHolds).
const HOLD_MS = 2500;
// After a skip, how long to keep looking for the new song at a quicker pace.
const CHASE_MS = 3000;
// Quicker polls are for moments, never a habit: a state that stays stuck falls
// back to the usual pace after this many.
const MAX_HURRIED_POLLS = 6;
// One failed request isn't "Spotify went away": the clock carries on through this
// many before the card gives up on the song.
const MAX_MISSED_POLLS = 3;
// How long the card's exit gets before the window hides (leaveCard in the page).
const LEAVE_MS = 200;
// Main coming and going: the longest the card waits for an up-to-date song.
const ARRIVE_WAIT_MS = 900;
// The window easing into its corner.
const SNAP_MS = 240;
// Album art is only ever a Spotify CDN https URL; anything else is dropped.
const HTTPS_IMAGE = /^https:\/\/[^\s"'<>\\]+$/i;
const CORNER_LABELS = {
  'top-left': 'Top left', 'top-right': 'Top right', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right'
};

function init(ctx, deps) {
  const { logger, appRoot } = ctx;
  const spotify = deps && deps.spotify;
  const lyrics = deps && deps.lyrics;
  const STORE_PATH = path.join(ctx.userDataPath, 'mini-player.json');

  let prefs = E.sanitizePrefs(readJson(STORE_PATH));
  let win = null;
  let winReady = false;   // the page has asked for its first state
  let cardHeight = 0;     // last card height the page reported
  let failed = false;     // the page failed to load — don't reopen until restart
  let pollTimer = null;
  let polling = false;
  let saveTimer = null;
  let layoutFallback = null;
  let leaveTimer = null;
  let arriveTimer = null;
  let snapTimer = null;
  let movedTimer = null;
  let presence = 'out';   // what the page has been told: 'in' on screen, 'out' leaving or hidden
  let holds = {};
  let chase = null;       // a skip waiting to show up: the song it should replace, and until when
  let hurriedPolls = 0;
  let missedPolls = 0;
  let tornDown = false;
  let immersive = false;
  let dismissedKey = null;
  let sample = { connected: false, playing: false, progressMs: 0, at: 0, track: null };
  let lyricsState = { key: null, status: 'none', synced: false, lines: [] };

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger.warn('Corner player: unreadable mini-player.json, starting fresh', { error: e.message });
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
      logger.error('Corner player: failed to save mini-player.json', e);
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  // ── State ───────────────────────────────────────────────────────────────

  function publicPrefs() {
    return {
      enabled: prefs.enabled, lyrics: prefs.lyrics, style: prefs.style,
      showWhen: prefs.showWhen, corner: prefs.corner
    };
  }

  function payload() {
    const key = E.trackKey(sample.track);
    const lyr = key && lyricsState.key === key
      ? { status: lyricsState.status, synced: lyricsState.synced, lines: lyricsState.lines }
      : { status: 'none', synced: false, lines: [] };
    return {
      presence,
      prefs: { lyrics: prefs.lyrics, style: prefs.style, accent: prefs.accent, anticipateMs: prefs.anticipateMs, corner: prefs.corner },
      track: sample.track,
      playing: sample.playing,
      progressMs: sample.progressMs,
      at: sample.at,
      lyrics: lyr
    };
  }

  function sendMain(channel, data) {
    const w = ctx.getMainWindow && ctx.getMainWindow();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, data); } catch (e) { /* window going away */ }
    }
  }

  function pushState() {
    if (!win || win.isDestroyed() || !winReady) return;
    try { win.webContents.send('mini-player:state', payload()); } catch (e) { /* window going away */ }
  }

  function mainVisible() {
    const w = ctx.getMainWindow && ctx.getMainWindow();
    return !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized());
  }

  function wanted() {
    return E.shouldShow({
      enabled: prefs.enabled,
      hasTrack: !!sample.track,
      showWhen: prefs.showWhen,
      mainVisible: mainVisible(),
      immersive,
      dismissedKey,
      trackKey: E.trackKey(sample.track)
    });
  }

  // ── Spotify polling ─────────────────────────────────────────────────────
  // Only while the corner player could be on screen. With "only while Main is
  // hidden", the launcher's own player is the one polling while it's open.

  function needsPolling() {
    return !tornDown && prefs.enabled && !!spotify && (prefs.showWhen === 'always' || !mainVisible());
  }

  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (needsPolling()) pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    pollTimer = null;
    if (!needsPolling() || polling) return;
    // Not connected to Spotify at all: nothing to ask, and asking would log a
    // "not connected" warning every few seconds.
    if (spotify.isConnected && !spotify.isConnected()) {
      if (sample.track) applySample(null);
      reconcile();
      schedulePoll(E.POLL_OFFLINE_MS);
      return;
    }
    polling = true;
    const asked = Date.now();
    try {
      const data = await spotify.getCurrentTrack();
      if (data && data.connected === false && sample.track && ++missedPolls <= MAX_MISSED_POLLS) {
        logger.debug('Corner player: a Spotify poll failed, carrying on', { missed: missedPolls });
      } else {
        missedPolls = 0;
        // Spotify read the position somewhere during the request; the midpoint
        // is the best guess at when.
        applySample(data, asked + (Date.now() - asked) / 2);
      }
    } catch (e) {
      logger.warn('Corner player: Spotify poll failed', { error: e && e.message });
    } finally {
      polling = false;
    }
    reconcile();
    schedulePoll(pollWait());
  }

  function pollWait() {
    const now = Date.now();
    const usual = E.pollDelay(sample, now);
    if (chase && (now >= chase.until || E.trackKey(sample.track) !== chase.key)) chase = null;
    const wait = chase ? Math.min(usual, E.POLL_CHASE_MS) : usual;
    if (wait >= E.POLL_PLAYING_MS) {
      hurriedPolls = 0;
      return wait;
    }
    return ++hurriedPolls > MAX_HURRIED_POLLS ? E.POLL_PLAYING_MS : wait;
  }

  function hold(field, value) {
    const now = Date.now();
    holds[field] = { value, at: now, until: now + HOLD_MS, key: E.trackKey(sample.track) };
  }

  // Spotify can go on reporting the old state for a couple of seconds after a
  // command, and the card would bounce back to it and forward again. Same rule as
  // the Phone Remote (main/phoneRemoteHost.js).
  function applyHolds(s) {
    const key = E.trackKey(s.track);
    for (const field of ['playing', 'progressMs']) {
      const h = holds[field];
      if (!h) continue;
      if (s.at >= h.until || h.key !== key) delete holds[field];
      else s[field] = field === 'progressMs' ? h.value + (s.playing ? s.at - h.at : 0) : h.value;
    }
  }

  function applySample(data, heardAt) {
    const t = data && data.connected && data.track ? data.track : null;
    const before = E.trackKey(sample.track);
    sample = {
      connected: !!(data && data.connected),
      playing: !!(t && data.is_playing),
      progressMs: t ? Math.max(0, Number(t.progress_ms) || 0) : 0,
      at: Number.isFinite(heardAt) ? heardAt : Date.now(),
      track: t ? {
        id: t.id ? String(t.id) : '',
        name: String(t.name || ''),
        artist: String(t.artist || ''),
        album: String(t.album || ''),
        image: typeof t.image === 'string' && HTTPS_IMAGE.test(t.image) ? t.image : '',
        durationMs: Math.max(0, Number(t.duration_ms) || 0)
      } : null
    };
    applyHolds(sample);
    const after = E.trackKey(sample.track);
    if (after !== before) {
      // "Hide until the next song" lasts exactly that long.
      if (dismissedKey && dismissedKey !== after) dismissedKey = null;
      ensureLyrics();
    }
    pushState();
  }

  // ── Lyrics ──────────────────────────────────────────────────────────────

  function ensureLyrics() {
    const track = sample.track;
    const key = E.trackKey(track);
    if (!prefs.lyrics || !track || !lyrics || lyricsState.key === key) return;
    lyricsState = { key, status: 'loading', synced: false, lines: [] };
    Promise.resolve(lyrics.getLyrics(track.name, track.artist, track.album, track.durationMs))
      .then((res) => {
        if (lyricsState.key !== key) return; // a newer song took over meanwhile
        if (res && res.success && Array.isArray(res.lyrics)) {
          lyricsState = {
            key,
            status: 'ready',
            synced: !!res.synced,
            lines: res.lyrics.map((l) => ({ t: Number.isFinite(l.time) ? l.time : null, text: String(l.text || '') }))
          };
        } else {
          lyricsState = { key, status: 'none', synced: false, lines: [] };
        }
        pushState();
      })
      .catch((e) => {
        logger.warn('Corner player: lyrics lookup failed', { error: e && e.message });
        if (lyricsState.key === key) lyricsState = { key, status: 'none', synced: false, lines: [] };
        pushState();
      });
  }

  // ── The window ──────────────────────────────────────────────────────────

  function targetBounds() {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => d.id === prefs.displayId) || screen.getPrimaryDisplay();
    const size = E.windowSize(cardHeight || (prefs.lyrics ? 118 : 72));
    const pos = E.cornerPosition(display.workArea, size, prefs.corner);
    return { x: pos.x, y: pos.y, width: size.width, height: size.height };
  }

  function stopSnap() {
    clearInterval(snapTimer);
    snapTimer = null;
  }

  function placeWindow() {
    if (!win || win.isDestroyed()) return;
    stopSnap();
    const want = targetBounds();
    const b = win.getBounds();
    if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) {
      win.setBounds(want);
    }
  }

  function reducedMotion() {
    try {
      return !!systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch (e) {
      return false;
    }
  }

  // Let go of it, or told to move: it eases into its corner instead of teleporting.
  function glideWindow() {
    if (!win || win.isDestroyed()) return;
    const want = targetBounds();
    const from = win.getBounds();
    // A window crossing between monitors of different scale gets resized on the
    // way, so that move is made in one step.
    const sameScale = screen.getDisplayMatching(from).scaleFactor === screen.getDisplayMatching(want).scaleFactor;
    if (!win.isVisible() || !sameScale || reducedMotion() || (from.x === want.x && from.y === want.y)) {
      placeWindow();
      return;
    }
    stopSnap();
    const started = Date.now();
    snapTimer = setInterval(() => {
      if (!win || win.isDestroyed()) {
        stopSnap();
        return;
      }
      const t = (Date.now() - started) / SNAP_MS;
      win.setBounds(E.snapStep(from, want, t));
      if (t >= 1) stopSnap();
    }, 16);
  }

  // Coming and going. The page plays its own entrance and exit: main shows the
  // window and says 'in', or says 'out' and hides the window once that has played.
  function enter() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    if (presence !== 'in') {
      presence = 'in';
      pushState();
    }
  }

  function leave() {
    if (!win || win.isDestroyed() || !win.isVisible() || leaveTimer) return;
    presence = 'out';
    pushState();
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!win || win.isDestroyed()) return;
      // Wanted again while it was leaving: never leave the window up with an
      // invisible card in it.
      if (wanted()) enter();
      else win.hide();
    }, LEAVE_MS);
  }

  function reconcile() {
    if (tornDown || failed) return;
    if (wanted()) {
      if (!win || win.isDestroyed()) createWindow();
      // It appears once the page has laid out (see 'mini-player:laid-out').
      else if (winReady && cardHeight) enter();
    } else {
      leave();
    }
  }

  function createWindow() {
    winReady = false;
    cardHeight = 0;
    presence = 'out';
    const w = new BrowserWindow({
      ...targetBounds(),
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
      title: 'Corner player',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: !app.isPackaged,
        // An always-on-top HUD: a throttled window would freeze its progress
        // bar and lyric line whenever Chromium decides it's occluded.
        backgroundThrottling: false,
        preload: path.join(appRoot, 'mini-player-preload.js')
      }
    });
    win = w;
    lockNavigation(w, logger);
    // 'screen-saver' keeps it above borderless games and other topmost windows.
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // A transparent window whose page fails to load still opens — as an
    // invisible rectangle over the desktop. Close it and say so instead.
    w.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Corner player page failed to load', null, { code, desc });
      failed = true;
      destroyWindow();
    });
    // macOS reports every step of a drag as 'moved'; Windows only the end of one.
    w.on('moved', () => {
      if (!isMac) {
        onMoved(w);
        return;
      }
      clearTimeout(movedTimer);
      movedTimer = setTimeout(() => onMoved(w), 160);
    });
    // Right-clicking a drag region on Windows opens the native system menu;
    // show the corner player's own menu instead.
    w.on('system-context-menu', (e) => { e.preventDefault(); popupMenu(); });
    w.on('closed', () => {
      if (win === w) { win = null; winReady = false; }
    });
    w.loadFile(path.join(appRoot, 'mini-player.html')).catch((e) => {
      logger.error('Failed to load the corner player page', e);
    });
  }

  function destroyWindow() {
    clearTimeout(layoutFallback);
    layoutFallback = null;
    clearTimeout(leaveTimer);
    leaveTimer = null;
    clearTimeout(arriveTimer);
    arriveTimer = null;
    clearTimeout(movedTimer);
    movedTimer = null;
    stopSnap();
    const w = win;
    win = null;
    winReady = false;
    cardHeight = 0;
    presence = 'out';
    if (w && !w.isDestroyed()) w.destroy();
  }

  // Dragged somewhere: snap into the nearest corner of that screen, and
  // remember it.
  function onMoved(w) {
    // Its own glide moves it too, and macOS reports those steps as well.
    if (w !== win || w.isDestroyed() || snapTimer) return;
    const b = w.getBounds();
    const display = screen.getDisplayMatching(b);
    const corner = E.nearestCorner(b, display.workArea);
    if (corner !== prefs.corner || display.id !== prefs.displayId) {
      prefs = Object.assign({}, prefs, { corner, displayId: display.id });
      saveSoon();
      sendMain('mini-player:changed', publicPrefs());
    }
    glideWindow();
  }

  // Changing the look resizes the window AND restyles the page, and the two
  // land at different moments. So the window goes invisible, the page gets
  // its new look first, and it only reappears once the page has reported its
  // new height (see the Timers floating windows for the same handshake).
  function hideForLayout() {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    clearTimeout(layoutFallback);
    try { win.setOpacity(0); } catch (e) { /* window going away */ }
    // Never leave it invisible if the page misses its cue.
    layoutFallback = setTimeout(revealAfterLayout, 450);
  }

  function revealAfterLayout() {
    clearTimeout(layoutFallback);
    layoutFallback = null;
    if (win && !win.isDestroyed() && win.getOpacity() < 1) win.setOpacity(1);
  }

  // A monitor unplugged or a resolution change must never strand it off-screen.
  screen.on('display-removed', placeWindow);
  screen.on('display-metrics-changed', placeWindow);

  function popupMenu() {
    if (!win || win.isDestroyed()) return;
    const radio = (label, key, value) => ({
      label, type: 'radio', checked: prefs[key] === value, click: () => setPrefs({ [key]: value })
    });
    const hasTrack = !!sample.track;
    const items = [
      { label: sample.playing ? 'Pause' : 'Play', enabled: hasTrack, click: () => act('toggle') },
      { label: 'Next song', enabled: hasTrack, click: () => act('next') },
      { label: 'Previous song', enabled: hasTrack, click: () => act('previous') },
      { type: 'separator' },
      { label: 'Show the lyric line', type: 'checkbox', checked: prefs.lyrics, click: () => setPrefs({ lyrics: !prefs.lyrics }) },
      { label: 'Style', submenu: [radio('Glass', 'style', 'glass'), radio('White', 'style', 'white')] },
      { label: 'Show', submenu: [radio('Only while Main is hidden', 'showWhen', 'hidden'), radio('Always while music plays', 'showWhen', 'always')] },
      { label: 'Move to corner', submenu: E.CORNERS.map((c) => radio(CORNER_LABELS[c], 'corner', c)) },
      { type: 'separator' },
      { label: 'Open Main', click: () => { try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ } } },
      { label: 'Hide until the next song', enabled: hasTrack, click: () => dismiss() },
      { label: 'Turn off the corner player', click: () => turnOff() }
    ];
    try {
      Menu.buildFromTemplate(items).popup({ window: win });
    } catch (e) {
      logger.warn('Corner player: could not open its menu', { error: e && e.message });
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  async function act(action, arg) {
    if (!spotify || !sample.track) return { ok: false };
    if (action === 'seek') {
      const ms = Math.round(Number(arg));
      if (!Number.isFinite(ms)) return { ok: false };
      const target = Math.max(0, sample.track.durationMs ? Math.min(ms, sample.track.durationMs) : ms);
      sample = Object.assign({}, sample, { progressMs: target, at: Date.now() });
      hold('progressMs', target);
      pushState();
      const r = await spotify.seek(target);
      if (!(r && r.success)) delete holds.progressMs;
      schedulePoll(500);
      return { ok: !!(r && r.success) };
    }
    if (action === 'toggle') {
      const play = !sample.playing;
      // Flip it now and let the next poll correct it, so the button answers
      // instantly instead of after Spotify's round trip.
      sample = Object.assign({}, sample, { playing: play, progressMs: E.positionAt(sample, Date.now()), at: Date.now() });
      hold('playing', play);
      pushState();
      const r = await spotify.control(play ? 'play' : 'pause');
      if (!(r && r.success)) delete holds.playing;
      schedulePoll(600);
      return { ok: !!(r && r.success) };
    }
    chase = { key: E.trackKey(sample.track), until: Date.now() + CHASE_MS };
    const r = await spotify.control(action === 'previous' ? 'previous' : 'next');
    schedulePoll(400);
    return { ok: !!(r && r.success) };
  }

  function dismiss() {
    dismissedKey = E.trackKey(sample.track);
    reconcile();
  }

  function expand() {
    try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ }
    sendMain('mini-player:open-fullscreen');
  }

  function turnOff() {
    setEnabled(false);
    // The widget's on/off switch lives in the renderer's registry prefs.
    sendMain('mini-player:turned-off');
  }

  // ── Settings ────────────────────────────────────────────────────────────

  function setEnabled(on) {
    const enabled = !!on;
    if (prefs.enabled !== enabled) {
      prefs = Object.assign({}, prefs, { enabled });
      saveSoon();
      sendMain('mini-player:changed', publicPrefs());
    }
    if (enabled) {
      failed = false;
      if (!pollTimer && !polling) schedulePoll(0);
    } else {
      clearTimeout(pollTimer);
      pollTimer = null;
      destroyWindow();
    }
    return publicPrefs();
  }

  function setPrefs(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    const before = prefs;
    const next = {};
    for (const k of ['lyrics', 'style', 'showWhen', 'corner']) if (k in p) next[k] = p[k];
    prefs = E.sanitizePrefs(Object.assign({}, prefs, next));
    saveSoon();
    if (prefs.lyrics && !before.lyrics) ensureLyrics();
    if (win && !win.isDestroyed()) {
      if (prefs.style !== before.style || prefs.lyrics !== before.lyrics) hideForLayout();
      pushState();
      if (prefs.corner !== before.corner) glideWindow();
      else placeWindow();
    }
    if (prefs.showWhen !== before.showWhen) schedulePoll(0);
    reconcile();
    sendMain('mini-player:changed', publicPrefs());
    return publicPrefs();
  }

  // The two things main can't see on its own: the launcher's accent colour
  // and its lyrics timing offset.
  function sync(data) {
    const d = data && typeof data === 'object' ? data : {};
    const next = E.sanitizePrefs(Object.assign({}, prefs, {
      accent: d.accent != null ? d.accent : prefs.accent,
      anticipateMs: d.anticipateMs != null ? Number(d.anticipateMs) : prefs.anticipateMs
    }));
    if (next.accent !== prefs.accent || next.anticipateMs !== prefs.anticipateMs) {
      prefs = next;
      saveSoon();
      pushState();
    }
    return { ok: true };
  }

  function setImmersive(on) {
    immersive = !!on;
    reconcile();
  }

  // ── Following the launcher window ───────────────────────────────────────
  // "Only while Main is hidden": start polling the moment it hides, stop when
  // it comes back.

  function onMainVisibility() {
    if (needsPolling()) {
      schedulePoll(0);
      // Coming into view: poll() reconciles when it lands, so the card arrives
      // showing the song playing now, not the one from when Main was opened.
      if (wanted()) {
        clearTimeout(arriveTimer);
        arriveTimer = setTimeout(reconcile, ARRIVE_WAIT_MS);
        return;
      }
    } else {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    reconcile();
  }

  const mainWin = ctx.getMainWindow && ctx.getMainWindow();
  if (mainWin && !mainWin.isDestroyed()) {
    for (const ev of ['show', 'hide', 'minimize', 'restore']) mainWin.on(ev, onMainVisibility);
  }

  // ── IPC: the launcher's panel ───────────────────────────────────────────

  function handle(channel, fn) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        logger.error(`Corner player: ${channel} failed`, e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('mini-player:get', () => publicPrefs());
  handle('mini-player:set-enabled', (on) => setEnabled(on));
  handle('mini-player:set-prefs', (patch) => setPrefs(patch));
  handle('mini-player:sync', (data) => sync(data));

  // ── IPC: the corner window ──────────────────────────────────────────────
  // Anything not sent by the live corner window itself is ignored.

  function fromCorner(event) {
    const w = BrowserWindow.fromWebContents(event.sender);
    return !!(w && win && w === win && !w.isDestroyed());
  }

  ipcMain.removeHandler('mini-player:ready');
  ipcMain.handle('mini-player:ready', (event) => {
    if (!fromCorner(event)) return null;
    winReady = true;
    return payload();
  });
  ipcMain.removeHandler('mini-player:action');
  ipcMain.handle('mini-player:action', (event, action, arg) => {
    if (!fromCorner(event) || !MINI_ACTIONS.has(action)) return { ok: false };
    return act(action, arg);
  });
  ipcMain.removeAllListeners('mini-player:laid-out');
  ipcMain.on('mini-player:laid-out', (event, height) => {
    if (!fromCorner(event)) return;
    const h = Number(height);
    if (!Number.isFinite(h) || h < 20 || h > 600) return;
    cardHeight = Math.round(h);
    placeWindow();
    revealAfterLayout();
    if (wanted()) enter();
  });
  ipcMain.removeAllListeners('mini-player:menu');
  ipcMain.on('mini-player:menu', (event) => { if (fromCorner(event)) popupMenu(); });
  ipcMain.removeAllListeners('mini-player:dismiss');
  ipcMain.on('mini-player:dismiss', (event) => { if (fromCorner(event)) dismiss(); });
  ipcMain.removeAllListeners('mini-player:expand');
  ipcMain.on('mini-player:expand', (event) => { if (fromCorner(event)) expand(); });

  // Sleep pauses Node timers; catch up on the way back.
  powerMonitor.on('resume', () => { if (needsPolling()) schedulePoll(0); });

  // Boot: deferred a moment so the launcher window exists and Spotify's
  // tokens are loaded.
  setTimeout(() => { if (!tornDown && needsPolling()) schedulePoll(0); }, 1500);

  return {
    setImmersive,
    teardown: () => {
      tornDown = true;
      clearTimeout(pollTimer);
      pollTimer = null;
      destroyWindow();
      saveNow();
    }
  };
}

module.exports = { init, MINI_ACTIONS };
