'use strict';

// Stages 3-6: rich answers, recognition, polish, and the engine seam.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V = require('../main/voiceCommands');
const R = require('../main/voiceResponses');
const E = require('../main/voiceEngines');

const here = (...p) => path.join(__dirname, '..', ...p);
const assistantSrc = fs.readFileSync(here('main', 'voiceAssistant.js'), 'utf8');
const overlaySrc = fs.readFileSync(here('voice-overlay.html'), 'utf8');
const rendererSrc = fs.readFileSync(here('renderer', 'voice-assistant.js'), 'utf8');
const statsSrc = fs.readFileSync(here('main', 'systemStats.js'), 'utf8');

// ── Stage 3: rich answers ────────────────────────────────────────────────────

test('album art is allowed by the overlay CSP, and only over http(s)', () => {
  // main.html already permits https: for exactly these images; the overlay now
  // mirrors that rather than inventing a looser policy.
  assert.match(overlaySrc, /img-src 'self' file: data: blob: https:;/);
  // A src attribute is not a place to trust a value that arrived from an API,
  // so it is re-checked at the point of use as well as on the way in.
  assert.match(overlaySrc, /\/\^https\?:\\\/\\\/\/i\.test\(rawArt\)/);
  assert.match(rendererSrc, /\/\^https\?:\\\/\\\/\/i\.test\(String\(result\.answer\.art/);
});

test('battery and disk do not run on the once-a-second stats path', () => {
  // get-system-stats is polled by the dashboard; a PowerShell spawn there would
  // be a performance disaster. Separate handler, cached.
  assert.match(statsSrc, /ipcMain\.handle\('get-system-extra'/);
  assert.match(statsSrc, /EXTRA_TTL_MS/);
  // Anchor on the handler REGISTRATION, not the first mention of the name —
  // the explanatory comment above readExtra mentions it first.
  const from = statsSrc.indexOf("ipcMain.handle('get-system-stats'");
  const statsHandler = statsSrc.slice(from, statsSrc.indexOf('get-system-extra'));
  assert.ok(from > 0 && !/runCmd|powershell/i.test(statsHandler),
    'the hot stats handler stays free of PowerShell');
});

test('the battery PowerShell is joined with newlines, not semicolons', () => {
  // A semicolon straight after `[ordered]@{` closes the hash literal and the
  // whole script fails to parse. This was a real failure, caught by running it.
  assert.match(statsSrc, /\]\.join\('\\n'\)/);
  assert.ok(!/\]\.join\('; '\)/.test(statsSrc));
});

test('battery and disk are real commands with executors', () => {
  for (const id of ['system.battery', 'system.disk']) {
    assert.ok(V.COMMANDS.find((c) => c.id === id), `${id} missing from the registry`);
    assert.ok(rendererSrc.includes(`'${id}':`), `${id} has no executor`);
  }
});

test('a machine with no battery gets an answer, not an error message', () => {
  // A desktop having no battery is a fact about the machine, not a failure to
  // read one, and "couldn't read it" would simply be wrong.
  assert.match(rendererSrc, /doesn’t have a battery/);
});

// ── Stage 4: recognition ─────────────────────────────────────────────────────

test('an alias adds a phrase and can never shadow a built-in one', () => {
  const { aliases, rejected } = V.validateAliases({
    'spotify.next': ['jump ahead'],
    'spotify.play': ['pause the music']       // already means spotify.pause
  }, null);
  assert.deepStrictEqual(aliases['spotify.next'], ['jump ahead']);
  assert.ok(!aliases['spotify.play'], 'a colliding alias is refused');
  assert.match(rejected.find((r) => r.phrase === 'pause the music').why, /already means/);
});

test('aliases are validated, not trusted', () => {
  const { aliases, rejected } = V.validateAliases({
    'nope.notacommand': ['two words'],
    'spotify.next': ['a', 'one two three four five six seven eight nine'],
    'system.mute': ['shut up speakers']
  }, null);
  assert.ok(!aliases['nope.notacommand'], 'unknown command refused');
  assert.ok(!aliases['spotify.next'], 'one-word and over-long aliases refused');
  assert.deepStrictEqual(aliases['system.mute'], ['shut up speakers']);
  assert.ok(rejected.length >= 3);
});

test('a valid alias is hearable and matches its command', () => {
  const vocab = V.buildVocabulary({ aliases: { 'spotify.next': ['jump ahead'] } });
  const g = V.compileGrammar(vocab);
  assert.ok(g.phrases.includes('jump ahead'), 'compiled into the grammar');
  assert.strictEqual(g.collisions.length, 0);
  assert.strictEqual(V.matchIntent('jump ahead', vocab).commandId, 'spotify.next');
  // And the built-in it sits beside still works.
  assert.strictEqual(V.matchIntent('pause the music', vocab).commandId, 'spotify.pause');
});

test('the spoken clock follows the locale convention', () => {
  const d = new Date(2026, 0, 1, 21, 5);
  assert.strictEqual(R.spokenTime(d, false), '9 oh 5 in the evening');
  assert.strictEqual(R.spokenTime(d, true), '21 oh 5');
  assert.strictEqual(R.localeUses24Hour('1:00:00 PM'), false);
  assert.strictEqual(R.localeUses24Hour('13:00:00'), true);
});

// ── Stage 5: polish ──────────────────────────────────────────────────────────

test('dwell scales with how much there is to read, within a ceiling', () => {
  assert.match(assistantSrc, /SETTLE_MS\.answer \+ Math\.max\(0, chars - 20\) \* 28/);
  assert.match(assistantSrc, /Math\.min\(SETTLE_MS\.answerMax/);
  const m = assistantSrc.match(/answerMax: (\d+)/);
  assert.ok(m && Number(m[1]) > 3600, 'the ceiling is above the base dwell');
});

test('history is capped and never written to disk', () => {
  // It is a debugging aid for false accepts, not a transcript of what is said
  // in the room.
  assert.match(assistantSrc, /HISTORY_MAX = 40/);
  assert.match(assistantSrc, /history\.length = HISTORY_MAX/);
  assert.match(assistantSrc, /ipcMain\.handle\('voice:get-history'/);
  // Just the recorder itself: a wider window runs into the settings loader,
  // which reads and writes files for entirely unrelated reasons.
  const from = assistantSrc.indexOf('function recordHistory(');
  const historyRegion = assistantSrc.slice(from, assistantSrc.indexOf('}', assistantSrc.indexOf('usageCounts.set')));
  assert.ok(from > 0 && !/writeFile|fs\./.test(historyRegion), 'history is in-memory only');
});

test('unknown utterances are recorded too — that is the point', () => {
  // A false accept is invisible unless the misses are logged alongside the hits.
  assert.match(assistantSrc, /recordHistory\(\{ transcript: text, commandId: '', outcome: 'unknown'/);
});

test('ducking restores the level it read, never a guessed one', () => {
  assert.match(rendererSrc, /duckRestoreTo = current/);
  assert.match(rendererSrc, /if \(current === null \|\| !data\.is_playing\) return;/,
    'nothing playing or unreadable level means leave it alone entirely');
  assert.match(rendererSrc, /typeof data\.volume_percent === 'number'/,
    'reads the real flat field, not a nested device object');
});

test('ducking is undone on every exit from speaking', () => {
  assert.match(assistantSrc, /case 'SPEAK-DONE':\s*\n\s*duckMusic\(false\)/);
  // Including when the user cuts the reply off.
  assert.match(assistantSrc, /stopSpeaking\(\);\s*\n\s*duckMusic\(false\)/);
});

// ── Stage 6: the engine seam ─────────────────────────────────────────────────

test('the seam describes engines honestly, including what is not shippable', () => {
  assert.strictEqual(E.activeEngineId(), 'system.speech');
  assert.strictEqual(E.ENGINES['system.speech'].available, true);
  // Claiming these work would be a lie: one needs a Mac to build, the other
  // needs a 75MB model shipped with a paid product.
  assert.strictEqual(E.ENGINES['apple.speech'].available, false);
  assert.strictEqual(E.ENGINES['whisper.cpp'].available, false);
  assert.deepStrictEqual(E.availableEnginesForPlatform('darwin'), []);
  assert.deepStrictEqual(E.availableEnginesForPlatform('win32').map((e) => e.id), ['system.speech']);
});

test('the closed-grammar constraint is a property of the engine, not the OS', () => {
  // Everything that exists because of the closed grammar should branch on this,
  // so an open engine relaxes them all at once.
  assert.strictEqual(E.needsCompiledGrammar('system.speech'), true);
  assert.strictEqual(E.needsCompiledGrammar('whisper.cpp'), false);
  assert.strictEqual(E.canRejectOutOfGrammar('system.speech'), false);
  assert.strictEqual(E.canRejectOutOfGrammar('apple.speech'), true);
  // An unknown engine is assumed to be the restrictive kind.
  assert.strictEqual(E.needsCompiledGrammar('nonsense'), true);
  assert.strictEqual(E.canRejectOutOfGrammar('nonsense'), false);
});

test('every engine declares the same contract fields', () => {
  for (const [id, e] of Object.entries(E.ENGINES)) {
    assert.strictEqual(e.id, id);
    for (const field of ['label', 'platforms', 'grammar', 'offline', 'available', 'canRejectOutOfGrammar']) {
      assert.ok(Object.prototype.hasOwnProperty.call(e, field), `${id} is missing "${field}"`);
    }
    assert.ok(['open', 'closed'].includes(e.grammar), `${id} has an odd grammar kind`);
    assert.ok(Array.isArray(e.platforms) && e.platforms.length, `${id} names no platform`);
  }
});
