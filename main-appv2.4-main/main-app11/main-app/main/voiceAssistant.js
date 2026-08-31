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
const SETTLE_MS = { success: 1000, error: 2000 };
// A dispatched command must answer within this, or the renderer is treated as
// unavailable — a hung executor must never strand the assistant mid-command.
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

  let vocabulary = V.EMPTY_VOCABULARY;
  let grammar = V.compileGrammar(vocabulary);
  let grammarDirty = true;

  let hotkeyAccel = null;              // currently registered globalShortcut
  let holdWatchActive = false;
  let triggersSuspended = false;

  let listenTimer = null;
  let settleTimer = null;
  let pendingConfirm = null;           // { commandId, params, command }
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
    revealTimer = setTimeout(revealOverlay, 400);
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

    if (state === V.VOICE_STATES.SUCCESS || state === V.VOICE_STATES.ERROR) {
      const ms = SETTLE_MS[state] || 2000;
      settleTimer = setTimeout(() => setState(V.VOICE_EVENTS.SETTLE), ms);
    }
    return changed;
  }

  // ── Speech host ───────────────────────────────────────────────────────
  function ensureHostScript() {
    ensureVersionedScript(HOST_SCRIPT, VOICE_HOST_SCRIPT_VERSION, VOICE_HOST_SCRIPT_CONTENT);
  }

  function ensureHost() {
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
    for (const phrase of grammar.phrases) hostSend('PHRASE ' + phrase);
    for (const d of grammar.dictation) hostSend('DICTATION ' + d.carrier);
    for (const w of V.CONFIRM_YES) hostSend('CONFIRM ' + w);
    for (const w of V.CONFIRM_NO) hostSend('CONFIRM ' + w);
    // Always sent, whether or not the wake word is currently on: the host keeps
    // the wake grammar loaded but disabled, so toggling the setting is a mode
    // switch rather than a grammar rebuild.
    for (const w of V.WAKE_PHRASES) hostSend('WAKE ' + w);
    hostSend('CHAIN ' + (settings.chaining ? '1' : '0'));
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
      case 'LEVEL':
        sendOverlay('voice:overlay-level', parseInt(rest, 10) || 0);
        return;
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
      handleUtterance(parsed.rest);
      return;
    }
    // Bare wake phrase — open up and listen for the command.
    setState(V.VOICE_EVENTS.ACTIVATE);
    setHostMode('command', settings.listenTimeoutMs);
    armListenTimeout();
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

    if (state === V.VOICE_STATES.CONFIRMING) {
      const answer = V.matchConfirmation(text);
      if (answer === 'yes') { runPendingConfirm(); return; }
      if (answer === 'no') { setState(V.VOICE_EVENTS.DISMISS); return; }
      return;   // not an answer — keep waiting
    }

    if (state !== V.VOICE_STATES.LISTENING) return;
    handleUtterance(text);
  }

  // Shared by speech and the typed fallback, so both take exactly the same path.
  function handleUtterance(text) {
    // Several commands in one breath, when every part resolves on its own.
    if (settings.chaining) {
      const chain = V.matchChain(text, vocabulary, grammar);
      if (chain.chained) { runChain(text, chain.steps); return; }
    }
    const match = V.matchIntent(text, vocabulary, grammar);

    if (match.status === 'unknown') {
      setState(V.VOICE_EVENTS.REJECTED, { transcript: text, message: 'I don’t know that one yet' });
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

    if (match.confirm) {
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
  function execute(commandId, params, command, transcript) {
    if (commandId === 'assistant.cancel') { setState(V.VOICE_EVENTS.DISMISS); return; }
    if (commandId === 'assistant.quiet') {
      hostSend('SHUTUP');
      setState(V.VOICE_EVENTS.EXECUTED, { transcript: 'Quiet' });
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

    const reply = (payload && payload.message)
      ? String(payload.message).slice(0, 200)
      : V.replyFor(entry.command, entry.params);

    if (!payload || !payload.ok) {
      setState(V.VOICE_EVENTS.FAILED, { message: reply || 'That didn’t work' });
      return { ok: true };
    }

    if (settings.voiceFeedback && reply) {
      lastSpokenExtra = { transcript: reply };
      setState(V.VOICE_EVENTS.SPEAK, { transcript: reply });
      hostSend('SPEAK ' + reply.replace(/[\r\n]+/g, ' '));
      // If the synthesizer never answers, don't hang in SPEAKING.
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (state === V.VOICE_STATES.SPEAKING) setState(V.VOICE_EVENTS.SPOKEN, lastSpokenExtra);
      }, 8000);
    } else {
      setState(V.VOICE_EVENTS.EXECUTED, { transcript: reply });
    }
    return { ok: true };
  }

  // ── Activation ────────────────────────────────────────────────────────
  function armListenTimeout() {
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
  ipcMain.handle('voice:execute-result', (_e, payload) => onExecuteResult(payload));

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
