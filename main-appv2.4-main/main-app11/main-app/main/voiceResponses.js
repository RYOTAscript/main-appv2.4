'use strict';

// ── The voice assistant's answering layer ────────────────────────────────────
//
// Every command used to answer with one fixed string — "Playing", "Quieter",
// "Checking". Said twice in a row that reads as a machine acknowledging a
// keystroke, which is the opposite of what an assistant should feel like.
//
// This module turns a command result into something a person would actually
// say, and separates two things the old single string conflated:
//
//   speech    what gets spoken aloud  — a sentence, unhurried, with the noun in
//   headline  what the overlay shows big — a value, not a sentence
//   detail    the supporting line under it
//   meta      short chips beside it
//
// "What's the weather" should SAY "It's 21 degrees and clear in London" while
// SHOWING a large 21° with "Clear · London" beneath. Those are different jobs
// and a single string can only do one of them well.
//
// Pure and dependency-free, like main/voiceCommands.js, so the whole thing is
// unit-testable without Electron.
//
// ── Variation without randomness ─────────────────────────────────────────────
// Repeating the same words back is what makes an assistant feel canned, but
// Math.random() is untestable and can repeat anyway. Instead each phrase pool
// ROTATES: consecutive uses of the same pool walk through every variant before
// any repeats. That is deterministic (so tests can assert exact strings), it
// guarantees no immediate repetition, and it uses the whole pool rather than
// clustering the way random picks do.

// ── Phrase pools ─────────────────────────────────────────────────────────────
// `%s` is substituted with the command's noun. Pools are ordered so the plainest
// variant comes first: the first thing a user ever hears is the least chatty.

const FAMILIES = Object.freeze({
  resume:   ['Playing', 'Back on', 'Rolling again'],
  pause:    ['Paused', 'Holding there', 'On hold'],
  next:     ['Skipping', 'Next one', 'Moving on'],
  previous: ['Going back', 'Previous track', 'Back one'],
  restart:  ['From the top', 'Starting it over', 'Back to the start'],

  louder:   ['Louder', 'Turning it up', 'Up a bit'],
  quieter:  ['Quieter', 'Turning it down', 'Down a bit'],
  muted:    ['Muted', 'Sound off', 'Silenced'],
  unmuted:  ['Sound back', 'Unmuted', 'Audio on'],

  on:       ['%s on', '%s enabled', 'Turned %s on'],
  off:      ['%s off', '%s disabled', 'Turned %s off'],
  opening:  ['Opening %s', '%s coming up', 'Here is %s'],
  starting: ['Starting %s', 'Launching %s', '%s on the way'],
  stopping: ['Stopped %s', '%s stopped', 'Done with %s'],
  applied:  ['%s applied', 'Done — %s', '%s is set'],

  done:     ['Done', 'Got it', 'All set'],
  ack:      ['Okay', 'Sure', 'Right'],
});

// ── Per-command wiring ───────────────────────────────────────────────────────
// `family` picks the pool, `noun` fills its %s. A command absent from this table
// falls back to its registry `reply`/`title`, so nothing can go unanswered — the
// contract test asserts every registry command resolves to a non-empty speech.

