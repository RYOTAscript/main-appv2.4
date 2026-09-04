'use strict';

// Stage 1: trust and safety.
//
// The motivating incident is real. While the microphone was open during
// testing, with nobody speaking to the assistant, background noise was
// recognised and it opened the Settings window on its own.
//
// That is not a tuning problem, it is structural: a CLOSED grammar cannot
// return "that was not a command". It can only return which of its several
// hundred phrases the audio sat nearest. So noise is not rejected — it is
// rounded. These tests pin down the three defences added for it.

const test = require('node:test');
const assert = require('node:assert');

const V = require('../main/voiceCommands');
const fs = require('node:fs');
const path = require('node:path');

const assistantSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'voiceAssistant.js'), 'utf8');

const cmd = (id) => {
  const c = V.COMMANDS.find((x) => x.id === id);
  assert.ok(c, `${id} missing from the registry`);
  return c;
};

// ── Risk classification ──────────────────────────────────────────────────────

test('every risky id and every inverse id refers to a real command', () => {
  const ids = new Set(V.COMMANDS.map((c) => c.id));
  for (const id of V.RISKY_COMMANDS) assert.ok(ids.has(id), `RISKY_COMMANDS names unknown command ${id}`);
  for (const [from, to] of Object.entries(V.INVERSE_COMMANDS)) {
    assert.ok(ids.has(from), `INVERSE_COMMANDS keyed on unknown command ${from}`);
    assert.ok(ids.has(to), `INVERSE_COMMANDS points at unknown command ${to}`);
  }
});

test('commands that close, clear or reconfigure are classified risky', () => {
  for (const id of ['fps.nuke', 'fps.clearTemp', 'clipboard.clear', 'app.launch',
                    'widget.disable', 'autoClicker.start', 'app.autostartOn']) {
    assert.strictEqual(V.isRiskyCommand(cmd(id)), true, `${id} should be risky`);
  }
});

test('everyday commands are not risky — the guard must not tax normal use', () => {
  for (const id of ['spotify.play', 'spotify.next', 'system.volumeUp', 'weather.now',
                    'system.time', 'crosshair.show', 'app.focus']) {
    assert.strictEqual(V.isRiskyCommand(cmd(id)), false, `${id} should not be risky`);
  }
});

test('a registry confirm:true flag still always asks, at any confidence', () => {
  // This flag predates the guard and means "ask first". Nothing here may weaken it.
  assert.strictEqual(V.needsRiskConfirm(cmd('fps.nuke'), 1, {}), true);
  assert.strictEqual(V.needsRiskConfirm(cmd('clipboard.clear'), 1, {}), true);
});

// ── The confidence bar ───────────────────────────────────────────────────────

test('a risky command runs unprompted only when the recognizer is near-certain', () => {
  const launch = cmd('app.launch');
  assert.strictEqual(V.needsRiskConfirm(launch, 0.99, {}), false, 'near-certain should run');
  assert.strictEqual(V.needsRiskConfirm(launch, 0.80, {}), true, 'merely-confident should ask');
  assert.strictEqual(V.needsRiskConfirm(launch, 0.5, {}), true);
});

test('an utterance nobody asked for clears a higher bar than a deliberate one', () => {
  // The wake word listens continuously, so a result on that path is not
  // evidence that anyone was talking to the assistant at all.
  const launch = cmd('app.launch');
  const conf = (V.RISK_CONFIDENCE + 1) / 2 > V.RISK_CONFIDENCE ? 0.94 : 0.94;
  assert.strictEqual(V.needsRiskConfirm(launch, conf, { viaWake: false }), false);
  assert.strictEqual(V.needsRiskConfirm(launch, conf, { viaWake: true }), true);
});

test('a missing confidence is treated as uncertain, never as certain', () => {
  // "No score" is not evidence of a good match. A guard must never read absent
  // evidence as a pass.
  const launch = cmd('app.launch');
  for (const bad of [undefined, null, NaN, 'high']) {
    assert.strictEqual(V.needsRiskConfirm(launch, bad, {}), true, `confidence ${String(bad)} should confirm`);
  }
});

test('the user can switch the guard off, and that disables it completely', () => {
  assert.strictEqual(V.needsRiskConfirm(cmd('app.launch'), 0.1, { confirmRisky: false }), false);
});

test('the setting exists, defaults on, and coerces junk', () => {
  assert.strictEqual(V.normalizeSettings({}).confirmRisky, true);
  assert.strictEqual(V.normalizeSettings({ confirmRisky: false }).confirmRisky, false);
  assert.strictEqual(V.normalizeSettings({ confirmRisky: 'yes' }).confirmRisky, true);
});

// ── Undo ─────────────────────────────────────────────────────────────────────

