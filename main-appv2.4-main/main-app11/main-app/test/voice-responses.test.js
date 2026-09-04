'use strict';

// Tests for the answering layer (main/voiceResponses.js) and the recognition
// upgrades that went in alongside it.
//
// The regression block at the bottom is the important one. Three "obvious"
// improvements in this change were each actively harmful, and all three looked
// fine until they were run against the real registry:
//
//   - a synonym table mapping "lower" -> "turn" broke "lower the volume", which
//     was ALREADY a template for system.volumeDown
//   - "mic" -> "microphone" broke "flip my mic"
//   - stripping "like" as a filler destroyed "like this song"
//
// The lesson is that any transform applied to an utterance BEFORE matching can
// move it away from a phrase it already matched. These tests pin that down.

const test = require('node:test');
const assert = require('node:assert');

const V = require('../main/voiceCommands');
const R = require('../main/voiceResponses');

const vocab = V.buildVocabulary({});

// ── The answering layer ──────────────────────────────────────────────────────

test('every registry command produces a non-empty spoken reply', () => {
  const r = R.createResponder();
  for (const cmd of V.COMMANDS) {
    const answer = r.respond(cmd, {}, { ok: true });
    assert.ok(
      answer && typeof answer.speech === 'string' && answer.speech.trim().length > 0,
      `"${cmd.id}" produced no speech — a command must never go unanswered`
    );
  }
});

test('phrase pools rotate: no immediate repeat, and the whole pool is used', () => {
  const r = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'spotify.play');
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(r.respond(cmd, {}, { ok: true }).speech);

  for (let i = 1; i < seen.length; i++) {
    assert.notStrictEqual(seen[i], seen[i - 1], `variant repeated back-to-back at ${i}: ${seen[i]}`);
  }
  // resume has three variants; six calls must have covered all of them.
  assert.strictEqual(new Set(seen).size, R.FAMILIES.resume.length);
});

test('rotation is deterministic — two fresh responders agree', () => {
  const a = R.createResponder();
  const b = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'spotify.pause');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(a.respond(cmd, {}, { ok: true }).speech, b.respond(cmd, {}, { ok: true }).speech);
  }
});

test('an executor\'s rich answer wins outright over the phrase pool', () => {
  const r = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'weather.now');
  const out = r.respond(cmd, {}, {
    ok: true,
    answer: { speech: 'It\'s 21 degrees and clear in London', headline: '21°C', detail: 'Clear · London', meta: ['Feels 19°'] }
  });
  assert.strictEqual(out.speech, 'It\'s 21 degrees and clear in London');
  assert.strictEqual(out.headline, '21°C');
  assert.strictEqual(out.detail, 'Clear · London');
  assert.deepStrictEqual(out.meta, ['Feels 19°']);
});

test('speech and headline are allowed to differ — that is the point of the split', () => {
  const r = R.createResponder();
  const out = r.respond(null, {}, { ok: true, answer: { speech: 'It is nine forty two in the evening', headline: '9:42 PM' } });
  assert.notStrictEqual(out.speech, out.headline);
  assert.ok(out.speech.length > out.headline.length);
});

test('a failure explains itself and suggests a way forward', () => {
  const r = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'spotify.play');
  const out = r.respond(cmd, {}, { ok: false, message: 'Spotify isn’t connected' });
  assert.strictEqual(out.ok, false);
  assert.match(out.speech, /Spotify/);
  assert.ok(out.detail.length > 0, 'a failure should carry a next step');
  assert.match(out.detail, /Spotify widget/);
});

test('failures without a known cause still answer, just without a hint', () => {
  const r = R.createResponder();
  const out = r.respond(null, {}, { ok: false, message: 'Something odd happened' });
  assert.strictEqual(out.speech, 'Something odd happened');
  assert.strictEqual(out.detail, '');
});

test('slot commands name what they acted on', () => {
  const r = R.createResponder();
  const cases = [
    ['app.launch', { appLabel: 'Chrome' }, /Chrome/],
    ['widget.open', { widgetLabel: 'Weather' }, /Weather/],
    ['widget.enable', { anyWidgetLabel: 'Crosshair' }, /Crosshair/],
    ['spotify.playPlaylist', { playlistLabel: 'Focus' }, /Focus/],
    ['bluetooth.connect', { deviceLabel: 'AirPods' }, /AirPods/],
    ['timer.start', { minutes: 30 }, /30 minutes/],
    ['system.setVolume', { volume: 40 }, /40%/]
  ];
  for (const [id, params, pattern] of cases) {
    const cmd = V.COMMANDS.find((c) => c.id === id);
    assert.ok(cmd, `${id} missing from the registry`);
    assert.match(r.respond(cmd, params, { ok: true }).speech, pattern, `${id} did not name its target`);
  }
});

