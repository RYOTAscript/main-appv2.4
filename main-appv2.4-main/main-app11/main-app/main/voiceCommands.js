// ── Voice Assistant: command registry, grammar generation & intent matching ──
//
// Pure logic — no Electron, no Node built-ins at all — so the whole intent layer
// is unit-testable (test/voice-commands.test.js) without a window, a microphone
// or a PowerShell host. main/voiceAssistant.js is the only consumer.
//
// Two layers, deliberately separate:
//
//   1. COMPILATION (compileGrammar) turns the registry below plus a live
//      vocabulary (the user's pinned apps, detected games, enabled widgets,
//      saved macros) into a flat list of literal phrases. That list is what the
//      Windows recognizer loads as a closed grammar. A closed grammar is why
//      recognition is accurate: measured on this machine, grammar-constrained
//      recognition scored 0.94 confidence on the same audio where free dictation
//      returned unrelated words at 0.27. Every phrase also lands in an index
//      mapping it straight back to { commandId, params }, so a grammar hit needs
//      no parsing at all.
//
//   2. MATCHING (matchIntent) is an independent natural-language layer over the
//      same registry: normalisation, filler/politeness stripping, exact index
//      lookup, then a scored token fallback with slot extraction. It exists
//      because (a) it degrades gracefully when the recognizer returns something
//      close-but-not-identical, (b) it powers the typed fallback the overlay
//      offers when no microphone is available, and (c) it is testable in
//      isolation, which a grammar living inside a PowerShell process is not.
//
// Adding a command = one entry in COMMANDS. The grammar, the phrase index and
// the in-overlay help list all generate from it; the only other edit is the
// executor arm in renderer/voice-assistant.js that actually performs it.

// ── State machine ─────────────────────────────────────────────────────────
// The overlay is either hidden or showing exactly one of these. Kept as a pure
// reducer so every transition is assertable, and so the main process, the
// overlay and the executor can never disagree about what a state means.
const VOICE_STATES = Object.freeze({
  HIDDEN: 'hidden',
  IDLE: 'idle',
  LISTENING: 'listening',
  PROCESSING: 'processing',
  CONFIRMING: 'confirming',
  SPEAKING: 'speaking',
  SUCCESS: 'success',
  ERROR: 'error'
});

// ACTIVATE/DISMISS come from the hotkey or the overlay; HEARD/REJECTED/TIMEOUT
// from the recognizer; EXECUTED/FAILED back from the renderer executor; SPOKEN
// from the synthesizer.
const VOICE_EVENTS = Object.freeze({
  ACTIVATE: 'activate',
  LISTEN: 'listen',
  // A command typed rather than spoken. It must NOT pass through LISTENING:
  // the overlay opens its microphone for the visualisation whenever it sees that
  // state, and a typed command has no reason to touch the mic at all.
  SUBMIT: 'submit',
  HEARD: 'heard',
  REJECTED: 'rejected',
  TIMEOUT: 'timeout',
  NEEDS_CONFIRM: 'needs-confirm',
  EXECUTED: 'executed',
  FAILED: 'failed',
  SPEAK: 'speak',
  SPOKEN: 'spoken',
  SETTLE: 'settle',
  DISMISS: 'dismiss'
});

const S = VOICE_STATES;
const E = VOICE_EVENTS;

// Explicit transition table. Anything not listed keeps the current state — an
// out-of-order event from a slow async path (a result landing after the user
// already cancelled, say) must never move the UI backwards.
const TRANSITIONS = Object.freeze({
  [S.HIDDEN]: { [E.ACTIVATE]: S.LISTENING, [E.SUBMIT]: S.PROCESSING },
  [S.IDLE]: { [E.LISTEN]: S.LISTENING, [E.ACTIVATE]: S.LISTENING, [E.SUBMIT]: S.PROCESSING, [E.DISMISS]: S.HIDDEN },
  [S.LISTENING]: { [E.HEARD]: S.PROCESSING, [E.REJECTED]: S.ERROR, [E.TIMEOUT]: S.ERROR, [E.DISMISS]: S.HIDDEN },
  [S.PROCESSING]: {
    [E.NEEDS_CONFIRM]: S.CONFIRMING, [E.EXECUTED]: S.SUCCESS,
    // A typed command enters PROCESSING directly (see SUBMIT), so this is where an
    // unknown / ambiguous / slotless utterance has to be able to fail. Without it
    // a typed nonsense command leaves the overlay stuck on "Working".
    [E.REJECTED]: S.ERROR,
    [E.FAILED]: S.ERROR, [E.SPEAK]: S.SPEAKING, [E.DISMISS]: S.HIDDEN
  },
  [S.CONFIRMING]: {
    [E.HEARD]: S.PROCESSING, [E.REJECTED]: S.ERROR, [E.TIMEOUT]: S.ERROR,
    [E.EXECUTED]: S.SUCCESS, [E.FAILED]: S.ERROR, [E.DISMISS]: S.HIDDEN
  },
  [S.SPEAKING]: { [E.SPOKEN]: S.SUCCESS, [E.FAILED]: S.ERROR, [E.DISMISS]: S.HIDDEN },
  [S.SUCCESS]: { [E.SETTLE]: S.HIDDEN, [E.DISMISS]: S.HIDDEN, [E.ACTIVATE]: S.LISTENING, [E.SUBMIT]: S.PROCESSING },
  [S.ERROR]: { [E.SETTLE]: S.HIDDEN, [E.DISMISS]: S.HIDDEN, [E.ACTIVATE]: S.LISTENING, [E.LISTEN]: S.LISTENING, [E.SUBMIT]: S.PROCESSING }
});

function nextState(current, event) {
  const row = TRANSITIONS[current];
  if (!row) return current;
  const to = row[event];
  return to === undefined ? current : to;
}

// The single source of truth for "should the microphone be open". After every
// transition main/voiceAssistant.js asserts the real recognizer against this, so
// no state can strand a hot microphone.
function isMicOpenState(state) {
  return state === S.LISTENING || state === S.CONFIRMING;
}

// ── Settings schema ───────────────────────────────────────────────────────
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // Ctrl+Alt+V — free against every existing binding (focus Ctrl+Alt+M, mic mute
  // Ctrl+Shift+M, crosshair Ctrl+Shift+X, Spotify Ctrl+arrow/page).
  hotkey: 'Control+Alt+V',
  activation: 'toggle',      // 'toggle' | 'hold' (push-to-talk)
  voiceFeedback: false,      // speak responses aloud; visual-only by default
  voiceName: '',             // '' = the system default voice
  speechRate: 0,             // System.Speech rate, -5..5
  confidence: 0.6,           // below this, a result is "didn't catch that"
  listenTimeoutMs: 7000,
  // Spoken activation. OFF by default, deliberately: turning it on keeps the
  // microphone open the whole time the assistant is idle. Recognition still
  // never leaves the machine, but "the mic is only live while listening" stops
  // being true, and that is the user's call to make rather than ours.
  // One sentence, several commands: "pause the music and optimize my pc".
  chaining: true,
  // Ask before running a command that closes programs, wipes something, or
  // changes machine-wide settings, unless the recognizer is near-certain.
  // On by default: a closed grammar cannot say "that was not a command", so
  // without this a stray noise can round to a destructive phrase and run it.
  confirmRisky: true,
  // Load a free-dictation catch-all beneath the command grammar, so a phrasing
  // that was never compiled in can still be understood.
  //
  // OFF by default. It shipped on in v4.2.0 and was reported the same day as
  // the assistant no longer hearing anything: a dictation grammar competes for
  // every utterance, and a result routed to it that fails the fuzzy bar is
  // dropped silently — indistinguishable from deafness. It is a real feature,
  // but it can only be judged by speaking to it, so it is opt-in until it has
  // been. See Behaviour → "Understand loose phrasing".
  freeform: false,
  // Set once the v4.2.0 freeform value has been cleared; see normalizeSettings.
  freeformReset: false,
  transition: 'fade',        // see TRANSITIONS
  vizStyle: 'aurora',        // see VIZ_STYLES
  scale: 1,                  // 0.7 .. 1.6 — the whole panel
  wakeWord: false,
  // A wake phrase is short, and short phrases are exactly what room noise fits
  // best, so it gets a much higher floor than an ordinary command.
  wakeConfidence: 0.85,
  showTranscript: true,
  reducedMotion: false,      // force the calm animation regardless of the OS setting
  clickActivate: true        // clicking the orb listens again
});

const ACTIVATION_MODES = ['toggle', 'hold'];
// How the panel enters and leaves. 'crt' is the old-television power-off: the
// picture collapses to a bright horizontal band, then to a point.
const PANEL_TRANSITIONS = ['fade', 'crt', 'collapse', 'slide'];
// The centrepiece animation.
const VIZ_STYLES = ['aurora', 'bars', 'pulse', 'ribbons', 'prism'];
// How long each exit takes, so the main process knows when the window may
// actually be hidden. Must match the keyframe durations in voice-overlay.html —
// for the CRT that is its LONGEST layer, the phosphor spark at 0.34s, not the
// 0.30s geometry: hiding on the geometry would cut the spark's decay off.
const EXIT_MS = Object.freeze({ fade: 140, crt: 300, collapse: 160, slide: 150 });

// -- Wake word ------------------------------------------------------------
// Spoken activation. These are the only phrases the recogniser listens for while
// the assistant is idle, and they are also stripped as leading fillers (see
// LEADING_FILLERS), so "hey main next track" and a bare "hey main" both work:
// the first runs the command in one breath, the second just opens the assistant.
//
// Keep this list SHORT. Every phrase here is live the whole time the wake word
// is on, and each extra one is another chance for ordinary conversation to
// trip it.
const WAKE_PHRASES = Object.freeze(['hey main', 'ok main', 'okay main']);

// Splits a heard phrase into its wake part and whatever followed it.
// Returns { woke, rest }; `woke` is false when there is no wake phrase at all.
function stripWakePhrase(text) {
  const t = String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return { woke: false, rest: '' };
  // Longest first, so "okay main" is never half-matched as "ok main".
  const ordered = [...WAKE_PHRASES].sort((a, b) => b.length - a.length);
  for (const phrase of ordered) {
    if (t === phrase) return { woke: true, rest: '' };
    if (t.startsWith(phrase + ' ')) return { woke: true, rest: t.slice(phrase.length + 1).trim() };
  }
  return { woke: false, rest: t };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Merges an untrusted patch (it arrives over IPC) onto current settings and
// coerces EVERY field of the result — not only the keys the patch touched.
// `current` is untrusted too: it may have been read back from a settings file
// that a crash left half-written, so a bad value already on disk must be
// corrected rather than carried forward. Unrecognised keys are dropped, so
// persisted settings can never grow a key the app doesn't understand.
function normalizeSettings(patch, current) {
  const cur = (current && typeof current === 'object') ? current : {};
  const p = (patch && typeof patch === 'object') ? patch : {};
  // A key present in the patch wins; otherwise fall back to current, then default.
  const pick = (key) => (key in p) ? p[key] : ((key in cur) ? cur[key] : DEFAULT_SETTINGS[key]);
  const bool = (key) => !!pick(key);

  const hotkeyRaw = pick('hotkey');
  const hotkey = typeof hotkeyRaw === 'string' ? hotkeyRaw.trim() : '';
  const voiceRaw = pick('voiceName');
  const voiceName = typeof voiceRaw === 'string' ? voiceRaw.trim() : '';
  const activation = pick('activation');

  return {
    enabled: bool('enabled'),
    // '-' is the app-wide "unbound" sentinel written by hotkey-conflict
    // resolution (renderer/spotify-widget.js) — keep it as-is.
    hotkey: (hotkey && hotkey.length <= 64) ? hotkey : DEFAULT_SETTINGS.hotkey,
    activation: ACTIVATION_MODES.includes(activation) ? activation : DEFAULT_SETTINGS.activation,
    voiceFeedback: bool('voiceFeedback'),
    voiceName: voiceName.length <= 80 ? voiceName : '',
    speechRate: Math.round(clampNumber(pick('speechRate'), -5, 5, DEFAULT_SETTINGS.speechRate)),
    confidence: clampNumber(pick('confidence'), 0.2, 0.95, DEFAULT_SETTINGS.confidence),
    listenTimeoutMs: Math.round(clampNumber(pick('listenTimeoutMs'), 2000, 20000, DEFAULT_SETTINGS.listenTimeoutMs)),
    chaining: bool('chaining'),
    confirmRisky: bool('confirmRisky'),
    // ── One-time correction ──
    // freeform shipped ON in v4.2.0 and was reported the same day as the
    // assistant hearing nothing. Flipping the DEFAULT fixes new installs and
    // does nothing for anyone who already ran that build: their settings file
    // holds `true`, and a saved value always beats a default. So the bad value
    // is cleared once, recorded by a flag, after which the user's own choice is
    // respected for good.
    freeform: bool('freeformReset') ? bool('freeform') : false,
    freeformReset: true,
    transition: PANEL_TRANSITIONS.includes(pick('transition')) ? pick('transition') : DEFAULT_SETTINGS.transition,
    vizStyle: VIZ_STYLES.includes(pick('vizStyle')) ? pick('vizStyle') : DEFAULT_SETTINGS.vizStyle,
    // Rounded to a step so the slider and the stored value always agree.
    scale: Math.round(clampNumber(pick('scale'), 0.7, 1.6, DEFAULT_SETTINGS.scale) * 20) / 20,
    wakeWord: bool('wakeWord'),
    wakeConfidence: clampNumber(pick('wakeConfidence'), 0.6, 0.95, DEFAULT_SETTINGS.wakeConfidence),
    showTranscript: bool('showTranscript'),
    reducedMotion: bool('reducedMotion'),
    clickActivate: bool('clickActivate')
  };
}

// ── Number words ──────────────────────────────────────────────────────────
// The recognizer speaks words, not digits, so numeric slots (volume percent,
// timer minutes) need their choices spelled out. 0–100 covers every numeric slot
// the registry uses.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 0 || v > 100) return '';
  if (v === 100) return 'one hundred';
  if (v < 20) return ONES[v];
  const t = Math.floor(v / 10);
  const o = v % 10;
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
}

