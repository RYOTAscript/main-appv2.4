'use strict';

// ── Speech engine seam ───────────────────────────────────────────────────────
//
// The assistant is currently welded to one recognizer: Windows `System.Speech`,
// driven through the persistent PowerShell/C# host in voiceHostScript.js. That
// choice leaks into everything — a CLOSED grammar is why a phrasing the matcher
// understands is still unhearable unless compiled in, why noise gets rounded to
// the nearest phrase instead of rejected, and why the whole widget is
// `platforms: ['win32']` with no macOS equivalent.
//
// This module is the seam that makes the recognizer replaceable. It does NOT
// implement a second engine. It defines what an engine has to provide, records
// what each candidate would cost, and gives the rest of the code one place to
// ask "what can the current engine actually do?" instead of assuming Windows.
//
// Deliberately declarative and dependency-free so it can be unit-tested without
// Electron, exactly like voiceCommands.js and voiceResponses.js.

// ── The contract ─────────────────────────────────────────────────────────────
// Any engine must satisfy this. The names match the line protocol the existing
// host already speaks, so `system.speech` is not a special case — it is simply
// the first implementation of the interface.
const ENGINE_CONTRACT = Object.freeze({
  // Commands the host must accept on stdin.
  commands: Object.freeze([
    'GRAMMAR-BEGIN', 'GRAMMAR-END', 'LISTEN', 'STOP', 'MODE', 'SPEAK', 'SHUTUP', 'PING', 'EXIT'
  ]),
  // Events the host must emit on stdout.
  events: Object.freeze([
    'READY', 'LISTENING', 'STOPPED', 'RESULT', 'REJECTED', 'TIMEOUT', 'ERROR'
  ])
});

// ── What each engine can actually do ─────────────────────────────────────────
// `grammar: 'closed'` is the single most consequential property. It is why the
// registry's phrases have to be compiled, and why several of this widget's
// sharpest edges exist. An open engine removes those edges and brings different
// ones (latency, model size, licensing).
const ENGINES = Object.freeze({
  'system.speech': {
    id: 'system.speech',
    label: 'Windows Speech',
    platforms: ['win32'],
    grammar: 'closed',        // only compiled phrases are hearable
    openDictation: true,      // available, but ~0.27 accuracy vs ~0.94 grammared
    offline: true,
    speaks: true,             // the same host does text-to-speech
    bundleMb: 0,              // ships with Windows
    available: true,
    // Cannot answer "that was not a command" — see the risk guard in
    // voiceCommands.js, which exists entirely because of this.
    canRejectOutOfGrammar: false
  },
  'apple.speech': {
    id: 'apple.speech',
    label: 'Apple Speech (SFSpeechRecognizer)',
    platforms: ['darwin'],
    grammar: 'open',
    openDictation: true,
    offline: true,            // on-device since macOS 10.15, per-locale download
    speaks: false,            // TTS would stay on `say`/AVSpeechSynthesizer
    bundleMb: 0,
    // NOT shippable from this repo as it stands, and saying otherwise would be
    // a lie: it needs a Swift helper binary, a hardened-runtime entitlement, a
    // usage-description prompt, and it can only be built and notarized ON a Mac
    // (electron-builder refuses --mac on Windows). See MACOS notes below.
    available: false,
    canRejectOutOfGrammar: true
  },
  'whisper.cpp': {
    id: 'whisper.cpp',
    label: 'whisper.cpp (local model)',
    platforms: ['win32', 'darwin', 'linux'],
    grammar: 'open',
    openDictation: true,
    offline: true,
    speaks: false,
    // The reason this is a product decision and not a code change: a paid
    // download grows by the model, and the smallest useful one is not small.
    bundleMb: 75,
    available: false,
    canRejectOutOfGrammar: true
  }
});

// The engine in use. Only one is implemented today; this is the function every
// caller should ask rather than testing `isWindows` directly.
function activeEngineId() {
  return 'system.speech';
}

function engineFor(id) {
  return ENGINES[id] || null;
}

// Engines that could run on a platform, whether or not they are implemented.
function enginesForPlatform(platform) {
  const p = String(platform || '');
  return Object.values(ENGINES).filter((e) => e.platforms.includes(p));
}

// Engines that are actually usable today on a platform.
function availableEnginesForPlatform(platform) {
  return enginesForPlatform(platform).filter((e) => e.available);
}

// Does the current engine need its phrases compiled ahead of time? Everything
// that exists because of the closed grammar should branch on THIS, not on the
// operating system — the two are only accidentally the same today.
function needsCompiledGrammar(engineId) {
  const e = engineFor(engineId || activeEngineId());
  return !e || e.grammar === 'closed';
}

// Can the engine tell us that something simply was not a command? When this
// becomes true for a real engine, the risk-confirmation guard can relax,
// because noise will be rejected rather than rounded.
function canRejectOutOfGrammar(engineId) {
  const e = engineFor(engineId || activeEngineId());
  return !!(e && e.canRejectOutOfGrammar);
}

module.exports = {
  ENGINE_CONTRACT,
  ENGINES,
  activeEngineId,
  engineFor,
  enginesForPlatform,
  availableEnginesForPlatform,
  needsCompiledGrammar,
  canRejectOutOfGrammar
};
