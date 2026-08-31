// Voice Assistant: the pure intent layer.
//
// main/voiceCommands.js has no Electron or Node dependencies precisely so this
// can cover it properly — the state machine, the grammar compiler, the natural
// language matcher, the confidence gate and the settings schema, all without a
// window, a microphone or a PowerShell host.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const V = require('../main/voiceCommands.js');
const S = V.VOICE_STATES;
const E = V.VOICE_EVENTS;

// A realistic vocabulary: a multi-word game with an alias, a name that collides
// with a Spotify command word, and an enabled widget.
const VOCAB = V.buildVocabulary({
  apps: [
    { id: 'C:/games/RainbowSix.exe', name: "Tom Clancy's Rainbow Six Siege", aliases: ['siege'] },
    { id: 'C:/valorant.exe', name: 'Valorant' },
    { id: 'C:/Spotify.exe', name: 'Spotify' },
    { id: 'C:/chrome.exe', name: 'Chrome' }
  ],
  widgets: [{ id: 'clipboard', name: 'Clipboard History' }, { id: 'timer', name: 'Countdown Timer' }],
  macros: [{ id: 'm1', name: 'Reload Combo' }]
});
const GRAMMAR = V.compileGrammar(VOCAB);

function match(text) { return V.matchIntent(text, VOCAB, GRAMMAR); }

// ── State machine ─────────────────────────────────────────────────────────
test('the happy path walks hidden → listening → processing → success → hidden', () => {
  let s = S.HIDDEN;
  s = V.nextState(s, E.ACTIVATE);  assert.equal(s, S.LISTENING);
  s = V.nextState(s, E.HEARD);     assert.equal(s, S.PROCESSING);
  s = V.nextState(s, E.EXECUTED);  assert.equal(s, S.SUCCESS);
  s = V.nextState(s, E.SETTLE);    assert.equal(s, S.HIDDEN);
});

test('an unlisted event is a no-op, never a backwards jump', () => {
  // A result landing after the user already cancelled must not reopen anything.
  assert.equal(V.nextState(S.HIDDEN, E.EXECUTED), S.HIDDEN);
  assert.equal(V.nextState(S.HIDDEN, E.HEARD), S.HIDDEN);
  assert.equal(V.nextState(S.SUCCESS, E.HEARD), S.SUCCESS);
  assert.equal(V.nextState('nonsense-state', E.ACTIVATE), 'nonsense-state');
});

test('only listening and confirming are microphone-open states', () => {
  const open = Object.values(S).filter(V.isMicOpenState);
  assert.deepEqual(open.sort(), [S.CONFIRMING, S.LISTENING].sort());
});

test('every state can always be dismissed to hidden', () => {
  for (const from of Object.values(S)) {
    if (from === S.HIDDEN) continue;
    assert.equal(V.nextState(from, E.DISMISS), S.HIDDEN, `${from} dismisses`);
  }
});

// Regression: a typed command must never make the overlay open the microphone.
// The overlay acquires getUserMedia the moment it sees `listening`, so SUBMIT
// has to reach PROCESSING directly.
test('SUBMIT (typed input) reaches processing without passing through listening', () => {
  for (const from of [S.HIDDEN, S.IDLE, S.SUCCESS, S.ERROR]) {
    const to = V.nextState(from, E.SUBMIT);
    assert.equal(to, S.PROCESSING, `${from} --submit--> processing`);
    assert.equal(V.isMicOpenState(to), false, 'and never opens the mic');
  }
});

// Regression: a typed command that turns out to be unrecognisable enters
// PROCESSING first, so PROCESSING must be able to fail — otherwise the overlay
// sits on "Working" forever.
test('processing accepts REJECTED so an unknown typed command can fail', () => {
  assert.equal(V.nextState(S.PROCESSING, E.REJECTED), S.ERROR);
  assert.equal(V.nextState(S.PROCESSING, E.FAILED), S.ERROR);
});

