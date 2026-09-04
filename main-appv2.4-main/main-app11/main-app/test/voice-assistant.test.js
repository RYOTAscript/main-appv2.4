// Voice Assistant: the contracts between the pieces.
//
// The intent layer is covered by voice-commands.test.js. This file covers the
// seams that a unit test of pure logic can't see: the line protocol the speech
// host and the main process have to agree on, the executor coverage that stops
// a command from silently doing nothing, and the app wiring (preload, main.js,
// registry, build manifest) that a missing line would break only at runtime.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const V = require('../main/voiceCommands.js');
const HOST = require('../main/voiceHostScript.js');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const hostSrc = HOST.VOICE_HOST_SCRIPT_CONTENT;
const assistantSrc = read('main', 'voiceAssistant.js');
const executorSrc = read('renderer', 'voice-assistant.js');
const preloadSrc = read('preload.js');
const mainSrc = read('main.js');
const overlaySrc = read('voice-overlay.html');
const overlayPreloadSrc = read('voice-overlay-preload.js');

// ── Host protocol ─────────────────────────────────────────────────────────
// The host is only a string until PowerShell compiles it, so nothing else
// catches a drift between what main/voiceAssistant.js sends and what the host
// understands — at runtime it just looks like an assistant that never answers.

test('the host handles every command the main process sends it', () => {
  for (const cmd of ['GRAMMAR-BEGIN', 'PHRASE', 'DICTATION', 'CONFIRM', 'WAKE', 'GRAMMAR-END',
    'LISTEN', 'WAKE-LISTEN', 'MODE', 'STOP', 'SPEAK', 'SHUTUP', 'VOICE', 'RATE', 'WATCH',
    'PING', 'EXIT']) {
    assert.ok(hostSrc.includes('case "' + cmd + '"'), `host handles ${cmd}`);
  }
});

