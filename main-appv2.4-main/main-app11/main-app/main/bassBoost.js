// ── Bass Boost (registry id `bassBoost`) ─────────────────────────────────────
//
// An equaliser for Spotify only, with no driver to install. The DSP and the
// audio plumbing live in a long-lived PowerShell/C# helper
// (main/bassBoostHostScript.js — read its header for how Spotify is captured
// and its own sound hidden); the filter design is the pure
// renderer/bass-engine.js, shared with the panel so the curve drawn is the
// curve heard. This module owns:
//   - bass-boost.json (prefs + the user's own presets), written atomically
//   - the helper's lifecycle: started when the boost is switched on (or when a
//     restore file says a previous run left Spotify routed), stopped a little
//     while after it's switched off
//   - the power hotkey (default Ctrl+Alt+B)
//   - the panel IPC, and the spectrum stream while the panel is open
// Windows-only: it is init-skipped elsewhere and the widget is gated to win32.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ipcMain, globalShortcut } = require('electron');
const { ensureVersionedScript } = require('./scriptCache');
const { BASS_HOST_SCRIPT_CONTENT, BASS_HOST_SCRIPT_VERSION } = require('./bassBoostHostScript');
const E = require('../renderer/bass-engine');

const IDLE_EXIT_MS = 30000;      // keep a switched-off helper warm this long
const CHAIN_COALESCE_MS = 25;    // knob drags send at most ~40 chains a second
const START_TIMEOUT_MS = 30000;