const COMMANDS = Object.freeze({
  // ── Spotify ──
  'spotify.play':        { family: 'resume' },
  'spotify.pause':       { family: 'pause' },
  'spotify.next':        { family: 'next' },
  'spotify.previous':    { family: 'previous' },
  'spotify.restart':     { family: 'restart' },
  'spotify.volumeUp':    { family: 'louder' },
  'spotify.volumeDown':  { family: 'quieter' },
  'spotify.mute':        { family: 'muted' },
  'spotify.full':        { speech: ['Full volume', 'All the way up'] },
  'spotify.like':        { speech: ['Liked', 'Added to your likes', 'Saved that one'] },
  'spotify.unlike':      { speech: ['Removed', 'Taken off your likes'] },
  'spotify.queue':       { speech: ['Queued', 'Added to the queue', 'Lined it up'] },
  'spotify.sleepCancel': { speech: ['Sleep timer off', 'Cancelled the sleep timer'] },

  // ── System audio ──
  'system.mute':    { family: 'muted' },
  'system.unmute':  { family: 'unmuted' },
  'system.volumeUp':   { family: 'louder' },
  'system.volumeDown': { family: 'quieter' },
  'mic.mute':   { speech: ['Mic muted', 'Microphone off', 'You are muted'] },
  'mic.unmute': { speech: ['Mic live', 'Microphone on', 'You are live'] },
  'mic.toggle': { speech: ['Mic toggled', 'Flipped the mic'] },

  'bluetooth.on':  { family: 'on',  noun: 'Bluetooth' },
  'bluetooth.off': { family: 'off', noun: 'Bluetooth' },

  // ── Launcher ──
  'app.openWidgetLibrary': { family: 'opening', noun: 'the widget library' },
  'app.openSettings':      { family: 'opening', noun: 'settings' },
  'app.openLogs':          { family: 'opening', noun: 'the logs' },
  'app.account':           { family: 'opening', noun: 'your account' },
  'app.focus':             { speech: ['Here', 'Front and centre', 'Up front'] },
  'app.minimize':          { speech: ['Out of the way', 'Minimised', 'Tucked away'] },
  'app.checkUpdates':      { speech: ['Checking for updates', 'Looking for an update'] },
  'app.autostartOn':       { speech: ['I will start with Windows', 'Autostart on'] },
  'app.autostartOff':      { speech: ['I will not start with Windows', 'Autostart off'] },

  // ── Performance ──
  'fps.optimize':     { speech: ['Optimising', 'Freeing things up', 'Cleaning up for you'] },
  'fps.nuke':         { speech: ['Closing everything I safely can', 'Full sweep running'] },
  'fps.battery':      { family: 'applied', noun: 'Battery saver' },
  'fps.revert':       { speech: ['Put back', 'Reverted', 'Back to normal'] },
  'fps.ultimate':     { family: 'applied', noun: 'Ultimate performance' },
  'fps.high':         { family: 'applied', noun: 'High performance' },
  'fps.balanced':     { family: 'applied', noun: 'Balanced power' },
  'fps.clearStandby': { speech: ['Standby memory cleared', 'Freed the standby list'] },
  'fps.clearTemp':    { speech: ['Temp files cleared', 'Cleaned out the temp folder'] },
  'fps.flushDns':     { speech: ['DNS flushed', 'Cleared the DNS cache'] },
  'fps.lowLatency':   { family: 'applied', noun: 'Low latency mode' },
  'fps.cpuPriority':  { family: 'applied', noun: 'CPU priority' },
  'fps.hags':         { family: 'applied', noun: 'Hardware scheduling' },

  // ── Gaming ──
  'crosshair.show':   { family: 'on',  noun: 'Crosshair' },
  'crosshair.hide':   { family: 'off', noun: 'Crosshair' },
  'crosshair.toggle': { speech: ['Crosshair toggled', 'Flipped the crosshair'] },
  'gameMode.on':      { family: 'on',  noun: 'Game mode' },
  'gameMode.off':     { family: 'off', noun: 'Game mode' },
  'autoClicker.start':{ speech: ['Auto clicker running', 'Clicking now'] },
  'autoClicker.stop': { speech: ['Auto clicker stopped', 'Stopped clicking'] },

  // ── Productivity ──
  'timer.cancel':  { speech: ['Timer cancelled', 'Cancelled it'] },
  'timer.pause':   { speech: ['Timer paused', 'Paused the countdown'] },
  'timer.resume':  { speech: ['Timer running', 'Counting again'] },
  'timer.restart': { speech: ['Timer restarted', 'Back to the start'] },
  'clipboard.open':{ family: 'opening', noun: 'your clipboard' },
  'clipboard.recopy': { speech: ['Copied again', 'Back on your clipboard'] },
  'clipboard.clear':  { speech: ['Clipboard cleared', 'Wiped your clipboard'] },
  'notes.new':     { speech: ['New note', 'Blank note ready'] },
  'macro.stop':    { speech: ['Macro stopped', 'Stopped it'] },
  'search.reindex':{ speech: ['Reindexing', 'Rebuilding the file index'] },

  // ── Assistant ──
  'assistant.quiet':  { speech: ['Quiet', 'Saying nothing'] },
  'assistant.cancel': { family: 'ack' },
});

// ── Failure phrasing ─────────────────────────────────────────────────────────
// A failure should say what went wrong AND what to do about it. "Spotify isn't
// connected" leaves the user stuck; adding the next step is the whole
// difference between an error and an assistant.