test('a confirmation can be reached and answered', () => {
  const confirming = V.nextState(S.PROCESSING, E.NEEDS_CONFIRM);
  assert.equal(confirming, S.CONFIRMING);
  assert.equal(V.isMicOpenState(confirming), true, 'stays listening for yes/no');
  assert.equal(V.nextState(confirming, E.HEARD), S.PROCESSING);
  assert.equal(V.nextState(confirming, E.DISMISS), S.HIDDEN);
});

test('speaking always ends, whether it finishes or fails', () => {
  assert.equal(V.nextState(S.SPEAKING, E.SPOKEN), S.SUCCESS);
  assert.equal(V.nextState(S.SPEAKING, E.FAILED), S.ERROR);
});

// ── Settings ──────────────────────────────────────────────────────────────
test('settings coerce out-of-range values instead of storing them', () => {
  const s = V.normalizeSettings(
    { confidence: 99, speechRate: -50, listenTimeoutMs: 1, activation: 'telepathy' }, null);
  assert.equal(s.confidence, 0.95);
  assert.equal(s.speechRate, -5);
  assert.equal(s.listenTimeoutMs, 2000);
  assert.equal(s.activation, 'toggle', 'an invalid mode falls back, never sticks');
});

test('settings drop keys the app does not understand', () => {
  const s = V.normalizeSettings({ evil: 'payload', __proto__: { x: 1 }, hotkey: 'Control+Alt+J' }, null);
  assert.ok(!('evil' in s), 'unknown key never reaches disk');
  assert.equal(s.hotkey, 'Control+Alt+J');
  for (const key of Object.keys(s)) {
    assert.ok(key in V.DEFAULT_SETTINGS, `"${key}" is a known setting`);
  }
});

test("settings keep the app's '-' unbound sentinel verbatim", () => {
  // Hotkey-conflict resolution writes '-' when another binding wins the key.
  assert.equal(V.normalizeSettings({ hotkey: '-' }, null).hotkey, '-');
  // But an empty/garbage hotkey falls back rather than unbinding silently.
  assert.equal(V.normalizeSettings({ hotkey: '' }, null).hotkey, V.DEFAULT_SETTINGS.hotkey);
  assert.equal(V.normalizeSettings({ hotkey: 42 }, null).hotkey, V.DEFAULT_SETTINGS.hotkey);
});

test('a corrupt stored settings object still yields usable settings', () => {
  const s = V.normalizeSettings(null, { confidence: 'banana', activation: null });
  assert.equal(typeof s.confidence, 'number');
  assert.ok(V.ACTIVATION_MODES.includes(s.activation));
});

// ── Confidence gate ───────────────────────────────────────────────────────
// A closed grammar always returns its NEAREST phrase, so silence comes back as
// a real command. Observed on this machine with an idle mic:
//   RESULT 0.704 silence      ("silence" mutes the system)
// Short utterances therefore have to clear a much higher bar than long ones.
test('the observed room-noise result is rejected at the default threshold', () => {
  const base = V.DEFAULT_SETTINGS.confidence;
  assert.equal(V.meetsConfidence('silence', 0.704, base), false, 'noise does not mute the system');
  assert.equal(V.meetsConfidence('silence', 0.86, base), true, 'said deliberately, it works');
});

test('confidence floors scale down as an utterance gets longer', () => {
  const base = V.DEFAULT_SETTINGS.confidence;
  const one = V.confidenceFloor('pause', base);
  const two = V.confidenceFloor('next track', base);
  const many = V.confidenceFloor('set a timer for ten minutes', base);
  assert.ok(one > two, 'one word is stricter than two');
  assert.ok(two > many, 'two words are stricter than a long phrase');
  assert.equal(many, base, 'a long phrase uses the user threshold as-is');
});

test('an empty transcript can never be accepted', () => {
  assert.equal(V.meetsConfidence('', 1, 0.2), false);
  assert.equal(V.meetsConfidence('hello', NaN, 0.2), false);
});

test('the user threshold still raises the bar for long phrases', () => {
  assert.equal(V.meetsConfidence('set a timer for ten minutes', 0.62, 0.9), false);
  assert.equal(V.meetsConfidence('set a timer for ten minutes', 0.95, 0.9), true);
});

