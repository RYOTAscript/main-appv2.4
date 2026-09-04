'use strict';

// Stage 2: conversation.
//
// Two ideas here, and they lean on each other. A SUBJECT lets the assistant
// resolve "it" against what you were just doing. A SUGGESTION offers the likely
// next thing as a chip, which is how anyone discovers a ninety-command
// vocabulary without reading a list.
//
// The recurring hazard in both is the same: a resolution that is *nearly* right
// acts on the wrong thing. Refusing has to stay cheaper than guessing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V = require('../main/voiceCommands');
const assistantSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'voiceAssistant.js'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(__dirname, '..', 'voice-overlay.html'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'voice-overlay-preload.js'), 'utf8');

const ids = new Set(V.COMMANDS.map((c) => c.id));

// ── Subjects ─────────────────────────────────────────────────────────────────

test('a widget subject carries its slot into the resolved command', () => {
  // "open the weather widget" then "turn it off" has to disable THAT widget.
  const out = V.resolvePronoun('turn it off', { kind: 'widget', params: { widget: 'weather', widgetLabel: 'Weather' } });
  assert.strictEqual(out.commandId, 'widget.disable');
  // widget.open uses the 'widget' slot; widget.disable uses 'anyWidget'.
  assert.strictEqual(out.params.anyWidget, 'weather');
  assert.strictEqual(out.params.anyWidgetLabel, 'Weather');
});

test('a widget pronoun with no remembered widget refuses', () => {
  // Acting on an unnamed widget would disable whichever one happened to be
  // first. Unknown is the correct answer.
  assert.strictEqual(V.resolvePronoun('turn it off', { kind: 'widget', params: {} }), null);
});

test('a phrase that means nothing for the current subject refuses', () => {
  // "skip it" is meaningful for music and meaningless for a widget. It must not
  // be forced into meaning something just because a subject exists.
  assert.strictEqual(V.resolvePronoun('skip it', { kind: 'widget', params: { widget: 'weather' } }), null);
  assert.strictEqual(V.resolvePronoun('turn it off', { kind: 'music', params: {} }), null);
});

test('subjects are established only by commands that name one', () => {
  assert.strictEqual(V.pronounSubjectOf('widget.open'), 'widget');
  assert.strictEqual(V.pronounSubjectOf('app.launch'), 'app');
  assert.strictEqual(V.pronounSubjectOf('spotify.next'), 'music');
  assert.strictEqual(V.pronounSubjectOf('system.volumeUp'), 'system');
  // Unrelated commands must not become the antecedent.
  assert.strictEqual(V.pronounSubjectOf('app.openSettings'), '');
  assert.strictEqual(V.pronounSubjectOf('weather.now'), '');
});

test('an unknown subject kind never resolves', () => {
  for (const bad of ['', null, undefined, 'nonsense', { kind: 'nonsense', params: {} }, {}]) {
    assert.strictEqual(V.resolvePronoun('turn it up', bad), null, `subject ${JSON.stringify(bad)}`);
  }
});

test('every pronoun target is a real command', () => {
  for (const [phrase, mapping] of Object.entries(V.PRONOUN_PHRASES)) {
    for (const [kind, id] of Object.entries(mapping)) {
      assert.ok(ids.has(id), `"${phrase}" (${kind}) points at unknown command ${id}`);
      assert.ok(Object.prototype.hasOwnProperty.call(V.PRONOUN_TARGETS, kind),
        `"${phrase}" names subject "${kind}", which nothing establishes`);
    }
  }
});

test('every subject kind can actually be established by some command', () => {
  // A subject nothing sets is dead weight that silently never resolves.
  for (const kind of Object.keys(V.PRONOUN_TARGETS)) {
    assert.ok(V.PRONOUN_TARGETS[kind].length > 0, `nothing establishes the "${kind}" subject`);
    for (const id of V.PRONOUN_TARGETS[kind]) {
      assert.ok(ids.has(id), `${kind} lists unknown command ${id}`);
    }
  }
});

// ── Suggestions ──────────────────────────────────────────────────────────────