// Inverse of numberToWords, plus bare digits — used by the typed fallback and by
// the fuzzy path, where the text didn't come from our own generated phrases.
// The spoken durations compiled into the recognizer's grammar, alongside the
// plain numbers. `spoken` is what the recognizer listens for; the template it
// fills already ends in "minutes", so each of these has to read correctly with
// that word dropped (see the minutes branch of the slot matcher).
const DURATION_IDIOMS = Object.freeze([
  { value: 30,  label: '30 min', spoken: 'half an hour', aliases: ['a half hour', 'half hour'] },
  { value: 60,  label: '1 hour', spoken: 'an hour', aliases: ['one hour'] },
  { value: 90,  label: '90 min', spoken: 'an hour and a half', aliases: ['one and a half hours'] },
  { value: 15,  label: '15 min', spoken: 'a quarter of an hour', aliases: ['quarter of an hour'] },
  { value: 120, label: '2 hours', spoken: 'two hours', aliases: [] },
  { value: 180, label: '3 hours', spoken: 'three hours', aliases: [] },
  { value: 2,   label: '2 min', spoken: 'a couple of minutes', aliases: ['a couple minutes'] },
  { value: 5,   label: '5 min', spoken: 'a few minutes', aliases: [] }
]);

// Durations as people actually say them. wordsToNumber handles bare integers up
// to 100, which is fine for a volume percentage and useless for a timer: "half
// an hour", "an hour and a half" and "a couple of minutes" are the normal ways
// to ask, and all three used to fall straight through to "unknown".
//
// Returns whole minutes, or null when the text is not a duration.
function parseDuration(text) {
  const s = String(text || '').toLowerCase()
    .replace(/[-]/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // Fixed idioms first — they do not decompose into number + unit.
  const IDIOMS = {
    'half an hour': 30, 'half hour': 30, 'an hour and a half': 90,
    'hour and a half': 90, 'a quarter of an hour': 15, 'quarter of an hour': 15,
    'a couple of minutes': 2, 'couple of minutes': 2, 'a couple minutes': 2,
    'a few minutes': 5, 'few minutes': 5, 'a minute': 1, 'a moment': 1,
    'an hour': 60, 'one hour': 60, 'a day': 1440
  };
  if (IDIOMS[s] !== undefined) return IDIOMS[s];

  // "<n> hours <n> minutes", either part optional.
  let total = 0;
  let saw = false;
  const hourMatch = s.match(/^(.*?)\s*(?:hours?|hrs?|h)\b/);
  let rest = s;
  if (hourMatch) {
    const h = hourMatch[1].trim();
    const hv = h === '' || h === 'a' || h === 'an' ? 1 : wordsToNumber(h);
    if (hv === null) return null;
    total += hv * 60;
    saw = true;
    rest = s.slice(hourMatch[0].length).trim();
  }
  if (rest) {
    const minMatch = rest.match(/^(.*?)\s*(?:minutes?|mins?|m)?$/);
    const m = (minMatch ? minMatch[1] : rest).trim();
    if (m) {
      if (m === 'a half' || m === 'half') { total += 30; saw = true; }
      else {
        const mv = m === 'a' || m === 'an' ? 1 : wordsToNumber(m);
        if (mv === null) return saw ? total : null;
        total += mv;
        saw = true;
      }
    }
  }
  if (!saw || total <= 0) return null;
  return total;
}

function wordsToNumber(text) {
  const s = String(text || '').trim().toLowerCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^\d{1,3}$/.test(s)) {
    const d = parseInt(s, 10);
    return d >= 0 && d <= 100 ? d : null;
  }
  if (s === 'a' || s === 'an' || s === 'one hundred' || s === 'a hundred' || s === 'hundred') {
    return (s === 'a' || s === 'an') ? 1 : 100;
  }
  const parts = s.split(' ');
  if (parts.length === 1) {
    const oi = ONES.indexOf(parts[0]);
    if (oi !== -1) return oi;
    const ti = TENS.indexOf(parts[0]);
    if (ti > 1) return ti * 10;
    return null;
  }
  if (parts.length === 2) {
    const ti = TENS.indexOf(parts[0]);
    const oi = ONES.indexOf(parts[1]);
    if (ti > 1 && oi > 0 && oi < 10) return ti * 10 + oi;
  }
  return null;
}

// Fixed enum slots. Unlike apps or playlists these never change, so they live
// here rather than arriving from the renderer.
const CROSSHAIR_STYLES = Object.freeze([
  { id: 'cross', label: 'Cross', spoken: 'cross' },
  { id: 'tshape', label: 'T shape', spoken: 't shape' },
  { id: 'xshape', label: 'X shape', spoken: 'x shape' },
  { id: 'circle', label: 'Circle', spoken: 'circle' },
  { id: 'dot', label: 'Dot', spoken: 'dot' }
]);

const COLOURS = Object.freeze([
  { id: '#00ff7f', label: 'green', spoken: 'green' },
  { id: '#ff3355', label: 'red', spoken: 'red' },
  { id: '#00d4ff', label: 'cyan', spoken: 'cyan' },
  { id: '#ff00ff', label: 'magenta', spoken: 'magenta' },
  { id: '#ffe600', label: 'yellow', spoken: 'yellow' },
  { id: '#ffffff', label: 'white', spoken: 'white' },
  { id: '#ff8800', label: 'orange', spoken: 'orange' },
  { id: '#8844ff', label: 'purple', spoken: 'purple' }
]);

// ── Numeric slot ranges ───────────────────────────────────────────────────
// Volume goes in fives (21 phrases, not 101 — a closed grammar stays small and
// the extra precision is meaningless for a spoken volume). Timer minutes go
// 1–60 in useful increments plus every value up to 20, which is where people
// actually set short timers.
const VOLUME_STEPS = Array.from({ length: 21 }, (_, i) => i * 5);
const TIMER_MINUTES = [...Array.from({ length: 20 }, (_, i) => i + 1), 25, 30, 35, 40, 45, 50, 55, 60];

