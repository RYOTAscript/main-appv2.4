const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { lockNavigation } = require('./windowGuard');
const { spawn } = require('child_process');
const { ensureVersionedScript } = require('./scriptCache');
const { isWindows } = require('./platform');
const { parseAccelerator } = require('./macros');
const { VOICE_HOST_SCRIPT_CONTENT, VOICE_HOST_SCRIPT_VERSION } = require('./voiceHostScript');
const V = require('./voiceCommands');
const { createResponder, forSpeech } = require('./voiceResponses');
const { createSpeaker } = require('./voiceSpeaker');

// One responder for the whole session: its phrase pools rotate, so the user
// hears the variation rather than the same wording every time. A fresh one per
// utterance would always return the first variant and defeat the point.
const responder = createResponder();

// What "it" currently refers to — set from the last command the user ran that
// established a subject (see V.pronounSubjectOf). Cleared on nothing: a stale
// antecedent is still the best available guess, and an unrelated command simply
// does not overwrite it.
let pronounSubject = null;   // { kind, params } — see V.resolvePronoun

// ── Voice Assistant ─────────────────────────────────────────────────────────
//
// Owns the overlay window, the persistent speech host, the activation hotkey and
// the state machine. Windows-only: recognition runs on the offline Windows
// desktop recognizer (System.Speech), which has no macOS counterpart reachable
// from osascript — the widget carries platforms: ['win32'] for the same reason
// autoClicker and controllerMacros do.
//
// WHERE COMMANDS ACTUALLY RUN: not here. A recognised intent is dispatched to
// the MAIN WINDOW's renderer (renderer/voice-assistant.js), which executes it
// through the same window.electronAPI calls the UI already uses. That is what
// keeps the assistant free of duplicated Spotify/launcher/widget logic — it
// drives the app the way a user does, through the existing preload bridge, and
// gains no capability the renderer doesn't already have.
//
// The overlay window itself is deliberately powerless: its preload exposes only
// render-state in and user-gestures out (see voice-overlay-preload.js).

const OVERLAY_WIDTH = 520;
const OVERLAY_HEIGHT = 500;
const OVERLAY_TOP_MARGIN = 8;

// How long a finished state lingers before the overlay dismisses itself.
//
// `answer` is deliberately much longer than `success`. An acknowledgement
// ("Paused") only has to register, and a second is plenty. A real ANSWER — a
// temperature, a time, a track, with a supporting line and chips — has to be
// READ, and at one second the panel was gone while the user was still looking
// at the "Done" label: the answer appeared to be "Done".
const SETTLE_MS = { success: 1000, error: 2000, answer: 3600, answerMax: 6000, errorHint: 3000 };
// A dispatched command must answer within this, or the renderer is treated as
// unavailable — a hung executor must never strand the assistant mid-command.
// A result whose loudest moment never reached this is the room, not a voice.
//
// The host reports 0..100, but that scale is NOT evenly used: measured on a
// built-in Intel mic array, ~18 seconds of silence peaked at 2 with a median of
// 0, because the driver's noise suppression flattens everything below speech.
// The original 8 therefore sat only six points above the noise floor with no
// evidence about where speech actually lands — and if speech lands under it,
// every single command is discarded and the assistant appears deaf. It was
// shipped at 8 in v4.2.0 and reported as exactly that.
//
// 3 clears the measured silence floor while leaving as much headroom as
// possible for a quiet or distant voice. This gate exists to catch "nobody
// spoke", not to rule on how loudly someone is allowed to.
const MIN_PEAK_LEVEL = 3;
// ...and the gate only applies once this many samples prove the meter is live.
const MIN_LEVEL_SAMPLES = 3;
// Waking is unsolicited, so it has to clear an unambiguously real voice rather
// than merely clearing silence. Deliberately a large multiple of MIN_PEAK_LEVEL:
// the cost of a missed wake is saying it again, the cost of a false wake is the
// overlay opening on its own and very nearly launching an app.
const WAKE_MIN_PEAK_LEVEL = 18;
const EXECUTE_TIMEOUT_MS = 12000;
const HOST_START_TIMEOUT_MS = 30000;