test('the main process only sends commands the host handles', () => {
  const sent = [...assistantSrc.matchAll(/hostSend\('([A-Z-]+)/g)].map(m => m[1]);
  assert.ok(sent.length > 0, 'the module does send commands');
  for (const cmd of new Set(sent)) {
    assert.ok(hostSrc.includes('case "' + cmd + '"'), `host understands "${cmd}"`);
  }
});

test('the host emits every event the main process parses', () => {
  for (const evt of ['READY', 'VOICE-AVAILABLE', 'GRAMMAR-OK', 'LISTENING', 'STOPPED',
    'LEVEL', 'AUDIO', 'HYP', 'RESULT', 'WAKED', 'REJECTED', 'TIMEOUT',
    'SPEAK-START', 'SPEAK-DONE', 'KEY-DOWN', 'KEY-UP', 'PONG', 'ERROR']) {
    assert.ok(hostSrc.includes('"' + evt), `host emits ${evt}`);
    assert.ok(assistantSrc.includes("case '" + evt + "'"), `main process handles ${evt}`);
  }
});

test('the host releases the audio device, not just the recognition', () => {
  // RecognizeAsyncCancel stops recognising but LEAVES THE MICROPHONE OPEN (and
  // its indicator lit). SetInputToNull is what actually hands the device back.
  assert.ok(hostSrc.includes('SetInputToNull'), 'the host calls SetInputToNull');
  const stop = hostSrc.slice(hostSrc.indexOf('static void StopListening'));
  const body = stop.slice(0, stop.indexOf('static void OnRecognized'));
  assert.ok(body.includes('RecognizeAsyncCancel'), 'StopListening cancels recognition');
  assert.ok(body.includes('SetInputToNull'), 'StopListening releases the device');
});

test('the host has its own listen timeout so a hung caller cannot hold the mic', () => {
  assert.ok(hostSrc.includes('listenTimer'), 'a host-side timer exists');
  assert.ok(/StopListening\(true\);\s*\n\s*Emit\("TIMEOUT"\)/.test(hostSrc),
    'the timeout stops listening before reporting');
});

test('the push-to-talk key is watched passively, never registered', () => {
  // A registered accelerator is consumed, has no key-up, and would swallow the
  // key from whatever is focused — the same reason autoClicker polls instead.
  assert.ok(hostSrc.includes('GetAsyncKeyState'), 'the host polls the key');
  assert.ok(hostSrc.includes('static void WatchLoop'), 'on its own thread');
});

test('bumping the host script means bumping its cache version', () => {
  // scriptCache.ensureVersionedScript only rewrites the .ps1 when this changes,
  // so a stale host would answer an older protocol forever.
  assert.equal(typeof HOST.VOICE_HOST_SCRIPT_VERSION, 'number');
  assert.ok(HOST.VOICE_HOST_SCRIPT_VERSION >= 1);
  assert.ok(assistantSrc.includes('VOICE_HOST_SCRIPT_VERSION'), 'the module passes the version through');
});

// ── The host actually compiles and speaks its protocol ────────────────────
test('the host compiles and answers its handshake', {
  skip: process.platform !== 'win32' ? 'needs Windows PowerShell + System.Speech' : false
}, () => {
  const file = path.join(os.tmpdir(), `voice-host-test-${process.pid}.ps1`);
  fs.writeFileSync(file, hostSrc, 'utf8');
  try {
    // A tiny grammar, a ping, and out. Deliberately no LISTEN: this must never
    // open the microphone just to run the test suite.
    const input = ['GRAMMAR-BEGIN', 'PHRASE next track', 'PHRASE open settings',
      'DICTATION search for', 'CONFIRM yes', 'CONFIRM no', 'WAKE hey main', 'GRAMMAR-END',
      'PING', 'RATE 0', 'MODE wake', 'MODE command 5000', 'STOP', 'EXIT', ''].join('\n');
    const res = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { input, encoding: 'utf8', timeout: 120000, windowsHide: true });

    assert.equal(res.status, 0, `host exited cleanly (stderr: ${String(res.stderr).slice(0, 400)})`);
    const lines = String(res.stdout).split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(lines.some(l => l.startsWith('READY ')), 'the C# compiled and the host started');
    assert.ok(lines.some(l => l.startsWith('GRAMMAR-OK ')), 'it loaded the grammar');
    assert.ok(lines.includes('PONG'), 'it answers PING');
    assert.ok(!lines.some(l => l.startsWith('ERROR')), 'no errors: ' + lines.filter(l => l.startsWith('ERROR')).join(' | '));

    // The grammar count must match what we actually sent (2 phrases + 1
    // dictation carrier + 2 confirm words + 1 wake phrase).
    const ok = lines.find(l => l.startsWith('GRAMMAR-OK '));
    assert.equal(parseInt(ok.split(' ')[1], 10), 6, 'every phrase kind was loaded, wake included');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
  }
});

// ── Executor coverage ─────────────────────────────────────────────────────
// The prompt-level rule for this feature: never claim a command works unless it
// is actually implemented.
// Commands about the assistant itself never leave the main process.
const MAIN_HANDLED = new Set(['assistant.help', 'assistant.cancel',
  'assistant.repeat', 'assistant.quiet', 'assistant.undo']);

function executorIds() {
  const body = executorSrc.slice(executorSrc.indexOf('const VOICE_EXECUTORS = {'));
  return new Set([...body.matchAll(/^ {12}'([a-zA-Z]+\.[A-Za-z]+)':/gm)].map(m => m[1]));
}

test('every registry command has a real executor', () => {
  const ids = executorIds();
  const missing = V.COMMANDS.filter(c => !MAIN_HANDLED.has(c.id) && !ids.has(c.id)).map(c => c.id);
  assert.deepEqual(missing, [], 'no command is advertised without an implementation');
});

test('no executor exists for a command that was removed', () => {
  const known = new Set(V.COMMANDS.map(c => c.id));
  const orphans = [...executorIds()].filter(id => !known.has(id));
  assert.deepEqual(orphans, [], 'no dead executors');
});

test('the two assistant-only commands are handled in the main process', () => {
  for (const id of MAIN_HANDLED) {
    assert.ok(assistantSrc.includes(`'${id}'`), `${id} handled in main/voiceAssistant.js`);
  }
});

test('a command with no executor fails loudly rather than reporting success', () => {
  assert.match(executorSrc, /no executor for command/, 'the miss is logged');
  assert.match(executorSrc, /ok: false, message: 'That isn.t wired up yet'/, 'and reported as a failure');
});

// ── Security boundaries ───────────────────────────────────────────────────
test('the overlay window cannot reach any feature IPC channel', () => {
  // Its bridge is render-state in, user-gestures out. If it could invoke feature
  // channels, an overlay compromise would inherit the whole app's capability.
  assert.ok(!overlayPreloadSrc.includes('ipcRenderer.invoke'), 'the overlay preload exposes no invoke');
  const channels = [...overlayPreloadSrc.matchAll(/ipcRenderer\.(?:send|on)\('([^']+)'/g)].map(m => m[1]);
  assert.ok(channels.length > 0, 'it does bridge something');
  for (const ch of channels) {
    assert.ok(ch.startsWith('voice:overlay-'), `"${ch}" stays inside the overlay namespace`);
  }
});

test('the overlay page runs with context isolation and no node integration', () => {
  const block = assistantSrc.slice(assistantSrc.indexOf('overlayWindow = new BrowserWindow'));
  const opts = block.slice(0, block.indexOf('});'));
  assert.match(opts, /nodeIntegration:\s*false/);
  assert.match(opts, /contextIsolation:\s*true/);
  assert.match(opts, /preload:\s*path\.join\(appRoot, 'voice-overlay-preload\.js'\)/);
});

test('overlay messages are accepted only from the overlay window', () => {
  // Without this check any renderer could drive the assistant's UI.
  assert.match(assistantSrc, /function fromOverlay\(event\)/);
  const handlers = [...assistantSrc.matchAll(/ipcMain\.on\('voice:overlay-[^']+', \(e[^)]*\) => \{?\s*(?:if \()?(!?fromOverlay)/g)];
  const total = [...assistantSrc.matchAll(/ipcMain\.on\('voice:overlay-/g)].length;
  assert.equal(handlers.length, total, 'every overlay handler checks the sender');
});

test('the assistant never runs commands itself — it dispatches to the renderer', () => {
  // It must gain no capability the renderer doesn't already have.
  assert.match(assistantSrc, /webContents\.send\('voice:execute'/, 'dispatches to the main window');
  assert.ok(!/require\('\.\/shellUtils'\)/.test(assistantSrc), 'no direct shell access');
  assert.ok(!/spawn\((?!'powershell)/.test(assistantSrc.replace(/spawn\('powershell\.exe'/g, '')),
    'the only process it spawns is its own speech host');
});

// ── App wiring ────────────────────────────────────────────────────────────
test('the preload bridge exposes the voice API', () => {
  for (const m of ['voiceGetState', 'voiceSetEnabled', 'voiceSettingsGet', 'voiceSettingsSet',
    'voiceSetVocabulary', 'voiceActivate', 'voiceCancel', 'voiceSubmitText',
    'voiceExecuteResult', 'onVoiceExecute', 'onVoiceState']) {
    assert.ok(preloadSrc.includes(m + ':'), `preload exposes ${m}`);
  }
});

test('every preload voice method targets a channel the module registers', () => {
  const invoked = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('(voice:[^']+)'/g)].map(m => m[1]);
  assert.ok(invoked.length >= 9, 'the bridge invokes the voice channels');
  for (const ch of new Set(invoked)) {
    assert.ok(assistantSrc.includes(`ipcMain.handle('${ch}'`), `main registers a handler for ${ch}`);
  }
});

test('main.js boots and tears the module down', () => {
  assert.match(mainSrc, /require\('\.\/main\/voiceAssistant'\)/, 'required');
  assert.match(mainSrc, /voiceAssistantModule = voiceAssistant\.init\(ctx\)/, 'initialised');
  assert.match(mainSrc, /voiceAssistantModule\.teardown\(\)/, 'torn down on quit');
  // The hold-to-talk watch lives in the speech host, not globalShortcut, so
  // unregisterAll() alone would leave it firing while a hotkey is being bound.
  assert.match(mainSrc, /voiceAssistantModule\.suspendTriggers\(\)/, 'suspended during hotkey binding');
  assert.match(mainSrc, /voiceAssistantModule\.resumeTriggers\(\)/, 'resumed afterwards');
});

test('teardown cannot resurrect the overlay it just destroyed', () => {
  // Killing the host fires its exit handler, which used to setState(FAILED) →
  // showOverlay() and recreate the window during shutdown.
  assert.match(assistantSrc, /let tearingDown = false;/);
  assert.match(assistantSrc, /if \(tearingDown\) return false;/, 'setState is inert once tearing down');
  assert.match(assistantSrc, /hostKillRequested/, 'a deliberate kill is distinguishable');
});

test('the overlay page and its preload are in the build manifest', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['voice-overlay.html', 'voice-overlay-preload.js']) {
    assert.ok(pkg.build.files.includes(f), `${f} ships in the build`);
  }
});

test('main.html loads the executor', () => {
  assert.ok(read('main.html').includes('renderer/voice-assistant.js'), 'script tag present');
});

// ── Registry entry ────────────────────────────────────────────────────────
function registry() {
  const src = read('renderer', 'core.js');
  const m = src.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  assert.ok(m, 'registry located');
  // eslint-disable-next-line no-eval
  return eval('(' + m[1] + ')');
}

test('the widget is registered, Windows-gated, and wired to its panel', () => {
  const w = registry().find(x => x.id === 'voiceAssistant');
  assert.ok(w, 'voiceAssistant is in the registry');
  assert.deepEqual(w.platforms, ['win32'], 'gated to Windows');
  assert.equal(w.panelId, 'voice-assistant-panel');
  assert.equal(w.panelRenderer, 'renderVoiceAssistantPanel');
  assert.ok(executorSrc.includes('function renderVoiceAssistantPanel'), 'that renderer exists');
  assert.ok(executorSrc.includes("getElementById('voice-assistant-panel')"), 'and fills that panel id');
  assert.ok(w.longDescription && w.features.length >= 4, 'documented for the library');
});

test('the default hotkey agrees everywhere it is written down', () => {
  const w = registry().find(x => x.id === 'voiceAssistant');
  assert.equal(w.defaultHotkey, V.DEFAULT_SETTINGS.hotkey, 'registry matches the settings default');
  assert.ok(read('renderer', 'core.js').includes(`voiceAssistant: '${V.DEFAULT_SETTINGS.hotkey}'`),
    'DEFAULT_HOTKEYS matches too');
});

test('the default hotkey does not collide with another widget', () => {
  const others = registry().filter(w => w.id !== 'voiceAssistant' && w.defaultHotkey).map(w => w.defaultHotkey);
  assert.ok(!others.includes(V.DEFAULT_SETTINGS.hotkey), 'no other widget claims Ctrl+Alt+V');
});

test('the config panel no-ops when its div is absent', () => {
  // Panel divs only exist while that widget's detail view is open.
  const fn = executorSrc.slice(executorSrc.indexOf('async function renderVoiceAssistantPanel'));
  assert.match(fn.slice(0, 300), /if \(!panel\) return;/, 'bails out with no panel');
});

// ── Hygiene ───────────────────────────────────────────────────────────────
test('no debug logging or leftover markers ship in the feature', () => {
  const files = {
    'main/voiceAssistant.js': assistantSrc,
    'main/voiceCommands.js': read('main', 'voiceCommands.js'),
    'main/voiceHostScript.js': read('main', 'voiceHostScript.js'),
    'renderer/voice-assistant.js': executorSrc,
    'voice-overlay.html': overlaySrc,
    'voice-overlay-preload.js': overlayPreloadSrc
  };
  for (const [name, src] of Object.entries(files)) {
    assert.ok(!/console\.log\(/.test(src), `${name} has no console.log`);
    assert.ok(!/\bdebugger\b/.test(src), `${name} has no debugger statement`);
    // NB: not the bare word "placeholder" - that is a real HTML attribute
    // (<input placeholder>) and a CSS pseudo-element (::placeholder).
    assert.ok(!/TODO|FIXME|XXX|HACK/.test(src), `${name} has no TODO/FIXME marker`);
    assert.ok(!/not implemented|coming soon|stub(bed)? out/i.test(src),
      `${name} has no stubbed-out work`);
  }
});

test('errors are reported through the logger, never swallowed silently', () => {
  assert.ok(assistantSrc.includes('logger.error'), 'failures reach the logger');
  // Every empty catch in the module must carry a note explaining why.
  const bareCatches = [...assistantSrc.matchAll(/catch \([^)]*\) \{\s*\}/g)];
  assert.equal(bareCatches.length, 0, 'no silent empty catch blocks');
});

// ── Wake word ─────────────────────────────────────────────────────────────
test('the wake grammar carries the command list as an OPTIONAL tail', () => {
  // That optional tail is what makes "hey main" and "hey main next track" both
  // single utterances rather than two round trips.
  const block = hostSrc.slice(hostSrc.indexOf('if (pendingWake.Count > 0)'));
  const body = block.slice(0, block.indexOf('ApplyMode();'));
  assert.ok(body.includes('gwake.Append(tail, 0, 1)'), 'the command tail repeats 0..1 times');
  assert.ok(body.includes('wakeGrammar.Name = "wake"'), 'and it is a separately named grammar');
});

test('a wake hit is reported distinctly from a command result', () => {
  // They are gated on different confidence thresholds, so they cannot share an
  // event name.
  assert.ok(hostSrc.includes('Grammar.Name == "wake"'), 'the host checks which grammar matched');
  assert.ok(hostSrc.includes('"WAKED "'), 'and emits WAKED for a wake hit');
  assert.ok(assistantSrc.includes('function onWaked'), 'the module handles it separately');
});

test('idle wake listening streams nothing the main process cannot use', () => {
  // The mic is open continuously in wake mode, so anything emitted there is
  // emitted forever. Hypotheses and audio-state changes have no consumer while
  // idle and stay suppressed.
  for (const fn of ['OnHypothesized', 'OnAudioState']) {
    const at = hostSrc.indexOf('static void ' + fn);
    assert.ok(at !== -1, fn + ' exists');
    const guard = hostSrc.slice(at, at + 260);
    assert.ok(guard.includes('mode == "wake"'), fn + ' is silent in wake mode');
  }
  // LEVEL is the exception, and has to be: it is the ONLY evidence the wake
  // gate has that a wake phrase had a real voice behind it. Suppressing it here
  // is what made the gate read a stale peak from an earlier command session and
  // go permanently deaf after the overlay was dismissed without speaking.
  const at = hostSrc.indexOf('static void OnLevel');
  const body = hostSrc.slice(at, at + 200);
  assert.ok(!body.includes('mode == "wake"'), 'OnLevel must measure in wake mode too');
  // The cost that guard was paying for is instead paid on the receiving side.
  assert.ok(/if \(V\.isMicOpenState\(state\)\) sendOverlay\('voice:overlay-level'/.test(assistantSrc),
    'idle levels must not be forwarded to the hidden overlay');
});

test('switching between wake and command never re-acquires the microphone', () => {
  // Re-acquiring costs hundreds of ms — far too slow to sit between the wake
  // phrase and the command spoken right after it.
  const at = hostSrc.indexOf('static void ApplyMode()');
  const body = hostSrc.slice(at, hostSrc.indexOf('static void ArmTimeout'));
  assert.ok(body.includes('.Enabled ='), 'the switch only toggles grammar enablement');
  assert.ok(!body.includes('SetInputTo'), 'it never touches the audio device');
});

test('the wake word is off by default and needs a higher confidence than commands', () => {
  assert.equal(V.DEFAULT_SETTINGS.wakeWord, false, 'opt-in: it keeps the mic open');
  assert.ok(V.DEFAULT_SETTINGS.wakeConfidence > V.DEFAULT_SETTINGS.confidence,
    'an always-listening phrase must clear a higher bar than a deliberate command');
});

test('every microphone decision goes through one reconciler', () => {
  // Wake mode and command mode must never both believe they own the device.
  assert.ok(assistantSrc.includes('function setHostMode'), 'a single mode setter exists');
  assert.ok(assistantSrc.includes('function reconcileMic'), 'and a single reconciler');
  assert.ok(!/hostSend\('LISTEN/.test(assistantSrc.replace(/function setHostMode[\s\S]*?\n  \}/, '')),
    'nothing outside setHostMode starts listening');
});

test('the wake word stands down while a hotkey is being bound', () => {
  // Otherwise it would be listening to whatever the user says mid-bind.
  const at = assistantSrc.indexOf('suspendTriggers:');
  const body = assistantSrc.slice(at, at + 500);
  assert.ok(body.includes('reconcileMic()'), 'suspend reconciles the mic');
});

test('the widget no longer claims the mic is only ever open while listening', () => {
  // It is still true by default, but the wake word makes it conditional, and the
  // registry copy is what a buyer reads.
  const src = read('renderer', 'core.js');
  const m = src.match(/const\s+MINI_WIDGETS_ALL\s*=\s*(\[[\s\S]*?\n\s*\]);/);
  // eslint-disable-next-line no-eval
  const w = eval('(' + m[1] + ')').find((x) => x.id === 'voiceAssistant');
  assert.ok(!/only ever open while the overlay is listening/.test(w.longDescription),
    'the unconditional claim is gone');
  assert.ok(/hey main/.test(w.longDescription), 'the wake word is described');
});

// ── Icon-only launcher tiles ──────────────────────────────────────────────
// Found by running against the real launcher: pinned tiles very often have a
// BLANK label (people run an icon-only launcher), which left "launch chrome"
// with nothing at all to match. The name now falls back to the icon, then the
// executable, and every candidate is kept as an alias.
test('a tile with no label still gets a speakable name', () => {
  const start = executorSrc.indexOf('function voiceAppNames(app) {');
  assert.ok(start !== -1, 'voiceAppNames exists');
  const close = executorSrc.indexOf('\n        }', start);
  const body = executorSrc.slice(start, close + 10);
  // eslint-disable-next-line no-new-func
  const voiceAppNames = new Function('return (' + body + ')')();

  assert.deepEqual(
    voiceAppNames({ name: '', icon: 'chrome.ico', path: 'C:\\apps\\chrome.exe' }),
    ['chrome'],
    'a blank label falls back to the icon');

  assert.deepEqual(
    voiceAppNames({ name: ' ', icon: 'discord.ico', path: 'C:\\apps\\Update.exe' }),
    ['discord', 'Update'],
    'the icon beats a generic launcher exe, which survives as an alias');

  assert.deepEqual(
    voiceAppNames({ name: '', icon: '', path: 'D:/games/Rocket League.exe' }),
    ['Rocket League'],
    'falls back to the executable, splitting forward slashes too');

  assert.deepEqual(
    voiceAppNames({ name: 'Valorant', icon: 'valorant.ico', path: 'C:\\r\\RiotClientServices.exe' }),
    ['Valorant', 'RiotClientServices'],
    'an explicit label always wins, exe stays as an alias');

  assert.deepEqual(voiceAppNames({ path: '' }), [], 'nothing speakable yields nothing');
});

test('the path split handles Windows separators, not just forward slashes', () => {
  // A one-character regex slip here silently turned the alias into a whole
  // file path, which then sanitised into unusable word soup.
  assert.match(executorSrc, /split\(\/\[\\\\\/\]\/\)/,
    'voiceAppNames splits on both backslash and forward slash');
});

// ── Appearance: transitions, viz styles, scale ────────────────────────────
test('the overlay knows every transition and viz style the settings allow', () => {
  // A style the settings accept but the stylesheet has no keyframes for would
  // simply not animate, with nothing to say so.
  const squashed = overlaySrc.split(' ').filter(Boolean).join(' ');
  for (const t of V.PANEL_TRANSITIONS) {
    // Runs of spaces are collapsed first: the stylesheet pads these rules
    // into columns, so an exact-substring match would miss.
    assert.ok(squashed.includes('.t-' + t + ' #capsule { animation:'),
      `overlay styles the "${t}" transition`);
    assert.ok(typeof V.EXIT_MS[t] === 'number', `"${t}" declares an exit duration`);
  }
  // Compare against the source of truth rather than a hardcoded copy, so adding
  // a style updates one place and this still guards the two lists agreeing.
  const listIn = (name) => {
    const at = overlaySrc.indexOf('const ' + name + ' = [');
    assert.ok(at !== -1, name + ' is declared in the overlay');
    const line = overlaySrc.slice(at, overlaySrc.indexOf(']', at) + 1);
    return line.split('[')[1].replace(']', '').split(',')
      .map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };
  assert.deepEqual(listIn('TRANSITIONS'), V.PANEL_TRANSITIONS.slice(),
    'the overlay transition list matches the settings list');
  assert.deepEqual(listIn('VIZ_STYLES'), V.VIZ_STYLES.slice(),
    'the overlay viz list matches the settings list');
  for (const v of V.VIZ_STYLES) {
    assert.ok(new RegExp("vizStyle === '" + v + "'").test(overlaySrc) || v === 'aurora',
      `the render loop branches for "${v}"`);
  }
});

test('appearance settings are validated, never trusted', () => {
  const junk = V.normalizeSettings({ transition: 'explode', vizStyle: 'lasers', scale: 99 }, null);
  assert.equal(junk.transition, 'fade');
  assert.equal(junk.vizStyle, 'aurora');
  assert.equal(junk.scale, 1.6, 'clamped to the maximum');
  const low = V.normalizeSettings({ scale: 0.01 }, null);
  assert.equal(low.scale, 0.7, 'clamped to the minimum');
  const stepped = V.normalizeSettings({ scale: 1.234 }, null);
  assert.equal(stepped.scale, Math.round(1.234 * 20) / 20, 'snapped to the slider step');
});

// The flicker this feature shipped with, locked down.
test('the exit animation is never cleared before the window is hidden', () => {
  // Stripping `leaving` on a timer dropped the animation's `both` fill while the
  // window was still on screen, so the panel snapped back to full opacity for a
  // frame. It is now only cleared on the next entrance.
  assert.ok(!/leaveTimer = setTimeout\(\(\) => \{\s*stage\.className = 'state-hidden'/.test(overlaySrc),
    'no timer resets the stage class mid-exit');
  assert.match(assistantSrc, /V\.EXIT_MS\[settings\.transition\]/,
    'main hides the window using the chosen transition duration');
});

// An answer that cannot be read is not an answer.
test('a result with something to read outlives a bare acknowledgement', () => {
  // The answer card was on screen for about 1.25s, which is fine for "Paused"
  // and far too short for a temperature plus a date plus chips — what actually
  // registered was the "Done" label and a flash. Success and answer must stay
  // separate durations.
  assert.match(assistantSrc, /SETTLE_MS\s*=\s*\{[^}]*answer:\s*(\d+)/,
    'SETTLE_MS declares a distinct duration for an answer');
  const answerMs = Number(assistantSrc.match(/SETTLE_MS\s*=\s*\{[^}]*answer:\s*(\d+)/)[1]);
  const successMs = Number(assistantSrc.match(/SETTLE_MS\s*=\s*\{[^}]*success:\s*(\d+)/)[1]);
  assert.ok(answerMs >= successMs * 2,
    `an answer (${answerMs}ms) must linger well beyond an acknowledgement (${successMs}ms)`);
  assert.match(assistantSrc, /extra && extra\.headline/,
    'the settle duration is chosen from whether the payload carries a headline');
});

// Measured: 428ms per popup before this, ~20ms after.
test('the overlay window is exempt from background throttling', () => {
  // The window spends all of its idle life hidden, and Chromium throttles a
  // hidden window: rAF stops entirely and timers are clamped. That throttled
  // the `painted` handshake itself — the one thing that has to run BEFORE the
  // window can be shown — so every activation fell back to the reveal timer.
  assert.match(assistantSrc, /backgroundThrottling: false/,
    'the overlay must keep running while hidden or it can never signal readiness');
});

test('the painted signal does not depend on a frame being rendered', () => {
  // A hidden window produces no frames, so rAF alone can never fire.
  assert.match(overlaySrc, /requestAnimationFrame\(\(\) => requestAnimationFrame\(signal\)\)/);
  assert.match(overlaySrc, /setTimeout\(signal, \d+\)/, 'a timer races the frame callback');
  assert.match(overlaySrc, /if \(signalled\) return;/, 'and only one of them wins');
});

test('the reveal fallback is a safety net, not the normal path', () => {
  const m = assistantSrc.match(/setTimeout\(revealOverlay, (\d+)\)/);
  assert.ok(m, 'there is still a fallback');
  assert.ok(Number(m[1]) <= 250, `the fallback (${m && m[1]}ms) must not be what the user waits for`);
});

test('the overlay is built before it is first needed', () => {
  // Creating it lazily put window creation and page load in front of the very
  // first popup.
  assert.match(assistantSrc, /ensureHost\(\)\.catch[\s\S]{0,400}?ensureOverlay\(\);/,
    'the window is warmed alongside the speech host');
});

test('the window is only revealed once a visible state has been painted', () => {
  // Showing first meant the window appeared displaying the previous state.
  assert.ok(overlayPreloadSrc.includes('painted:'), 'the overlay can report a paint');
  assert.match(assistantSrc, /ipcMain\.on\('voice:overlay-painted'/, 'main listens for it');
  assert.match(assistantSrc, /function revealOverlay\(\)/, 'revealing is separate from preparing');
  assert.match(assistantSrc, /revealTimer = setTimeout\(revealOverlay/, 'with a fallback if it never arrives');
});

test('the panel scale drives the window size, so a big panel is never clipped', () => {
  assert.match(assistantSrc, /function overlaySize\(\)/);
  assert.match(assistantSrc, /settings\.scale/, 'the size comes from the setting');
  assert.match(assistantSrc, /if \(before\.scale !== settings\.scale\) positionOverlay\(\)/,
    'changing it resizes immediately');
});

// ── Showing UI ────────────────────────────────────────────────────────────
test('commands that show UI raise the launcher from the main process', () => {
  // window.focus() from a renderer cannot restore a minimised window or pull one
  // in front of a fullscreen game. "open settings" really did open the modal —
  // out of sight — which is exactly what made it look broken.
  assert.match(assistantSrc, /ipcMain\.handle\('voice:focus-launcher'/, 'main exposes a focus channel');
  // Windows will not let a background process take the foreground, so a bare
  // show()/focus() is silently ignored. The always-on-top pulse is what makes
  // the raise actually happen.
  assert.ok(assistantSrc.includes('setAlwaysOnTop(true)'), 'it asserts topmost to win the raise');
  assert.ok(assistantSrc.includes('setAlwaysOnTop(false)'), 'and drops it again afterwards');
  assert.ok(assistantSrc.includes('app.focus({ steal: true })'), 'and steals focus explicitly');
  assert.ok(preloadSrc.includes('voiceFocusLauncher:'), 'the bridge exposes it');
  assert.match(executorSrc, /voiceFocusLauncher\(\)/, 'the executor calls it');
});

// ── Collapsible panel ─────────────────────────────────────────────────────
test('the config panel is split into sections that remember their state', () => {
  for (const id of ['activation', 'wake', 'appearance', 'behaviour', 'routines', 'try']) {
    assert.ok(executorSrc.includes("'" + id + "'"), `the "${id}" section exists`);
  }
  assert.match(executorSrc, /voicePanelSections/, 'open sections persist');
  assert.match(executorSrc, /function voiceToggleSection/, 'sections toggle');
  // Toggling must not re-render: that would throw away an in-progress routine.
  const fn = executorSrc.slice(executorSrc.indexOf('function voiceToggleSection'));
  const body = fn.slice(0, fn.indexOf('function voiceSection'));
  assert.ok(!body.includes('renderVoiceAssistantPanel'), 'toggling a section does not re-render the panel');
});

// ── Colour ────────────────────────────────────────────────────────────────
test('the form is white until the launcher has an accent theme', () => {
  // --accent is literally 255,255,255 until the user picks a theme, so reading
  // it gives white by default and their colour the moment they choose one.
  assert.match(executorSrc, /function voiceAccent\(\)/, 'the renderer reads the app accent');
  assert.match(executorSrc, /getPropertyValue\('--accent'\)/, 'from the same variable the app uses');
  assert.match(executorSrc, /return '255,255,255'/, 'falling back to white');
  assert.match(assistantSrc, /accentRgb = '255,255,255'/, 'main defaults to white too');
  assert.ok(overlaySrc.includes("let accent = '255,255,255'"), 'and so does the overlay');
});

test('the accent is validated everywhere it crosses a boundary', () => {
  // It is concatenated into rgba() strings, so only three plain numbers may pass.
  for (const src of [assistantSrc, overlaySrc]) {
    assert.ok(src.includes('d{1,3},') && src.includes('.test('),
      'a strict r,g,b check is present');
  }
});

test('only the two colour styles may hardcode white', () => {
  // Every accent-driven style must paint through `accent`, or picking a theme
  // would recolour only part of the form. Ribbons and Prism are the exception:
  // they carry their own palette, and the white heart where their bands cross is
  // the point of them.
  const js = overlaySrc.slice(overlaySrc.lastIndexOf('<script>'));
  const ribbons = js.indexOf('function drawRibbons');
  const prismEnd = js.indexOf('function render(now)');
  assert.ok(ribbons !== -1 && prismEnd > ribbons, 'the colour styles are where expected');
  const colourStyles = js.slice(ribbons, prismEnd);
  const elsewhere = js.slice(0, ribbons) + js.slice(prismEnd);
  assert.ok(!elsewhere.includes("'rgba(255,255,255,'"),
    'no literal white outside the two colour styles');
  assert.ok(js.includes("'rgba(' + accent + ','"), 'the accent is what everything else paints with');
  // And the colour styles genuinely do use white at their core.
  assert.ok(colourStyles.includes("'rgba(255,255,255,'"), 'their bright centre stays white');
});

// ── Naming ────────────────────────────────────────────────────────────────
test('no brand names appear in the customisation options', () => {
  for (const [name, src] of Object.entries({ 'voice-overlay.html': overlaySrc, 'renderer/voice-assistant.js': executorSrc,
    'main/voiceCommands.js': read('main', 'voiceCommands.js') })) {
    assert.ok(!/siri/i.test(src), name + ' mentions no brand');
  }
  assert.ok(V.VIZ_STYLES.includes('ribbons') && V.VIZ_STYLES.includes('prism'),
    'the two colour styles are named neutrally');
});

// ── Canvas sizing ─────────────────────────────────────────────────────────
test('the canvas is sized from layout, never from the transformed rect', () => {
  // The bug this guards: getBoundingClientRect() INCLUDES CSS transforms, and
  // the exit animations scale the capsule to a sliver (CRT reaches scaleY(0.014)).
  // A resize observed mid-animation rebuilt the backing store at 78x3, so every
  // later frame drew into a 3-pixel-tall buffer and the visual vanished for good.
  // Slice from the declaration to just past setTransform, which is the last
  // statement in resizeCanvas. An earlier version over-sliced into the hover
  // handler, which legitimately reads getBoundingClientRect.
  const at = overlaySrc.indexOf('function resizeCanvas()');
  const body = overlaySrc.slice(at, overlaySrc.indexOf('setTransform', at) + 40);
  assert.ok(!body.includes('canvas.getBoundingClientRect'),
    'sizing must not read the transformed rect');
  assert.ok(body.includes('canvas.clientWidth') && body.includes('canvas.clientHeight'),
    'it uses layout size, which transforms cannot affect');
  assert.ok(body.includes('w < 8') && body.includes('h < 8'),
    'and refuses to rebuild the buffer from a degenerate size');
});