// ── Command registry ──────────────────────────────────────────────────────
// Fields:
//   id        stable key; the executor in renderer/voice-assistant.js switches on it
//   title     human label, shown in the overlay's help list
//   category  groups the help list
//   phrases   spoken forms. `{slot}` marks the one entity slot the command takes.
//             Order matters only for readability; matching is score-based.
//   slot      'app' | 'widget' | 'macro' | 'volume' | 'minutes' | 'query' | null
//   prompt    what the assistant asks when the slot is missing ("Launch what?")
//   reply     short confirmation text; a function when it depends on params
//   confirm   destructive/wide-reaching commands ask first and require a spoken
//             yes before running (see CONFIRM_YES / CONFIRM_NO below)
//   needs     capability the executor must have — surfaced as a clean "Spotify
//             isn't connected" rather than a silent failure
const COMMANDS = Object.freeze([
  // ── Spotify ──
  {
    id: 'spotify.play', title: 'Resume playback', category: 'Spotify', needs: 'spotify',
    phrases: ['play', 'resume', 'play music', 'resume music', 'resume playback', 'unpause', 'keep playing',
      'start the music', 'put the music back on', 'resume the song'
    ],
    reply: 'Playing'
  },
  {
    id: 'spotify.pause', title: 'Pause playback', category: 'Spotify', needs: 'spotify',
    phrases: ['pause', 'pause music', 'pause the music', 'stop music', 'stop the music', 'pause playback',
      'pause the song', 'hold the music'
    ],
    reply: 'Paused'
  },
  {
    id: 'spotify.next', title: 'Next track', category: 'Spotify', needs: 'spotify',
    phrases: ['next track', 'next song', 'skip track', 'skip song', 'skip this song', 'play the next song',
      'next', 'skip', 'play the next one'
    ],
    reply: 'Next track'
  },
  {
    id: 'spotify.previous', title: 'Previous track', category: 'Spotify', needs: 'spotify',
    phrases: ['previous track', 'previous song', 'last song', 'go back a song', 'play the previous song',
      'play that again from before'
    ],
    reply: 'Previous track'
  },
  {
    id: 'spotify.volumeUp', title: 'Music louder', category: 'Spotify', needs: 'spotify',
    phrases: ['turn the music up', 'music louder', 'turn it up', 'louder'],
    reply: 'Louder'
  },
  {
    id: 'spotify.volumeDown', title: 'Music quieter', category: 'Spotify', needs: 'spotify',
    phrases: ['turn the music down', 'music quieter', 'turn it down', 'quieter'],
    reply: 'Quieter'
  },
  {
    id: 'spotify.setVolume', title: 'Set music volume', category: 'Spotify', needs: 'spotify',
    slot: 'volume', prompt: 'What volume?',
    phrases: ['set the volume to {volume}', 'set volume to {volume}', 'set the music volume to {volume}'],
    reply: (p) => `Volume ${p.volume}%`
  },
  {
    id: 'spotify.like', title: 'Save this track', category: 'Spotify', needs: 'spotify',
    phrases: ['like this song', 'like this track', 'save this song', 'save this track', 'add this to my library',
      'i like this song', 'favourite this', 'favorite this song'
    ],
    reply: 'Saved to your library'
  },
  {
    id: 'spotify.whatsPlaying', title: 'What is playing', category: 'Spotify', needs: 'spotify',
    phrases: ['what is playing', 'what song is this', 'what is this song', 'what am i listening to', 'now playing',
      'who is this', 'who sings this', 'name this song'
    ],
    reply: 'Checking'
  },

  // ── System audio & microphone ──
  {
    id: 'system.mute', title: 'Mute system audio', category: 'System',
    phrases: ['mute the sound', 'mute system audio', 'mute everything', 'silence',
      'silence the computer'
    ],
    reply: 'Muted'
  },
  {
    id: 'system.unmute', title: 'Unmute system audio', category: 'System',
    phrases: ['unmute the sound', 'unmute system audio', 'unmute everything',
      'sound back on'
    ],
    reply: 'Unmuted'
  },
  {
    id: 'mic.mute', title: 'Mute microphone', category: 'System',
    phrases: ['mute my microphone', 'mute my mic', 'mute the microphone',
      'mute me', 'turn my microphone off'
    ],
    reply: 'Microphone muted'
  },
  {
    id: 'mic.unmute', title: 'Unmute microphone', category: 'System',
    phrases: ['unmute my microphone', 'unmute my mic', 'unmute the microphone',
      'unmute me', 'turn my microphone on'
    ],
    reply: 'Microphone live'
  },

  // ── Launching ──
  {
    id: 'app.launch', title: 'Launch an app or game', category: 'Launcher',
    slot: 'app', prompt: 'What should I launch?',
    phrases: ['launch {app}', 'open {app}', 'start {app}', 'run {app}', 'play {app}', 'fire up {app}'],
    reply: (p) => `Opening ${p.appLabel || 'it'}`
  },

  // ── Performance ──
  {
    id: 'fps.optimize', title: 'Optimize performance', category: 'Performance',
    phrases: ['optimize my pc', 'optimise my pc', 'boost performance', 'optimize performance', 'optimise performance', 'speed up my pc',
      'make my pc faster', 'free up some memory', 'clean up my computer'
    ],
    reply: 'Optimizing'
  },
  {
    id: 'fps.nuke', title: 'Close background apps', category: 'Performance', confirm: true,
    confirmPrompt: 'Close background apps?',
    phrases: ['close background apps', 'kill background apps', 'free up memory', 'maximum performance',
      'close all background apps', 'shut down background programs'
    ],
    reply: 'Clearing background apps'
  },
  {
    id: 'fps.battery', title: 'Battery saver', category: 'Performance',
    phrases: ['battery saver', 'save battery', 'turn on battery saver'],
    reply: 'Battery saver on'
  },
  {
    id: 'fps.revert', title: 'Restore default settings', category: 'Performance', confirm: true,
    confirmPrompt: 'Restore the default performance settings?',
    phrases: ['restore defaults', 'revert optimizations', 'revert optimisations', 'undo the optimizations',
      'undo the optimisation', 'put my settings back', 'restore my settings'
    ],
    reply: 'Defaults restored'
  },

  // ── Crosshair ──
  {
    id: 'crosshair.show', title: 'Show crosshair', category: 'Gaming',
    phrases: ['show the crosshair', 'crosshair on', 'turn on the crosshair',
      'give me a crosshair', 'put the crosshair up'
    ],
    reply: 'Crosshair on'
  },
  {
    id: 'crosshair.hide', title: 'Hide crosshair', category: 'Gaming',
    phrases: ['hide the crosshair', 'crosshair off', 'turn off the crosshair',
      'get rid of the crosshair', 'take the crosshair away'
    ],
    reply: 'Crosshair off'
  },

  // ── Navigation inside main ──
  {
    id: 'widget.open', title: 'Open a widget', category: 'Launcher',
    slot: 'widget', prompt: 'Which widget?',
    // Every phrase carries the word "widget" so "open spotify" stays an app
    // launch and never collides with the Spotify widget.
    phrases: ['open the {widget} widget', 'show the {widget} widget', 'open {widget} widget'],
    reply: (p) => `Opening ${p.widgetLabel || 'the widget'}`
  },
  {
    id: 'app.openWidgetLibrary', title: 'Open the Widget Library', category: 'Launcher',
    phrases: ['open the widget library', 'show my widgets', 'open my widgets', 'widget library'],
    reply: 'Widget Library'
  },
  {
    id: 'app.openSettings', title: 'Open settings', category: 'Launcher',
    phrases: ['open settings', 'show settings', 'open the settings', 'open preferences',
      'open your settings', 'show me settings', 'let me change settings'
    ],
    reply: 'Settings'
  },
  {
    id: 'app.focus', title: 'Show the launcher', category: 'Launcher',
    phrases: ['show the launcher', 'open the launcher', 'bring up main', 'show main',
      'come here', 'show yourself', 'bring up the launcher'
    ],
    reply: 'Here'
  },

  // ── Search ──
  {
    id: 'search.files', title: 'Search for files', category: 'Search',
    // The only open-ended slot: appended to the grammar as free dictation, so
    // the transcript is shown and the search opens pre-filled rather than acted
    // on blindly (dictation accuracy is far below the closed grammar's).
    slot: 'query', prompt: 'What should I search for?',
    phrases: ['search for {query}', 'find files called {query}', 'look for {query}'],
    reply: (p) => `Searching for "${p.query || ''}"`
  },

  // ── Information ──
  {
    id: 'weather.now', title: 'Current weather', category: 'Information',
    phrases: ['what is the weather', 'how is the weather', 'what is the weather like', 'weather', 'the weather',
      'whats it like outside', 'is it raining', 'how hot is it', 'temperature outside'
    ],
    reply: 'Checking the weather'
  },
  {
    id: 'system.stats', title: 'System status', category: 'Information',
    phrases: ['how is my pc doing', 'system status', 'check my cpu', 'cpu usage', 'how much memory am i using',
      'how is my computer doing', 'check my system', 'how is performance', 'is my pc struggling'
    ],
    reply: 'Checking'
  },

  // ── Timer ──
  {
    id: 'timer.start', title: 'Start a timer', category: 'Productivity',
    slot: 'minutes', prompt: 'A timer for how many minutes?',
    phrases: ['set a timer for {minutes}', 'start a timer for {minutes}', 'timer for {minutes}'],
    reply: (p) => `Timer set for ${p.minutes} min`
  },
  {
    id: 'timer.cancel', title: 'Cancel the timer', category: 'Productivity',
    phrases: ['cancel the timer', 'stop the timer', 'clear the timer',
      'forget the timer', 'cancel my timer'
    ],
    reply: 'Timer cancelled'
  },
  {
    id: 'clipboard.open', title: 'Open clipboard history', category: 'Productivity',
    phrases: ['open my clipboard', 'clipboard history', 'show my clipboard',
      'open clipboard history'
    ],
    reply: 'Clipboard history'
  },
  {
    id: 'macro.play', title: 'Run a macro', category: 'Productivity',
    slot: 'macro', prompt: 'Which macro?',
    phrases: ['run the {macro} macro', 'play the {macro} macro', 'run macro {macro}'],
    reply: (p) => `Running ${p.macroLabel || 'the macro'}`
  },

  // ── The assistant itself ──
  {
    id: 'assistant.help', title: 'What can I say', category: 'Assistant',
    phrases: ['what can i say', 'what can you do', 'help', 'show me the commands', 'list commands',
      'what commands do you know', 'how do i use you', 'list your commands'
    ],
    reply: 'Here is what I can do'
  },
  // ── Spotify, deeper ──
  {
    id: 'spotify.playPlaylist', title: 'Play a playlist', category: 'Spotify', needs: 'spotify',
    slot: 'playlist', prompt: 'Which playlist?',
    phrases: ['play my {playlist} playlist', 'play the {playlist} playlist', 'put on {playlist}'],
    reply: (p) => `Playing ${p.playlistLabel || 'playlist'}`
  },
  {
    id: 'spotify.unlike', title: 'Remove from library', category: 'Spotify', needs: 'spotify',
    phrases: ['unlike this song', 'remove this from my library', 'unsave this track'],
    reply: 'Removed from your library'
  },
  {
    id: 'spotify.restart', title: 'Restart this track', category: 'Spotify', needs: 'spotify',
    phrases: ['start this song over', 'restart this track', 'play this from the beginning',
      'play this from the start'
    ],
    reply: 'From the top'
  },
  {
    id: 'spotify.mute', title: 'Silence the music', category: 'Spotify', needs: 'spotify',
    phrases: ['mute the music', 'silence the music'],
    reply: 'Music muted'
  },
  {
    id: 'spotify.full', title: 'Music to full volume', category: 'Spotify', needs: 'spotify',
    phrases: ['music to full volume', 'max out the music', 'music full blast'],
    reply: 'Volume 100%'
  },
  {
    id: 'spotify.queue', title: 'What is up next', category: 'Spotify', needs: 'spotify',
    phrases: ['what is up next', 'what is next in the queue', 'what song is next'],
    reply: 'Checking the queue'
  },
  {
    id: 'spotify.sleepTimer', title: 'Sleep timer', category: 'Spotify', needs: 'spotify',
    slot: 'minutes', prompt: 'A sleep timer for how long?',
    phrases: ['sleep timer for {minutes}', 'stop the music in {minutes}'],
    reply: (p) => `Music stops in ${p.minutes} min`
  },
  {
    id: 'spotify.sleepCancel', title: 'Cancel the sleep timer', category: 'Spotify', needs: 'spotify',
    phrases: ['cancel the sleep timer', 'stop the sleep timer'],
    reply: 'Sleep timer cancelled'
  },

  // ── System volume (the Volume Mixer engine, not Spotify) ──
  {
    id: 'system.volumeUp', title: 'System volume up', category: 'System',
    phrases: ['volume up', 'turn the volume up', 'raise the volume',
      'make it louder', 'volume higher', 'increase the volume', 'crank the volume'
    ],
    reply: 'Volume up'
  },
  {
    id: 'system.volumeDown', title: 'System volume down', category: 'System',
    phrases: ['volume down', 'turn the volume down', 'lower the volume',
      'make it quieter', 'volume lower', 'decrease the volume', 'turn the sound down'
    ],
    reply: 'Volume down'
  },
  {
    id: 'system.setVolume', title: 'Set system volume', category: 'System',
    slot: 'volume', prompt: 'What volume?',
    phrases: ['set the system volume to {volume}', 'set my volume to {volume}'],
    reply: (p) => `System volume ${p.volume}%`
  },
  {
    id: 'app.mute', title: 'Mute one app', category: 'System',
    slot: 'session', prompt: 'Mute which app?',
    phrases: ['mute {session}', 'silence {session}'],
    reply: (p) => `Muted ${p.sessionLabel || 'it'}`
  },
  {
    id: 'app.unmute', title: 'Unmute one app', category: 'System',
    slot: 'session', prompt: 'Unmute which app?',
    phrases: ['unmute {session}'],
    reply: (p) => `Unmuted ${p.sessionLabel || 'it'}`
  },
  {
    id: 'mic.toggle', title: 'Toggle the microphone', category: 'System',
    phrases: ['toggle my microphone', 'toggle my mic', 'flip my mic'],
    reply: 'Microphone toggled'
  },

  // ── Bluetooth ──
  {
    id: 'bluetooth.on', title: 'Bluetooth on', category: 'System',
    phrases: ['turn on bluetooth', 'bluetooth on', 'enable bluetooth',
      'switch bluetooth on'
    ],
    reply: 'Bluetooth on'
  },
  {
    id: 'bluetooth.off', title: 'Bluetooth off', category: 'System',
    phrases: ['turn off bluetooth', 'bluetooth off', 'disable bluetooth',
      'switch bluetooth off'
    ],
    reply: 'Bluetooth off'
  },
  {
    id: 'bluetooth.connect', title: 'Connect a device', category: 'System',
    slot: 'device', prompt: 'Connect to what?',
    phrases: ['connect to {device}', 'connect my {device}'],
    reply: (p) => `Connecting ${p.deviceLabel || 'device'}`
  },
  {
    id: 'bluetooth.disconnect', title: 'Disconnect a device', category: 'System',
    slot: 'device', prompt: 'Disconnect what?',
    phrases: ['disconnect {device}', 'disconnect my {device}'],
    reply: (p) => `Disconnecting ${p.deviceLabel || 'device'}`
  },

  // ── Performance, granular ──
  {
    id: 'fps.ultimate', title: 'Ultimate performance plan', category: 'Performance',
    phrases: ['ultimate performance', 'ultimate power plan'],
    reply: 'Ultimate performance'
  },
  {
    id: 'fps.high', title: 'High performance plan', category: 'Performance',
    phrases: ['high performance', 'high performance plan'],
    reply: 'High performance'
  },
  {
    id: 'fps.balanced', title: 'Balanced power plan', category: 'Performance',
    phrases: ['balanced power plan', 'balanced power'],
    reply: 'Balanced'
  },
  {
    id: 'fps.clearStandby', title: 'Clear standby memory', category: 'Performance',
    phrases: ['clear standby memory', 'free up standby memory'],
    reply: 'Standby memory cleared'
  },
  {
    id: 'fps.clearTemp', title: 'Clear temp files', category: 'Performance',
    phrases: ['clear temp files', 'clean up temp files'],
    reply: 'Temp files cleared'
  },
  {
    id: 'fps.flushDns', title: 'Flush DNS', category: 'Performance',
    phrases: ['flush dns', 'flush my dns cache'],
    reply: 'DNS flushed'
  },
  {
    id: 'fps.lowLatency', title: 'Low latency networking', category: 'Performance',
    phrases: ['low latency mode', 'optimize my network', 'optimise my network'],
    reply: 'Low latency on'
  },
  {
    id: 'fps.cpuPriority', title: 'CPU game priority', category: 'Performance',
    phrases: ['prioritize games on my cpu', 'game cpu priority'],
    reply: 'Games prioritised'
  },
  {
    id: 'fps.hags', title: 'Hardware GPU scheduling', category: 'Performance',
    phrases: ['enable gpu scheduling', 'turn on hardware scheduling'],
    reply: 'GPU scheduling on'
  },

  // ── Crosshair ──
  {
    id: 'crosshair.toggle', title: 'Toggle the crosshair', category: 'Gaming',
    phrases: ['toggle the crosshair', 'flip the crosshair'],
    reply: 'Crosshair toggled'
  },
  {
    id: 'crosshair.style', title: 'Change crosshair style', category: 'Gaming',
    slot: 'crosshairStyle', prompt: 'Which crosshair style?',
    phrases: ['make the crosshair a {crosshairStyle}', 'crosshair style {crosshairStyle}'],
    reply: (p) => `Crosshair: ${p.crosshairStyleLabel || 'updated'}`
  },
  {
    id: 'crosshair.color', title: 'Change crosshair colour', category: 'Gaming',
    slot: 'colour', prompt: 'What colour?',
    phrases: ['make the crosshair {colour}', 'crosshair colour {colour}', 'crosshair color {colour}'],
    reply: (p) => `Crosshair ${p.colourLabel || 'recoloured'}`
  },

  // ── Gaming utilities ──
  {
    id: 'gameMode.on', title: 'Game Mode on', category: 'Gaming',
    phrases: ['turn on game mode', 'game mode on', 'enable game mode',
      'i am gaming', 'turn on gaming mode'
    ],
    reply: 'Game Mode on'
  },
  {
    id: 'gameMode.off', title: 'Game Mode off', category: 'Gaming',
    phrases: ['turn off game mode', 'game mode off', 'disable game mode',
      'i am done gaming', 'turn off gaming mode'
    ],
    reply: 'Game Mode off'
  },
  {
    id: 'autoClicker.start', title: 'Start the auto clicker', category: 'Gaming', confirm: true,
    confirmPrompt: 'Start the auto clicker?',
    phrases: ['start the auto clicker', 'start clicking'],
    reply: 'Auto clicker running'
  },
  {
    id: 'autoClicker.stop', title: 'Stop the auto clicker', category: 'Gaming',
    phrases: ['stop the auto clicker', 'stop clicking'],
    reply: 'Auto clicker stopped'
  },
  {
    id: 'macro.stop', title: 'Stop the running macro', category: 'Productivity',
    phrases: ['stop the macro', 'stop the running macro'],
    reply: 'Macro stopped'
  },

  // ── Clipboard ──
  {
    id: 'clipboard.recopy', title: 'Re-copy the last clip', category: 'Clipboard',
    phrases: ['copy that again', 'recopy the last thing', 'copy my last clip'],
    reply: 'Copied'
  },
  {
    id: 'clipboard.clear', title: 'Clear clipboard history', category: 'Clipboard', confirm: true,
    confirmPrompt: 'Clear your clipboard history?',
    phrases: ['clear my clipboard history', 'wipe my clipboard'],
    reply: 'Clipboard cleared'
  },

  // ── Timer, fuller ──
  {
    id: 'timer.pause', title: 'Pause the timer', category: 'Productivity',
    phrases: ['pause the timer', 'hold the timer'],
    reply: 'Timer paused'
  },
  {
    id: 'timer.resume', title: 'Resume the timer', category: 'Productivity',
    phrases: ['resume the timer', 'continue the timer', 'unpause the timer'],
    reply: 'Timer running'
  },
  {
    id: 'timer.restart', title: 'Restart the timer', category: 'Productivity',
    phrases: ['restart the timer', 'start the timer again'],
    reply: 'Timer restarted'
  },
  {
    id: 'timer.status', title: 'Time left on the timer', category: 'Productivity',
    phrases: ['how long is left', 'how much time is left', 'check the timer',
      'check my timer', 'how long on the timer'
    ],
    reply: 'Checking'
  },
  {
    id: 'notes.new', title: 'New note', category: 'Productivity',
    phrases: ['start a new note', 'make me a new note', 'new note'],
    reply: 'New note'
  },

  // ── Widgets & app control ──
  {
    id: 'widget.enable', title: 'Turn a widget on', category: 'Launcher',
    slot: 'anyWidget', prompt: 'Which widget?',
    phrases: ['turn on the {anyWidget} widget', 'enable the {anyWidget} widget'],
    reply: (p) => `${p.anyWidgetLabel || 'Widget'} on`
  },
  {
    id: 'widget.disable', title: 'Turn a widget off', category: 'Launcher',
    slot: 'anyWidget', prompt: 'Which widget?',
    phrases: ['turn off the {anyWidget} widget', 'disable the {anyWidget} widget'],
    reply: (p) => `${p.anyWidgetLabel || 'Widget'} off`
  },
  {
    id: 'app.minimize', title: 'Minimise the launcher', category: 'Launcher',
    // "go away" is deliberately NOT here — assistant.cancel owns it. Said to an
    // assistant it means "dismiss this", not "minimise the launcher".
    phrases: ['minimize the launcher', 'minimise the launcher', 'hide the launcher', 'get out of the way'],
    reply: 'Hidden'
  },
  {
    id: 'app.checkUpdates', title: 'Check for updates', category: 'Launcher',
    phrases: ['check for updates', 'is there an update'],
    reply: 'Checking for updates'
  },
  {
    id: 'app.openLogs', title: 'Open the log folder', category: 'Launcher',
    phrases: ['open the logs', 'open my log folder', 'show me the logs'],
    reply: 'Log folder'
  },
  {
    id: 'app.account', title: 'Open my account', category: 'Launcher',
    phrases: ['open my account', 'show my account', 'show my license'],
    reply: 'Account'
  },
  {
    id: 'app.autostartOn', title: 'Start with Windows', category: 'Launcher',
    phrases: ['start with windows', 'launch on startup', 'turn on autostart'],
    reply: 'Will start with Windows'
  },
  {
    id: 'app.autostartOff', title: 'Do not start with Windows', category: 'Launcher',
    phrases: ['do not start with windows', 'turn off autostart'],
    reply: 'Autostart off'
  },
  {
    id: 'search.reindex', title: 'Rebuild the file index', category: 'Search',
    phrases: ['rebuild the file index', 'reindex my files'],
    reply: 'Rebuilding the index'
  },

  // ── Information ──
  {
    id: 'system.battery', title: 'Check the battery', category: 'Information',
    phrases: ['how is my battery', 'what is my battery', 'battery level',
              'how much battery do i have', 'check my battery',
      'battery status', 'how much charge do i have', 'am i charging'
    ],
    reply: 'Checking the battery'
  },
  {
    id: 'system.disk', title: 'Check free space', category: 'Information',
    phrases: ['how much space is left', 'how much disk space do i have',
              'check my disk space', 'how much storage is left', 'free space',
      'do i have space', 'is my disk full', 'storage left'
    ],
    reply: 'Checking your disk'
  },
  {
    id: 'system.time', title: 'What time is it', category: 'Information',
    phrases: ['what time is it', 'what is the time', 'tell me the time',
      'do you have the time', 'whats the time', 'time please'
    ],
    reply: 'Checking'
  },
  {
    id: 'weather.forecast', title: 'The forecast', category: 'Information',
    phrases: ['what is the forecast', 'what is the weather tomorrow', 'give me the forecast',
      'what is tomorrow like', 'and tomorrow', 'what about tomorrow', 'will it rain tomorrow'
    ],
    reply: 'Checking the forecast'
  },

  // ── Routines: user-defined multi-step commands ──
  {
    id: 'routine.run', title: 'Run one of your routines', category: 'Routines',
    slot: 'routine', prompt: 'Which routine?',
    phrases: ['{routine}', 'run {routine}', 'start {routine}', 'activate {routine}'],
    reply: (p) => `${p.routineLabel || 'Routine'}`
  },

  // ── The assistant itself ──
  {
    id: 'assistant.repeat', title: 'Do that again', category: 'Assistant',
    phrases: ['do that again', 'again', 'repeat that', 'one more time'],
    reply: 'Again'
  },
  {
    id: 'assistant.quiet', title: 'Stop talking', category: 'Assistant',
    phrases: ['be quiet', 'stop talking', 'shush'],
    reply: 'Quiet'
  },
  {
    // Deliberately NOT "never mind" — that is assistant.cancel, which dismisses
    // the overlay without touching anything. Undo reverses the last action.
    id: 'assistant.undo', title: 'Undo the last thing', category: 'Assistant',
    phrases: ['undo that', 'undo', 'take that back', 'reverse that', 'put that back',
      'undo the last thing', 'revert that', 'that was wrong undo it'
    ],
    reply: 'Undone'
  },
  {
    id: 'assistant.cancel', title: 'Dismiss', category: 'Assistant',
    phrases: ['cancel', 'never mind', 'nevermind', 'forget it', 'go away', 'dismiss', 'nothing'],
    reply: 'Okay'
  }
]);