// ── Normalisation ─────────────────────────────────────────────────────────
test('politeness and wake words are stripped from the front', () => {
  assert.equal(V.normalizeTranscript('please can you open settings'), 'open settings');
  assert.equal(V.normalizeTranscript('hey main pause the music'), 'pause the music');
  assert.equal(V.normalizeTranscript('  Next   Track  '), 'next track');
});

test('courtesies are stripped from the end', () => {
  assert.equal(V.normalizeTranscript('skip this song thanks'), 'skip this song');
  assert.equal(V.normalizeTranscript('open settings please'), 'open settings');
});

test('contractions are expanded so they match the written phrases', () => {
  assert.equal(V.normalizeTranscript("what's the weather"), 'what is the weather');
  assert.equal(V.normalizeTranscript('hows the weather'), 'how is the weather');
});

test('normalisation never throws on junk input', () => {
  for (const junk of [null, undefined, 12345, '!!!???', '   ', '\n\t']) {
    assert.equal(typeof V.normalizeTranscript(junk), 'string');
  }
});

// ── Grammar compilation ───────────────────────────────────────────────────
test('the compiled grammar has no phrase claimed by two commands', () => {
  // A collision means two commands want the same words and one silently loses.
  assert.deepEqual(GRAMMAR.collisions, [], 'no unintended phrase collisions');
});

test('the grammar compiles the vocabulary into real phrases', () => {
  assert.ok(GRAMMAR.phrases.length > 200, `expected a substantial grammar, got ${GRAMMAR.phrases.length}`);
  assert.ok(!GRAMMAR.truncated, 'the grammar fits inside its cap');
  assert.ok(GRAMMAR.phrases.includes('launch valorant'));
  assert.ok(GRAMMAR.phrases.includes('open the clipboard history widget'));
  assert.ok(GRAMMAR.phrases.includes('set a timer for ten minutes'));
});

test('every compiled phrase is speakable — plain lowercase words only', () => {
  for (const p of GRAMMAR.phrases) {
    assert.match(p, /^[a-z0-9]+( [a-z0-9]+)*$/, `phrase "${p}" is safe for a closed grammar`);
  }
});

test('every phrase maps back to a real command with no parsing', () => {
  const ids = new Set(V.COMMANDS.map(c => c.id));
  for (const p of GRAMMAR.phrases) {
    const hit = GRAMMAR.index.get(p);
    assert.ok(hit, `"${p}" is indexed`);
    assert.ok(ids.has(hit.commandId), `"${p}" maps to a registered command`);
  }
});

test('the open-ended search slot is exported as a dictation carrier, not a phrase', () => {
  assert.ok(GRAMMAR.dictation.length > 0, 'there is at least one dictation carrier');
  for (const d of GRAMMAR.dictation) {
    assert.equal(d.commandId, 'search.files');
    assert.match(d.carrier, /^[a-z ]+$/);
  }
});

test('an empty vocabulary still produces a working grammar', () => {
  const g = V.compileGrammar(null);
  assert.ok(g.phrases.length > 100, 'the slotless commands still compile');
  assert.deepEqual(g.collisions, []);
  assert.ok(!g.phrases.includes('launch valorant'), 'nothing invented from an empty vocabulary');
});

// ── Vocabulary sanitising ─────────────────────────────────────────────────
test('app names are sanitised into something a recogniser can accept', () => {
  assert.equal(V.speakableName('Rockstar Games: GTA V!'), 'rockstar games gta v');
  assert.equal(V.speakableName('Ben & Jerry'), 'ben and jerry');
  assert.equal(V.speakableName('C++ Builder'), 'c plus plus builder');
  assert.equal(V.speakableName('!!!'), '', 'an unspeakable name is dropped entirely');
});

test('vocabulary entries are de-duplicated and bounded', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ id: 'id' + i, name: 'App ' + i }));
  const v = V.buildVocabulary({ apps: many.concat(many) });
  assert.ok(v.apps.length <= 120, 'capped');
  assert.equal(new Set(v.apps.map(a => a.spoken)).size, v.apps.length, 'no duplicates');
});