test('every suggestion points at a command that exists', () => {
  for (const [from, list] of Object.entries(V.SUGGESTIONS)) {
    assert.ok(ids.has(from), `suggestions keyed on unknown command ${from}`);
    for (const s of list) {
      assert.ok(ids.has(s.commandId), `${from} suggests unknown command ${s.commandId}`);
      assert.ok(s.label && s.label.length <= 20, `${from} -> ${s.commandId} needs a short label`);
    }
  }
});

test('a suggestion never offers a command that needs a slot', () => {
  // A chip dispatches with no params, so a slot command would arrive empty and
  // fail. "Change style" would have run crosshair.style with no style.
  for (const from of Object.keys(V.SUGGESTIONS)) {
    for (const s of V.suggestionsFor(from)) {
      const target = V.COMMANDS.find((c) => c.id === s.commandId);
      assert.ok(!target.slot, `${from} offers ${s.commandId}, which needs a "${target.slot}" slot`);
    }
  }
});

test('the crosshair suggestion is filtered out rather than shipped broken', () => {
  assert.ok(V.SUGGESTIONS['crosshair.show'].some((s) => s.commandId === 'crosshair.style'),
    'the raw table still lists it');
  assert.deepStrictEqual(V.suggestionsFor('crosshair.show'), [],
    'but it is filtered before it can be offered');
});

test('a command with no suggestions returns an empty list, never undefined', () => {
  assert.deepStrictEqual(V.suggestionsFor('app.minimize'), []);
  assert.deepStrictEqual(V.suggestionsFor('nonsense.command'), []);
});

test('suggestions do not point back at themselves', () => {
  for (const [from, list] of Object.entries(V.SUGGESTIONS)) {
    for (const s of list) {
      assert.notStrictEqual(s.commandId, from, `${from} suggests itself`);
    }
  }
});

// ── Wiring contracts ─────────────────────────────────────────────────────────

test('suggestions travel with the answer and render as chips', () => {
  assert.match(assistantSrc, /suggestions: V\.suggestionsFor\(/,
    'main attaches follow-ups to the answer payload');
  assert.match(overlaySrc, /payload\.suggestions/,
    'the overlay renders them');
  assert.match(overlaySrc, /!payload\.confirmPrompt && Array\.isArray\(payload\.suggestions\)/,
    'offers never appear while something is waiting to be confirmed');
});

test('the subject is remembered with its params, not just its kind', () => {
  assert.match(assistantSrc, /pronounSubject = \{ kind: subjectKind, params: entry\.params \|\| \{\} \}/,
    'the slot travels with the subject');
});

// ── Barge-in ─────────────────────────────────────────────────────────────────

test('speech can be interrupted without touching microphone ownership', () => {
  // Arming the recognizer during SPEAKING would put wake and command mode back
  // in contention for the audio device, which is the one invariant in this
  // module that must not be worked around. The interrupt is an explicit
  // gesture instead.
  assert.match(preloadSrc, /shutup: \(\) => ipcRenderer\.send\('voice:overlay-shutup'\)/,
    'the overlay can ask for silence');
  assert.match(assistantSrc, /voice:overlay-shutup/, 'main handles it');
  assert.match(assistantSrc, /if \(state !== V\.VOICE_STATES\.SPEAKING\) return;\s*\n\s*stopSpeaking\(\)/,
    'it only applies while actually speaking');
  assert.match(assistantSrc, /function stopSpeaking\(\) \{[\s\S]{0,240}?hostSend\('SHUTUP'\)/,
    'and stopSpeaking still reaches the host synthesizer');
  assert.ok(!/setHostMode\('command'[^)]*\)\s*;?\s*\/\/\s*barge/i.test(assistantSrc),
    'barge-in does not re-open the microphone');
});

test('interrupting works even with click-to-listen turned off', () => {
  // Someone who disabled click-to-listen still needs a way to stop a reply
  // that is talking over them.
  assert.match(overlaySrc, /if \(current\.state === 'speaking'\) \{ api\.shutup\(\); return; \}[\s\S]{0,200}?clickActivate === false/,
    'the barge-in check precedes the clickActivate gate');
});