// Spoken confirmation vocabulary for `confirm: true` commands. Kept out of
// COMMANDS because these are only ever live while a confirmation is pending —
// they are added to the grammar for that window and removed again after.
const CONFIRM_YES = Object.freeze(['yes', 'yeah', 'yep', 'do it', 'confirm', 'go ahead', 'okay', 'ok']);
const CONFIRM_NO = Object.freeze(['no', 'nope', 'cancel', 'stop', 'never mind', 'nevermind', 'forget it']);

// ── Normalisation ─────────────────────────────────────────────────────────
// Contractions the recognizer or a typing user may produce that our phrases
// spell out in full. Kept tiny and unambiguous on purpose — an over-eager
// expansion table causes more misses than it fixes.
const CONTRACTIONS = Object.freeze({
  "what's": 'what is', "how's": 'how is', "that's": 'that is', "it's": 'it is',
  "i'm": 'i am', "don't": 'do not', "won't": 'will not', "can't": 'can not',
  "let's": 'let us', "there's": 'there is', "whats": 'what is', "hows": 'how is'
});

// Politeness and wake-word prefixes that carry no intent. Stripped from the
// FRONT only — "play" is a command, but "please" in "search for please help"
// is part of the query and must survive.
const LEADING_FILLERS = Object.freeze([
  'hey main', 'ok main', 'okay main', 'hey there', 'main',
  'please', 'can you', 'could you', 'would you', 'will you',
  'i want to', 'i would like to', 'i want you to', 'i need you to',
  'um', 'uh', 'er', 'so', 'just', 'now'
]);

// Trailing courtesies, stripped from the END for the same reason.
const TRAILING_FILLERS = Object.freeze([
  'please', 'thanks', 'thank you', 'for me', 'right now', 'now',
  'if you can', 'if you could', 'would you', 'will you', 'alright', 'ok', 'okay'
]);

// Fillers that land in the MIDDLE of an utterance. Leading/trailing stripping
// alone cannot reach these, and one stray "um" was enough to drop a phrase below
// the match floor: "turn the um volume up" scored as though a word were missing,
// because to the matcher one was.
//
// EVERY entry must be a word that appears in no command template, or stripping
// it silently destroys a working command. "like" is the cautionary example — it
// looks like a filler, but "like this song" is how you favourite a track, and
// removing it leaves the bare "this song". `test/voice-commands.test.js` asserts
// this list stays disjoint from the registry's vocabulary, so a future command
// that uses one of these words fails the build instead of breaking in the field.
//
// There is deliberately NO synonym-rewriting table here. Collapsing verbs to a
// canonical form ("lower" -> "turn") reads as an obvious win and is actively
// harmful: the registry already enumerates the natural variants, so "lower the
// volume" is ALREADY a template, and rewriting it produces "turn the volume",
// which matches neither that template nor "turn the volume down". A rewrite can
// only move an utterance away from a phrase it already matched. Add new wordings
// to a command's `phrases` instead.
const INNER_FILLERS = Object.freeze(['um', 'uh', 'erm', 'ah', 'basically', 'literally', 'actually']);