function init(ctx) {
  const { logger, userDataPath, appRoot, getMainWindow } = ctx;

  const SETTINGS_FILE = path.join(userDataPath, 'voice-assistant.json');
  const HOST_SCRIPT = path.join(userDataPath, 'voice-host.ps1');

  let settings = loadSettings();
  let enabled = false;                 // mirrors the widget toggle
  let state = V.VOICE_STATES.HIDDEN;

  let overlayWindow = null;

  let hostProc = null;
  let hostReady = false;
  let hostBuffer = '';
  // What the host's microphone is currently doing: 'off' (device released),
  // 'wake' (open, listening only for the wake phrase) or 'command' (open, full
  // grammar). Every change goes through setHostMode() so wake mode and command
  // mode can never both think they own the device.
  let hostMode = 'off';
  let hostStartWaiters = [];
  let hostStartTimer = null;
  // Distinguishes a host we killed on purpose (disable / app quit) from one that
  // died on its own. Without it, quitting mid-listen reports a spurious error —
  // and, far worse, the exit handler's setState(FAILED) calls showOverlay() and
  // resurrects the overlay window that teardown just destroyed.
  let hostKillRequested = false;
  let tearingDown = false;
  let recognizerName = '';
  let availableVoices = [];
  // Voices only WinRT can reach (OneCore). Tracked separately so the picker can
  // show which engine a voice comes from, and so a stale WinRT name can never
  // be handed to the SAPI fallback, which has never heard of it.
  let winrtVoices = [];
  let speaker = null;

  let vocabulary = V.EMPTY_VOCABULARY;
  let grammar = V.compileGrammar(vocabulary);
  let grammarDirty = true;

  let hotkeyAccel = null;              // currently registered globalShortcut
  let holdWatchActive = false;
  let triggersSuspended = false;

  let listenTimer = null;
  let settleTimer = null;
  let pendingConfirm = null;           // { commandId, params, command }
  // The loudest input seen since listening began, and how many level samples
  // arrived. A recognizer result that never had any audio behind it is an echo
  // of the room, not speech — see onResult.
  let peakLevel = 0;
  let levelSamples = 0;
  // A rolling window of recent level samples, for the wake gate only.
  // `peakLevel` is a per-session maximum, which is the right measure for a
  // command the user deliberately started and the wrong one for a wake word:
  // waking has no session, so the session peak it read belonged to whatever
  // happened last. Dismissing the overlay without speaking left it at ~2, below
  // the wake floor, and nothing waking does ever raised it again — so the wake
  // word stayed deaf until the next spoken command.
  const LEVEL_WINDOW_MS = 1500;
  let levelWindow = [];
  // The last command actually executed, so "undo that" has something to reverse.
  // Separate from lastIntent (which drives "do that again") because a repeat and
  // an undo must never chase each other.
  let lastExecuted = null;

  // ── Training ───────────────────────────────────────────────────────────
  // While a training run is active the assistant LISTENS but never acts. That
  // is the whole safety property of this mode: the user is reading prompts
  // aloud, not issuing commands, and "open settings" during training must open
  // nothing. Every recognition path checks this before dispatching.
  let training = null;   // { resolve, timer } while waiting on one prompt

  // ── History ────────────────────────────────────────────────────────────
  // What was heard, what it matched, and how sure it was. This exists because
  // of the false-accept incident: without a record, "it opened Settings on its
  // own" is unfalsifiable, and there is no way to tell a misheard command from
  // a mis-implemented one. Capped and in-memory only — it is a debugging aid,
  // not a transcript, and nothing about what a user says is written to disk.
  const HISTORY_MAX = 40;
  const history = [];
  const usageCounts = new Map();

  function recordHistory(entry) {
    // The peak input level is recorded WITH the outcome, because the two
    // together are what identify the failure. "Heard the wrong words at a good
    // level" is an acoustic or grammar problem; "heard nothing at a peak of 4"
    // is a microphone problem, and no amount of grammar work fixes the second.
    history.unshift(Object.assign({ at: Date.now(), peak: peakLevel }, entry));
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    if (entry.commandId) {
      usageCounts.set(entry.commandId, (usageCounts.get(entry.commandId) || 0) + 1);
    }
  }
  let lastHypothesis = '';
  let micState = 'unknown';            // 'ok' | 'denied' | 'missing' | 'error'
  // White until the launcher says otherwise (see setVocabulary).
  let accentRgb = '255,255,255';
  // Releases the temporary topmost flag used to force the launcher forward.
  let raiseDropTimer = null;
  // Removes the focus/blur listeners the raise installs.
  let raiseCleanup = null;

  const pendingExecutions = new Map(); // requestId -> { resolve, timer }
  let executionSeq = 0;

  // ── Settings ──────────────────────────────────────────────────────────
  function loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return V.normalizeSettings(raw, V.DEFAULT_SETTINGS);
      }
    } catch (e) {
      // A corrupt settings file must never stop the widget from loading.
      if (logger) logger.warn('Voice assistant settings unreadable — using defaults', e);
    }
    return { ...V.DEFAULT_SETTINGS };
  }

  function saveSettings() {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) {
      logger.error('Voice assistant settings could not be saved', e);
    }
  }

  // ── Overlay window ────────────────────────────────────────────────────
  // Placed at the top centre of the display the user is actually looking at
  // (the one under the cursor), not blindly on the primary monitor.
  function targetDisplay() {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch (e) {
      return screen.getPrimaryDisplay();
    }
  }

  // The window has to be big enough for the panel at whatever scale the user
  // picked, plus room for its shadow and the CRT flash.
  function overlaySize() {
    const scale = settings.scale || 1;
    const area = targetDisplay().workArea;
    return {
      width: Math.min(area.width, Math.max(OVERLAY_WIDTH, Math.round(OVERLAY_WIDTH * scale) + 40)),
      height: Math.min(area.height, Math.max(OVERLAY_HEIGHT, Math.round(OVERLAY_HEIGHT * scale) + 40))
    };
  }

  function positionOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const area = targetDisplay().workArea;
    const { width, height } = overlaySize();
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + OVERLAY_TOP_MARGIN);
    try { overlayWindow.setBounds({ x, y, width, height }); } catch (e) { /* display gone */ }
  }

  function ensureOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
    const initial = overlaySize();
    overlayWindow = new BrowserWindow({
      width: initial.width,
      height: initial.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      // Focusable so the typed fallback and Esc work for keyboard-only use, but
      // it is shown inactive by default so it never pulls focus out of a game.
      focusable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        // Chromium throttles a hidden or occluded window: rAF stops entirely and
        // timers are clamped. This window spends ALL of its idle life hidden, so
        // the throttle applied to exactly the code that has to run before it can
        // be shown — the `painted` handshake never arrived and every activation
        // after the first sat on the reveal fallback instead. It is also what
        // froze the entrance animation mid-flight.
        //
        // Safe here because the window is tiny, and it only animates while it is
        // actually on screen: hidden, it renders nothing and costs nothing.
        backgroundThrottling: false,
        preload: path.join(appRoot, 'voice-overlay-preload.js')
      }
    });
    lockNavigation(overlayWindow, logger);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Click-through by default: a transparent 520x500 window at the top of the
    // screen must never eat a click meant for whatever is underneath. The
    // overlay asks for the mouse back only while the pointer is over the capsule
    // (voice:overlay-hover below).
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadFile(path.join(appRoot, 'voice-overlay.html')).catch((e) => {
      logger.error('Voice overlay failed to load', e);
    });
    overlayWindow.on('closed', () => { overlayWindow = null; });
    positionOverlay();
    return overlayWindow;
  }

  // Reveals the window. Called from the overlay's `painted` signal (and from a
  // fallback timer), never directly on a state change — showing before the new
  // state has rendered is what made the window flash the previous frame.
  function revealOverlay() {
    const win = overlayWindow;
    if (!win || win.isDestroyed() || win.isVisible()) return;
    if (state === V.VOICE_STATES.HIDDEN) return;   // it was dismissed while we waited
    positionOverlay();
    // If the launcher itself is in the foreground, the user is at the keyboard —
    // give the overlay focus so Esc and the typed field work immediately. If
    // anything else is focused (a game), show without stealing it.
    const main = getMainWindow();
    const launcherFocused = !!(main && !main.isDestroyed() && main.isFocused());
    try {
      // Always inactive: the overlay is a HUD. Taking focus here would fight the
      // launcher when a command raises it a moment later.
      win.showInactive();
      if (launcherFocused) { /* the launcher keeps focus; the overlay just appears */ }
      raiseOverlayAboveEverything();
    } catch (e) {
      logger.warn('Voice overlay could not be shown', e);
    }
  }

  // Prepares the window and arms the reveal. The overlay answers with `painted`
  // as soon as the new state is on screen; the timer is only a safety net for a
  // renderer that is still loading.
  let revealTimer = null;
  function showOverlay() {
    const win = ensureOverlay();
    if (!win || win.isDestroyed()) return;
    positionOverlay();
    if (win.isVisible()) return;
    clearTimeout(revealTimer);
    // Pure safety net now that `painted` reliably arrives within ~25ms even
    // when the window is hidden. It only matters for a renderer that is still
    // loading, so it no longer needs to be generous.
    revealTimer = setTimeout(revealOverlay, 220);
  }

  // The HUD must sit above everything, including the launcher — which this
  // module briefly pins topmost when a command opens UI. Always-on-top set once
  // at creation does not survive another window becoming topmost afterwards, so
  // the level is re-asserted (and the window moved to the front of its band)
  // every time the overlay is shown or the launcher is raised.
  function raiseOverlayAboveEverything() {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    try {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.moveTop();
    } catch (e) { /* window going away */ }
  }

  function hideOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    try {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.hide();
    } catch (e) { /* already gone */ }
  }

  function sendOverlay(channel, payload) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    try { overlayWindow.webContents.send(channel, payload); } catch (e) { /* window closing */ }
  }

  // ── State ─────────────────────────────────────────────────────────────
  function stateLabel(next, extra) {
    if (extra && extra.label) return extra.label;
    switch (next) {
      case V.VOICE_STATES.LISTENING: return 'Listening';
      case V.VOICE_STATES.PROCESSING: return 'Working';
      case V.VOICE_STATES.CONFIRMING: return 'Confirm';
      case V.VOICE_STATES.SPEAKING: return 'Speaking';
      case V.VOICE_STATES.SUCCESS: return 'Done';
      case V.VOICE_STATES.ERROR: return 'Sorry';
      default: return 'Ready';
    }
  }

  function pushState(extra) {
    const payload = Object.assign({
      state,
      label: stateLabel(state, extra),
      showTranscript: settings.showTranscript,
      reducedMotion: settings.reducedMotion,
      clickActivate: settings.clickActivate,
      transition: settings.transition,
      vizStyle: settings.vizStyle,
      scale: settings.scale,
      accent: accentRgb,
      micAvailable: micState !== 'denied' && micState !== 'missing',
      hint: state === V.VOICE_STATES.LISTENING
        ? (settings.activation === 'hold' ? 'Release to send' : formatAccel(settings.hotkey) + ' to cancel')
        : ''
    }, extra || {});
    sendOverlay('voice:overlay-state', payload);
    // The widget's config panel mirrors live state so the user can see the
    // assistant working from inside the Widget Library.
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      try { main.webContents.send('voice:state', { state, enabled, hostReady, recognizerName, micState }); } catch (e) { /* ignore */ }
    }
  }

  function formatAccel(accel) {
    return String(accel || '').replace(/CommandOrControl|Control/g, 'Ctrl').replace(/\+/g, '+');
  }

  // The one place state changes. Every transition goes through the pure reducer,
  // and the microphone is reconciled against the resulting state immediately —
  // so no path, including an error path, can leave the mic open.
  function setState(event, extra) {
    // Once teardown has started nothing may reopen the overlay or the mic.
    if (tearingDown) return false;
    const next = V.nextState(state, event);
    const changed = next !== state;
    state = next;

    clearTimeout(settleTimer);
    if (!V.isMicOpenState(state)) {
      clearTimeout(listenTimer);
      listenTimer = null;
      // Not "stop": with the wake word on, leaving a command drops back to wake
      // listening rather than releasing the device.
      reconcileMic();
    }

    if (state === V.VOICE_STATES.HIDDEN) {
      holdEscape(false);
      pendingConfirm = null;
      lastHypothesis = '';
      pushState(extra);
      // Let the overlay play its exit before the window goes away.
      // Hide only after the exit animation has finished — cutting it short is
      // what the flicker was.
      settleTimer = setTimeout(hideOverlay, (V.EXIT_MS[settings.transition] || 240) + 60);
      return changed;
    }

    // Order matters: create + position, send the new state, then arm the reveal.
    ensureOverlay();
    pushState(extra);
    showOverlay();
    holdEscape(true);

    if (state === V.VOICE_STATES.SUCCESS || state === V.VOICE_STATES.ERROR) {
      // Something with content to read stays up long enough to read it.
      const hasCard = !!(extra && extra.headline);
      const hasHint = !!(extra && extra.detail);
      // Scale with how much there is to read. A two-digit temperature and a
      // wrapped track title are both "an answer", but they are not the same
      // amount of reading, and a fixed dwell is wrong for one of them.
      let ms;
      if (hasCard) {
        const chars = String(extra.headline).length + String(extra.detail || '').length;
        ms = Math.min(SETTLE_MS.answerMax, SETTLE_MS.answer + Math.max(0, chars - 20) * 28);
      } else if (state === V.VOICE_STATES.ERROR && hasHint) {
        ms = SETTLE_MS.errorHint;
      } else {
        ms = SETTLE_MS[state] || 2000;
      }
      settleTimer = setTimeout(() => setState(V.VOICE_EVENTS.SETTLE), ms);
    }
    return changed;
  }

  // ── Speech host ───────────────────────────────────────────────────────
  function ensureHostScript() {
    ensureVersionedScript(HOST_SCRIPT, VOICE_HOST_SCRIPT_VERSION, VOICE_HOST_SCRIPT_CONTENT);
  }

  function ensureHost() {
    // The better-voices helper comes up with the host. Independent processes on
    // purpose: if this one never becomes ready, speech falls back to SAPI and
    // recognition is completely unaffected.
    startSpeaker();
    return new Promise((resolve, reject) => {
      if (hostProc && hostReady) { resolve(); return; }
      hostStartWaiters.push({ resolve, reject });
      if (hostProc) return;            // already starting — READY flushes everyone
      try {
        ensureHostScript();
        hostProc = spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOST_SCRIPT],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        hostProc = null;
        flushHostWaiters(e);
        return;
      }

      hostStartTimer = setTimeout(() => {
        if (!hostReady) {
          logger.error('Voice host did not become ready in time', null, {});
          killHost();
          flushHostWaiters(new Error('Voice host failed to start'));
        }
      }, HOST_START_TIMEOUT_MS);

      hostProc.stdout.on('data', (chunk) => {
        hostBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = hostBuffer.indexOf('\n')) !== -1) {
          const line = hostBuffer.slice(0, nl).trim();
          hostBuffer = hostBuffer.slice(nl + 1);
          if (line) handleHostLine(line);
        }
      });
      hostProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) logger.error('Voice host stderr', new Error(msg.slice(0, 500)));
      });
      hostProc.on('exit', (code) => {
        const wasActive = state !== V.VOICE_STATES.HIDDEN;
        const deliberate = hostKillRequested || tearingDown;
        hostProc = null;
        hostReady = false;
        hostMode = 'off';
        hostBuffer = '';
        hostKillRequested = false;
        clearTimeout(hostStartTimer);
        flushHostWaiters(new Error('Voice host exited'));
        if (deliberate) {
          logger.log(`Voice host stopped (code ${code})`, 'INFO');
          return;
        }
        if (wasActive) {
          logger.error('Voice host exited unexpectedly', null, { code, state });
          setState(V.VOICE_EVENTS.FAILED, { message: 'Speech engine stopped' });
        } else {
          logger.log(`Voice host exited (code ${code})`, 'INFO');
        }
      });
    });
  }

  function flushHostWaiters(err) {
    const waiters = hostStartWaiters;
    hostStartWaiters = [];
    for (const w of waiters) err ? w.reject(err) : w.resolve();
  }

  function hostSend(line) {
    if (hostProc && hostProc.stdin.writable) {
      try { hostProc.stdin.write(line + '\n'); } catch (e) { /* host dying */ }
    }
  }

  // ── Speaking ───────────────────────────────────────────────────────────
  // Prefer the WinRT (OneCore) voices: SAPI5 can only see the older "Desktop"
  // voices, which is most of why the assistant sounded synthetic. If the helper
  // is not up — old Windows, WinRT unavailable — this falls straight back to the
  // host's own synthesizer, so speech degrades in quality but never disappears.
  function speakReply(text) {
    const wantsWinrt = !settings.voiceName || winrtVoices.includes(settings.voiceName);
    if (speaker && speaker.isReady() && wantsWinrt) {
      if (speaker.speak(text, settings.voiceName, settings.speechRate)) return;
    }
    hostSend('SPEAK ' + text);
  }

  function stopSpeaking() {
    if (speaker && speaker.isReady()) speaker.stopSpeaking();
    hostSend('SHUTUP');
  }

  function startSpeaker() {
    if (speaker) return;
    speaker = createSpeaker({
      logger,
      onEvent: (kind, payload) => {
        if (kind === 'voices' && Array.isArray(payload)) {
          winrtVoices = payload.slice();
          // Offered ahead of the SAPI names: these are the better ones.
          availableVoices = winrtVoices.concat(availableVoices.filter((v) => !winrtVoices.includes(v)));
          pushState();
        } else if (kind === 'speak-done') {
          duckMusic(false);
          if (state === V.VOICE_STATES.SPEAKING) setState(V.VOICE_EVENTS.SPOKEN, lastSpokenExtra);
        } else if (kind === 'unavailable' || kind === 'exit') {
          winrtVoices = [];
        }
      }
    });
    speaker.start();
  }

  function killHost() {
    if (!hostProc) return;
    hostKillRequested = true;
    try {
      hostSend('STOP');
      hostSend('EXIT');
      const proc = hostProc;
      // Give it a moment to release the audio device cleanly, then make sure.
      setTimeout(() => { try { proc.kill(); } catch (e) { /* already gone */ } }, 1200);
    } catch (e) { /* ignore */ }
    hostProc = null;
    hostReady = false;
    hostMode = 'off';
  }

  function pushGrammar() {
    if (!hostReady) return;
    hostSend('GRAMMAR-BEGIN');
    // Machine-discovered app names go to the bulk bucket: they are the bulk of
    // the vocabulary and the least valuable part of it, so they are loaded at a
    // lower weight rather than competing with real commands head-on.
    for (const phrase of grammar.phrases) {
      const entry = grammar.index.get(phrase);
      const bulk = entry && entry.commandId === 'app.launch';
      hostSend((bulk ? 'BULK ' : 'PHRASE ') + phrase);
    }
    for (const d of grammar.dictation) hostSend('DICTATION ' + d.carrier);
    for (const w of V.CONFIRM_YES) hostSend('CONFIRM ' + w);
    for (const w of V.CONFIRM_NO) hostSend('CONFIRM ' + w);
    // Always sent, whether or not the wake word is currently on: the host keeps
    // the wake grammar loaded but disabled, so toggling the setting is a mode
    // switch rather than a grammar rebuild.
    for (const w of V.WAKE_PHRASES) hostSend('WAKE ' + w);
    hostSend('CHAIN ' + (settings.chaining ? '1' : '0'));
    // Sent before GRAMMAR-END so the flag is in place when the host builds its
    // grammars — the catch-all is loaded during that build, not after it.
    hostSend('FREEFORM ' + (settings.freeform === false ? '0' : '1'));
    hostSend('GRAMMAR-END');
    grammarDirty = false;
  }

  // The ONLY place the microphone changes state.
  //
  // Switching between wake and command uses MODE, which just flips which
  // grammars are enabled — the audio device is never re-acquired, so the command
  // grammar is live the instant the wake phrase lands. Only 'off' actually
  // releases the device.
  function setHostMode(next, timeoutMs) {
    if (!hostReady) { hostMode = 'off'; return; }
    if (next === 'off') {
      if (hostMode !== 'off') hostSend('STOP');
      hostMode = 'off';
      return;
    }
    if (grammarDirty) pushGrammar();
    if (next === 'wake') {
      if (hostMode === 'wake') return;
      hostSend(hostMode === 'off' ? 'WAKE-LISTEN' : 'MODE wake');
      hostMode = 'wake';
      return;
    }
    // command
    const ms = timeoutMs || settings.listenTimeoutMs;
    hostSend('VOICE ' + (settings.voiceName || ''));
    hostSend('RATE ' + settings.speechRate);
    hostSend(hostMode === 'off' ? ('LISTEN ' + ms) : ('MODE command ' + ms));
    hostMode = 'command';
  }

  // Brings the microphone in line with the current state and settings. Called
  // after every transition, so no path can leave the device in the wrong mode.
  //
  // The invariant: the mic is open only while the overlay needs it, OR while the
  // wake word is switched on. Nothing else opens it.
  // Loudest sample in the recent window; anything older simply does not count.
  function recentPeak() {
    const cut = Date.now() - LEVEL_WINDOW_MS;
    let peak = 0;
    for (const sample of levelWindow) if (sample.at >= cut && sample.lvl > peak) peak = sample.lvl;
    return peak;
  }

  function reconcileMic() {
    if (tearingDown || !enabled || !hostReady) return;
    if (V.isMicOpenState(state)) return;          // command listening owns it
    if (settings.wakeWord && !triggersSuspended) setHostMode('wake');
    else setHostMode('off');
  }

  function handleHostLine(line) {
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);

    switch (tag) {
      case 'READY':
        hostReady = true;
        recognizerName = rest;
        clearTimeout(hostStartTimer);
        logger.success('Voice host started', { recognizer: rest });
        grammarDirty = true;
        pushGrammar();
        applyHoldWatch();
        reconcileMic();
        flushHostWaiters(null);
        return;
      case 'VOICE-AVAILABLE':
        if (rest && !availableVoices.includes(rest)) availableVoices.push(rest);
        return;
      case 'GRAMMAR-OK':
        logger.log(`Voice grammar loaded (${rest} phrases)`, 'INFO');
        return;
      case 'LISTENING':
        return;
      case 'STOPPED':
        hostMode = 'off';
        return;
      case 'FREE':
        // Open-dictation text. Not a command match — a guess at the words. It
        // goes through the same matcher, but with no confidence benefit of the
        // doubt: it has to earn a match on the words alone.
        onFreeform(rest);
        return;
      case 'ALT':
        // An n-best candidate for the result just emitted. Held rather than
        // acted on: the decision needs the whole set, and RESULT arrives first.
        if (pendingAlternates) {
          const sp = rest.indexOf(' ');
          if (sp !== -1) {
            pendingAlternates.push({
              confidence: parseFloat(rest.slice(0, sp)),
              text: rest.slice(sp + 1).trim()
            });
          }
        }
        return;
      case 'LEVEL': {
        const lvl = parseInt(rest, 10) || 0;
        if (lvl > peakLevel) peakLevel = lvl;
        levelSamples++;
        const now = Date.now();
        levelWindow.push({ at: now, lvl });
        while (levelWindow.length && now - levelWindow[0].at > LEVEL_WINDOW_MS) levelWindow.shift();
        // Only a visible overlay wants a meter. Wake mode measures now too, but
        // it is idle and hidden — it must not push frames at a window nobody is
        // looking at.
        if (V.isMicOpenState(state)) sendOverlay('voice:overlay-level', lvl);
        return;
      }
      case 'AUDIO':
        return;
      case 'HYP':
        if (state === V.VOICE_STATES.LISTENING && rest) {
          lastHypothesis = rest;
          if (settings.showTranscript) pushState({ hypothesis: rest });
        }
        return;
      case 'RESULT':
        onResult(rest);
        return;
      case 'WAKED':
        onWaked(rest);
        return;
      case 'REJECTED':
        // Ordinary room noise. The host stays in Multiple mode, so a rejected
        // utterance is not a failure — keep listening and let the timeout end it
        // if nothing better arrives. Failing here would make the assistant give
        // up the instant someone coughed.
        return;
      case 'TIMEOUT':
        hostMode = 'off';
        if (V.isMicOpenState(state)) {
          setState(V.VOICE_EVENTS.TIMEOUT, { message: lastHypothesis ? 'Didn’t catch that' : 'I didn’t hear anything' });
        }
        return;
      case 'SPEAK-START':
        return;
      case 'SPEAK-DONE':
        duckMusic(false);
        if (state === V.VOICE_STATES.SPEAKING) setState(V.VOICE_EVENTS.SPOKEN, lastSpokenExtra);
        return;
      case 'KEY-DOWN':
        onHoldDown();
        return;
      case 'KEY-UP':
        onHoldUp();
        return;
      case 'PONG':
        return;
      case 'ERROR':
        logger.error('Voice host error', new Error(rest.slice(0, 300)));
        if (V.isMicOpenState(state)) {
          const friendly = /microphone/i.test(rest) ? 'No microphone available' : 'Speech engine error';
          setState(V.VOICE_EVENTS.FAILED, { message: friendly });
        }
        return;
      default:
        return;
    }
  }

  // ── Recognition results ───────────────────────────────────────────────
  // A hit on the wake grammar. The text is either the bare wake phrase or the
  // wake phrase plus a command said in the same breath ("hey main next track"),
  // because the wake grammar carries the command list as an optional tail.
  function onWaked(rest) {
    if (!settings.wakeWord || !enabled || triggersSuspended) return;
    const sp = rest.indexOf(' ');
    const confidence = parseFloat(sp === -1 ? rest : rest.slice(0, sp));
    const text = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (!text) return;

    // The wake phrase is always listening, so it gets its own much higher bar
    // than a command the user deliberately activated for.
    if (!Number.isFinite(confidence) || confidence < settings.wakeConfidence) {
      logger.debug('Wake phrase below its confidence floor', { text, confidence });
      return;
    }

    // ── And its own LEVEL bar ──
    // MIN_PEAK_LEVEL is set just above the measured silence floor so a
    // deliberately-activated command from a quiet voice is never thrown away.
    // That is far too permissive for a phrase nobody asked for: with the wake
    // word on, the assistant was waking on near-silence — the log literally
    // reads `Woken by voice {"command":"silence"}` — and popping the overlay
    // open by itself. Waking is unsolicited, so it must clear a real voice.
    // Measured over the last second and a half, not over a session that may
    // have ended minutes ago. As everywhere else here, too few samples to judge
    // means the gate stands down rather than silencing anything.
    const recent = recentPeak();
    if (levelWindow.length >= MIN_LEVEL_SAMPLES && recent < WAKE_MIN_PEAK_LEVEL) {
      logger.log('Wake ignored: no speech-level audio behind it', 'INFO',
        { heard: text, peak: recent, floor: WAKE_MIN_PEAK_LEVEL });
      return;
    }
    const parsed = V.stripWakePhrase(text);
    if (!parsed.woke) return;
    // Already mid-command: a stray wake phrase must not restart anything.
    if (V.isMicOpenState(state) || state === V.VOICE_STATES.PROCESSING) return;

    logger.log('Woken by voice', 'INFO', { command: parsed.rest || '(none)' });
    showOverlay();
    if (parsed.rest) {
      // Command spoken in the same breath — run it without a second round trip.
      // SUBMIT, not ACTIVATE: the words are already in hand, so the overlay has
      // no reason to open its own microphone for a listening animation.
      setState(V.VOICE_EVENTS.SUBMIT, { transcript: parsed.rest });
      // Nobody deliberately activated: this came from the always-listening wake
      // path, so a risky command has to clear a higher bar.
      handleUtterance(parsed.rest, { confidence, viaWake: true });
      return;
    }
    // Bare wake phrase — open up and listen for the command.
    setState(V.VOICE_EVENTS.ACTIVATE);
    setHostMode('command', settings.listenTimeoutMs);
    armListenTimeout();
  }

  // ── N-best re-ranking ──────────────────────────────────────────────────
  // The recognizer's top pick is its acoustic best guess. It has no idea which
  // phrases are real commands right now, and the main process does — so when
  // the top pick matches nothing, a lower-scoring alternate that DOES match a
  // command is much more likely to be what was said.
  //
  // Strictly a rescue path: a top result that already matches always wins, so
  // this can only turn a miss into a hit, never change a working answer.
  let pendingAlternates = null;
  let alternateTimer = null;

  // How much worse an alternate may be before preferring it stops being
  // reasonable. A candidate the engine barely heard is not evidence.
  const ALT_MIN_CONFIDENCE = 0.35;

  function chooseFromAlternates(alts, topText, topConfidence) {
    if (!alts || !alts.length) return null;
    for (const alt of alts) {
      if (!alt.text || !Number.isFinite(alt.confidence)) continue;
      if (alt.confidence < ALT_MIN_CONFIDENCE) continue;
      const m = V.matchIntent(alt.text, vocabulary, grammar);
      if (m.status === 'matched' || m.status === 'missing-slot') {
        logger.log('Voice result rescued from an alternate', 'INFO', {
          heard: topText, confidence: topConfidence, used: alt.text, altConfidence: alt.confidence
        });
        return alt;
      }
    }
    return null;
  }

  // ── Freeform ───────────────────────────────────────────────────────────
  // The closed grammar can only hear what was compiled into it, so anything
  // phrased differently was not misheard — it was inaudible. The catch-all
  // dictation grammar produces a transcription of ANY speech, and matching that
  // against ~90 known commands is a far easier problem than transcribing
  // English correctly, so a rough transcription is usually enough.
  //
  // Held to a higher bar than a grammar hit, deliberately: dictation fires on
  // everything, including speech that was never meant for the assistant.
  const FREEFORM_MIN_SCORE = 0.78;

  function onFreeform(rest) {
    const sp = rest.indexOf(' ');
    const confidence = parseFloat(sp === -1 ? rest : rest.slice(0, sp));
    const text = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (!text) return;
    // Training captures whatever was heard and runs nothing.
    if (training) { captureTraining(text, confidence); return; }
    if (state !== V.VOICE_STATES.LISTENING) return;

    // Same audio-level evidence the grammar path needs.
    if (levelSamples >= MIN_LEVEL_SAMPLES && peakLevel < MIN_PEAK_LEVEL) return;

    const match = V.matchIntent(text, vocabulary, grammar);
    // Only a confident, unambiguous match is worth acting on. Anything less and
    // we stay silent and keep listening — the grammar may still produce a
    // proper hit, and acting on a weak dictation guess is how an assistant ends
    // up doing something nobody asked for.
    if (match.status !== 'matched' || !(match.score >= FREEFORM_MIN_SCORE)) {
      // INFO, not debug: this is the path that silently swallows an utterance,
      // so it has to be visible in the log or the failure is invisible.
      logger.log('Heard, but not a command', 'INFO', { heard: text, score: match.score });
      // Recorded even though nothing ran: this is precisely the evidence that
      // shows whether the words were heard correctly and merely failed to match.
      recordHistory({ transcript: text, commandId: '', outcome: 'heard-only', confidence, viaFree: true });
      return;
    }
    logger.log('Understood via free dictation', 'INFO', { text, commandId: match.commandId, score: match.score });
    // Passed as the ACTUAL confidence so the risk guard still applies: a risky
    // command reached this way is confirmed, not run.
    recordHistory({ transcript: text, commandId: match.commandId, outcome: 'freeform', confidence, viaFree: true });
    handleUtterance(text, { confidence, viaWake: false, viaFreeform: true });
  }

  function onResult(rest) {
    const sp = rest.indexOf(' ');
    const confidence = parseFloat(sp === -1 ? rest : rest.slice(0, sp));
    const text = sp === -1 ? '' : rest.slice(sp + 1).trim();
    if (!text) return;

    // Length-aware confidence gate. A closed grammar always returns its nearest
    // phrase, so short utterances (which room noise can fit) need far more
    // confidence than long ones. See voiceCommands.confidenceFloor.
    if (!V.meetsConfidence(text, confidence, settings.confidence)) {
      logger.log('Voice result below confidence floor', 'INFO', { text, confidence });
      return;   // keep listening; the timeout ends it if nothing better arrives
    }

    // Was there ever any audio behind this? The recognizer will happily round
    // near-silence to its nearest phrase, and that is how the assistant ended
    // up running a command with nobody speaking to it.
    //
    // Only applied once the level stream has proven it works: with no samples
    // at all this must NOT block, or a broken meter would silence the whole
    // assistant. Missing evidence blocks nothing here; it simply skips the gate.
    if (levelSamples >= MIN_LEVEL_SAMPLES && peakLevel < MIN_PEAK_LEVEL) {
      logger.log('Voice result discarded: no speech-level audio behind it', 'INFO',
        { heard: text, confidence, peakLevel, floor: MIN_PEAK_LEVEL, levelSamples });
      return;
    }

    // Training captures whatever was heard and runs nothing. Checked before the
    // alternates window so a training prompt answers immediately.
    if (training) { captureTraining(text, confidence); return; }

    // Alternates arrive immediately after RESULT. Give them a beat to land, then
    // decide — the whole set has to be in hand before a rescue makes sense.
    pendingAlternates = [];
    clearTimeout(alternateTimer);
    alternateTimer = setTimeout(() => {
      const alts = pendingAlternates;
      pendingAlternates = null;
      finishResult(text, confidence, alts || []);
    }, 60);
    return;
  }

  // The second half of onResult, once any alternates are in.
  function finishResult(text, confidence, alts) {
    if (state === V.VOICE_STATES.CONFIRMING) {
      const answer = V.matchConfirmation(text);
      if (answer === 'yes') { runPendingConfirm(); return; }
      if (answer === 'no') { setState(V.VOICE_EVENTS.DISMISS); return; }
      return;   // not an answer — keep waiting
    }

    if (state !== V.VOICE_STATES.LISTENING) return;

    // Only rescue an outright miss. A top result that already matches a command
    // — or parses as a chain — always wins, so this can turn a miss into a hit
    // but can never change an answer that was already working.
    let chosenText = text;
    let chosenConfidence = confidence;
    const top = V.matchIntent(text, vocabulary, grammar);
    const topChains = settings.chaining && V.matchChain(text, vocabulary, grammar).chained;
    if (top.status === 'unknown' && !topChains) {
      const better = chooseFromAlternates(alts, text, confidence);
      if (better) {
        chosenText = better.text;
        chosenConfidence = better.confidence;
      }
    }
    handleUtterance(chosenText, { confidence: chosenConfidence, viaWake: false });
  }

  // Shared by speech and the typed fallback, so both take exactly the same path.
  function handleUtterance(text, origin) {
    // Declared up front because the history recorder and the risk guard BOTH
    // read them, and the recorder runs first. They used to be declared beside
    // the risk guard, which put the earlier read inside the temporal dead zone —
    // every unrecognised utterance threw a ReferenceError instead of answering.
    const o = origin || {};
    // Typed input reports full confidence: it was unambiguously intended, so the
    // guard that exists for what the microphone heard does not apply to it.
    const conf = Number.isFinite(Number(o.confidence)) ? Number(o.confidence) : 1;

    // Several commands in one breath, when every part resolves on its own.
    if (settings.chaining) {
      const chain = V.matchChain(text, vocabulary, grammar);
      if (chain.chained) { runChain(text, chain.steps); return; }
    }
    let match = V.matchIntent(text, vocabulary, grammar);

    // "Turn it up" is not a command — it is a reference to whatever the user was
    // just doing. Resolve it against the last subject they acted on, but only
    // when the matcher has nothing better: a real match always wins, and with no
    // antecedent this returns '' and the utterance stays unknown rather than
    // guessing which volume to change.
    if (match.status === 'unknown' || match.status === 'ambiguous') {
      const resolved = V.resolvePronoun(text, pronounSubject);
      if (resolved) {
        const cmd = V.COMMANDS.find((c) => c.id === resolved.commandId);
        if (cmd) {
          match = {
            status: 'matched', commandId: cmd.id, command: cmd,
            params: resolved.params || {}, phrase: text, score: 1, confirm: !!cmd.confirm
          };
        }
      }
    }

    if (match.status === 'unknown') {
      recordHistory({ transcript: text, commandId: '', outcome: 'unknown', confidence: conf, viaWake: !!o.viaWake });
      const answer = responder.respondUnknown(text);
      setState(V.VOICE_EVENTS.REJECTED, {
        transcript: text,
        message: answer.speech,
        detail: answer.detail
      });
      return;
    }
    if (match.status === 'missing-slot') {
      setState(V.VOICE_EVENTS.REJECTED, { transcript: text, message: match.prompt });
      return;
    }
    if (match.status === 'ambiguous') {
      setState(V.VOICE_EVENTS.REJECTED, {
        transcript: text,
        label: 'Which one?',
        message: 'Did you mean…',
        retry: false,
        options: match.options.map((o) => ({ commandId: o.commandId, title: o.title }))
      });
      return;
    }

    // Risky and not near-certain: ask instead of doing. Typed input reports a
    // confidence of 1 because it was unambiguously intended — the guard exists
    // for what the microphone heard, not for what the user typed.
    const riskConfirm = V.needsRiskConfirm(match.command, conf, {
      // Free dictation fires on any speech in the room, so a command reached
      // that way deserves the same suspicion as one from the wake path.
      viaWake: !!o.viaWake || !!o.viaFreeform,
      confirmRisky: settings.confirmRisky
    });

    recordHistory({
      transcript: text,
      commandId: match.commandId,
      outcome: (match.confirm || riskConfirm) ? 'confirming' : 'matched',
      confidence: conf,
      viaWake: !!o.viaWake
    });

    // Also to the log file, not just the in-memory panel. A command that ran on
    // a mishearing previously left NO trace anywhere — "I said discord and it
    // opened Steam" was unfalsifiable after the fact, and the in-memory history
    // dies with the process. The heard text plus the resolved target is what
    // makes that class of report diagnosable.
    logger.log('Voice matched', 'INFO', {
      heard: text,
      commandId: match.commandId,
      target: match.params && (match.params.appLabel || match.params.widgetLabel ||
              match.params.anyWidgetLabel || match.params.playlistLabel) || undefined,
      confidence: conf,
      score: typeof match.score === 'number' ? Math.round(match.score * 100) / 100 : undefined,
      ambiguous: match.ambiguousSlot || undefined,
      willConfirm: (match.confirm || riskConfirm) || undefined
    });

    if (match.confirm || riskConfirm) {
      if (riskConfirm && !match.confirm) {
        logger.log('Risky command held for confirmation', 'INFO',
          { commandId: match.commandId, confidence: conf, viaWake: !!o.viaWake });
      }
      pendingConfirm = { commandId: match.commandId, params: match.params, command: match.command };
      setState(V.VOICE_EVENTS.HEARD, { transcript: text });
      setState(V.VOICE_EVENTS.NEEDS_CONFIRM, {
        transcript: text,
        message: match.command.confirmPrompt || 'Are you sure?',
        confirmPrompt: true
      });
      setHostMode('command', settings.listenTimeoutMs);   // listen for the spoken yes/no
      armListenTimeout();
      return;
    }

    setState(V.VOICE_EVENTS.HEARD, { transcript: text });
    execute(match.commandId, match.params, match.command, text);
  }

  // Runs a chained utterance step by step, stopping at the first failure so a
  // half-understood sentence can't half-happen silently. A step needing
  // confirmation ends the chain there and asks — a chain must never be able to
  // slip a destructive command past the gate.
  async function runChain(text, steps) {
    setState(V.VOICE_EVENTS.HEARD, { transcript: text });
    const done = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.confirm) {
        pendingConfirm = { commandId: step.commandId, params: step.params, command: step.command };
        setState(V.VOICE_EVENTS.NEEDS_CONFIRM, {
          transcript: done.length ? done.join(' · ') : text,
          message: step.command.confirmPrompt || 'Are you sure?',
          confirmPrompt: true
        });
        setHostMode('command', settings.listenTimeoutMs);
        armListenTimeout();
        return;
      }
      const result = await runOneStep(step);
      if (!result.ok) {
        setState(V.VOICE_EVENTS.FAILED, {
          message: done.length ? `${done.join(' · ')} — then ${result.message}` : result.message
        });
        return;
      }
      done.push(result.message);
    }
    lastIntent = { commandId: steps[steps.length - 1].commandId, params: steps[steps.length - 1].params, command: steps[steps.length - 1].command };
    setState(V.VOICE_EVENTS.EXECUTED, { transcript: done.join(' · ') });
  }

  // One chain step, resolved to { ok, message }. Shares the dispatch path and
  // the renderer timeout with a single command.
  function runOneStep(step) {
    return new Promise((resolve) => {
      const main = getMainWindow();
      if (!main || main.isDestroyed()) { resolve({ ok: false, message: 'The launcher isn’t running' }); return; }
      const requestId = ++executionSeq;
      const timer = setTimeout(() => {
        if (!pendingExecutions.has(requestId)) return;
        pendingExecutions.delete(requestId);
        resolve({ ok: false, message: 'that took too long' });
      }, EXECUTE_TIMEOUT_MS);
      pendingExecutions.set(requestId, {
        timer, command: step.command, params: step.params,
        settle: (payload) => resolve({
          ok: !!(payload && payload.ok),
          message: (payload && payload.message) || V.replyFor(step.command, step.params)
        })
      });
      try {
        main.webContents.send('voice:execute', { requestId, commandId: step.commandId, params: step.params, transcript: '' });
      } catch (e) {
        clearTimeout(timer);
        pendingExecutions.delete(requestId);
        resolve({ ok: false, message: 'couldn’t run that' });
      }
    });
  }

  function runPendingConfirm() {
    if (!pendingConfirm) { setState(V.VOICE_EVENTS.DISMISS); return; }
    const { commandId, params, command } = pendingConfirm;
    pendingConfirm = null;
    setState(V.VOICE_EVENTS.HEARD, { transcript: V.replyFor(command, params) });
    execute(commandId, params, command, '');
  }

  // ── Execution ─────────────────────────────────────────────────────────
  // Two commands are about the assistant itself and never leave this process.
  function execute(commandId, params, command, transcript, opts) {
    if (commandId === 'assistant.cancel') { setState(V.VOICE_EVENTS.DISMISS); return; }
    if (commandId === 'assistant.quiet') {
      stopSpeaking();
      setState(V.VOICE_EVENTS.EXECUTED, { transcript: 'Quiet' });
      return;
    }
    if (commandId === 'assistant.undo') {
      if (!lastExecuted) {
        setState(V.VOICE_EVENTS.FAILED, { message: 'There is nothing to undo yet' });
        return;
      }
      const back = V.inverseOf(lastExecuted.commandId, lastExecuted.params);
      if (!back) {
        // Naming it matters: "I can't undo that" leaves the user wondering
        // which "that" — the query they just made, or the action before it.
        // Better to say so than to run a second, differently-wrong action.
        setState(V.VOICE_EVENTS.FAILED, {
          message: `I can’t undo ${lastExecuted.command ? lastExecuted.command.title.toLowerCase() : 'that'}`,
          detail: 'Only reversible commands can be undone'
        });
        return;
      }
      const inverseCommand = V.COMMANDS.find((c) => c.id === back.commandId);
      lastExecuted = null;
      // isUndo: the reversal must not become the next thing "undo" undoes, or
      // saying it twice just toggles the setting back and forth forever.
      execute(back.commandId, back.params, inverseCommand, '', { isUndo: true });
      return;
    }
    if (commandId === 'assistant.repeat') {
      if (!lastIntent) {
        setState(V.VOICE_EVENTS.FAILED, { message: 'Nothing to repeat yet' });
        return;
      }
      const again = lastIntent;
      setState(V.VOICE_EVENTS.HEARD, { transcript: V.replyFor(again.command, again.params) });
      execute(again.commandId, again.params, again.command, '');
      return;
    }
    // Remember it so "do that again" has something to repeat. Deliberately not
    // the meta commands above — repeating a repeat is a loop.
    lastIntent = { commandId, params, command };
    // Every real command is recorded, including ones with no inverse. Recording
    // only reversible commands let "undo that" step over the thing the user
    // actually meant and reverse something from further back: after "what time
    // is it", undo restarted the music. Now the un-undoable command is what
    // undo sees, and it can say so.
    if (!(opts && opts.isUndo)) lastExecuted = { commandId, params, command };
    if (commandId === 'assistant.help') {
      setState(V.VOICE_EVENTS.EXECUTED, {
        label: 'What you can say',
        transcript: '',
        help: V.helpEntries(vocabulary)
      });
      // The help sheet is worth reading — give it longer than a normal success.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setState(V.VOICE_EVENTS.SETTLE), 9000);
      return;
    }

    const main = getMainWindow();
    if (!main || main.isDestroyed()) {
      setState(V.VOICE_EVENTS.FAILED, { message: 'The launcher isn’t running' });
      return;
    }

    const requestId = ++executionSeq;
    const timer = setTimeout(() => {
      if (!pendingExecutions.has(requestId)) return;
      pendingExecutions.delete(requestId);
      logger.error('Voice command timed out in the renderer', null, { commandId });
      setState(V.VOICE_EVENTS.FAILED, { message: 'That took too long' });
    }, EXECUTE_TIMEOUT_MS);
    pendingExecutions.set(requestId, { timer, command, params });

    try {
      main.webContents.send('voice:execute', { requestId, commandId, params, transcript });
    } catch (e) {
      clearTimeout(timer);
      pendingExecutions.delete(requestId);
      logger.error('Voice command could not be dispatched', e, { commandId });
      setState(V.VOICE_EVENTS.FAILED, { message: 'Couldn’t run that' });
    }
  }

  // ── Ducking ────────────────────────────────────────────────────────────
  // A spoken reply competing with music at full volume is not audible, which
  // makes voiceFeedback pointless exactly when it is most useful. The previous
  // level is remembered rather than assumed, so restoring cannot invent one.
  let duckedFrom = null;
  function duckMusic(on) {
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return;
    try {
      if (on) {
        if (duckedFrom !== null) return;         // already ducked
        main.webContents.send('voice:duck', { duck: true });
      } else {
        main.webContents.send('voice:duck', { duck: false });
        duckedFrom = null;
      }
    } catch (e) { /* window going away */ }
  }

  let lastSpokenExtra = null;
  // The last real command, for "do that again".
  let lastIntent = null;

  function onExecuteResult(payload) {
    const requestId = payload && payload.requestId;
    const entry = pendingExecutions.get(requestId);
    if (!entry) return { ok: false };      // already timed out
    clearTimeout(entry.timer);
    pendingExecutions.delete(requestId);

    // A chained step resolves its own promise; runChain owns the UI from there.
    if (typeof entry.settle === 'function') { entry.settle(payload); return { ok: true }; }

    // The overlay may already have been dismissed by the user.
    if (state === V.VOICE_STATES.HIDDEN) return { ok: true };

    // The responder turns the executor's raw result into something a person
    // would say, and splits it: `speech` is spoken, headline/detail/meta are
    // shown. An executor that returned rich `answer` data wins outright.
    const answer = responder.respond(entry.command, entry.params, payload || {});
    const reply = String(answer.speech || '').slice(0, 240);

    // Remember what this command established as "it" for the next utterance,
    // WITH its slot: "turn it off" after "open the weather widget" has to reach
    // that widget, and re-deriving it later is not possible.
    const subjectKind = V.pronounSubjectOf(entry.command && entry.command.id);
    if (subjectKind) pronounSubject = { kind: subjectKind, params: entry.params || {} };

    if (!payload || !payload.ok) {
      setState(V.VOICE_EVENTS.FAILED, {
        message: reply || 'That didn’t work',
        detail: answer.detail || ''
      });
      return { ok: true };
    }

    // Everything the overlay needs to draw the answer card, plus the follow-ups
    // worth offering. Chips dispatch by command id through the existing
    // 'choose' path, so no new IPC surface is needed for them.
    const card = {
      headline: answer.headline || '',
      detail: answer.detail || '',
      meta: answer.meta || [],
      art: answer.art || '',
      suggestions: V.suggestionsFor(entry.command && entry.command.id)
    };

    if (settings.voiceFeedback && reply) {
      // Duck the music so the reply is audible over it. Restored on SPEAK-DONE.
      duckMusic(true);
      lastSpokenExtra = { transcript: reply, ...card };
      setState(V.VOICE_EVENTS.SPEAK, { transcript: reply, ...card });
      // Only the SPOKEN copy is rewritten. The card keeps "35°C" and "CPU",
      // which are right to look at and wrong to read aloud.
      // speakReply prefers the WinRT voices and falls back to the host's SAPI
      // one, so losing the helper costs quality but never speech itself.
      speakReply(forSpeech(reply).replace(/[\r\n]+/g, ' '));
      // If the synthesizer never answers, don't hang in SPEAKING.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (state === V.VOICE_STATES.SPEAKING) setState(V.VOICE_EVENTS.SPOKEN, lastSpokenExtra);
      }, 8000);
    } else {
      setState(V.VOICE_EVENTS.EXECUTED, { transcript: reply, ...card });
    }
    return { ok: true };
  }

  // ── Activation ────────────────────────────────────────────────────────
  function armListenTimeout() {
    // A fresh listen is a fresh measurement.
    peakLevel = 0;
    levelSamples = 0;
    levelWindow = [];
    clearTimeout(alternateTimer);
    pendingAlternates = null;
    clearTimeout(listenTimer);
    // Slightly longer than the host's own safety net so the host's TIMEOUT wins
    // in the normal case and this only fires if the host went silent.
    listenTimer = setTimeout(() => {
      if (V.isMicOpenState(state)) {
        setState(V.VOICE_EVENTS.TIMEOUT, { message: 'I didn’t hear anything' });
      }
    }, settings.listenTimeoutMs + 1500);
  }

  async function activate() {
    if (!enabled || !isWindows) return;
    if (triggersSuspended) return;

    // Toggle: a second press while listening cancels.
    if (V.isMicOpenState(state)) { cancel(); return; }

    showOverlay();
    setState(V.VOICE_EVENTS.ACTIVATE);

    try {
      await ensureHost();
    } catch (e) {
      logger.error('Voice host unavailable', e);
      setState(V.VOICE_EVENTS.FAILED, { message: 'Speech engine unavailable' });
      return;
    }
    // The user may have cancelled while the host was starting.
    if (!V.isMicOpenState(state)) return;
    setHostMode('command', settings.listenTimeoutMs);
    armListenTimeout();
  }

  // ── Esc to dismiss ─────────────────────────────────────────────────────
  // The overlay is shown INACTIVE (it is a HUD and must not steal focus from a
  // game), so it almost never receives a keystroke itself. A global accelerator
  // is the only way Esc can reach it — but Esc is far too valuable a key to hold
  // permanently, so it is held ONLY while the overlay is actually on screen and
  // released the moment it is not.
  let escHeld = false;

  function holdEscape(on) {
    if (on === escHeld) return;
    if (on) {
      try { escHeld = globalShortcut.register('Escape', () => cancel()); }
      catch (e) { escHeld = false; }
    } else {
      try { globalShortcut.unregister('Escape'); } catch (e) { /* already gone */ }
      escHeld = false;
    }
  }

  function cancel() {
    clearTimeout(listenTimer);
    listenTimer = null;
    pendingConfirm = null;
    setState(V.VOICE_EVENTS.DISMISS);
  }

  function onHoldDown() {
    if (settings.activation !== 'hold' || triggersSuspended || !enabled) return;
    if (V.isMicOpenState(state)) return;
    activate();
  }

  function onHoldUp() {
    if (settings.activation !== 'hold') return;
    // Releasing ends the utterance: stop capturing and let whatever was
    // recognised land. If nothing did, the timeout path reports it.
    if (state !== V.VOICE_STATES.LISTENING) return;
    reconcileMic();
    clearTimeout(listenTimer);
    listenTimer = setTimeout(() => {
      if (state === V.VOICE_STATES.LISTENING) {
        setState(V.VOICE_EVENTS.TIMEOUT, { message: 'I didn’t catch that' });
      }
    }, 900);
  }

  // ── Hotkey ────────────────────────────────────────────────────────────
  function toElectronAccelerator(accel) {
    return String(accel || '').replace(/Control/g, 'CommandOrControl');
  }

  function applyHoldWatch() {
    if (!hostReady) return;
    const wantWatch = enabled && !triggersSuspended && settings.activation === 'hold';
    if (!wantWatch) {
      if (holdWatchActive) { hostSend('WATCH 0 0'); holdWatchActive = false; }
      return;
    }
    // Reuse the macro engine's accelerator parser rather than writing a second
    // one — the two must agree about what "Control+Alt+V" means.
    if (!settings.hotkey || settings.hotkey === '-') return;
    const parsed = parseAccelerator(settings.hotkey);
    if (!parsed || parsed.mouse) {
      logger.warn('Voice assistant hold hotkey is not a keyboard accelerator', { hotkey: settings.hotkey });
      return;
    }
    hostSend('WATCH ' + parsed.vk + ' ' + parsed.mods);
    holdWatchActive = true;
  }

  function registerHotkey() {
    if (hotkeyAccel) { globalShortcut.unregister(hotkeyAccel); hotkeyAccel = null; }
    if (!enabled || triggersSuspended || !isWindows) return true;
    const accel = settings.hotkey;
    if (!accel || accel === '-') return true;

    // Hold mode watches the key passively in the host (GetAsyncKeyState) instead
    // of registering it: a registered accelerator is consumed, gives no key-up,
    // and would swallow the key from whatever is focused.
    if (settings.activation === 'hold') { applyHoldWatch(); return true; }

    const electronAccel = toElectronAccelerator(accel);
    let ok = false;
    try { ok = globalShortcut.register(electronAccel, () => { activate(); }); } catch (e) { ok = false; }
    if (!ok) {
      logger.error('Voice assistant hotkey registration failed', null, { accelerator: accel });
      return false;
    }
    hotkeyAccel = electronAccel;
    applyHoldWatch();
    return true;
  }

  // ── Vocabulary ────────────────────────────────────────────────────────
  function setVocabulary(raw) {
    // Carried alongside the vocabulary because the renderer is the only place
    // that knows the user's accent theme. Validated to three plain numbers.
    const a = raw && typeof raw.accent === 'string' ? raw.accent.trim() : '';
    accentRgb = /^\d{1,3},\d{1,3},\d{1,3}$/.test(a) ? a : '255,255,255';
    vocabulary = V.buildVocabulary(raw);
    grammar = V.compileGrammar(vocabulary);
    grammarDirty = true;
    if (grammar.collisions.length) {
      // Never fatal, but it means two commands want the same words — worth
      // knowing about rather than silently letting the first one win.
      logger.warn('Voice grammar phrase collisions', { collisions: grammar.collisions.slice(0, 5) });
    }
    if (hostReady && !V.isMicOpenState(state)) pushGrammar();
    return { phrases: grammar.phrases.length };
  }

  // ── Enable / disable ──────────────────────────────────────────────────
  async function setEnabled(next) {
    const was = enabled;
    enabled = !!next && isWindows;
    if (was === enabled) return enabled;

    if (enabled) {
      registerHotkey();
      // Warm the host now so the first activation doesn't wait ~1s for
      // System.Speech to load and the grammar to compile.
      ensureHost().catch((e) => logger.warn('Voice host warm-up failed', e));
      // Build the overlay window up front too. It was created lazily on first
      // activation, which put window creation and page load — about 150ms — in
      // front of the very first popup. It stays hidden and costs nothing.
      ensureOverlay();
      logger.success('Voice assistant enabled', { hotkey: settings.hotkey, activation: settings.activation });
    } else {
      cancel();
      if (hotkeyAccel) { globalShortcut.unregister(hotkeyAccel); hotkeyAccel = null; }
      if (holdWatchActive) { hostSend('WATCH 0 0'); holdWatchActive = false; }
      setHostMode('off');
      killHost();
      if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.destroy(); overlayWindow = null; }
      logger.log('Voice assistant disabled', 'INFO');
    }
    return enabled;
  }

  // ── IPC ───────────────────────────────────────────────────────────────
  ipcMain.handle('voice:get-state', () => ({
    state, enabled, hostReady, recognizerName, micState,
    // 'off' | 'wake' | 'command' — what the microphone is actually doing, which
    // is what the panel reports so the user is never guessing.
    hostMode, wakeWord: settings.wakeWord, wakePhrases: V.WAKE_PHRASES.slice(),
    voices: availableVoices.slice(),
    phrases: grammar.phrases.length,
    supported: isWindows
  }));

  ipcMain.handle('voice:set-enabled', (_e, value) => setEnabled(value));

  ipcMain.handle('voice:settings-get', () => ({ ...settings }));

  ipcMain.handle('voice:settings-set', (_e, patch) => {
    const before = settings;
    settings = V.normalizeSettings(patch, settings);
    saveSettings();
    // Anything that changes how activation works has to be re-applied live.
    if (before.hotkey !== settings.hotkey || before.activation !== settings.activation) {
      registerHotkey();
      applyHoldWatch();
    }
    if (before.voiceName !== settings.voiceName) hostSend('VOICE ' + (settings.voiceName || ''));
    if (before.speechRate !== settings.speechRate) hostSend('RATE ' + settings.speechRate);
    if (before.scale !== settings.scale) positionOverlay();
    if (before.chaining !== settings.chaining) {
      // The grammar itself changes shape, so it has to be rebuilt.
      grammarDirty = true;
      if (hostReady && !V.isMicOpenState(state)) pushGrammar();
    }
    if (before.wakeWord !== settings.wakeWord) {
      logger.log('Voice wake word ' + (settings.wakeWord ? 'enabled — the microphone now stays on while idle' : 'disabled — the microphone is released when idle'), 'INFO');
      // Turning it on needs a host; turning it off must release the device.
      if (settings.wakeWord) ensureHost().then(reconcileMic).catch((e) => logger.warn('Voice host unavailable for the wake word', e));
      else reconcileMic();
    }
    return { ...settings };
  });

  ipcMain.handle('voice:set-vocabulary', (_e, raw) => setVocabulary(raw));

  // Dry-run the matcher. Returns the same shape matchIntent does, minus the
  // command object (which does not survive IPC). Runs nothing.
  ipcMain.handle('voice:match', (_e, text) => {
    const m = V.matchIntent(String(text == null ? '' : text).slice(0, 300), vocabulary, grammar);
    return {
      status: m.status,
      commandId: m.commandId || null,
      params: m.params || {},
      title: m.command ? m.command.title : null,
      prompt: m.prompt || null
    };
  });
  // Raising the launcher has to happen in the MAIN process. window.focus() from
  // the renderer cannot restore a minimised window or pull one in front of a
  // fullscreen game, which is why "open settings" appeared to do nothing: the
  // modal really did open, behind everything.
  ipcMain.handle('voice:focus-launcher', () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return false;
    try {
      // Windows refuses to let a background process take the foreground, so a
      // plain show()/focus() from here is silently ignored — the launcher stays
      // behind whatever the user is looking at and the Settings modal opens out
      // of sight. That was the real reason "open settings" looked broken.
      //
      // The reliable sequence: restore if minimised, briefly assert
      // always-on-top (which Windows DOES honour), show, focus, then drop the
      // topmost flag again so the window does not stay pinned above everything.
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.setAlwaysOnTop(true);
      win.show();
      win.focus();
      try { app.focus({ steal: true }); } catch (e) { /* not on every platform */ }

      // Dropping topmost on a short timer only made the window FLASH: Windows
      // often refuses the foreground to a background process, so once the flag
      // went the launcher fell straight back behind whatever was in front and
      // the Settings modal was open but invisible. Measured with Notepad in
      // front: the modal opened, the launcher did not come forward.
      //
      // So the flag stays until the window is genuinely finished with — it is
      // released on the first blur (the user clicked away), with a long stop so
      // it can never be pinned above everything forever.
      // Releasing on the FIRST blur was no better than the timer: Windows often
      // denies the foreground outright, so a blur arrives immediately, topmost is
      // dropped, and the launcher sinks back behind the other window. Measured:
      // the launcher went from composited to occluded across the command.
      //
      // So the flag is released only once the window has genuinely been focused
      // and then left, with a hard cap so it can never stay pinned.
      clearTimeout(raiseDropTimer);
      if (raiseCleanup) raiseCleanup();
      let sawFocus = win.isFocused();
      const drop = () => {
        if (raiseCleanup) raiseCleanup();
        try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch (e) { /* gone */ }
      };
      const onFocus = () => { sawFocus = true; };
      const onBlur = () => { if (sawFocus) drop(); };
      raiseCleanup = () => {
        raiseCleanup = null;
        clearTimeout(raiseDropTimer);
        try { win.removeListener('focus', onFocus); win.removeListener('blur', onBlur); } catch (e) { /* gone */ }
      };
      win.on('focus', onFocus);
      win.on('blur', onBlur);
      raiseDropTimer = setTimeout(drop, 6000);
      // The launcher is now topmost; the HUD has to go back above it.
      setTimeout(raiseOverlayAboveEverything, 60);
      setTimeout(raiseOverlayAboveEverything, 400);
      return true;
    } catch (e) {
      logger.warn('Could not raise the launcher', e);
      return false;
    }
  });

  ipcMain.handle('voice:activate', () => { activate(); return true; });
  ipcMain.handle('voice:cancel', () => { cancel(); return true; });
  // Resolves the prompt currently being read, with what the recognizer made of
  // it. Never dispatches — see the `training` note above.
  function captureTraining(text, confidence) {
    const t = training;
    if (!t) return;
    training = null;
    clearTimeout(t.timer);
    const match = V.matchIntent(text, vocabulary, grammar);
    setHostMode('off');
    t.resolve({
      heard: text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      peak: peakLevel,
      matchedId: match.status === 'matched' ? match.commandId : ''
    });
  }

  ipcMain.handle('voice:train-prompts', () => V.TRAINING_PROMPTS.slice());

  // Listens for one spoken prompt and reports what was heard. Resolves with an
  // empty `heard` on timeout, which analyzeTraining counts as skipped rather
  // than as a mistake — silence is not evidence of a bad recognizer.
  ipcMain.handle('voice:train-listen', async (_e, timeoutMs) => {
    if (!enabled || !isWindows) return { heard: '', confidence: 0, peak: 0, matchedId: '' };
    try { await ensureHost(); } catch (e) { return { heard: '', confidence: 0, peak: 0, matchedId: '' }; }
    if (training) { clearTimeout(training.timer); training.resolve({ heard: '', confidence: 0, peak: 0, matchedId: '' }); training = null; }

    const ms = Math.max(2000, Math.min(15000, Number(timeoutMs) || 7000));
    return new Promise((resolve) => {
      training = {
        resolve,
        timer: setTimeout(() => {
          training = null;
          setHostMode('off');
          resolve({ heard: '', confidence: 0, peak: 0, matchedId: '' });
        }, ms)
      };
      peakLevel = 0;
      levelSamples = 0;
      levelWindow = [];
      setHostMode('command', ms);
    });
  });

  ipcMain.handle('voice:train-cancel', () => {
    if (training) { clearTimeout(training.timer); training.resolve({ heard: '', confidence: 0, peak: 0, matchedId: '' }); training = null; }
    setHostMode('off');
    return true;
  });

  // Turns a finished run into applicable changes. Analysis is pure and lives in
  // voiceCommands so it can be tested without any of this.
  ipcMain.handle('voice:train-analyze', (_e, samples) => V.analyzeTraining(samples, vocabulary));

  ipcMain.handle('voice:execute-result', (_e, payload) => onExecuteResult(payload));

  // Recent utterances and how often each command is used. Read-only, and
  // deliberately not persisted.
  ipcMain.handle('voice:get-history', () => ({
    history: history.slice(0, 20),
    top: [...usageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([commandId, count]) => ({ commandId, count }))
  }));

  // Lets the renderer drive the assistant by text — the accessibility path and
  // the panel's "try a command" field both use it.
  ipcMain.handle('voice:submit-text', (_e, text) => {
    const value = String(text == null ? '' : text).slice(0, 300).trim();
    if (!value) return false;
    // SUBMIT, not ACTIVATE: a typed command goes straight to PROCESSING so the
    // overlay never sees LISTENING and never opens the microphone.
    if (!V.isMicOpenState(state)) { showOverlay(); setState(V.VOICE_EVENTS.SUBMIT); }
    handleUtterance(value);
    return true;
  });

  // ── Overlay → main ────────────────────────────────────────────────────
  function fromOverlay(event) {
    return overlayWindow && !overlayWindow.isDestroyed() && event.sender.id === overlayWindow.webContents.id;
  }

  ipcMain.on('voice:overlay-ready', (e) => { if (fromOverlay(e)) pushState(); });
  ipcMain.on('voice:overlay-painted', (e) => {
    if (!fromOverlay(e)) return;
    clearTimeout(revealTimer);
    revealOverlay();
  });
  ipcMain.on('voice:overlay-cancel', (e) => { if (fromOverlay(e)) cancel(); });
  ipcMain.on('voice:overlay-listen', (e) => { if (fromOverlay(e)) activate(); });
  ipcMain.on('voice:overlay-text', (e, text) => {
    if (!fromOverlay(e)) return;
    const value = String(text == null ? '' : text).slice(0, 300).trim();
    if (value) handleUtterance(value);
  });
  ipcMain.on('voice:overlay-confirm', (e, answer) => {
    if (!fromOverlay(e)) return;
    if (answer === 'yes') runPendingConfirm();
    else cancel();
  });
  // Barge-in. The microphone deliberately stays shut during SPEAKING — the mic
  // ownership rules in setHostMode()/reconcileMic() are the one thing in this
  // module that must not be worked around, and arming the recognizer here would
  // put wake and command mode back in contention for the device. So the
  // interrupt is an explicit gesture instead: click the orb (or press the
  // hotkey) and the synthesizer stops mid-sentence.
  ipcMain.on('voice:overlay-shutup', (e) => {
    if (!fromOverlay(e)) return;
    if (state !== V.VOICE_STATES.SPEAKING) return;
    stopSpeaking();
    duckMusic(false);
    setState(V.VOICE_EVENTS.SPOKEN, lastSpokenExtra);
  });
  ipcMain.on('voice:overlay-choose', (e, commandId) => {
    if (!fromOverlay(e)) return;
    const command = V.COMMANDS.find((c) => c.id === commandId);
    if (!command) { cancel(); return; }
    if (state !== V.VOICE_STATES.PROCESSING) setState(V.VOICE_EVENTS.ACTIVATE);
    setState(V.VOICE_EVENTS.HEARD, { transcript: command.title });
    execute(command.id, {}, command, '');
  });
  ipcMain.on('voice:overlay-hover', (e, over) => {
    if (!fromOverlay(e) || !overlayWindow || overlayWindow.isDestroyed()) return;
    try { overlayWindow.setIgnoreMouseEvents(!over, { forward: true }); } catch (err) { /* closing */ }
  });
  ipcMain.on('voice:overlay-mic-state', (e, kind, detail) => {
    if (!fromOverlay(e)) return;
    micState = String(kind || 'unknown');
    if (micState === 'denied' || micState === 'missing') {
      logger.warn('Voice overlay has no microphone for its visualisation', { micState, detail: String(detail || '').slice(0, 160) });
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────
  // Nothing starts until the widget is enabled: no host process, no overlay
  // window, no hotkey, no microphone.
  logger.log('Voice assistant module ready', 'INFO', { supported: isWindows });

  return {
    isEnabled: () => enabled,
    reapplyHotkey: () => { registerHotkey(); },
    // The renderer is capturing raw keys for a hotkey bind — the passive hold
    // watch has to stop too, or binding the key fires the assistant.
    suspendTriggers: () => {
      triggersSuspended = true;
      if (hotkeyAccel) { globalShortcut.unregister(hotkeyAccel); hotkeyAccel = null; }
      if (holdWatchActive) { hostSend('WATCH 0 0'); holdWatchActive = false; }
      // The wake word listens for whatever is being spoken while a hotkey is
      // being bound, so it has to stand down too.
      reconcileMic();
    },
    resumeTriggers: () => { triggersSuspended = false; registerHotkey(); reconcileMic(); },
    teardown: () => {
      tearingDown = true;
      holdEscape(false);
      if (speaker) { speaker.stop(); speaker = null; }
      clearTimeout(listenTimer);
      clearTimeout(settleTimer);
      clearTimeout(revealTimer);
      clearTimeout(raiseDropTimer);
      if (raiseCleanup) raiseCleanup();
      for (const entry of pendingExecutions.values()) clearTimeout(entry.timer);
      pendingExecutions.clear();
      if (hotkeyAccel) { try { globalShortcut.unregister(hotkeyAccel); } catch (e) { /* ignore */ } hotkeyAccel = null; }
      // STOP before EXIT so the recognizer releases the audio device rather than
      // being killed with the microphone still open.
      killHost();
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        try { overlayWindow.destroy(); } catch (e) { /* ignore */ }
      }
      overlayWindow = null;
    }
  };
}

module.exports = { init };