const FAILURE_HINTS = Object.freeze([
  [/spotify (is)?n.?t connected|no active spotify/i, 'Connect it in the Spotify widget and try again'],
  [/widget is off|widget is disabled/i,              'Turn it on in the widget library'],
  [/is ?n.?t available/i,                            'That widget is not enabled on this machine'],
  [/could ?n.?t read|could ?n.?t get/i,              'Give it a moment and ask again'],
  [/do ?n.?t know that routine/i,                    'Say "what can I say" to hear your routines'],
]);

function failureHint(message) {
  const text = String(message || '');
  for (const [pattern, hint] of FAILURE_HINTS) {
    if (pattern.test(text)) return hint;
  }
  return '';
}

// ── Small helpers ────────────────────────────────────────────────────────────

function titleOf(command) {
  return command && command.title ? String(command.title) : '';
}

// The registry's own reply, used when a command has no entry above.
function registryReply(command, params) {
  if (!command) return '';
  const r = command.reply;
  if (typeof r === 'function') {
    try { return String(r(params || {})); } catch (e) { return titleOf(command); }
  }
  return String(r || titleOf(command) || '');
}

function applyNoun(phrase, noun) {
  if (!phrase.includes('%s')) return phrase;
  const n = noun == null ? '' : String(noun);
  const out = phrase.replace(/%s/g, n).replace(/\s+/g, ' ').trim();
  // "%s on" with an empty noun would leave a dangling " on".
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}

// Spoken numbers read better than digits in a few places, but only where the
// value is genuinely small — "twelve percent" beats "12 percent" aloud, while
// "sixty-seven percent" does not beat "67 percent".
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function spokenCount(n) {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i <= 10 ? SMALL[i] : String(n);
}

function plural(n, word) {
  return `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
}

// A duration in minutes as a person would say it.
function spokenDuration(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  if (m === 0) return 'no time';
  if (m < 60) return plural(m, 'minute');
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  if (!mins) return plural(hours, 'hour');
  if (mins === 30) return `${hours === 1 ? 'an hour' : plural(hours, 'hour')} and a half`;
  return `${plural(hours, 'hour')} ${plural(mins, 'minute')}`;
}

// A clock time as a person would say it, not as a clock shows it.
// `hour24` follows the user's locale. Reading "nine oh five in the evening" to
// someone whose clock says 21:05 is wrong in the same way a Fahrenheit answer
// would be — the words have to match the convention they actually use.
function spokenTime(date, hour24) {
  const d = date instanceof Date ? date : new Date();
  const h24 = d.getHours();
  const mins = d.getMinutes();
  if (hour24) {
    const hh = String(h24);
    if (mins === 0) return `${hh} hundred hours`;
    return `${hh} ${mins < 10 ? 'oh ' + mins : mins}`;
  }
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const part = h24 < 12 ? 'in the morning' : h24 < 18 ? 'in the afternoon' : 'in the evening';
  if (mins === 0) return `${h12} o'clock ${part}`;
  const m = mins < 10 ? `oh ${mins}` : String(mins);
  return `${h12} ${m} ${part}`;
}

// Does this machine's locale show a 12-hour clock? Derived rather than
// configured: the app already formats every other time with toLocaleTimeString,
// so the spoken form should follow the same convention automatically.
function localeUses24Hour(sample) {
  try {
    const s = typeof sample === 'string'
      ? sample
      : new Date(2020, 0, 1, 13, 0).toLocaleTimeString();
    return !/[ap]\.?m\.?/i.test(s);
  } catch (e) {
    return false;
  }
}