function normalizeTranscript(text) {
  let s = String(text == null ? '' : text).toLowerCase();
  // Unicode curly apostrophes come back from some TTS/STT paths.
  s = s.replace(/[‘’ʼ]/g, "'");
  s = s.replace(/[^a-z0-9'\s%-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';

  s = s.split(' ').map((w) => (CONTRACTIONS[w] !== undefined ? CONTRACTIONS[w] : w)).join(' ');
  s = s.replace(/'/g, '');
  s = s.replace(/\s+/g, ' ').trim();

  // Strip leading fillers repeatedly — "please can you open settings" has two.
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const f of LEADING_FILLERS) {
      if (s === f) { s = ''; changed = true; break; }
      if (s.startsWith(f + ' ')) { s = s.slice(f.length + 1); changed = true; break; }
    }
  }
  // Mid-sentence fillers, between the leading and trailing passes so a stripped
  // inner word can expose a new leading/trailing filler.
  if (s) {
    const kept = s.split(' ').filter((w) => !INNER_FILLERS.includes(w));
    // Never let filler-stripping empty an utterance that had real words — an
    // all-filler phrase should stay unknown, not silently become something else.
    if (kept.length) s = kept.join(' ');
  }

  changed = true;
  while (changed && s) {
    changed = false;
    for (const f of TRAILING_FILLERS) {
      if (s === f) { s = ''; changed = true; break; }
      if (s.endsWith(' ' + f)) { s = s.slice(0, -(f.length + 1)); changed = true; break; }
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

// ── Vocabulary ────────────────────────────────────────────────────────────
// The renderer supplies the live vocabulary (pinned apps, detected games,
// enabled widget labels, saved macros). It is user data, so every name is
// sanitised before it can reach a grammar phrase: a closed grammar only accepts
// plain spoken words, and a name with punctuation, digits-as-symbols or absurd
// length would either fail to compile or produce an unspeakable phrase.
const MAX_VOCAB_ENTRIES = 120;      // per kind
const MAX_VOCAB_WORDS = 6;          // words per spoken name

function speakableName(name) {
  let s = String(name == null ? '' : name).toLowerCase();
  s = s.replace(/[‘’ʼ]/g, '');
  // Common symbols people put in app names, spoken the way a person would.
  s = s.replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/@/g, ' at ');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  // Digits are fine to leave as digits: the recognizer speaks "2" as "two" and
  // the phrase index only ever has to match itself.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ').slice(0, MAX_VOCAB_WORDS);
  return words.join(' ');
}

// Normalises one { id, name, aliases } list. Entries that sanitise to nothing
// are dropped (they can never be spoken), and duplicates collapse to the first.
// TWO passes, and the order matters more than it looks.
//
// Names and aliases used to share one `seen` set filled in list order, so an
// earlier entry's ALIAS could claim a word that was a later entry's real NAME —
// and that later app was then dropped from the vocabulary entirely. A pinned
// "Rainbow Six Siege" tile with a derived alias of "steam" silently deleted
// Steam, and "open steam" launched the game instead. Aliases are guesses
// (derived from an exe, icon or folder name); a primary name is what the user
// actually calls the thing, so a guess must never be allowed to shadow one.
function buildVocabularyList(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;

  // Pass 1 — primary names. First writer wins among these, as before.
  const taken = new Set();
  const kept = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id == null ? '' : item.id).slice(0, 200);
    const label = String(item.name == null ? '' : item.name).slice(0, 120);
    if (!id || !label) continue;
    const spoken = speakableName(label);
    if (!spoken || taken.has(spoken)) continue;
    taken.add(spoken);
    kept.push({ id, label, spoken, item });
    if (kept.length >= MAX_VOCAB_ENTRIES) break;
  }

  // Pass 2 — aliases, which may only take words no primary name claimed.
  for (const k of kept) {
    const aliases = [];
    if (Array.isArray(k.item.aliases)) {
      for (const a of k.item.aliases.slice(0, 6)) {
        const sa = speakableName(a);
        if (sa && sa !== k.spoken && !taken.has(sa)) { taken.add(sa); aliases.push(sa); }
      }
    }
    out.push({ id: k.id, label: k.label, spoken: k.spoken, aliases });
  }
  return out;
}

function buildVocabulary(raw) {
  const v = (raw && typeof raw === 'object') ? raw : {};
  // NB: `raw.accent` is deliberately not part of the vocabulary — it travels on
  // the same message but is a look setting, handled in main/voiceAssistant.js.
  return {
    // Validated on the way in: an alias reaching the grammar unchecked could
    // shadow a built-in phrase.
    aliases: validateAliases(raw && raw.aliases, null).aliases,
    apps: buildVocabularyList(v.apps),
    // Widgets the user has ENABLED (things worth opening) vs the whole catalogue
    // (things worth switching on or off) — two different questions.
    widgets: buildVocabularyList(v.widgets),
    allWidgets: buildVocabularyList(v.allWidgets),
    macros: buildVocabularyList(v.macros),
    devices: buildVocabularyList(v.devices),
    sessions: buildVocabularyList(v.sessions),
    playlists: buildVocabularyList(v.playlists),
    routines: buildVocabularyList(v.routines)
  };
}

const EMPTY_VOCABULARY = Object.freeze(buildVocabulary(null));

// Which vocabulary list (or generated numeric list) fills each slot.
function slotEntries(slot, vocab) {
  switch (slot) {
    case 'app': return vocab.apps;
    case 'widget': return vocab.widgets;
    case 'macro': return vocab.macros;
    case 'anyWidget': return vocab.allWidgets;
    case 'device': return vocab.devices;
    case 'session': return vocab.sessions;
    case 'playlist': return vocab.playlists;
    case 'routine': return vocab.routines;
    case 'crosshairStyle': return CROSSHAIR_STYLES.map((c) => ({ ...c, aliases: [] }));
    case 'colour': return COLOURS.map((c) => ({ ...c, aliases: [] }));
    case 'volume': return VOLUME_STEPS.map((n) => ({ id: String(n), label: `${n}%`, spoken: numberToWords(n), aliases: [], value: n }));
    case 'minutes': {
      // `spoken` carries the unit because the template no longer does. That is
      // what lets "ten minutes" and "half an hour" fill the same slot, instead
      // of a "{minutes} minutes" template forcing every duration to end in that
      // word and compiling idioms to "half an hour minutes".
      const numeric = TIMER_MINUTES.map((n) => ({
        id: String(n),
        label: `${n} min`,
        spoken: `${numberToWords(n)} ${n === 1 ? 'minute' : 'minutes'}`,
        aliases: [`${n} minutes`],
        value: n
      }));
      // Recognition runs against a CLOSED grammar: a phrasing the matcher can
      // parse is still unhearable unless it is compiled in as a choice. These
      // are the idiomatic durations people actually say, added so "set a timer
      // for half an hour" works by voice and not only when typed.
      const idioms = DURATION_IDIOMS.map((d) => ({
        id: String(d.value), label: d.label, spoken: d.spoken, aliases: d.aliases || [], value: d.value
      }));
      return numeric.concat(idioms);
    }
    default: return [];
  }
}

// The params a filled slot contributes. Kept in one place so the grammar index
// and the fuzzy matcher can never disagree about the shape they produce.
function slotParams(slot, entry) {
  switch (slot) {
    case 'app': return { app: entry.id, appLabel: entry.label };
    case 'widget': return { widget: entry.id, widgetLabel: entry.label };
    case 'macro': return { macro: entry.id, macroLabel: entry.label };
    case 'anyWidget': return { anyWidget: entry.id, anyWidgetLabel: entry.label };
    case 'device': return { device: entry.id, deviceLabel: entry.label };
    case 'session': return { session: entry.id, sessionLabel: entry.label };
    case 'playlist': return { playlist: entry.id, playlistLabel: entry.label };
    case 'routine': return { routine: entry.id, routineLabel: entry.label };
    case 'crosshairStyle': return { crosshairStyle: entry.id, crosshairStyleLabel: entry.label };
    case 'colour': return { colour: entry.id, colourLabel: entry.label };
    case 'volume': return { volume: entry.value };
    case 'minutes': return { minutes: entry.value };
    default: return {};
  }
}

// ── User aliases ─────────────────────────────────────────────────────────────
// Users can add their own wording for a command. This is the SAFE shape of the
// idea that a synonym table got wrong: an alias is an extra phrase on a command,
// so it can only add matches. A rewrite could move an utterance away from a
// phrase that already worked, which is how "lower the volume" got broken.
//
// Aliases are user input, so they are validated hard before they can reach the
// grammar: a phrase that collides with an existing one is rejected rather than
// silently shadowing a built-in command.
const MAX_ALIASES = 60;
const MAX_ALIAS_WORDS = 8;

// Cleans one alias. Returns '' when it cannot be used.
function normalizeAlias(text) {
  const t = normalizeTranscript(text);
  if (!t) return '';
  const words = t.split(' ').filter(Boolean);
  if (!words.length || words.length > MAX_ALIAS_WORDS) return '';
  // A one-word alias is exactly the shape room noise fits best; the confidence
  // floors already distrust those, and letting users mint more of them makes
  // false accepts more likely rather than less.
  if (words.length < 2) return '';
  return words.join(' ');
}

// Validates a whole alias map ({ commandId: [phrase, ...] }) against the
// registry and against the phrases already in use.
//
// Returns { aliases, rejected } — rejected explains itself so the UI can say
// WHY a phrase was refused instead of silently dropping it.
function validateAliases(map, vocabulary) {
  const out = {};
  const rejected = [];
  if (!map || typeof map !== 'object') return { aliases: out, rejected };

  const byId = new Map(COMMANDS.map((c) => [c.id, c]));
  // Every phrase the built-in grammar already claims.
  const taken = new Set();
  for (const cmd of COMMANDS) {
    for (const phrase of cmd.phrases) {
      if (cmd.slot && phrase.includes('{' + cmd.slot + '}')) continue;
      taken.add(normalizeTranscript(phrase));
    }
  }

  let count = 0;
  for (const [commandId, list] of Object.entries(map)) {
    if (!byId.has(commandId)) { rejected.push({ commandId, phrase: '', why: 'no such command' }); continue; }
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (count >= MAX_ALIASES) { rejected.push({ commandId, phrase: String(raw), why: 'too many aliases' }); continue; }
      const phrase = normalizeAlias(raw);
      if (!phrase) { rejected.push({ commandId, phrase: String(raw), why: 'needs 2 to 8 words' }); continue; }
      if (taken.has(phrase)) { rejected.push({ commandId, phrase, why: 'already means something else' }); continue; }
      taken.add(phrase);
      (out[commandId] = out[commandId] || []).push(phrase);
      count++;
    }
  }
  return { aliases: out, rejected };
}

// ── Voice training ───────────────────────────────────────────────────────────
// A read-these-phrases flow, and it is worth being precise about what it can and
// cannot do, because the obvious assumption is wrong.
//
// It does NOT retrain an acoustic model. System.Speech exposes no API to feed
// training audio — the acoustic profile belongs to Windows, and the only thing
// that adapts it is Windows' own trainer (SpeechUXWiz.exe UserTraining), which
// the panel offers separately.
//
// What it DOES do is the half Windows cannot: it learns how THIS user phrases
// things, on THIS microphone.
//
//   1. If a prompt is consistently heard as something else, that mishearing is
//      offered as a user ALIAS. Aliases only ever ADD phrases, so this can widen
//      what is understood without ever breaking a phrase that already worked.
//   2. It measures the real confidence of correct recognitions and proposes a
//      threshold from that, instead of everyone sharing one guessed number.
//   3. It measures peak input level, which is usually the actual problem and is
//      invisible without measuring it.
//
// Prompts are chosen to be phonetically varied and to cover the command shapes
// people use most, so the sample says something about ordinary use.
const TRAINING_PROMPTS = Object.freeze([
  { commandId: 'system.time',           say: 'what time is it' },
  { commandId: 'weather.now',           say: 'what is the weather' },
  { commandId: 'spotify.pause',         say: 'pause the music' },
  { commandId: 'spotify.next',          say: 'skip this song' },
  { commandId: 'system.volumeUp',       say: 'turn the volume up' },
  { commandId: 'app.openSettings',      say: 'open settings' },
  { commandId: 'system.stats',          say: 'how is my pc doing' },
  { commandId: 'assistant.help',        say: 'what can i say' }
]);

// Levels below this are the real limit on accuracy, whatever the wording.
const TRAINING_LOW_PEAK = 15;

function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// Turns a completed training run into concrete, applicable changes.
//
// samples: [{ commandId, said, heard, confidence, peak, matchedId }]
//   heard     what the recognizer returned ('' if it heard nothing)
//   matchedId which command that text resolved to ('' if none)
//
// Returns { accuracy, heardCount, peakMedian, lowMic, confidence, aliases,
//           misheard, skipped } — `aliases` is already validated, so it can be
// saved as-is.
function analyzeTraining(samples, vocabulary) {
  const list = Array.isArray(samples) ? samples : [];
  const attempted = list.filter((x) => x && x.heard);
  const correct = attempted.filter((x) => x.matchedId && x.matchedId === x.commandId);
  const wrong = attempted.filter((x) => !x.matchedId || x.matchedId !== x.commandId);

  const peakMedian = median(list.map((x) => Number(x && x.peak)));

  // A threshold derived from what this user's correct recognitions actually
  // score, rather than one number guessed for everybody. Set a little under the
  // weakest correct sample so a normal utterance is not rejected, and clamped so
  // a bad run can never disable the guard or make it impossible to trigger.
  let confidence = null;
  if (correct.length >= 3) {
    const lowest = Math.min(...correct.map((x) => Number(x.confidence) || 0));
    confidence = Math.max(0.35, Math.min(0.8, Math.round((lowest - 0.08) * 100) / 100));
  }

  // A mishearing is only worth teaching if the words are stable enough to be a
  // phrase: a one-word fragment is exactly what room noise produces, and would
  // make false accepts more likely rather than less.
  const proposed = {};
  const misheard = [];
  for (const x of wrong) {
    const heard = normalizeTranscript(x.heard);
    if (!heard || heard.split(' ').filter(Boolean).length < 2) continue;
    // Never teach a phrase that already means something else — validateAliases
    // enforces this too, but recording the reason here makes the UI honest.
    misheard.push({ commandId: x.commandId, said: x.said, heard });
    (proposed[x.commandId] = proposed[x.commandId] || []).push(heard);
  }
  const { aliases, rejected } = validateAliases(proposed, vocabulary);

  return {
    total: list.length,
    heardCount: attempted.length,
    skipped: list.length - attempted.length,
    accuracy: attempted.length ? Math.round((correct.length / attempted.length) * 100) : 0,
    peakMedian,
    lowMic: attempted.length > 0 && peakMedian < TRAINING_LOW_PEAK,
    confidence,
    aliases,
    misheard,
    rejected
  };
}

// ── Grammar compilation ───────────────────────────────────────────────────
// Produces:
//   phrases     literal strings for the recognizer's closed Choices grammar
//   index       phrase -> { commandId, params }, so a grammar hit needs no parsing
//   dictation   carrier prefixes for the one open slot ('search for …'), which
//               the host appends a DictationGrammar to
//   collisions  phrases claimed by more than one command — first wins, but the
//               list is asserted empty in the tests so an accidental clash from
//               a future command is caught at build time rather than in the field
// ── Contractions in the grammar ──────────────────────────────────────────────
// normalizeTranscript EXPANDS contractions ("whats" -> "what is") so matching
// only ever has to deal with one form. That is right for matching and wrong for
// the grammar: the recognizer listens for literal strings, and the registry is
// written out in full, so "what is the weather" was compiled and "what's the
// weather" was not. Saying the contraction — which is how nearly everyone
// actually says it — was inaudible.
//
// So every compiled phrase also gets its contracted spelling. Only the grammar
// needs them; a recognized contraction normalizes straight back to the expanded
// form and finds the command in the index as usual.
const CONTRACTION_VARIANTS = Object.freeze([
  ['what is', 'whats'], ['what are', 'whatre'], ['how is', 'hows'],
  ['it is', 'its'], ['that is', 'thats'], ['there is', 'theres'],
  ['who is', 'whos'], ['where is', 'wheres'], ['when is', 'whens'],
  ['i am', 'im'], ['i have', 'ive'], ['i will', 'ill'], ['i would', 'id'],
  ['you are', 'youre'], ['we are', 'were'], ['they are', 'theyre'],
  ['do not', 'dont'], ['does not', 'doesnt'], ['did not', 'didnt'],
  ['is not', 'isnt'], ['are not', 'arent'], ['was not', 'wasnt'],
  ['can not', 'cant'], ['cannot', 'cant'], ['will not', 'wont'],
  ['have not', 'havent'], ['let us', 'lets']
]);

// Every contracted spelling of a phrase. Returns [] when none apply, so callers
// can skip the common case cheaply.
function contractedVariants(phrase) {
  const out = [];
  for (const [long, short] of CONTRACTION_VARIANTS) {
    if (!phrase.includes(long)) continue;
    const variant = phrase.split(long).join(short).replace(/\s+/g, ' ').trim();
    if (variant && variant !== phrase && !out.includes(variant)) out.push(variant);
  }
  return out;
}

const MAX_GRAMMAR_PHRASES = 4000;