test('a malformed vocabulary never throws', () => {
  for (const junk of [null, 'string', 42, { apps: 'nope' }, { apps: [null, {}, { id: 'x' }] }]) {
    const v = V.buildVocabulary(junk);
    assert.ok(Array.isArray(v.apps) && Array.isArray(v.widgets) && Array.isArray(v.macros));
  }
});

// ── Matching: exact ───────────────────────────────────────────────────────
test('exact grammar phrases resolve with their parameters', () => {
  const cases = [
    ['next track', 'spotify.next', {}],
    ['open settings', 'app.openSettings', {}],
    ['launch valorant', 'app.launch', { app: 'C:/valorant.exe', appLabel: 'Valorant' }],
    ['set the volume to fifty', 'spotify.setVolume', { volume: 50 }],
    ['set a timer for ten minutes', 'timer.start', { minutes: 10 }],
    ['run the reload combo macro', 'macro.play', { macro: 'm1', macroLabel: 'Reload Combo' }]
  ];
  for (const [say, id, params] of cases) {
    const m = match(say);
    assert.equal(m.status, 'matched', `"${say}" matched`);
    assert.equal(m.commandId, id, `"${say}" → ${id}`);
    assert.deepEqual(m.params, params, `"${say}" params`);
  }
});

test('an alias resolves to the full app', () => {
  const m = match('play siege');
  assert.equal(m.commandId, 'app.launch');
  assert.equal(m.params.app, 'C:/games/RainbowSix.exe');
});

test('"open spotify" launches the app rather than opening a widget', () => {
  // widget.open phrases all carry the literal word "widget" to keep these apart.
  const m = match('open spotify');
  assert.equal(m.commandId, 'app.launch');
  assert.equal(m.params.appLabel, 'Spotify');
});

test('a bare "play" resumes music rather than launching something', () => {
  assert.equal(match('play').commandId, 'spotify.play');
});

// ── Matching: robustness ──────────────────────────────────────────────────
test('a misrecognised app name still resolves', () => {
  const m = match('launch valarant');
  assert.equal(m.commandId, 'app.launch');
  assert.equal(m.params.appLabel, 'Valorant');
});

test('filler words do not prevent a match', () => {
  assert.equal(match('please can you launch siege').commandId, 'app.launch');
  assert.equal(match('hey main pause the music').commandId, 'spotify.pause');
  assert.equal(match('skip this song thanks').commandId, 'spotify.next');
});

test('free text after the search carrier becomes the query', () => {
  const m = match('search for my valorant clips');
  assert.equal(m.commandId, 'search.files');
  assert.equal(m.params.query, 'my valorant clips');
});

test('digits and number words both work for numeric slots', () => {
  assert.equal(match('set volume to 30').params.volume, 30);
  assert.equal(match('set volume to thirty').params.volume, 30);
  assert.equal(match('timer for 15 minutes').params.minutes, 15);
});

// ── Matching: failure modes ───────────────────────────────────────────────
test('an unknown command is reported, never guessed at', () => {
  for (const junk of ['make me a sandwich', 'asdfgh', 'launch the international space station']) {
    assert.equal(match(junk).status, 'unknown', `"${junk}"`);
  }
});

test('a command with its slot missing asks for it', () => {
  const m = match('launch');
  assert.equal(m.status, 'missing-slot');
  assert.equal(m.commandId, 'app.launch');
  assert.ok(m.prompt && m.prompt.length > 0, 'there is something to ask');
});

test('an empty transcript is unknown, not a match', () => {
  assert.equal(match('').status, 'unknown');
  assert.equal(match('   ').status, 'unknown');
});

test('an app that is not in the vocabulary is not invented', () => {
  const m = match('launch photoshop');
  assert.notEqual(m.status, 'matched');
});