function greeting(date) {
  const h = (date instanceof Date ? date : new Date()).getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// ── The responder ────────────────────────────────────────────────────────────
// createResponder() owns the rotation counters. Tests make a fresh one per case
// so every assertion is exact; the app makes one for the whole session so the
// user hears the pool cycle rather than the same phrase every time.

// ── Preparing text for a synthesizer ─────────────────────────────────────────
// A speech synthesizer reads characters, not meaning. "35°C" comes out as
// "thirty five see", "CPU" as "kup", "6 GB" as "six gee bee", and "C:" as
// "see colon". None of that is the voice's fault — it is being handed text that
// was written to be LOOKED at.
//
// The answer layer already separates `speech` from `headline` precisely so the
// spoken form can be written for the ear. This is the safety net for anything
// that still slips through, and for executor messages written before that
// split existed.
const SPEECH_FIXUPS = Object.freeze([
  // Units and symbols.
  [/(\d+)\s*°\s*C\b/gi, '$1 degrees'],
  [/(\d+)\s*°\s*F\b/gi, '$1 degrees'],
  [/(\d+)\s*°/g, '$1 degrees'],
  [/(\d+)\s*%/g, '$1 percent'],
  [/\b(\d+(?:\.\d+)?)\s*GB\b/gi, '$1 gigabytes'],
  [/\b(\d+(?:\.\d+)?)\s*MB\b/gi, '$1 megabytes'],
  [/\b(\d+(?:\.\d+)?)\s*TB\b/gi, '$1 terabytes'],
  // Initialisms the voice would otherwise try to pronounce as words.
  [/\bCPU\b/g, 'C P U'],
  [/\bRAM\b/g, 'ram'],
  [/\bGPU\b/g, 'G P U'],
  [/\bDNS\b/g, 'D N S'],
  [/\bFPS\b/g, 'F P S'],
  [/\bPC\b/g, 'P C'],
  [/\bOK\b/g, 'okay'],
  // A drive letter, not a note followed by a colon.
  [/\bC:\B/g, 'drive C'],
  // Separators that are punctuation to the eye and noise to the ear.
  [/\s*·\s*/g, ', '],
  [/\s*—\s*/g, ', '],
  [/\s*--\s*/g, ', ']
]);

// Rewrites a reply into something worth listening to. Idempotent, so passing an
// already-clean sentence through changes nothing.
function forSpeech(text) {
  let out = String(text == null ? '' : text);
  for (const [pattern, replacement] of SPEECH_FIXUPS) out = out.replace(pattern, replacement);
  // Collapse whatever the substitutions left behind.
  return out.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

function createResponder() {
  const cursors = new Map();

  // Walks a pool. Returns '' for an empty pool so callers can fall through.
  function rotate(key, pool) {
    if (!Array.isArray(pool) || !pool.length) return '';
    const next = cursors.has(key) ? (cursors.get(key) + 1) % pool.length : 0;
    cursors.set(key, next);
    return pool[next];
  }

  // The main entry point.
  //
  //   command  the registry entry (may be null for meta outcomes)
  //   params   resolved slot values
  //   result   the executor's { ok, message, answer } — `answer` is the rich
  //            payload an executor may return for informational commands
  //
  // Always returns a full answer object; `headline` may be empty, in which case
  // the overlay just shows the speech line.
  function respond(command, params, result) {
    const p = params || {};
    const res = result || {};
    const id = command && command.id ? command.id : '';

    // 1. An executor that returned rich data owns the answer outright — it is
    //    the only layer that has the real values.
    if (res.answer && (res.answer.speech || res.answer.headline)) {
      const a = res.answer;
      return {
        speech: String(a.speech || a.headline || ''),
        headline: String(a.headline || ''),
        detail: String(a.detail || ''),
        meta: Array.isArray(a.meta) ? a.meta.filter(Boolean).map(String).slice(0, 4) : [],
        art: typeof a.art === 'string' ? a.art : '',
        ok: res.ok !== false
      };
    }

    // 2. A failure explains itself and suggests a way forward.
    if (res.ok === false) {
      const why = String(res.message || 'That did not work');
      const hint = failureHint(why);
      return { speech: why, headline: '', detail: hint, meta: [], ok: false };
    }

    // 3. Slot commands name what they acted on, which a fixed string cannot.
    const slotSpeech = slotPhrase(id, p, res);
    if (slotSpeech) return { speech: slotSpeech, headline: '', detail: '', meta: [], ok: true };

    // 4. The command's own pool.
    const entry = COMMANDS[id];
    if (entry) {
      const pool = entry.speech || FAMILIES[entry.family] || null;
      const phrase = rotate(id, pool);
      if (phrase) {
        const spoken = applyNoun(phrase, entry.noun);
        if (spoken) return { speech: spoken, headline: '', detail: '', meta: [], ok: true };
      }
    }

    // 5. Whatever the executor said, then the registry's own wording.
    const fallback = String(res.message || '') || registryReply(command, p) || rotate('__done', FAMILIES.done);
    return { speech: fallback, headline: '', detail: '', meta: [], ok: true };
  }

  // Commands carrying a slot read far better when the answer repeats the value
  // back — "Launching Chrome" tells you it heard you; "Starting" does not.
  function slotPhrase(id, p, res) {
    switch (id) {
      case 'app.launch':
        return p.appLabel ? applyNoun(rotate(id, FAMILIES.starting), p.appLabel) : '';
      case 'widget.open':
        return p.widgetLabel ? applyNoun(rotate(id, FAMILIES.opening), p.widgetLabel) : '';
      // These two carry the 'anyWidget' slot, not 'widget' — different param.
      case 'widget.enable':
        return p.anyWidgetLabel ? applyNoun(rotate(id, FAMILIES.on), p.anyWidgetLabel) : '';
      case 'widget.disable':
        return p.anyWidgetLabel ? applyNoun(rotate(id, FAMILIES.off), p.anyWidgetLabel) : '';
      case 'macro.play':
        return p.macroLabel ? applyNoun(rotate(id, FAMILIES.starting), p.macroLabel) : '';
      case 'spotify.playPlaylist':
        return p.playlistLabel ? `Playing ${p.playlistLabel}` : '';
      case 'bluetooth.connect':
        return p.deviceLabel ? `Connecting to ${p.deviceLabel}` : '';
      case 'bluetooth.disconnect':
        return p.deviceLabel ? `Disconnecting ${p.deviceLabel}` : '';
      case 'app.mute':
        return p.sessionLabel ? `Muted ${p.sessionLabel}` : '';
      case 'app.unmute':
        return p.sessionLabel ? `Unmuted ${p.sessionLabel}` : '';
      case 'crosshair.style':
        return p.crosshairStyleLabel ? `Crosshair set to ${p.crosshairStyleLabel}` : '';
      case 'crosshair.color':
        return p.colourLabel ? `Crosshair is ${p.colourLabel} now` : '';
      case 'search.files':
        return p.query ? `Searching for ${p.query}` : '';
      case 'timer.start':
        return p.minutes ? `Timer set for ${spokenDuration(p.minutes)}` : '';
      case 'spotify.sleepTimer':
        return p.minutes ? `Music stops in ${spokenDuration(p.minutes)}` : '';
      case 'spotify.setVolume':
        return `Music at ${p.volume}%`;
      case 'system.setVolume':
        return `Volume at ${p.volume}%`;
      case 'routine.run': {
        // The executor knows how many steps actually ran; without that the
        // reply would claim success for a routine that half-failed.
        const name = p.routineLabel || p.routine || 'that routine';
        if (res && typeof res.ran === 'number') {
          if (res.ran === 0) return `${name} did not run`;
          const failed = typeof res.failed === 'number' ? res.failed : 0;
          if (failed) return `Ran ${plural(res.ran, 'step')} of ${name}, ${failed} did not work`;
          return `${name} done — ${plural(res.ran, 'step')}`;
        }
        return `Running ${name}`;
      }
      default:
        return '';
    }
  }

  // A chain ("dim the lights and play music") should be acknowledged as one
  // action, not narrated step by step.
  function respondChain(count, failed) {
    const n = Number(count) || 0;
    const bad = Number(failed) || 0;
    if (!n) return { speech: 'None of that worked', headline: '', detail: '', meta: [], ok: false };
    if (bad) {
      return {
        speech: `${spokenCount(n)} done, ${spokenCount(bad)} did not`,
        headline: '', detail: '', meta: [], ok: true
      };
    }
    const pool = n === 2 ? ['Both done', 'Two things done'] : [`All ${spokenCount(n)} done`, `${spokenCount(n)} things done`];
    return { speech: rotate('__chain' + n, pool), headline: '', detail: '', meta: [], ok: true };
  }

  // Nothing matched. Saying "unknown command" is the least helpful thing an
  // assistant can do, so this points at the way out.
  function respondUnknown(transcript) {
    const heard = String(transcript || '').trim();
    const pool = heard
      ? [`I heard "${heard}" but that is not a command I know`,
         `"${heard}" is not something I can do yet`]
      : ['I did not catch that', 'I did not hear a command'];
    return {
      speech: rotate('__unknown', pool),
      headline: '',
      detail: 'Say "what can I say" for the full list',
      meta: [], ok: false
    };
  }

  return { respond, respondChain, respondUnknown, greeting, rotate };
}

module.exports = {
  createResponder,
  forSpeech,
  SPEECH_FIXUPS,
  FAMILIES,
  COMMANDS,
  failureHint,
  spokenDuration,
  spokenTime,
  localeUses24Hour,
  spokenCount,
  greeting,
  plural
};