function compileGrammar(vocabulary) {
  const vocab = vocabulary && vocabulary.apps ? vocabulary : buildVocabulary(vocabulary);
  // User aliases are compiled in exactly like built-in phrases — a phrasing the
  // matcher understands but the grammar has never heard is unusable by voice.
  const aliasMap = (vocab && vocab.aliases) || {};
  const index = new Map();
  const phrases = [];
  const dictation = [];
  const collisions = [];
  let truncated = false;

  function add(phrase, payload) {
    const key = normalizeTranscript(phrase);
    if (!key) return;
    if (index.has(key)) {
      const prev = index.get(key);
      // A bare slot carrier losing to a fully-specified command is the intended
      // outcome, not a clash: "play" alone means resume music, even though
      // "play {app}" also generates a bare "play". Only record a collision when
      // two real, fully-specified phrases want the same words — that is a
      // registry bug, and the tests assert the list stays empty.
      const carrierInvolved = !!(prev.missingSlot || payload.missingSlot);
      if (prev.commandId !== payload.commandId && !carrierInvolved) {
        collisions.push({ phrase: key, kept: prev.commandId, dropped: payload.commandId });
      }
      return;
    }
    if (phrases.length >= MAX_GRAMMAR_PHRASES) { truncated = true; return; }
    index.set(key, payload);
    phrases.push(key);
  }

  for (const cmd of COMMANDS) {
    for (const template of cmd.phrases) {
      const hasSlot = cmd.slot && template.includes(`{${cmd.slot}}`);
      if (!hasSlot) {
        add(template, { commandId: cmd.id, params: {} });
        continue;
      }
      if (cmd.slot === 'query') {
        // Open slot: the carrier goes to the host as a dictation prefix, and the
        // bare carrier is also a phrase so "search for" alone prompts for a query.
        const carrier = normalizeTranscript(template.replace(`{${cmd.slot}}`, ''));
        if (carrier) {
          dictation.push({ commandId: cmd.id, slot: cmd.slot, carrier });
          add(carrier, { commandId: cmd.id, params: {}, missingSlot: cmd.slot });
        }
        continue;
      }
      for (const entry of slotEntries(cmd.slot, vocab)) {
        const names = [entry.spoken, ...entry.aliases];
        for (const name of names) {
          add(template.replace(`{${cmd.slot}}`, name), { commandId: cmd.id, params: slotParams(cmd.slot, entry) });
        }
      }
      // The bare carrier ("launch", "open the widget") so a slotless utterance
      // becomes a clean "Launch what?" prompt instead of an unknown-command error.
      const bare = normalizeTranscript(template.replace(`{${cmd.slot}}`, ''));
      if (bare) add(bare, { commandId: cmd.id, params: {}, missingSlot: cmd.slot });
    }
  }

  // Contracted spellings of everything compiled so far. Added to `phrases` only
  // — NOT to the index — because a recognized contraction normalizes back to the
  // expanded form, which is already indexed. Adding them through `add()` would
  // be a no-op for exactly that reason: the key would collide with itself.
  const spoken = phrases.slice();
  for (const phrase of spoken) {
    for (const variant of contractedVariants(phrase)) {
      if (phrases.length >= MAX_GRAMMAR_PHRASES) { truncated = true; break; }
      // Only compile a variant that ROUND-TRIPS. A contraction the normalizer
      // cannot expand again ("whos this") would be hearable but unresolvable —
      // the recognizer would return a phrase nothing could map to a command.
      // Checking rather than trusting the table means the two can never drift.
      if (normalizeTranscript(variant) !== phrase) continue;
      if (!index.has(variant) && !phrases.includes(variant)) phrases.push(variant);
    }
  }

  // User aliases last, so a built-in phrase always wins a tie: `add` keeps the
  // first claim on a phrase, which means an alias can extend the grammar but can
  // never shadow a command the user did not write.
  for (const [commandId, list] of Object.entries(aliasMap)) {
    if (!Array.isArray(list)) continue;
    for (const phrase of list) add(phrase, { commandId, params: {} });
  }

  return { phrases, index, dictation, collisions, truncated };
}

// ── Matching ──────────────────────────────────────────────────────────────
// Levenshtein, capped: only ever run over single vocabulary names (a few words),
// never over whole transcripts.
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[n];
}

function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return 1 - editDistance(a, b) / longest;
}

// Resolves a spoken fragment to one vocabulary entry. Exact match first, then
// "starts with"/"contains" (people say "siege", not "rainbow six siege"), then a
// similarity floor for near-misses.
const VOCAB_SIMILARITY_FLOOR = 0.72;

// How close a second candidate may be before picking one becomes a coin toss.
const VOCAB_AMBIGUITY_DELTA = 0.08;

function resolveEntry(fragment, entries) {
  const frag = normalizeTranscript(fragment);
  if (!frag || !entries.length) return null;
  let best = null;
  // The best score from a DIFFERENT entry. Tracked because picking the winner
  // of a near-tie silently is how "open discord" can launch Steam: with dozens
  // of installed apps in the slot, two names scoring 0.72 and 0.71 is ordinary,
  // and the loser is discarded without anyone being told there was a contest.
  let runnerUp = null;
  for (const entry of entries) {
    let entryBest = 0;
    for (const name of [entry.spoken, ...entry.aliases]) {
      let score;
      if (name === frag) score = 1;
      else if (name.startsWith(frag + ' ') || name.endsWith(' ' + frag)) score = 0.94;
      else if (name.includes(' ' + frag + ' ')) score = 0.9;
      else if (frag.startsWith(name + ' ') || frag.endsWith(' ' + name)) score = 0.88;
      else score = similarity(frag, name);
      if (score > entryBest) entryBest = score;
    }
    if (!best || entryBest > best.score) {
      if (best) runnerUp = best.score;
      best = { entry, score: entryBest };
    } else if (runnerUp === null || entryBest > runnerUp) {
      runnerUp = entryBest;
    }
  }
  if (!best || best.score < VOCAB_SIMILARITY_FLOOR) return null;
  // An exact match is never ambiguous, whatever else scored close: saying a
  // name correctly must always just work.
  best.ambiguous = best.score < 1 &&
    runnerUp !== null && (best.score - runnerUp) < VOCAB_AMBIGUITY_DELTA;
  best.runnerUp = runnerUp;
  return best;
}

// Token overlap between an utterance and a phrase template's fixed words.
// Deliberately asymmetric: every fixed word of the template must be accounted
// for (missing "crosshair" from "show the crosshair" is not a near miss), while
// extra words in the utterance only cost a little.
function scoreTemplate(tokens, templateTokens) {
  if (!templateTokens.length) return 0;
  let matched = 0;
  let cursor = 0;
  for (const t of templateTokens) {
    let found = -1;
    for (let i = cursor; i < tokens.length; i++) {
      if (tokens[i] === t || similarity(tokens[i], t) >= 0.85) { found = i; break; }
    }
    if (found !== -1) { matched++; cursor = found + 1; }
  }
  const coverage = matched / templateTokens.length;
  const extra = Math.max(0, tokens.length - templateTokens.length);
  return coverage - Math.min(0.25, extra * 0.05);
}

// ── Phonetic matching ────────────────────────────────────────────────────────
// The characteristic failure of this recognizer is not hearing nonsense — it is
// hearing something that SOUNDS like what you said. "Open settings" comes back
// as "open sentences"; "pause the music" as "paws the music". Letter-level
// similarity barely helps there (settings/sentences share few letters in the
// same order) but the two are near-identical to the ear.
//
// So this is a last-resort layer that compares how words SOUND. A compact
// Metaphone-style key: drop vowels after the first, fold the digraphs English
// spells inconsistently, and collapse doubles. Deliberately hand-rolled rather
// than pulled in — it is thirty lines, and a dependency in a shipped paid
// product has to earn itself.
//
// It only ever runs when every other stage has already failed, so it cannot
// change a match that was working; it can only rescue one that was lost.
const PHONETIC_FOLD = Object.freeze([
  [/[^A-Z]/g, ''],
  // Silent leading clusters.
  [/^(KN|GN|PN|AE|WR)/, 'N'],
  [/^X/, 'S'],
  [/^WH/, 'W'],
  // Digraphs, longest first.
  [/PH/g, 'F'],
  [/TCH/g, 'CH'],
  [/SCH/g, 'SK'],
  [/CH/g, 'X'],
  [/SH/g, 'X'],
  [/TH/g, '0'],
  [/CK/g, 'K'],
  [/GH/g, ''],
  [/QU/g, 'KW'],
  [/[CQ]/g, 'K'],
  [/Z/g, 'S'],
  [/V/g, 'F'],
  [/[WY]/g, ''],
  // A trailing S is grammatical noise far more often than it is meaning:
  // "setting" and "settings" must not be treated as different words.
  [/S$/, '']
]);

function phoneticKey(word) {
  let w = String(word || '').toUpperCase();
  const first = w.charAt(0);
  for (const [pattern, replacement] of PHONETIC_FOLD) w = w.replace(pattern, replacement);
  if (!w) return '';
  // Vowels carry almost no discriminating power once a recognizer has already
  // guessed wrong, but the FIRST sound of a word is strongly preserved in
  // mishearings, so it is kept whatever it is.
  const head = /[AEIOU]/.test(first) ? first : '';
  const body = w.replace(/[AEIOU]/g, '');
  // Collapse runs: "SETTINGS" -> "STNGS", not "STTNGS".
  const collapsed = (head + body).replace(/(.)\1+/g, '$1');
  return collapsed;
}

// Do these two words plausibly sound the same? Compared on their phonetic keys
// with the same edit-distance similarity the literal matcher uses.
function soundsLike(a, b) {
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  // A single-character key matching by chance is noise, not evidence.
  if (ka.length < 2 || kb.length < 2) return 0;
  return similarity(ka, kb);
}

// Scores a heard phrase against a template by sound rather than by spelling.
// Mirrors scoreTemplate's in-order walk so the two are comparable.
function phoneticScore(tokens, templateTokens) {
  if (!templateTokens.length) return 0;
  let matched = 0;
  let cursor = 0;
  for (const t of templateTokens) {
    let found = -1;
    for (let i = cursor; i < tokens.length; i++) {
      if (tokens[i] === t || soundsLike(tokens[i], t) >= 0.82) { found = i; break; }
    }
    if (found !== -1) { matched++; cursor = found + 1; }
  }
  const coverage = matched / templateTokens.length;
  const extra = Math.max(0, tokens.length - templateTokens.length);
  return coverage - Math.min(0.25, extra * 0.05);
}

// Higher than MATCH_FLOOR: sounding similar is weaker evidence than being
// similar, so it has to be a better fit before it is worth acting on.
const PHONETIC_FLOOR = 0.86;

const MATCH_FLOOR = 0.7;        // below this an utterance is simply unknown
const AMBIGUITY_DELTA = 0.06;   // two different commands this close = ambiguous

// Matches a transcript against the registry.
//
// Returns one of:
//   { status: 'matched',      commandId, command, params, phrase, score, confirm }
//   { status: 'missing-slot', commandId, command, slot, prompt, score }
//   { status: 'ambiguous',    options: [{ commandId, title, score }] }
//   { status: 'unknown',      transcript }
// ── Pronouns ─────────────────────────────────────────────────────────────────
// "Turn it up" is the single most natural thing to say and the registry cannot
// answer it, because "it" is not a word — it is a reference to whatever you were
// just doing. Without this the phrase is genuinely ambiguous between the music
// and the system volume, and the matcher would either guess or give up.
//
// So the assistant remembers the last SUBJECT it acted on and resolves bare
// pronoun commands against it. Scoped deliberately tightly: only a fixed set of
// phrases, only against a subject the user themselves just established, and only
// when there IS one — with no antecedent, "turn it up" stays unknown rather than
// guessing which volume to change.
//
// A subject is { kind, params }. The params matter: undoing or acting on "it"
// after "open the weather widget" has to reach THAT widget, so the slot travels
// with the subject rather than being re-derived.

// Which subject each command establishes as "it" for the next utterance.
const PRONOUN_TARGETS = Object.freeze({
  music: [
    'spotify.play', 'spotify.pause', 'spotify.next', 'spotify.previous',
    'spotify.volumeUp', 'spotify.volumeDown', 'spotify.setVolume', 'spotify.mute',
    'spotify.full', 'spotify.like', 'spotify.unlike', 'spotify.restart',
    'spotify.queue', 'spotify.whatsPlaying', 'spotify.playPlaylist'
  ],
  system: [
    'system.mute', 'system.unmute', 'system.volumeUp', 'system.volumeDown',
    'system.setVolume'
  ],
  // Established by anything that names a widget, so "turn it off" afterwards
  // means that widget rather than the music.
  widget: ['widget.open', 'widget.enable', 'widget.disable'],
  // An app the user just launched.
  app: ['app.launch']
});

// The bare phrases that need a subject supplied, and what each means per subject.
// A phrase absent for a subject simply does not resolve for it — "skip it" means
// nothing for a widget, and must not be forced into meaning something.
const PRONOUN_PHRASES = Object.freeze({
  'turn it up':   { music: 'spotify.volumeUp',   system: 'system.volumeUp' },
  'turn it down': { music: 'spotify.volumeDown', system: 'system.volumeDown' },
  'turn that up':   { music: 'spotify.volumeUp',   system: 'system.volumeUp' },
  'turn that down': { music: 'spotify.volumeDown', system: 'system.volumeDown' },
  'louder':       { music: 'spotify.volumeUp',   system: 'system.volumeUp' },
  'quieter':      { music: 'spotify.volumeDown', system: 'system.volumeDown' },
  'mute it':      { music: 'spotify.mute',       system: 'system.mute' },
  'mute that':    { music: 'spotify.mute',       system: 'system.mute' },
  'unmute it':    { music: 'spotify.play',       system: 'system.unmute' },
  'stop it':      { music: 'spotify.pause',      system: 'system.mute' },
  'pause it':     { music: 'spotify.pause',      system: 'system.mute' },
  'skip it':      { music: 'spotify.next',       system: 'spotify.next' },
  'play it':      { music: 'spotify.play',       system: 'spotify.play' },
  // Widget-subject phrases. These carry the remembered slot (see resolvePronoun).
  'turn it off':  { widget: 'widget.disable' },
  'turn that off': { widget: 'widget.disable' },
  'disable it':   { widget: 'widget.disable' },
  'turn it on':   { widget: 'widget.enable' },
  'enable it':    { widget: 'widget.enable' },
  'open it':      { widget: 'widget.open' },
  'close it':     { widget: 'widget.disable' }
});