// ── Confirmation ──────────────────────────────────────────────────────────
test('far-reaching commands are flagged for confirmation', () => {
  const nuke = match('close background apps');
  assert.equal(nuke.commandId, 'fps.nuke');
  assert.equal(nuke.confirm, true, 'closing background apps asks first');
  assert.equal(match('next track').confirm, false, 'ordinary commands do not');
});

test('every confirm command has a prompt to show', () => {
  for (const c of V.COMMANDS.filter(c => c.confirm)) {
    assert.ok(c.confirmPrompt && c.confirmPrompt.length > 0, `${c.id} has a confirmPrompt`);
  }
});

test('spoken yes/no answers are classified, anything else is not', () => {
  assert.equal(V.matchConfirmation('yes'), 'yes');
  assert.equal(V.matchConfirmation('yeah'), 'yes');
  assert.equal(V.matchConfirmation('do it'), 'yes');
  assert.equal(V.matchConfirmation('no'), 'no');
  assert.equal(V.matchConfirmation('never mind'), 'no');
  assert.equal(V.matchConfirmation('bananas'), null, 'an unrelated word is not an answer');
  assert.equal(V.matchConfirmation(''), null);
});

// ── Registry integrity ────────────────────────────────────────────────────
test('every command is well formed', () => {
  const seen = new Set();
  for (const c of V.COMMANDS) {
    assert.match(c.id, /^[a-zA-Z]+\.[A-Za-z]+$/, `${c.id} follows area.name`);
    assert.ok(!seen.has(c.id), `${c.id} is unique`);
    seen.add(c.id);
    assert.ok(c.title && c.category, `${c.id} has a title and category`);
    assert.ok(Array.isArray(c.phrases) && c.phrases.length > 0, `${c.id} has phrases`);
    assert.ok(c.reply, `${c.id} has something to say back`);
    if (c.slot) {
      assert.ok(c.prompt, `${c.id} can ask for its missing slot`);
      assert.ok(c.phrases.some(p => p.includes('{' + c.slot + '}')), `${c.id} uses its slot`);
    }
  }
});