test('widget.enable reads anyWidgetLabel, not widgetLabel (different slot)', () => {
  const r = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'widget.enable');
  // Passing the WRONG param must not produce a sentence with a hole in it.
  const wrong = r.respond(cmd, { widgetLabel: 'Weather' }, { ok: true });
  assert.ok(!/^\s*on\b/i.test(wrong.speech), 'fell through to a dangling noun');
  assert.ok(wrong.speech.trim().length > 0);
});

test('a routine reports how much of it actually ran', () => {
  const r = R.createResponder();
  const cmd = V.COMMANDS.find((c) => c.id === 'routine.run');
  assert.match(r.respond(cmd, { routineLabel: 'Gaming' }, { ok: true, ran: 3, failed: 0 }).speech, /3 steps/);
  assert.match(r.respond(cmd, { routineLabel: 'Gaming' }, { ok: true, ran: 2, failed: 1 }).speech, /1 did not work/);
  assert.match(r.respond(cmd, { routineLabel: 'Gaming' }, { ok: true, ran: 0, failed: 2 }).speech, /did not run/);
});

test('chains are acknowledged as one action', () => {
  const r = R.createResponder();
  assert.match(r.respondChain(2, 0).speech, /[Bb]oth|[Tt]wo/);
  assert.match(r.respondChain(3, 1).speech, /did not/);
  assert.strictEqual(r.respondChain(0, 0).ok, false);
});

test('an unknown utterance points at the way out instead of just refusing', () => {
  const r = R.createResponder();
  const out = r.respondUnknown('make me a sandwich');
  assert.match(out.speech, /make me a sandwich/);
  assert.match(out.detail, /what can I say/i);
  assert.strictEqual(out.ok, false);
});

// ── Spoken-form helpers ──────────────────────────────────────────────────────

test('durations are spoken the way a person says them', () => {
  assert.strictEqual(R.spokenDuration(1), '1 minute');
  assert.strictEqual(R.spokenDuration(30), '30 minutes');
  assert.strictEqual(R.spokenDuration(60), '1 hour');
  assert.strictEqual(R.spokenDuration(90), 'an hour and a half');
  assert.strictEqual(R.spokenDuration(120), '2 hours');
  assert.strictEqual(R.spokenDuration(135), '2 hours 15 minutes');
});

test('greeting follows the clock', () => {
  assert.strictEqual(R.greeting(new Date(2026, 0, 1, 9)), 'Good morning');
  assert.strictEqual(R.greeting(new Date(2026, 0, 1, 14)), 'Good afternoon');
  assert.strictEqual(R.greeting(new Date(2026, 0, 1, 21)), 'Good evening');
  assert.strictEqual(R.greeting(new Date(2026, 0, 1, 3)), 'Still up');
});

test('spokenTime reads a clock rather than displaying one', () => {
  assert.strictEqual(R.spokenTime(new Date(2026, 0, 1, 9, 0)), "9 o'clock in the morning");
  assert.strictEqual(R.spokenTime(new Date(2026, 0, 1, 21, 5)), '9 oh 5 in the evening');
  assert.strictEqual(R.spokenTime(new Date(2026, 0, 1, 14, 42)), '2 42 in the afternoon');
});

// ── Recognition: durations ───────────────────────────────────────────────────

test('parseDuration understands how people ask for a timer', () => {
  const cases = [
    ['half an hour', 30], ['an hour and a half', 90], ['a couple of minutes', 2],
    ['a few minutes', 5], ['ten minutes', 10], ['90 minutes', 90],
    ['two hours', 120], ['a quarter of an hour', 15], ['an hour', 60],
    ['1 hour 30 minutes', 90]
  ];
  for (const [text, want] of cases) {
    assert.strictEqual(V.parseDuration(text), want, `"${text}"`);
  }
});

test('parseDuration refuses things that are not durations', () => {
  for (const text of ['banana', '', 'the weather', 'chrome']) {
    assert.strictEqual(V.parseDuration(text), null, `"${text}" should not parse as a duration`);
  }
});