// Commands whose resolved form needs the subject's slot carried into it.
// widget.enable/disable take the 'anyWidget' slot; widget.open takes 'widget'.
const WIDGET_SLOT_FOR = Object.freeze({
  'widget.enable': 'anyWidget',
  'widget.disable': 'anyWidget',
  'widget.open': 'widget'
});

// Which subject a command id establishes. Returns '' for commands that say
// nothing about a subject, so an unrelated command never becomes the antecedent
// — "open settings" must not make "turn it up" mean anything.
function pronounSubjectOf(commandId) {
  if (!commandId) return '';
  for (const subject of Object.keys(PRONOUN_TARGETS)) {
    if (PRONOUN_TARGETS[subject].includes(commandId)) return subject;
  }
  return '';
}

// Resolves a bare pronoun phrase against the last subject the user acted on.
//
//   text     the transcript
//   subject  either a bare kind string ('music'), or { kind, params } when the
//            subject carries a slot that must travel with it
//
// Returns { commandId, params } or null. Null when this is not a pronoun
// phrase, when there is no antecedent, or when the phrase means nothing for
// that subject — refusing beats guessing, because a wrong guess here mutes or
// disables the wrong thing.
function resolvePronoun(text, subject) {
  const t = normalizeTranscript(text);
  if (!t) return null;
  const mapping = PRONOUN_PHRASES[t];
  if (!mapping) return null;

  const kind = typeof subject === 'string' ? subject : (subject && subject.kind) || '';
  const subjectParams = (subject && typeof subject === 'object' && subject.params) || {};
  if (!Object.prototype.hasOwnProperty.call(PRONOUN_TARGETS, kind)) return null;

  const commandId = mapping[kind];
  if (!commandId) return null;

  // Carry the remembered widget across, translating between the two slot names.
  const wantSlot = WIDGET_SLOT_FOR[commandId];
  if (wantSlot) {
    const id = subjectParams.widget || subjectParams.anyWidget;
    const label = subjectParams.widgetLabel || subjectParams.anyWidgetLabel;
    // Nothing to act on: better unknown than acting on the wrong widget.
    if (!id) return null;
    const params = {};
    params[wantSlot] = id;
    params[wantSlot + 'Label'] = label;
    return { commandId, params };
  }
  return { commandId, params: {} };
}

// ── Follow-up suggestions ────────────────────────────────────────────────────
// After an answer, the useful next thing is usually predictable. Offering it as
// a chip turns discovery into something you can see rather than something you
// have to already know — the help list is 90 commands long, and nobody reads it
// twice.
//
// Every target is a real command id, asserted by the tests, so a suggestion can
// never advertise something the assistant cannot do.
const SUGGESTIONS = Object.freeze({
  'weather.now': [{ label: 'Tomorrow', commandId: 'weather.forecast' }],
  'weather.forecast': [{ label: 'Right now', commandId: 'weather.now' }],
  'system.time': [{ label: 'Weather', commandId: 'weather.now' }],
  'system.stats': [
    { label: 'Free up memory', commandId: 'fps.optimize' },
    { label: 'Disk space', commandId: 'system.disk' }
  ],
  'system.battery': [{ label: 'Battery saver', commandId: 'fps.battery' }],
  'system.disk': [{ label: 'Clear temp files', commandId: 'fps.clearTemp' }],
  'spotify.whatsPlaying': [
    { label: 'Like', commandId: 'spotify.like' },
    { label: 'Skip', commandId: 'spotify.next' }
  ],
  'spotify.play': [{ label: "What's this?", commandId: 'spotify.whatsPlaying' }],
  'spotify.next': [{ label: "What's this?", commandId: 'spotify.whatsPlaying' }],
  'timer.start': [{ label: 'How long left?', commandId: 'timer.status' }],
  'timer.status': [{ label: 'Cancel it', commandId: 'timer.cancel' }],
  'fps.optimize': [{ label: 'How is it now?', commandId: 'system.stats' }],
  'fps.nuke': [{ label: 'How is it now?', commandId: 'system.stats' }],
  'crosshair.show': [{ label: 'Change style', commandId: 'crosshair.style' }]
});

// The follow-ups to offer after a command, minus anything whose command needs a
// slot the caller cannot fill.
function suggestionsFor(commandId) {
  const list = SUGGESTIONS[commandId];
  if (!list) return [];
  return list.filter((x) => {
    const target = COMMANDS.find((c) => c.id === x.commandId);
    // A chip dispatches with no params. A command that needs a slot filled
    // would arrive empty and fail, so it can never be offered as one — the
    // "Change style" chip would have run crosshair.style with no style.
    return target && !target.slot;
  }).map((x) => ({ label: x.label, commandId: x.commandId }));
}

function matchIntent(transcript, vocabulary, compiled) {
  const vocab = vocabulary && vocabulary.apps ? vocabulary : buildVocabulary(vocabulary);
  const grammar = compiled || compileGrammar(vocab);
  const text = normalizeTranscript(transcript);
  if (!text) return { status: 'unknown', transcript: '' };

  const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

  // 1. Exact phrase — the path every grammar hit takes.
  const exact = grammar.index.get(text);
  if (exact) {
    const cmd = commandById.get(exact.commandId);
    if (exact.missingSlot) {
      return {
        status: 'missing-slot', commandId: cmd.id, command: cmd,
        slot: exact.missingSlot, prompt: cmd.prompt || 'What exactly?', score: 1
      };
    }
    return {
      status: 'matched', commandId: cmd.id, command: cmd,
      params: { ...exact.params }, phrase: text, score: 1, confirm: !!cmd.confirm
    };
  }

  // 2. Slot-carrier prefix — "launch <something we didn't compile>", including
  //    the open dictation slot. Handles apps added since the grammar was built
  //    and anything the typed fallback throws at us.
  const tokens = text.split(' ');
  let bestSlot = null;
  for (const cmd of COMMANDS) {
    if (!cmd.slot) continue;
    for (const template of cmd.phrases) {
      const marker = `{${cmd.slot}}`;
      if (!template.includes(marker)) continue;
      const [rawBefore, rawAfter] = template.split(marker);
      const before = normalizeTranscript(rawBefore);
      const after = normalizeTranscript(rawAfter);
      if (before && !text.startsWith(before + ' ')) continue;
      if (!before && after) continue; // slot-first templates aren't used
      let rest = before ? text.slice(before.length + 1) : text;
      if (after) {
        if (rest.endsWith(' ' + after)) {
          rest = rest.slice(0, -(after.length + 1));
        } else if (cmd.slot !== 'minutes') {
          continue;
        }
        // Duration templates carry no trailing unit any more — the unit lives in
        // the slot value. This branch stays as a guard: if a template ever
        // reintroduces one, the tail is kept whole and parseDuration reads the
        // unit out of it rather than the phrase silently failing to match.
      }
      rest = rest.trim();
      if (!rest) continue;

      if (cmd.slot === 'query') {
        const cand = { cmd, params: { query: rest }, score: 0.8 };
        if (!bestSlot || cand.score > bestSlot.score) bestSlot = cand;
        continue;
      }
      if (cmd.slot === 'volume' || cmd.slot === 'minutes') {
        if (cmd.slot === 'minutes') {
          // parseDuration understands "half an hour" and "an hour and a half";
          // wordsToNumber is the fallback for a bare "ten".
          const mins = parseDuration(rest);
          const n = mins !== null ? mins : wordsToNumber(rest.replace(/\bminutes?\b/g, '').trim());
          if (n === null) continue;
          const cand = { cmd, params: { minutes: Math.max(1, Math.min(1440, n)) }, score: 0.95 };
          if (!bestSlot || cand.score > bestSlot.score) bestSlot = cand;
          continue;
        }
        const n = wordsToNumber(rest.replace(/\bpercent\b/g, '').trim());
        if (n === null) continue;
        const cand = { cmd, params: { volume: Math.min(100, n) }, score: 0.95 };
        if (!bestSlot || cand.score > bestSlot.score) bestSlot = cand;
        continue;
      }
      const hit = resolveEntry(rest, slotEntries(cmd.slot, vocab));
      if (!hit) continue;
      // A longer fixed prefix is stronger evidence than a bare one-word verb.
      const specificity = before ? Math.min(0.1, before.split(' ').length * 0.03) : 0;
      const cand = {
        cmd, params: slotParams(cmd.slot, hit.entry),
        score: 0.82 + hit.score * 0.12 + specificity,
        // A near-tie between two vocabulary entries is confirmed rather than
        // guessed. Launching the wrong program is not a small mistake, and the
        // codebase's rule everywhere else is that refusing beats guessing.
        ambiguous: !!hit.ambiguous
      };
      if (!bestSlot || cand.score > bestSlot.score) bestSlot = cand;
    }
  }

  // 3. Scored token match against every fixed (slotless) template.
  const scored = [];
  for (const cmd of COMMANDS) {
    let best = 0;
    for (const template of cmd.phrases) {
      if (cmd.slot && template.includes(`{${cmd.slot}}`)) continue;
      const tt = normalizeTranscript(template).split(' ').filter(Boolean);
      if (!tt.length) continue;
      const s = scoreTemplate(tokens, tt);
      if (s > best) best = s;
    }
    if (best >= MATCH_FLOOR) scored.push({ cmd, score: best });
  }
  scored.sort((a, b) => b.score - a.score);

  const slotScore = bestSlot ? bestSlot.score : 0;
  const fixedScore = scored.length ? scored[0].score : 0;

  if (slotScore >= fixedScore && slotScore > 0) {
    return {
      status: 'matched', commandId: bestSlot.cmd.id, command: bestSlot.cmd,
      params: { ...bestSlot.params }, phrase: text, score: slotScore,
      // Confirm when the registry says so OR when the NAME was a close call.
      // The recognizer can be perfectly confident about the words and still
      // leave the matcher choosing between two similar app names.
      confirm: !!bestSlot.cmd.confirm || !!bestSlot.ambiguous,
      ambiguousSlot: !!bestSlot.ambiguous
    };
  }

  // Nothing matched on spelling. Before giving up, try on SOUND — this is where
  // "open sentences" finally reaches app.openSettings.
  if (!scored.length) {
    const heard = [];
    for (const cmd of COMMANDS) {
      let best = 0;
      for (const template of cmd.phrases) {
        if (cmd.slot && template.includes(`{${cmd.slot}}`)) continue;
        const tt = normalizeTranscript(template).split(' ').filter(Boolean);
        if (!tt.length) continue;
        const sc = phoneticScore(tokens, tt);
        if (sc > best) best = sc;
      }
      if (best >= PHONETIC_FLOOR) heard.push({ cmd, score: best });
    }
    heard.sort((a, b) => b.score - a.score);
    // Two commands that sound equally alike is not a rescue, it is a coin toss.
    if (heard.length && (heard.length === 1 || heard[0].score - heard[1].score >= AMBIGUITY_DELTA)) {
      const w = heard[0];
      return {
        status: 'matched', commandId: w.cmd.id, command: w.cmd,
        params: {}, phrase: text,
        // Reported below the literal floor on purpose: this is a sound-alike, so
        // anything risky reached this way still has to be confirmed.
        score: Math.min(0.85, w.score), viaPhonetic: true, confirm: !!w.cmd.confirm
      };
    }
    return { status: 'unknown', transcript: text };
  }

  if (scored.length > 1 && scored[0].score - scored[1].score < AMBIGUITY_DELTA) {
    return {
      status: 'ambiguous',
      transcript: text,
      options: scored.slice(0, 3).map((s) => ({ commandId: s.cmd.id, title: s.cmd.title, score: s.score }))
    };
  }

  const winner = scored[0];
  return {
    status: 'matched', commandId: winner.cmd.id, command: winner.cmd,
    params: {}, phrase: text, score: winner.score, confirm: !!winner.cmd.confirm
  };
}

// ── Confidence gating ─────────────────────────────────────────────────────
// A closed grammar is always trying to fit what it hears to SOME phrase, so
// ambient noise does not come back as nothing — it comes back as the nearest
// phrase. Measured here with an idle microphone, room noise produced
// `RESULT 0.704 silence`, which is a real command ("silence" mutes the system).
//
// The fix that holds up is length-aware: a one-word utterance carries far less
// acoustic evidence than a four-word one, so it has to clear a much higher bar.
// Longer phrases are self-verifying — noise essentially never lines up with
// "set a timer for ten minutes" — and keep the base threshold, which is what
// the user's sensitivity setting actually tunes.
// Short utterances get a higher bar than long ones, because a closed grammar
// rounds noise to its nearest phrase and short phrases are what noise fits.
//
// Relaxed from 0.82/0.72. Those numbers predate the two defences that do this
// job far better: a result with no audio level behind it is now discarded
// outright, and anything destructive is confirmed rather than run. What the old
// floors were left doing was rejecting ordinary short commands — "next track"
// needed 0.72, which a built-in microphone array often does not reach, so it
// was silently dropped rather than misheard.
const SHORT_PHRASE_FLOORS = Object.freeze({ 1: 0.74, 2: 0.64 });

