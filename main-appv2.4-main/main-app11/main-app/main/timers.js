// Timers mini widget — main-process owner of the timers, the alarms, the
// floating always-on-top timer windows and the global hotkeys.
//
// Why main and not the renderer: the old countdown lived in the renderer, and a
// hidden BrowserWindow throttles timers (see CLAUDE.md) — so a timer set before
// minimising to the tray could finish minutes late. Node timers here are not
// throttled. Same split as the Calendar: renderer/timer-engine.js holds every
// rule (shared with the UI), this file runs it and presents the results,
// renderer/timer.js is only UI.
//
// Scheduling is ONE setTimeout aimed at the next thing due (a timer's end or
// its heads-up), capped at E.WAKE_CAP and re-armed on resume from sleep — never
// a poll. What is due and what counts as missed is decided by E.scan().
//
// Floating timers: one small frameless, transparent, always-on-top window per
// popped-out timer. Each has its OWN narrow preload (timer-float-preload.js) —
// never the app preload — and main works out which timer a message is about
// from the sending window, so a floating window can only ever touch its own
// timer. Position, style, size, opacity and click-through are remembered per
// timer, and windows reopen where they were on the next launch.
//
// Storage (userData): timers.json, written atomically (temp file + rename).

const { ipcMain, BrowserWindow, Notification, Menu, screen, globalShortcut, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lockNavigation } = require('./windowGuard');
const E = require('../renderer/timer-engine');

const MAX_FLOATS = 6;
// What a floating window may ask for. Everything else (rename, delete,
// settings) is only reachable from the main app's panel.
const FLOAT_ACTIONS = new Set(['toggle', 'start', 'pause', 'resume', 'reset', 'restart', 'dismiss', 'adjust', 'lap', 'skip']);
const PANEL_ACTIONS = new Set([...FLOAT_ACTIONS, 'setDuration', 'resetCycle']);