test('reply text resolves for both string and function replies', () => {
  for (const c of V.COMMANDS) {
    const text = V.replyFor(c, { volume: 50, minutes: 10, appLabel: 'X', widgetLabel: 'Y', macroLabel: 'Z', query: 'q' });
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${c.id} produces reply text`);
  }
});

test('the help list is generated from the registry and is fully populated', () => {
  const help = V.helpEntries(VOCAB);
  assert.ok(help.length >= 5, 'several categories');
  const total = help.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, V.COMMANDS.length - 1, 'every command except the dismiss verb is listed');
  for (const group of help) {
    for (const item of group.items) {
      assert.ok(item.example && !item.example.includes('{'), `"${item.example}" has no unfilled slot`);
    }
  }
});

// ── Number words ──────────────────────────────────────────────────────────
test('numbers round-trip between words and values', () => {
  for (const n of [0, 1, 7, 13, 20, 21, 45, 60, 99, 100]) {
    const words = V.numberToWords(n);
    assert.ok(words, `${n} has words`);
    assert.equal(V.wordsToNumber(words), n, `"${words}" → ${n}`);
  }
});

test('out-of-range and junk numbers are refused', () => {
  assert.equal(V.numberToWords(101), '');
  assert.equal(V.numberToWords(-1), '');
  assert.equal(V.wordsToNumber('elventy'), null);
  assert.equal(V.wordsToNumber(''), null);
});

// ── Wake phrases ──────────────────────────────────────────────────────────
test('a bare wake phrase wakes with no command attached', () => {
  for (const phrase of V.WAKE_PHRASES) {
    const r = V.stripWakePhrase(phrase);
    assert.equal(r.woke, true, `"${phrase}" wakes`);
    assert.equal(r.rest, '', 'and carries no command');
  }
});

test('a command spoken in the same breath is split off', () => {
  const r = V.stripWakePhrase('hey main next track');
  assert.equal(r.woke, true);
  assert.equal(r.rest, 'next track');
  assert.equal(V.matchIntent(r.rest, VOCAB, GRAMMAR).commandId, 'spotify.next');
});

test('"okay main" is not half-matched as "ok main"', () => {
  // Longest-first matching, or the leftover "ay main …" would become the command.
  assert.deepEqual(V.stripWakePhrase('okay main launch valorant'),
    { woke: true, rest: 'launch valorant' });
});

test('ordinary speech does not wake it', () => {
  for (const text of ['next track', 'hey there', 'main street', '']) {
    assert.equal(V.stripWakePhrase(text).woke, false, `"${text}" does not wake`);
  }
});

test('every wake phrase is also stripped as a leading filler', () => {
  // So "hey main pause the music" matches whether it arrives via the wake
  // grammar or is simply said while already listening.
  for (const phrase of V.WAKE_PHRASES) {
    assert.equal(V.normalizeTranscript(phrase + ' next track'), 'next track',
      `"${phrase}" is stripped by normalisation too`);
  }
});

test('wake phrases are short, lowercase and grammar-safe', () => {
  for (const phrase of V.WAKE_PHRASES) {
    assert.match(phrase, /^[a-z]+( [a-z]+)*$/, `"${phrase}" is speakable`);
    assert.ok(phrase.split(' ').length <= 3, `"${phrase}" is short enough to say quickly`);
  }
  assert.ok(V.WAKE_PHRASES.length <= 4, 'the list stays small — each one is a false-positive risk');
});

test('wake settings coerce like every other setting', () => {
  assert.equal(V.normalizeSettings({ wakeConfidence: 99 }, null).wakeConfidence, 0.95);
  assert.equal(V.normalizeSettings({ wakeConfidence: -1 }, null).wakeConfidence, 0.6);
  assert.equal(V.normalizeSettings({ wakeWord: 'yes please' }, null).wakeWord, true);
});

// ── Command chaining ──────────────────────────────────────────────────────
test('a chained utterance splits into its commands, in order', () => {
  const c = V.matchChain('pause the music and optimize my pc', VOCAB, GRAMMAR);
  assert.equal(c.chained, true);
  assert.deepEqual(c.steps.map((s) => s.commandId), ['spotify.pause', 'fps.optimize']);
});

test('every connector works, and three commands is the ceiling', () => {
  for (const conn of ['and', 'then', 'and then', 'also', 'plus']) {
    const c = V.matchChain(`next track ${conn} open settings`, VOCAB, GRAMMAR);
    assert.equal(c.chained, true, `"${conn}" chains`);
  }
  const three = V.matchChain('mute my mic and hide the launcher and flush dns', VOCAB, GRAMMAR);
  assert.equal(three.steps.length, 3);
  assert.ok(V.MAX_CHAIN === 3);
});

test('a single command is never treated as a chain', () => {
  const c = V.matchChain('next track', VOCAB, GRAMMAR);
  assert.equal(c.chained, false);
  assert.equal(c.whole.commandId, 'spotify.next');
});

// The failure this guards against: tearing a real phrase in half at an "and"
// that is part of the words themselves.
test('a connector inside a real phrase does not split it', () => {
  const vocab = V.buildVocabulary({ playlists: [{ id: 'spotify:p:1', name: 'peace and quiet' }] });
  const g = V.compileGrammar(vocab);
  const c = V.matchChain('play my peace and quiet playlist', vocab, g);
  assert.equal(c.chained, false, 'the playlist name survives');
  assert.equal(c.whole.commandId, 'spotify.playPlaylist');
  assert.equal(c.whole.params.playlistLabel, 'peace and quiet');
});

test('a chain is rejected wholesale if any part is not understood', () => {
  // Half-understanding a sentence must not half-perform it.
  const c = V.matchChain('next track and make me a sandwich', VOCAB, GRAMMAR);
  assert.equal(c.chained, false, 'falls back to matching the whole utterance');
});

test('splitChain never splits on a leading or trailing connector', () => {
  assert.deepEqual(V.splitChain('and next track'), ['and next track']);
  assert.deepEqual(V.splitChain('next track and'), ['next track and']);
  assert.deepEqual(V.splitChain(''), []);
});

test('a destructive command inside a chain still carries its confirmation flag', () => {
  const c = V.matchChain('close background apps and next track', VOCAB, GRAMMAR);
  assert.equal(c.chained, true);
  assert.equal(c.steps[0].confirm, true, 'the gate travels with the step');
});

test('chaining is a setting that can be turned off', () => {
  assert.equal(V.DEFAULT_SETTINGS.chaining, true);
  assert.equal(V.normalizeSettings({ chaining: false }, null).chaining, false);
});

// ── The expanded catalogue ────────────────────────────────────────────────
test('the catalogue is broad and every command still resolves', () => {
  assert.ok(V.COMMANDS.length >= 85, `expected a large catalogue, got ${V.COMMANDS.length}`);
  const categories = new Set(V.COMMANDS.map((c) => c.category));
  assert.ok(categories.size >= 9, `expected many categories, got ${categories.size}`);
});

test('the new slot kinds all resolve from a live vocabulary', () => {
  const vocab = V.buildVocabulary({
    apps: [{ id: 'a', name: 'Chrome' }],
    widgets: [{ id: 'timer', name: 'Countdown Timer' }],
    allWidgets: [{ id: 'crosshair', name: 'Crosshair' }],
    devices: [{ id: 'AA:BB', name: 'WH 1000XM4' }],
    sessions: [{ id: '4242', name: 'Discord' }],
    playlists: [{ id: 'spotify:playlist:9', name: 'Focus' }],
    routines: [{ id: 'r1', name: 'gaming mode' }],
    macros: []
  });
  const g = V.compileGrammar(vocab);
  const cases = [
    ['connect to wh 1000xm4', 'bluetooth.connect', 'device', 'AA:BB'],
    ['mute discord', 'app.mute', 'session', '4242'],
    ['play my focus playlist', 'spotify.playPlaylist', 'playlist', 'spotify:playlist:9'],
    ['turn on the crosshair widget', 'widget.enable', 'anyWidget', 'crosshair'],
    ['gaming mode', 'routine.run', 'routine', 'r1']
  ];
  for (const [say, id, key, value] of cases) {
    const m = V.matchIntent(say, vocab, g);
    assert.equal(m.status, 'matched', `"${say}" matched`);
    assert.equal(m.commandId, id, `"${say}" -> ${id}`);
    assert.equal(m.params[key], value, `"${say}" carries ${key}`);
  }
});

test('the fixed enum slots work without any live vocabulary', () => {
  const g = V.compileGrammar(null);
  const style = V.matchIntent('make the crosshair a circle', null, g);
  assert.equal(style.commandId, 'crosshair.style');
  assert.equal(style.params.crosshairStyle, 'circle');

  const colour = V.matchIntent('make the crosshair red', null, g);
  assert.equal(colour.commandId, 'crosshair.color');
  assert.match(colour.params.colour, /^#[0-9a-f]{6}$/i, 'a real hex colour');
});

test('the whole catalogue still compiles with no phrase collisions', () => {
  const vocab = V.buildVocabulary({
    apps: [{ id: 'a', name: 'Chrome' }, { id: 'b', name: 'Spotify' }],
    widgets: [{ id: 'timer', name: 'Countdown Timer' }],
    allWidgets: [{ id: 'timer', name: 'Countdown Timer' }, { id: 'crosshair', name: 'Crosshair' }],
    devices: [{ id: 'd', name: 'Headphones' }],
    sessions: [{ id: '1', name: 'Discord' }],
    playlists: [{ id: 'p', name: 'Focus' }],
    routines: [{ id: 'r', name: 'gaming mode' }],
    macros: [{ id: 'm', name: 'Reload Combo' }]
  });
  const g = V.compileGrammar(vocab);
  assert.deepEqual(g.collisions, [], 'no two commands claim the same words');
  assert.ok(!g.truncated, 'the grammar fits inside its cap');
  assert.ok(g.phrases.length > 500, `a large grammar: ${g.phrases.length}`);
});