test('reversible commands invert, and the inverse of the inverse returns home', () => {
  const pairs = [['spotify.play', 'spotify.pause'], ['system.mute', 'system.unmute'],
                 ['crosshair.show', 'crosshair.hide'], ['gameMode.on', 'gameMode.off']];
  for (const [a, b] of pairs) {
    assert.strictEqual(V.inverseOf(a, {}).commandId, b);
    assert.strictEqual(V.inverseOf(b, {}).commandId, a);
  }
});

test('undoing a slot command carries the slot with it', () => {
  // Undoing "enable the crosshair widget" has to disable THAT widget.
  const back = V.inverseOf('widget.enable', { anyWidget: 'crosshair', anyWidgetLabel: 'Crosshair' });
  assert.strictEqual(back.commandId, 'widget.disable');
  assert.strictEqual(back.params.anyWidget, 'crosshair');
  // With no slot there is nothing to disable, so it must refuse.
  assert.strictEqual(V.inverseOf('widget.enable', {}), null);
});

test('a command with no true inverse refuses rather than guessing', () => {
  // Running a second, differently-wrong action is worse than saying "I can't".
  for (const id of ['system.setVolume', 'weather.now', 'app.openSettings',
                    'search.files', 'system.time', 'assistant.help']) {
    assert.strictEqual(V.inverseOf(id, { volume: 50 }), null, `${id} should not claim an inverse`);
  }
});

test('every power tweak is undone by the same restore command', () => {
  for (const id of ['fps.ultimate', 'fps.high', 'fps.balanced', 'fps.battery', 'fps.nuke']) {
    assert.strictEqual(V.inverseOf(id, {}).commandId, 'fps.revert');
  }
});

test('the undo command exists and is not confusable with cancel', () => {
  const undo = cmd('assistant.undo');
  const cancel = cmd('assistant.cancel');
  // "never mind" dismisses the overlay; it must not reverse an action.
  assert.ok(cancel.phrases.includes('never mind'));
  for (const phrase of undo.phrases) {
    assert.ok(!cancel.phrases.includes(phrase), `"${phrase}" is claimed by both undo and cancel`);
  }
});

test('undo resolves from speech without colliding with another command', () => {
  const vocab = V.buildVocabulary({});
  for (const phrase of ['undo that', 'undo', 'take that back']) {
    assert.strictEqual(V.matchIntent(phrase, vocab).commandId, 'assistant.undo', `"${phrase}"`);
  }
  assert.strictEqual(V.matchIntent('never mind', vocab).commandId, 'assistant.cancel');
});

// Both of these were live-test failures before they were tests.
test('a reversal never becomes the next thing undo undoes', () => {
  // "undo that" twice used to toggle a setting back and forth forever, because
  // execute() re-recorded the inverse as the new undoable action.
  assert.match(assistantSrc, /execute\(back\.commandId, back\.params, inverseCommand, '', \{ isUndo: true \}\)/,
    'the reversal is executed with isUndo set');
  assert.match(assistantSrc, /if \(!\(opts && opts\.isUndo\)\) lastExecuted =/,
    'an undo does not record itself as undoable');
});

test('undo never steps over a command it cannot reverse', () => {
  // Recording only invertible commands let "undo that" reach PAST the thing the
  // user meant: after "what time is it", undo restarted the music.
  assert.ok(!/if \(V\.inverseOf\(commandId, params\)\) lastExecuted =/.test(assistantSrc),
    'every executed command is recorded, not only the reversible ones');
});

// ── The level gate (source contract) ─────────────────────────────────────────
// This one lives in main/voiceAssistant.js against live host events, so it is
// asserted at the source level the way the other main-process contracts are.

test('a result with no audio level behind it is discarded', () => {
  assert.match(assistantSrc, /peakLevel < MIN_PEAK_LEVEL/,
    'onResult gates on the peak input level');
  assert.match(assistantSrc, /peakLevel = 0;\s*\n\s*levelSamples = 0;/,
    'the peak is reset each time listening begins');
});

test('a broken level meter silences nothing', () => {
  // Requiring samples before the gate applies is deliberate: if the meter never
  // reports, the gate must skip rather than reject every command.
  assert.match(assistantSrc, /levelSamples >= MIN_LEVEL_SAMPLES && peakLevel < MIN_PEAK_LEVEL/,
    'the gate only applies once the meter has proven it is live');
});

test('the risk guard is consulted before anything is executed', () => {
  assert.match(assistantSrc, /V\.needsRiskConfirm\(/, 'main asks whether the match needs confirming');
  assert.match(assistantSrc, /confirmRisky: settings\.confirmRisky/, 'the user setting is honoured');
  assert.match(assistantSrc, /if \(match\.confirm \|\| riskConfirm\)/,
    'a risky match takes the existing confirmation path');
});

test('typed commands are not second-guessed', () => {
  // The guard exists for what the microphone heard. A typed command was
  // unambiguously intended, so it defaults to full confidence.
  assert.match(assistantSrc, /Number\.isFinite\(Number\(o\.confidence\)\) \? Number\(o\.confidence\) : 1/,
    'a missing origin confidence means typed input, which is certain');
});