function init(ctx) {
  const { logger, appRoot } = ctx;
  const STORE_PATH = path.join(ctx.userDataPath, 'timers.json');

  let store = E.sanitizeStore(readJson(STORE_PATH), Date.now());
  let wake = null;
  let saveTimer = null;
  let tornDown = false;
  const floats = new Map(); // timerId -> BrowserWindow
  const moveSaveTimers = new Map();
  // Electron garbage-collects an unreferenced Notification along with its
  // click handler — keep the recent ones alive.
  const liveNotes = [];
  const boundHotkeys = { toggle: null, float: null };

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      logger.warn('Timers: unreadable timers.json, starting fresh', { error: e.message });
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
      logger.error('Timers: failed to save timers.json', e);
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  // ── State out ───────────────────────────────────────────────────────────

  function publicState() {
    return {
      enabled: store.enabled,
      timers: store.timers,
      presets: store.presets,
      settings: store.settings,
      floats: store.floats,
      openFloats: [...floats.keys()],
      history: store.history,
      summary: E.summarize(store, Date.now()),
      focusId: store.focusId
    };
  }

  function sendMain(channel, payload) {
    const win = ctx.getMainWindow && ctx.getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) { /* window going away */ }
    }
  }

  function floatPrefs(id) {
    return store.floats[id] || E.sanitizeFloat(null, store.settings);
  }

  function floatPayload(id) {
    const timer = store.timers.find(t => t.id === id);
    if (!timer) return null;
    const p = floatPrefs(id);
    return {
      timer,
      prefs: { style: p.style, size: p.size, opacity: p.opacity, ghost: p.ghost },
      longEvery: store.settings.pomodoro.longEvery,
      now: Date.now()
    };
  }

  function sendFloat(id, channel, payload) {
    const win = floats.get(id);
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) { /* window going away */ }
    }
  }

  function broadcast() {
    sendMain('timer:changed', publicState());
    for (const id of floats.keys()) sendFloat(id, 'timer-float:state', floatPayload(id));
  }

  function commit() {
    saveSoon();
    broadcast();
    arm();
  }

  // ── Scheduler ───────────────────────────────────────────────────────────

  function arm() {
    clearTimeout(wake);
    wake = null;
    if (!store.enabled || tornDown) return;
    const next = E.nextDue(store, Date.now());
    if (next == null) return;
    // +2ms so the wake lands just past the due instant, not a hair before it.
    const delay = Math.max(0, Math.min(E.WAKE_CAP, next - Date.now())) + 2;
    wake = setTimeout(tick, delay);
  }

  function tick() {
    wake = null;
    if (!store.enabled || tornDown) return;
    const now = Date.now();
    const result = E.scan(store, now);
    if (result.changed) {
      store = result.store;
      saveNow();
      broadcast();
      for (const ev of result.events) present(ev, now);
    }
    arm();
  }

  function iconPath() {
    const ico = path.join(appRoot || path.join(__dirname, '..'), 'icons', 'main.ico');
    return fs.existsSync(ico) ? ico : undefined;
  }

  // One place decides how an alert is presented.
  function present(ev, now) {
    const S = store.settings;
    const words = E.describeEvent(ev, now);
    // Only a real, on-time finish rings on repeat; a heads-up is a single soft
    // blip, and something that finished while the app was closed stays silent.
    const ring = ev.type === 'done' || (ev.type === 'phase' && !ev.autoStarted);
    sendMain('timer:alert', {
      type: ev.type,
      timerId: ev.timerId,
      title: words.title,
      body: words.body,
      color: ev.color,
      missed: !!ev.missed,
      sound: ev.missed ? 'none' : S.sound,
      volume: S.volume,
      soft: ev.type === 'warn' || ev.type === 'checkpoint',
      loop: ring && !ev.missed && S.ringUntilDismissed
    });
    sendFloat(ev.timerId, 'timer-float:alert', { type: ev.type });
    if (S.notify) showNative(ev, words);
  }

  function showNative(ev, words) {
    try {
      if (!Notification.isSupported()) return;
      const main = ctx.getMainWindow && ctx.getMainWindow();
      // The in-app toast already covers a launcher you're looking at.
      if (main && !main.isDestroyed() && main.isVisible() && main.isFocused() && (ev.type === 'warn' || ev.type === 'checkpoint')) return;
      const actions = [];
      if (ev.type === 'done' && ev.kind === 'countdown') {
        actions.push({ type: 'button', text: '+1 min' }, { type: 'button', text: 'Restart' }, { type: 'button', text: 'Dismiss' });
      } else if (ev.type === 'phase' && !ev.autoStarted) {
        actions.push({ type: 'button', text: 'Start ' + (E.PHASE_LABELS[ev.next] || 'next').toLowerCase() }, { type: 'button', text: 'Dismiss' });
      }
      const n = new Notification({
        title: words.title,
        body: words.body,
        icon: iconPath(),
        // The renderer plays the widget's own sound, so the OS stays quiet.
        silent: true,
        timeoutType: ev.type === 'done' || ev.type === 'phase' ? 'never' : 'default',
        urgency: ev.type === 'done' ? 'critical' : 'normal',
        actions
      });
      n.on('click', () => {
        try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ }
        sendMain('timer:open', { timerId: ev.timerId });
      });
      n.on('action', (event, legacyIndex) => {
        const idx = event && typeof event.actionIndex === 'number' ? event.actionIndex : legacyIndex;
        const a = actions[idx];
        if (!a) return;
        if (a.text === '+1 min') act(ev.timerId, 'adjust', 60000);
        else if (a.text === 'Restart') act(ev.timerId, 'restart');
        else if (a.text === 'Dismiss') act(ev.timerId, 'dismiss');
        else if (a.text.startsWith('Start')) act(ev.timerId, 'start');
      });
      n.show();
      liveNotes.push(n);
      if (liveNotes.length > 12) liveNotes.shift();
    } catch (e) {
      logger.warn('Timers: native notification failed', { error: e && e.message });
    }
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  function findIndex(id) { return store.timers.findIndex(t => t.id === id); }

  function act(id, action, arg) {
    const i = findIndex(id);
    if (i < 0) return { ok: false, error: 'That timer no longer exists' };
    const before = store.timers[i];
    const next = E.applyAction(before, action, arg, Date.now(), store.settings);
    if (!next) return { ok: false, error: 'Unknown action' };
    const timers = store.timers.slice();
    timers[i] = next;
    store = Object.assign({}, store, { timers, focusId: id });
    const started = before.status !== 'running' && next.status === 'running';
    if (started && store.settings.autoFloat && !floats.has(id)) openFloat(id, { quiet: true });
    commit();
    return { ok: true, timer: next };
  }

  function create(opts) {
    if (store.timers.length >= E.MAX_TIMERS) return { ok: false, error: `You can keep up to ${E.MAX_TIMERS} timers — remove one first` };
    const o = opts && typeof opts === 'object' ? opts : {};
    const timer = E.createTimer(o, Date.now(), store.settings, store.timers.length, Math.random());
    if (!timer) return { ok: false, error: 'Set at least 1 second' };
    store = Object.assign({}, store, { timers: store.timers.concat(timer), focusId: timer.id });
    if (o.float || (store.settings.autoFloat && timer.status === 'running')) openFloat(timer.id, { quiet: true });
    commit();
    return { ok: true, timer };
  }

  // The pre-2.0 renderer-only countdown kept one timer in localStorage. The
  // renderer hands it over once; it arrives in the old shape and is sanitised
  // like anything else read from disk.
  function importLegacy(legacy) {
    if (!legacy || typeof legacy !== 'object' || store.timers.length >= E.MAX_TIMERS) return { ok: false };
    const now = Date.now();
    const status = ['running', 'paused', 'done'].includes(legacy.status) ? legacy.status : null;
    if (!status || !(Number(legacy.durationMs) >= 1000)) return { ok: false };
    const timer = E.sanitizeTimer({
      id: E.newId('t', now, Math.random()),
      kind: 'countdown',
      status,
      durationMs: legacy.durationMs,
      remainingMs: legacy.remainingMs,
      endAt: legacy.endTime,
      createdAt: now
    }, now, store.settings);
    if (!timer) return { ok: false };
    store = Object.assign({}, store, { timers: store.timers.concat(timer), focusId: timer.id });
    commit();
    tick();
    return { ok: true, timer };
  }

  function update(id, patch) {
    const i = findIndex(id);
    if (i < 0 || !patch || typeof patch !== 'object') return { ok: false, error: 'That timer no longer exists' };
    let t = Object.assign({}, store.timers[i]);
    if ('label' in patch) t.label = E.cleanLabel(patch.label);
    if ('color' in patch && /^#[0-9a-f]{6}$/i.test(String(patch.color))) t.color = String(patch.color).toLowerCase();
    if ('repeat' in patch && t.kind === 'countdown') {
      const r = Math.round(Number(patch.repeat));
      if (Number.isFinite(r)) t.repeat = Math.max(-1, Math.min(99, r));
      t.repeatsDone = Math.min(t.repeatsDone, Math.max(0, t.repeat));
    }
    if ('durationMs' in patch) t = E.applyAction(t, 'setDuration', patch.durationMs, Date.now(), store.settings) || t;
    const timers = store.timers.slice();
    timers[i] = E.sanitizeTimer(t, Date.now(), store.settings);
    store = Object.assign({}, store, { timers });
    commit();
    return { ok: true, timer: timers[i] };
  }

  function setCheckpointsFor(id, list) {
    const i = findIndex(id);
    if (i < 0) return { ok: false, error: 'That timer no longer exists' };
    if (store.timers[i].kind !== 'countdown') return { ok: false, error: 'Checkpoints are for countdowns' };
    const timers = store.timers.slice();
    timers[i] = E.setCheckpoints(timers[i], Array.isArray(list) ? list.slice(0, 50) : [], Date.now());
    store = Object.assign({}, store, { timers });
    commit();
    return { ok: true, timer: timers[i] };
  }

  function remove(id) {
    if (findIndex(id) < 0) return { ok: false };
    closeFloat(id, { remember: false, quiet: true });
    const floatsNext = Object.assign({}, store.floats);
    delete floatsNext[id];
    const timers = store.timers.filter(t => t.id !== id);
    store = Object.assign({}, store, { timers, floats: floatsNext, focusId: store.focusId === id ? null : store.focusId });
    commit();
    return { ok: true };
  }

  function reorder(ids) {
    if (!Array.isArray(ids)) return { ok: false };
    const rank = new Map(ids.map((id, i) => [String(id), i]));
    const timers = store.timers.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
    store = Object.assign({}, store, { timers });
    commit();
    return { ok: true };
  }

  function setSettings(patch) {
    const settings = E.mergeSettings(store.settings, patch);
    store = Object.assign({}, store, { settings, timers: E.syncPomodoroDurations(store.timers, settings) });
    const hotkeys = registerHotkeys();
    // Floating windows follow the new default look only where the user hasn't
    // picked one for that window — so nothing is saved for them here.
    commit();
    return { ok: true, settings, hotkeys };
  }

  function savePreset(p) {
    const ms = Math.round(Number(p && p.ms));
    if (!(ms >= 1000) || ms > E.MAX_DURATION) return { ok: false, error: 'Set at least 1 second' };
    if (store.presets.some(x => x.ms === ms)) return { ok: false, error: 'That preset already exists' };
    if (store.presets.length >= E.MAX_PRESETS) return { ok: false, error: `Up to ${E.MAX_PRESETS} presets` };
    const preset = { id: E.newId('p', Date.now(), Math.random()), label: E.cleanLabel(p.label, 24) || E.formatShort(ms), ms };
    const presets = E.sanitizePresets(store.presets.concat(preset).sort((a, b) => a.ms - b.ms));
    store = Object.assign({}, store, { presets });
    commit();
    return { ok: true };
  }

  function deletePreset(id) {
    store = Object.assign({}, store, { presets: store.presets.filter(p => p.id !== id) });
    commit();
    return { ok: true };
  }

  function resetPresets() {
    store = Object.assign({}, store, { presets: E.defaultPresets() });
    commit();
    return { ok: true };
  }

  function clearHistory() {
    store = Object.assign({}, store, { history: [], stats: { days: {} } });
    commit();
    return { ok: true };
  }

  function setEnabled(enabled) {
    const on = !!enabled;
    const changed = on !== store.enabled;
    store = Object.assign({}, store, { enabled: on });
    if (on) {
      // Reopen the floating timers that were out when the widget was last on.
      for (const t of store.timers) {
        if (store.floats[t.id] && store.floats[t.id].open) openFloat(t.id, { quiet: true });
      }
      registerHotkeys();
      tick();
    } else {
      // Remember which floats were open, so switching back on restores them.
      for (const id of [...floats.keys()]) closeFloat(id, { remember: true, keepOpenFlag: true, quiet: true });
      unregisterHotkeys();
      clearTimeout(wake);
      wake = null;
    }
    if (changed) saveNow();
    broadcast();
    return publicState();
  }

  // ── Floating windows ────────────────────────────────────────────────────

  function initialBounds(id, dims) {
    const p = floatPrefs(id);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const b = { x: p.x, y: p.y, width: dims.width, height: dims.height };
      // getDisplayMatching returns the NEAREST display for off-screen bounds,
      // so a timer left on an unplugged monitor comes back onto a real one.
      return E.clampToArea(b, screen.getDisplayMatching(b).workArea);
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const pos = E.cornerPosition(area, dims, 'top-right', 24);
    // Stack new windows downward so several don't open on top of each other.
    return E.clampToArea({ x: pos.x, y: pos.y + floats.size * (dims.height + 12), width: dims.width, height: dims.height }, area);
  }

  function openFloat(id, opts) {
    const o = opts || {};
    if (findIndex(id) < 0) return { ok: false, error: 'That timer no longer exists' };
    if (!store.enabled) return { ok: false, error: 'Turn the Timers widget on first' };
    const existing = floats.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.showInactive();
      return { ok: true };
    }
    if (floats.size >= MAX_FLOATS) return { ok: false, error: `Up to ${MAX_FLOATS} floating timers at once` };

    const p = floatPrefs(id);
    const dims = E.floatDims(p.style, p.size);
    const win = new BrowserWindow({
      ...initialBounds(id, dims),
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
      title: 'Timer',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // An always-on-top HUD: a throttled window would freeze its clock
        // and animations whenever Chromium decides it's occluded.
        backgroundThrottling: false,
        preload: path.join(appRoot, 'timer-float-preload.js')
      }
    });
    lockNavigation(win, logger);
    // 'screen-saver' keeps it above borderless games and other topmost windows.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (p.opacity < 100) win.setOpacity(p.opacity / 100);
    if (p.ghost) win.setIgnoreMouseEvents(true, { forward: true });

    const reveal = () => { if (!win.isDestroyed() && !win.isVisible()) win.showInactive(); };
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
    // A transparent window whose page fails to load still opens — as an
    // invisible rectangle over the desktop. Close it and say so instead.
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      logger.error('Floating timer page failed to load', null, { code, desc });
      closeFloat(id, { remember: false });
    });
    win.on('moved', () => rememberPosition(id));
    // Right-clicking a drag region on Windows opens the native system menu;
    // show the timer's own menu instead.
    win.on('system-context-menu', (e) => { e.preventDefault(); popupMenu(id); });
    win.on('closed', () => {
      if (floats.get(id) === win) floats.delete(id);
    });
    win.loadFile(path.join(appRoot, 'timer-float.html')).catch((e) => {
      logger.error('Failed to load floating timer HTML', e);
    });

    floats.set(id, win);
    store = Object.assign({}, store, { floats: Object.assign({}, store.floats, { [id]: Object.assign({}, p, { open: true }) }) });
    if (!o.quiet) commit();
    return { ok: true };
  }

  function closeFloat(id, opts) {
    const o = opts || {};
    const win = floats.get(id);
    floats.delete(id);
    const t = moveSaveTimers.get(id);
    if (t) { clearTimeout(t); moveSaveTimers.delete(id); }
    if (layoutSwitches.has(id)) { clearTimeout(layoutSwitches.get(id)); layoutSwitches.delete(id); }
    if (win && !win.isDestroyed()) {
      if (o.remember !== false) captureBounds(id, win);
      win.destroy();
    }
    if (store.floats[id] && !o.keepOpenFlag) {
      store = Object.assign({}, store, { floats: Object.assign({}, store.floats, { [id]: Object.assign({}, store.floats[id], { open: false }) }) });
    }
    if (!o.quiet) commit();
    return { ok: true };
  }

  function captureBounds(id, win) {
    try {
      const b = win.getBounds();
      store = Object.assign({}, store, { floats: Object.assign({}, store.floats, { [id]: Object.assign({}, floatPrefs(id), { x: b.x, y: b.y }) }) });
    } catch (e) { /* window already gone */ }
  }

  function rememberPosition(id) {
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
    if (findIndex(id) < 0) return { ok: false };
    const before = floatPrefs(id);
    const p = E.sanitizeFloat(Object.assign({}, before, patch), store.settings);
    store = Object.assign({}, store, { floats: Object.assign({}, store.floats, { [id]: p }) });
    const win = floats.get(id);
    if (win && !win.isDestroyed()) {
      if (p.style !== before.style || p.size !== before.size) {
        // Changing the look resizes the window AND restyles the page, and the
        // two land at different moments — for a frame or more the ring would be
        // drawn inside a pill-shaped window (or the pill inside a square one),
        // overlapping itself. So the window goes invisible, the page gets its
        // new look first, the window is resized, and it only reappears once the
        // page reports it has laid out at the new size.
        hideForLayout(id, win);
        sendFloat(id, 'timer-float:state', floatPayload(id));
        // Resize about the window's centre, then pull it back on screen.
        const b = win.getBounds();
        const dims = E.floatDims(p.style, p.size);
        const next = {
          x: Math.round(b.x + (b.width - dims.width) / 2),
          y: Math.round(b.y + (b.height - dims.height) / 2),
          width: dims.width,
          height: dims.height
        };
        const clamped = E.clampToArea(next, screen.getDisplayMatching(b).workArea);
        win.setBounds(clamped);
        store.floats[id] = Object.assign({}, p, { x: clamped.x, y: clamped.y });
      }
      if (!layoutSwitches.has(id)) win.setOpacity(p.opacity / 100);
      if (p.ghost) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    }
    commit();
    return { ok: true };
  }

  // timerId -> fallback timeout, while a floating window changes its look.
  const layoutSwitches = new Map();

  function hideForLayout(id, win) {
    clearTimeout(layoutSwitches.get(id));
    try { win.setOpacity(0); } catch (e) { /* window going away */ }
    // Never leave a window invisible if the page misses its cue.
    layoutSwitches.set(id, setTimeout(() => revealAfterLayout(id), 450));
  }

  function revealAfterLayout(id) {
    if (!layoutSwitches.has(id)) return;
    clearTimeout(layoutSwitches.get(id));
    layoutSwitches.delete(id);
    const win = floats.get(id);
    if (win && !win.isDestroyed()) win.setOpacity(floatPrefs(id).opacity / 100);
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

  // A monitor unplugged or a resolution change must never strand a timer
  // off-screen.
  function keepFloatsOnScreen() {
    for (const [id, win] of floats) {
      if (win.isDestroyed()) continue;
      const b = win.getBounds();
      const clamped = E.clampToArea(b, screen.getDisplayMatching(b).workArea);
      if (clamped.x !== b.x || clamped.y !== b.y) {
        win.setBounds(clamped);
        captureBounds(id, win);
      }
    }
    saveSoon();
  }
  screen.on('display-removed', keepFloatsOnScreen);
  screen.on('display-metrics-changed', keepFloatsOnScreen);

  function popupMenu(id) {
    const win = floats.get(id);
    const t = store.timers.find(x => x.id === id);
    if (!win || win.isDestroyed() || !t) return;
    const p = floatPrefs(id);
    const running = t.status === 'running';
    const items = [];
    if (t.status === 'done') {
      items.push({ label: t.kind === 'pomodoro' ? `Start ${(E.PHASE_LABELS[t.phase] || '').toLowerCase()}` : 'Restart', click: () => act(id, t.kind === 'pomodoro' ? 'start' : 'restart') });
      items.push({ label: 'Dismiss', click: () => act(id, 'dismiss') });
    } else {
      items.push({ label: running ? 'Pause' : (t.status === 'paused' ? 'Resume' : 'Start'), click: () => act(id, 'toggle') });
      items.push({ label: 'Reset', enabled: t.status !== 'idle', click: () => act(id, 'reset') });
    }
    if (t.kind === 'stopwatch') {
      items.push({ label: 'Lap', enabled: running, click: () => act(id, 'lap') });
    } else {
      items.push({ label: '+1 minute', click: () => act(id, 'adjust', 60000) });
      items.push({ label: '+5 minutes', click: () => act(id, 'adjust', 300000) });
      if (t.status !== 'done') items.push({ label: '−1 minute', click: () => act(id, 'adjust', -60000) });
    }
    if (t.kind === 'pomodoro') items.push({ label: 'Skip to next phase', click: () => act(id, 'skip') });
    items.push({ type: 'separator' });

    const radio = (label, key, value) => ({ label, type: 'radio', checked: p[key] === value, click: () => setFloatPrefs(id, { [key]: value }) });
    items.push({
      label: 'Style', submenu: [radio('Ring', 'style', 'ring'), radio('Pill', 'style', 'pill'), radio('Text only', 'style', 'text')]
    });
    items.push({
      label: 'Size', submenu: [radio('Small', 'size', 's'), radio('Medium', 'size', 'm'), radio('Large', 'size', 'l')]
    });
    items.push({
      label: 'Opacity', submenu: [100, 85, 70, 55, 40].map(v => radio(v + '%', 'opacity', v))
    });
    items.push({
      label: 'Click-through (ghost mode)', type: 'checkbox', checked: p.ghost,
      click: () => setFloatPrefs(id, { ghost: !p.ghost })
    });
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
    items.push({ label: 'Open in main', click: () => { try { ctx.focusMainWindow(); } catch (e) { /* ignore */ } sendMain('timer:open', { timerId: id }); } });
    items.push({ label: 'Close floating timer', click: () => closeFloat(id) });
    try {
      Menu.buildFromTemplate(items).popup({ window: win });
    } catch (e) {
      logger.warn('Timers: could not open the floating timer menu', { error: e && e.message });
    }
  }

  // ── Hotkeys ─────────────────────────────────────────────────────────────

  function primaryId() {
    const t = E.primaryTimer(store);
    return t ? t.id : null;
  }

  function hotkeyToggle() {
    const id = primaryId();
    if (id) act(id, 'toggle');
  }

  function hotkeyFloat() {
    const id = primaryId();
    if (!id) return;
    if (floats.has(id)) closeFloat(id);
    else openFloat(id);
  }

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
    const want = { toggle: [store.settings.hotkeyToggle, hotkeyToggle], float: [store.settings.hotkeyFloat, hotkeyFloat] };
    for (const key of Object.keys(want)) {
      const [accel, fn] = want[key];
      if (!accel) continue;
      let ok = false;
      try { ok = globalShortcut.register(accel, fn); } catch (e) { ok = false; }
      if (ok) boundHotkeys[key] = accel;
      else {
        failed.push(key);
        logger.warn('Timers: hotkey registration failed', { key, accelerator: accel });
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
        logger.error(`Timers: ${channel} failed`, e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('timer:get', () => publicState());
  handle('timer:set-enabled', (enabled) => setEnabled(enabled));
  handle('timer:create', (opts) => create(opts));
  handle('timer:import-legacy', (legacy) => importLegacy(legacy));
  handle('timer:action', (id, action, arg) => (PANEL_ACTIONS.has(action) ? act(String(id || ''), action, arg) : { ok: false, error: 'Unknown action' }));
  handle('timer:update', (id, patch) => update(String(id || ''), patch));
  handle('timer:remove', (id) => remove(String(id || '')));
  handle('timer:set-checkpoints', (id, list) => setCheckpointsFor(String(id || ''), list));
  handle('timer:reorder', (ids) => reorder(ids));
  handle('timer:set-settings', (patch) => setSettings(patch));
  handle('timer:save-preset', (p) => savePreset(p));
  handle('timer:delete-preset', (id) => deletePreset(String(id || '')));
  handle('timer:reset-presets', () => resetPresets());
  handle('timer:clear-history', () => clearHistory());
  handle('timer:float-open', (id) => openFloat(String(id || '')));
  handle('timer:float-close', (id) => closeFloat(String(id || '')));
  handle('timer:float-close-all', () => {
    for (const id of [...floats.keys()]) closeFloat(id, { quiet: true });
    commit();
    return { ok: true };
  });
  handle('timer:float-prefs', (id, patch) => setFloatPrefs(String(id || ''), patch && typeof patch === 'object' ? {
    style: patch.style, size: patch.size, opacity: patch.opacity, ghost: patch.ghost
  } : {}));
  handle('timer:float-snap', (id, corner) => snapFloat(String(id || ''), String(corner || '')));

  // ── IPC: floating windows ───────────────────────────────────────────────
  // The sender decides which timer a message is about. A message from any
  // window that isn't a live floating timer is ignored.

  function floatIdFor(event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    for (const [id, w] of floats) if (w === win) return id;
    return null;
  }

  ipcMain.removeHandler('timer-float:ready');
  ipcMain.handle('timer-float:ready', (event) => {
    const id = floatIdFor(event);
    return id ? floatPayload(id) : null;
  });
  ipcMain.removeHandler('timer-float:action');
  ipcMain.handle('timer-float:action', (event, action, arg) => {
    const id = floatIdFor(event);
    if (!id || !FLOAT_ACTIONS.has(action)) return { ok: false };
    return act(id, action, arg);
  });
  ipcMain.removeAllListeners('timer-float:menu');
  ipcMain.on('timer-float:menu', (event) => {
    const id = floatIdFor(event);
    if (id) popupMenu(id);
  });
  // Ghost mode: the window ignores the mouse, but the page still sees mouse
  // moves (forward: true) and asks to catch clicks while the pointer is over
  // its unlock handle.
  ipcMain.removeAllListeners('timer-float:hover-handle');
  ipcMain.on('timer-float:hover-handle', (event, over) => {
    const id = floatIdFor(event);
    const win = id && floats.get(id);
    if (!win || win.isDestroyed() || !floatPrefs(id).ghost) return;
    if (over) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.removeAllListeners('timer-float:laid-out');
  ipcMain.on('timer-float:laid-out', (event) => {
    const id = floatIdFor(event);
    if (id) revealAfterLayout(id);
  });
  ipcMain.removeAllListeners('timer-float:exit-ghost');
  ipcMain.on('timer-float:exit-ghost', (event) => {
    const id = floatIdFor(event);
    if (id) setFloatPrefs(id, { ghost: false });
  });
  ipcMain.removeAllListeners('timer-float:close');
  ipcMain.on('timer-float:close', (event) => {
    const id = floatIdFor(event);
    if (id) closeFloat(id);
  });
  ipcMain.removeAllListeners('timer-float:open-app');
  ipcMain.on('timer-float:open-app', (event) => {
    const id = floatIdFor(event);
    if (!id) return;
    try { ctx.focusMainWindow && ctx.focusMainWindow(); } catch (e) { /* ignore */ }
    sendMain('timer:open', { timerId: id });
  });

  // Sleep and screen-lock pause Node timers. On the way back, catch up.
  powerMonitor.on('resume', () => tick());
  powerMonitor.on('unlock-screen', () => tick());

  // Boot: catch up on anything that finished while the app was closed (it is
  // reported as missed), reopen floating timers, bind hotkeys. Deferred a
  // moment so the main window exists to receive the state.
  setTimeout(() => {
    if (tornDown || !store.enabled) return;
    for (const t of store.timers) {
      if (store.floats[t.id] && store.floats[t.id].open) openFloat(t.id, { quiet: true });
    }
    registerHotkeys();
    tick();
    broadcast();
  }, 1200);

  return {
    reapplyHotkeys: () => { registerHotkeys(); },
    teardown: () => {
      tornDown = true;
      clearTimeout(wake);
      wake = null;
      unregisterHotkeys();
      // Remember where each floating timer was; keep their open flags so they
      // come back on the next launch.
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