test('a spoken duration reaches the timer command', () => {
  const m = V.matchIntent('set a timer for half an hour', vocab);
  assert.strictEqual(m.status, 'matched');
  assert.strictEqual(m.commandId, 'timer.start');
  assert.strictEqual(m.params.minutes, 30);
});

// ── Recognition: pronouns ────────────────────────────────────────────────────

// resolvePronoun returns { commandId, params } as of stage 2: a widget subject
// has to carry its slot, so a bare command id is no longer enough.
test('"turn it up" resolves against whatever was last controlled', () => {
  assert.strictEqual(V.resolvePronoun('turn it up', 'music').commandId, 'spotify.volumeUp');
  assert.strictEqual(V.resolvePronoun('turn it up', 'system').commandId, 'system.volumeUp');
  assert.strictEqual(V.resolvePronoun('mute it', 'music').commandId, 'spotify.mute');
  assert.strictEqual(V.resolvePronoun('mute it', 'system').commandId, 'system.mute');
});

test('with no antecedent a pronoun is refused, not guessed', () => {
  // Guessing here mutes the wrong thing, which is worse than asking.
  assert.strictEqual(V.resolvePronoun('turn it up', ''), null);
  assert.strictEqual(V.resolvePronoun('turn it up', 'nonsense'), null);
});

test('only audio commands become the antecedent', () => {
  assert.strictEqual(V.pronounSubjectOf('spotify.next'), 'music');
  assert.strictEqual(V.pronounSubjectOf('system.volumeUp'), 'system');
  // Opening settings must not make "turn it up" mean anything.
  assert.strictEqual(V.pronounSubjectOf('app.openSettings'), '');
  assert.strictEqual(V.pronounSubjectOf('fps.optimize'), '');
  assert.strictEqual(V.pronounSubjectOf(''), '');
});

test('every pronoun phrase maps to a command that really exists', () => {
  const ids = new Set(V.COMMANDS.map((c) => c.id));
  for (const [phrase, mapping] of Object.entries(V.PRONOUN_PHRASES)) {
    for (const [subject, id] of Object.entries(mapping)) {
      assert.ok(ids.has(id), `"${phrase}" (${subject}) points at unknown command ${id}`);
    }
  }
});

test('every pronoun target id really exists too', () => {
  const ids = new Set(V.COMMANDS.map((c) => c.id));
  for (const [subject, list] of Object.entries(V.PRONOUN_TARGETS)) {
    for (const id of list) assert.ok(ids.has(id), `${subject} lists unknown command ${id}`);
  }
});

// ── Regression guards ────────────────────────────────────────────────────────
// Each of these matched before this change and must still match after it.

test('utterance preprocessing never breaks a phrase the registry already had', () => {
  const cases = [
    ['lower the volume', 'system.volumeDown'],
    ['raise the volume', 'system.volumeUp'],
    ['like this song', 'spotify.like'],
    ['flip my mic', 'mic.toggle'],
    ['what is the weather like', 'weather.now'],
    ['toggle my mic', 'mic.toggle'],
    ['open settings', 'app.openSettings']
  ];
  for (const [text, want] of cases) {
    const m = V.matchIntent(text, vocab);
    assert.strictEqual(m.commandId, want, `"${text}" should still match ${want}, got ${m.commandId || m.status}`);
  }
});

test('inner fillers are disjoint from every word the registry uses', () => {
  // Stripping a word that appears in a template silently destroys that command.
  // This is the invariant that "like" violated.
  const words = new Set();
  for (const cmd of V.COMMANDS) {
    for (const phrase of cmd.phrases) {
      for (const w of String(phrase).toLowerCase().split(/[^a-z]+/)) if (w) words.add(w);
    }
  }
  const clashes = V.INNER_FILLERS.filter((f) => words.has(f));
  assert.deepStrictEqual(clashes, [], `these fillers appear in command templates: ${clashes.join(', ')}`);
});

test('a mid-sentence filler no longer costs a match', () => {
  assert.strictEqual(V.matchIntent('turn the um volume up', vocab).commandId, 'system.volumeUp');
  assert.strictEqual(V.matchIntent('uh pause the music', vocab).commandId, 'spotify.pause');
});

test('an utterance of nothing but fillers stays unknown', () => {
  // Filler-stripping must not be able to turn noise into a command.
  for (const text of ['um', 'uh um', 'basically']) {
    const m = V.matchIntent(text, vocab);
    assert.notStrictEqual(m.status, 'matched', `"${text}" should not match a command`);
  }
});