function confidenceFloor(text, baseThreshold) {
  const base = Number.isFinite(Number(baseThreshold)) ? Number(baseThreshold) : DEFAULT_SETTINGS.confidence;
  const words = normalizeTranscript(text).split(' ').filter(Boolean).length;
  // Nothing was said. Infinity rather than 1, because a perfect 1.0 confidence
  // would otherwise clear a floor of exactly 1.
  if (!words) return Infinity;
  return Math.max(base, SHORT_PHRASE_FLOORS[words] || 0);
}

// True when a recognizer result is trustworthy enough to act on.
function meetsConfidence(text, confidence, baseThreshold) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return false;
  return c >= confidenceFloor(text, baseThreshold);
}

// ── Risk, and the false-accept problem ───────────────────────────────────────
// A closed grammar ALWAYS returns its nearest phrase. It cannot answer "that
// wasn't a command" — only "of the 700 things I know, this was closest". So room
// noise does not get rejected, it gets rounded to whatever it happens to sit
// nearest, and during testing that was enough to make the assistant open the
// Settings window on its own with nobody speaking to it.
//
// confidenceFloor already raises the bar for short utterances. That is not
// enough on its own, because the damage a false accept does has nothing to do
// with how long the phrase was: mishearing "pause" costs a keypress, while
// mishearing "close background apps" closes the user's applications.
//
// So risk is classified per command, and a risky command that arrives with
// anything less than near-certainty is CONFIRMED rather than run. The user
// keeps one keystroke of friction on the handful of commands that deserve it,
// and none at all on the ninety that don't.
const RISKY_COMMANDS = Object.freeze([
  // Closes or changes other programs.
  'fps.nuke', 'fps.optimize', 'app.launch', 'macro.play', 'routine.run',
  // Destroys something the user cannot get back.
  'clipboard.clear', 'fps.clearTemp', 'fps.clearStandby',
  // Changes machine-wide configuration.
  'fps.revert', 'fps.ultimate', 'fps.high', 'fps.balanced', 'fps.battery',
  'fps.lowLatency', 'fps.cpuPriority', 'fps.hags', 'fps.flushDns',
  'app.autostartOn', 'app.autostartOff',
  // Takes over input, or turns off something the user may be relying on.
  'autoClicker.start', 'widget.disable', 'bluetooth.off', 'bluetooth.disconnect',
  'search.reindex'
]);

// How certain a risky command has to be before it runs without asking. Well
// above the ordinary floor: this is the bar for "act on this without checking".
const RISK_CONFIDENCE = 0.92;

// Utterances that arrived without the user deliberately activating — i.e. the
// wake word was listening the whole time — carry a penalty on top, because
// nobody was necessarily talking to the assistant at all.
const PASSIVE_PENALTY = 0.06;

function isRiskyCommand(command) {
  if (!command) return false;
  // An explicit `confirm: true` in the registry already means "ask first".
  if (command.confirm) return true;
  return RISKY_COMMANDS.includes(command.id);
}

// Should this match be confirmed rather than executed?
//
//   command     the matched registry entry
//   confidence  the recognizer's score (1 for typed input — a typed command was
//               unambiguously intended, so it is never second-guessed)
//   opts.viaWake     the utterance came from the always-listening wake path
//   opts.confirmRisky the user's setting; false disables the whole guard
function needsRiskConfirm(command, confidence, opts) {
  const o = opts || {};
  if (o.confirmRisky === false) return false;
  if (!isRiskyCommand(command)) return false;
  // A registry `confirm: true` always asks, at any confidence — that is what
  // the flag has always meant and this must not weaken it.
  if (command && command.confirm) return true;
  const c = Number(confidence);
  // No score at all is not evidence of certainty. Typed input passes 1
  // explicitly; anything that cannot say how sure it is gets confirmed.
  if (!Number.isFinite(c)) return true;
  const bar = RISK_CONFIDENCE + (o.viaWake ? PASSIVE_PENALTY : 0);
  return c < bar;
}

// ── Undo ─────────────────────────────────────────────────────────────────────
// The counterpart to the guard above: a false accept that does get through
// should be one sentence away from being put back. Only commands with a true
// inverse are listed — "undo" must never be a second, differently-wrong action.
// Anything absent from this map answers honestly that it cannot be undone.
const INVERSE_COMMANDS = Object.freeze({
  'spotify.play': 'spotify.pause',
  'spotify.pause': 'spotify.play',
  'spotify.next': 'spotify.previous',
  'spotify.previous': 'spotify.next',
  'spotify.volumeUp': 'spotify.volumeDown',
  'spotify.volumeDown': 'spotify.volumeUp',
  'spotify.mute': 'spotify.play',
  'spotify.like': 'spotify.unlike',
  'spotify.unlike': 'spotify.like',
  'spotify.sleepTimer': 'spotify.sleepCancel',
  'system.mute': 'system.unmute',
  'system.unmute': 'system.mute',
  'system.volumeUp': 'system.volumeDown',
  'system.volumeDown': 'system.volumeUp',
  'mic.mute': 'mic.unmute',
  'mic.unmute': 'mic.mute',
  'bluetooth.on': 'bluetooth.off',
  'bluetooth.off': 'bluetooth.on',
  'crosshair.show': 'crosshair.hide',
  'crosshair.hide': 'crosshair.show',
  'gameMode.on': 'gameMode.off',
  'gameMode.off': 'gameMode.on',
  'autoClicker.start': 'autoClicker.stop',
  'autoClicker.stop': 'autoClicker.start',
  'widget.enable': 'widget.disable',
  'widget.disable': 'widget.enable',
  'timer.pause': 'timer.resume',
  'timer.resume': 'timer.pause',
  'timer.start': 'timer.cancel',
  'app.autostartOn': 'app.autostartOff',
  'app.autostartOff': 'app.autostartOn',
  // Every fps.* power tweak is undone by the same restore command.
  'fps.ultimate': 'fps.revert',
  'fps.high': 'fps.revert',
  'fps.balanced': 'fps.revert',
  'fps.battery': 'fps.revert',
  'fps.lowLatency': 'fps.revert',
  'fps.cpuPriority': 'fps.revert',
  'fps.hags': 'fps.revert',
  'fps.optimize': 'fps.revert',
  'fps.nuke': 'fps.revert'
});

// The inverse of a command, with the params it should carry.
// Returns null when the command cannot be undone.
function inverseOf(commandId, params) {
  const target = INVERSE_COMMANDS[commandId];
  if (!target) return null;
  const p = params || {};
  // Slot commands hand their slot straight to the inverse: undoing
  // "enable the crosshair widget" has to disable THAT widget.
  if (commandId === 'widget.enable' || commandId === 'widget.disable') {
    if (!p.anyWidget) return null;
    return { commandId: target, params: { anyWidget: p.anyWidget, anyWidgetLabel: p.anyWidgetLabel } };
  }
  // A volume set has no inverse without knowing the previous level, and
  // guessing one is worse than admitting it.
  return { commandId: target, params: {} };
}

// ── Command chaining ──────────────────────────────────────────────────────
// "pause the music and optimize my pc" is two commands in one breath. The
// connectors below are the only split points, and they are only treated as
// connectors when BOTH sides still parse as something — otherwise "rock and
// roll" or a playlist called "peace and quiet" would be torn in half.
const CHAIN_CONNECTORS = Object.freeze(['and then', 'then', 'and also', 'and', 'also', 'plus']);
const MAX_CHAIN = 3;

// Splits text into candidate command segments, longest connector first. Returns
// a single-element array when nothing splits cleanly — the common case.
function splitChain(text) {
  const base = normalizeTranscript(text);
  if (!base) return [];
  const parts = [base];
  // Repeatedly split the LAST segment, so "a and b then c" yields three.
  for (let guard = 0; guard < MAX_CHAIN; guard++) {
    const tail = parts[parts.length - 1];
    let didSplit = false;
    for (const conn of CHAIN_CONNECTORS) {
      const needle = ' ' + conn + ' ';
      const at = tail.indexOf(needle);
      if (at <= 0) continue;
      const left = tail.slice(0, at).trim();
      const right = tail.slice(at + needle.length).trim();
      if (!left || !right) continue;
      parts[parts.length - 1] = left;
      parts.push(right);
      didSplit = true;
      break;
    }
    if (!didSplit) break;
  }
  return parts.slice(0, MAX_CHAIN);
}

// Matches a whole utterance, chained or not.
//
// A chain is only accepted when EVERY segment matches on its own. If any segment
// is unknown the split was probably wrong (a connector inside a real phrase), so
// it falls back to matching the original text in one piece.
function matchChain(transcript, vocabulary, compiled) {
  const vocab = vocabulary && vocabulary.apps ? vocabulary : buildVocabulary(vocabulary);
  const grammar = compiled || compileGrammar(vocab);
  const whole = matchIntent(transcript, vocab, grammar);

  const segments = splitChain(transcript);
  if (segments.length < 2) return { chained: false, steps: [whole], whole };

  // An exact whole-utterance hit always wins: it means the recogniser matched a
  // real phrase, connector words and all.
  if (whole.status === 'matched' && whole.score >= 1) return { chained: false, steps: [whole], whole };

  const steps = segments.map((seg) => matchIntent(seg, vocab, grammar));
  if (steps.every((m) => m.status === 'matched')) return { chained: true, steps, whole };
  return { chained: false, steps: [whole], whole };
}

// Classifies a spoken answer while a confirmation is pending.
// Returns 'yes' | 'no' | null (not an answer at all).
function matchConfirmation(transcript) {
  const text = normalizeTranscript(transcript);
  if (!text) return null;
  if (CONFIRM_YES.includes(text)) return 'yes';
  if (CONFIRM_NO.includes(text)) return 'no';
  return null;
}

// Resolves a command's `reply` (string or function) to display/speech text.
function replyFor(command, params) {
  if (!command) return '';
  const r = command.reply;
  if (typeof r === 'function') {
    try { return String(r(params || {})); } catch (e) { return command.title; }
  }
  return String(r || command.title || '');
}

// Picks a representative value to show in the help list. The first entry of a
// numeric range is a terrible example — it produced "set the volume to zero" and
// the ungrammatical "set a timer for one minutes".
function sampleEntry(slot, entries) {
  const preferred = slot === 'volume' ? 50 : slot === 'minutes' ? 10 : null;
  if (preferred !== null) {
    const hit = entries.find((e) => e.value === preferred);
    if (hit) return hit;
  }
  return entries[0];
}

// The help list the overlay renders for "what can I say" — grouped by category,
// one representative phrase each, generated so it can never drift from the
// registry.
function helpEntries(vocabulary) {
  const vocab = vocabulary && vocabulary.apps ? vocabulary : buildVocabulary(vocabulary);
  const byCategory = new Map();
  for (const cmd of COMMANDS) {
    if (cmd.id === 'assistant.cancel') continue;
    let example = cmd.phrases[0];
    if (cmd.slot && example.includes(`{${cmd.slot}}`)) {
      const entries = slotEntries(cmd.slot, vocab);
      const sample = entries.length ? sampleEntry(cmd.slot, entries).spoken
        : (cmd.slot === 'query' ? 'my clips' : 'something');
      example = example.replace(`{${cmd.slot}}`, sample);
    }
    if (!byCategory.has(cmd.category)) byCategory.set(cmd.category, []);
    byCategory.get(cmd.category).push({ id: cmd.id, title: cmd.title, example });
  }
  return Array.from(byCategory.entries()).map(([category, items]) => ({ category, items }));
}

module.exports = {
  VOICE_STATES,
  VOICE_EVENTS,
  nextState,
  isMicOpenState,
  DEFAULT_SETTINGS,
  ACTIVATION_MODES,
  PANEL_TRANSITIONS,
  VIZ_STYLES,
  EXIT_MS,
  parseDuration,
  DURATION_IDIOMS,
  phoneticKey,
  soundsLike,
  VOCAB_AMBIGUITY_DELTA,
  contractedVariants,
  CONTRACTION_VARIANTS,
  phoneticScore,
  PHONETIC_FLOOR,
  RISKY_COMMANDS,
  RISK_CONFIDENCE,
  isRiskyCommand,
  needsRiskConfirm,
  INVERSE_COMMANDS,
  inverseOf,
  INNER_FILLERS,
  resolvePronoun,
  pronounSubjectOf,
  PRONOUN_TARGETS,
  PRONOUN_PHRASES,
  SUGGESTIONS,
  suggestionsFor,
  normalizeAlias,
  validateAliases,
  TRAINING_PROMPTS,
  TRAINING_LOW_PEAK,
  analyzeTraining,
  MAX_ALIASES,
  normalizeSettings,
  COMMANDS,
  CONFIRM_YES,
  CONFIRM_NO,
  WAKE_PHRASES,
  CROSSHAIR_STYLES,
  COLOURS,
  stripWakePhrase,
  splitChain,
  matchChain,
  CHAIN_CONNECTORS,
  MAX_CHAIN,
  VOLUME_STEPS,
  TIMER_MINUTES,
  numberToWords,
  wordsToNumber,
  normalizeTranscript,
  speakableName,
  buildVocabulary,
  EMPTY_VOCABULARY,
  compileGrammar,
  matchIntent,
  confidenceFloor,
  meetsConfidence,
  matchConfirmation,
  replyFor,
  helpEntries,
  MAX_GRAMMAR_PHRASES
};