function init(ctx) {
  const { logger } = ctx;
  const STORE_PATH = path.join(ctx.userDataPath, 'bass-boost.json');
  const SCRIPT_PATH = path.join(ctx.userDataPath, 'bass-boost-host.ps1');
  const RESTORE_PATH = path.join(ctx.userDataPath, 'bass-boost-restore.txt');

  let prefs = E.sanitizePrefs(readJson());
  let widgetEnabled = false;
  let saveTimer = null;
  let proc = null;
  let ready = false;
  let buffer = '';
  let status = { state: 'off', message: '', target: null, sink: null, pending: false };
  let devices = [];
  let deviceWaiters = [];
  let meterWanted = false;
  let rate = E.SAMPLE_RATE;   // the host's pipeline rate (RATE line)
  const recentLogs = [];       // the host's last LOG lines, for the diagnostics report
  let capTest = null;          // { lines, done } while a CAPTEST runs
  let chainTimer = null;
  let idleTimer = null;
  let boundHotkey = null;
  let hotkeyFailed = false;
  let quitting = false;

  // ── Persistence ─────────────────────────────────────────────────────────

  function readJson() {
    try {
      if (!fs.existsSync(STORE_PATH)) return null;
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (e) {
      logger.warn('Bass Boost: unreadable bass-boost.json, starting fresh', { error: e.message });
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
      logger.error('Bass Boost: failed to save bass-boost.json', e);
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  // ── State to the panel ──────────────────────────────────────────────────

  function publicState(extra) {
    return Object.assign({
      prefs,
      widgetEnabled,
      status,
      devices,
      hotkeyFailed,
      preampDb: Math.round(E.preampDb(prefs) * 10) / 10
    }, extra || {});
  }

  function sendMain(channel, data) {
    const w = ctx.getMainWindow && ctx.getMainWindow();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(channel, data); } catch (e) { /* window going away */ }
    }
  }

  function broadcast() { sendMain('bass:changed', publicState()); }

  // ── The helper process ──────────────────────────────────────────────────

  function wantRunning() { return widgetEnabled && prefs.on; }

  function ensureHost() {
    if (proc) return;
    try {
      ensureVersionedScript(SCRIPT_PATH, BASS_HOST_SCRIPT_VERSION, BASS_HOST_SCRIPT_CONTENT);
      // Electron's children live in a kill-on-close job, so this helper dies
      // the instant main does (quit or crash) — before it can put Spotify's
      // output back. It can't be spawned detached (a console-less PowerShell
      // exits at once with piped stdio), so it starts its own watchdog, which
      // breaks away from the job and does the restore. See the host script.
      proc = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-RestoreFile', RESTORE_PATH],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      proc = null;
      logger.error('Bass Boost: could not start the audio engine', e);
      setStatus({ state: 'error', message: 'The audio engine could not start' });
      return;
    }
    ready = false;
    buffer = '';
    rate = E.SAMPLE_RATE;          // a fresh host starts at 48 kHz
    const me = proc;
    const startTimer = setTimeout(() => {
      if (proc === me && !ready) {
        logger.error('Bass Boost: audio engine did not become ready in time', null, {});
        killHost();
        setStatus({ state: 'error', message: 'The audio engine did not start' });
      }
    }, START_TIMEOUT_MS);
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onLine(line, startTimer);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) logger.error('Bass Boost engine stderr', new Error(msg.slice(0, 2000)));
    });
    proc.on('exit', (code) => {
      clearTimeout(startTimer);
      if (proc !== me) return;
      proc = null;
      ready = false;
      flushDevices();
      logger.log(`Bass Boost engine exited (code ${code})`, 'INFO');
      if (!quitting && wantRunning()) {
        setStatus({ state: 'error', message: 'The audio engine stopped — retrying' });
        setTimeout(() => { if (wantRunning() && !proc) syncHost(); }, 3000);
      } else if (!quitting) {
        setStatus({ state: 'off', message: '' });
      }
    });
  }

  function onLine(line, startTimer) {
    if (line === 'READY') {
      ready = true;
      clearTimeout(startTimer);
      logger.success('Bass Boost engine started');
      send(E.chainLine(E.buildChain(prefs, rate)));
      if (meterWanted) send('METER 1');
      syncHost();
      return;
    }
    if (line.startsWith('LV ')) {
      if (!meterWanted) return;
      const m = E.parseMeter(line);
      if (m) sendMain('bass:meter', m);
      return;
    }
    if (line.startsWith('STATUS ')) {
      try {
        const s = JSON.parse(line.slice(7));
        setStatus(s);
        if (s.state === 'error' && s.message) logger.warn('Bass Boost: ' + s.message);
      } catch (e) { /* malformed line */ }
      scheduleIdleExit();
      return;
    }
    if (line.startsWith('DEVICES ')) {
      try {
        const list = JSON.parse(line.slice(8));
        devices = Array.isArray(list)
          ? list.filter((d) => d && typeof d.id === 'string').map((d) => ({ id: d.id, name: String(d.name || 'Audio device'), default: !!d.default }))
          : [];
      } catch (e) { devices = []; }
      flushDevices();
      broadcast();
      return;
    }
    if (line.startsWith('LOG ')) {
      logger.log('Bass Boost: ' + line.slice(4), 'INFO');
      recentLogs.push(new Date().toISOString().slice(11, 19) + ' ' + line.slice(4));
      if (recentLogs.length > 15) recentLogs.shift();
      return;
    }
    if (line.startsWith('CAPTEST')) {
      if (capTest) {
        capTest.lines.push(line.slice(8));
        const variants = capTest.lines.filter((l) => /^\d+ /.test(l)).length;
        if (variants >= 6 || / spotify 0$/.test(line) || / busy$/.test(line)) capTest.done();
      }
      return;
    }
    if (line.startsWith('RATE ')) {
      // A capture fallback runs the pipeline at another rate: rebuild the
      // filters for it, or every frequency would be off by the ratio.
      const r = parseInt(line.slice(5), 10);
      if (r >= 8000 && r <= 192000 && r !== rate) {
        rate = r;
        logger.log(`Bass Boost: pipeline now at ${rate} Hz`, 'INFO');
        send(E.chainLine(E.buildChain(prefs, rate)));
      }
      return;
    }
    if (line.startsWith('CHAIN-OK')) return;
  }

  function setStatus(s) {
    const next = {
      state: typeof s.state === 'string' ? s.state : 'off',
      message: typeof s.message === 'string' ? s.message : '',
      target: typeof s.target === 'string' ? s.target : null,
      sink: typeof s.sink === 'string' ? s.sink : null,
      pending: !!s.pending
    };
    const changed = JSON.stringify(next) !== JSON.stringify(status);
    status = next;
    if (changed) broadcast();
  }

  function send(line) {
    if (proc && ready && proc.stdin.writable) {
      try { proc.stdin.write(line + '\n'); } catch (e) { /* exiting */ }
    }
  }

  function killHost() {
    if (!proc) return;
    const p = proc;
    try { if (p.stdin.writable) { p.stdin.write('EXIT\n'); p.stdin.end(); } } catch (e) { /* ignore */ }
    // EXIT restores Spotify's output first; only force it after a grace period.
    setTimeout(() => { try { p.kill(); } catch (e) { /* already gone */ } }, 8000).unref();
    proc = null;
    ready = false;
  }

  // Bring the helper in line with what is wanted.
  function syncHost() {
    clearTimeout(idleTimer);
    if (wantRunning()) {
      if (!proc) { ensureHost(); return; }       // READY calls back in here
      if (!ready) return;
      send(`START ${prefs.device || '-'} ${prefs.sink || '-'}`);
      return;
    }
    if (proc && ready) send('STOP');
    scheduleIdleExit();
  }

  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (!proc || wantRunning() || status.pending || meterWanted || deviceWaiters.length) return;
    idleTimer = setTimeout(() => {
      if (!wantRunning() && !status.pending && !meterWanted) killHost();
    }, IDLE_EXIT_MS);
    idleTimer.unref();
  }

  function sendChainSoon() {
    if (chainTimer) return;
    chainTimer = setTimeout(() => {
      chainTimer = null;
      send(E.chainLine(E.buildChain(prefs, rate)));
    }, CHAIN_COALESCE_MS);
  }

  function flushDevices() {
    const w = deviceWaiters;
    deviceWaiters = [];
    for (const fn of w) fn(devices);
  }

  function listDevices() {
    return new Promise((resolve) => {
      deviceWaiters.push(resolve);
      const timer = setTimeout(() => {
        deviceWaiters = deviceWaiters.filter((f) => f !== resolve);
        resolve(devices);
      }, 15000);
      timer.unref();
      if (!proc) ensureHost();
      const ask = () => { if (ready) send('DEVICES'); else setTimeout(ask, 200); };
      ask();
    }).then((d) => { scheduleIdleExit(); return d; });
  }

  // ── Hotkey ──────────────────────────────────────────────────────────────

  function unregisterHotkey() {
    if (boundHotkey) {
      try { globalShortcut.unregister(boundHotkey); } catch (e) { /* ignore */ }
      boundHotkey = null;
    }
  }

  function registerHotkey() {
    unregisterHotkey();
    hotkeyFailed = false;
    if (!widgetEnabled || !prefs.hotkey) return;
    let ok = false;
    try { ok = globalShortcut.register(prefs.hotkey, () => setPower(!prefs.on, 'hotkey')); } catch (e) { ok = false; }
    if (ok) boundHotkey = prefs.hotkey;
    else {
      hotkeyFailed = true;
      logger.warn('Bass Boost: hotkey registration failed', { accelerator: prefs.hotkey });
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  function setPower(on, source) {
    prefs = E.applyPatch(prefs, { on: !!on });
    saveSoon();
    syncHost();
    sendMain('bass:changed', publicState({ source: source || 'panel' }));
    return publicState();
  }

  function setPrefs(patch) {
    const before = prefs;
    prefs = E.applyPatch(prefs, patch);
    saveSoon();
    if (before.hotkey !== prefs.hotkey) registerHotkey();
    if (before.on !== prefs.on || before.device !== prefs.device || before.sink !== prefs.sink) syncHost();
    sendChainSoon();
    const state = publicState();
    sendMain('bass:changed', state);
    return state;
  }

  function setWidgetEnabled(on) {
    widgetEnabled = !!on;
    registerHotkey();
    syncHost();
    return publicState();
  }

  function setMeter(on) {
    meterWanted = !!on;
    if (meterWanted && !proc && wantRunning()) ensureHost();
    send(meterWanted ? 'METER 1' : 'METER 0');
    if (!meterWanted) scheduleIdleExit();
    return true;
  }

  // ── IPC ─────────────────────────────────────────────────────────────────

  function handle(channel, fn) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        logger.error(`Bass Boost: ${channel} failed`, e);
        return { ok: false, error: 'Something went wrong' };
      }
    });
  }

  handle('bass:get', () => publicState());
  handle('bass:set-enabled', (on) => setWidgetEnabled(on));
  handle('bass:set-power', (on) => setPower(on, 'panel'));
  handle('bass:set-prefs', (patch) => setPrefs(patch && typeof patch === 'object' ? patch : {}));
  handle('bass:save-preset', (name) => {
    const res = E.saveCustom(prefs, typeof name === 'string' ? name : '');
    if (res.error) return publicState({ error: res.error });
    prefs = res.prefs;
    saveSoon();
    broadcast();
    return publicState();
  });
  handle('bass:delete-preset', (id) => {
    prefs = E.deleteCustom(prefs, String(id || ''));
    saveSoon();
    broadcast();
    return publicState();
  });
  handle('bass:devices', async () => publicState({ devices: await listDevices() }));
  handle('bass:meter', (on) => setMeter(on));
  // A plain-text report the user can copy and send: the Windows build, what
  // the engine says, the outputs it sees, its recent log, and — while no
  // stream is running — every capture variant tried against Spotify.
  handle('bass:diagnose', async () => {
    if (!proc) ensureHost();
    const t0 = Date.now();
    while ((!proc || !ready) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
    if (!proc || !ready) return { ok: false, report: 'The audio engine did not start.' };
    const devs = await listDevices();
    const lines = await new Promise((resolve) => {
      const job = { lines: [], done: null };
      const timer = setTimeout(() => finish(), 20000);
      function finish() { clearTimeout(timer); if (capTest === job) capTest = null; resolve(job.lines); }
      job.done = finish;
      capTest = job;
      send('CAPTEST');
    });
    const report = [
      `main ${ctx.APP_VERSION || ''} — Bass Boost diagnostics`,
      ...lines.filter((l) => /^build /.test(l)).map((l) => {
        const m = /^build (\d+) spotify (\d+)/.exec(l);
        if (!m) return l;
        const kind = Number(m[1]) >= 22000 ? 'Windows 11' : Number(m[1]) >= 10240 ? 'Windows 10' : 'Windows';
        return `${kind} build ${m[1]} — Spotify ${m[2] === '0' ? 'NOT RUNNING (open Spotify, play a song, run this again)' : 'running (pid ' + m[2] + ')'}`;
      }),
      `Status: ${status.state}${status.message ? ' — ' + status.message : ''}`,
      `Speakers profile: ${prefs.speaker}; power ${prefs.on ? 'on' : 'off'}; pipeline ${rate} Hz`,
      'Outputs: ' + (devs.length ? devs.map((d) => d.name + (d.default ? ' (default)' : '')).join(', ') : 'none'),
      'Capture test (no routing, nothing changed):',
      ...lines.filter((l) => !/^build /.test(l)).map((l) => '  ' + l),
      'Recent engine log:',
      ...recentLogs.map((l) => '  ' + l)
    ].join('\n');
    scheduleIdleExit();
    return { ok: true, report };
  });
  // Voice + quick nudges: change the BASS knob by a step and switch on.
  handle('bass:nudge', (delta) => {
    const d = Number(delta);
    const next = E.nudgeBass(prefs, Number.isFinite(d) ? Math.max(-24, Math.min(24, d)) : 3);
    return setPrefs({ bass: next.bass, on: true });
  });

  // A previous run that was killed outright left Spotify routed to a muted
  // output, or an output muted (the host's mute ledger, RESTORE_PATH +
  // '.mutes'): start the helper now, which puts both back on boot.
  if (fs.existsSync(RESTORE_PATH) || fs.existsSync(RESTORE_PATH + '.mutes')) {
    logger.log('Bass Boost: restore file found, putting audio settings back', 'INFO');
    ensureHost();
  }

  return {
    reapplyHotkeys: () => registerHotkey(),
    teardown: () => {
      quitting = true;
      if (saveTimer) saveNow();
      unregisterHotkey();
      killHost();
    }
  };
}

module.exports = { init };
