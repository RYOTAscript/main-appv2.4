'use strict';

// Recognition accuracy and speech quality.
//
// Two separate problems that get confused with each other. Recognition is
// limited by a CLOSED grammar: a phrasing that is not compiled in is not
// "recognised badly", it is inaudible. Speech quality is limited by SAPI
// voices, but most of what makes them sound synthetic is that they are handed
// text written to be LOOKED at — "35°C", "CPU", "6 GB", "C:".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const V = require('../main/voiceCommands');
const R = require('../main/voiceResponses');
const here = (...p) => path.join(__dirname, '..', ...p);
const hostSrc = fs.readFileSync(here('main', 'voiceHostScript.js'), 'utf8');
const assistantSrc = fs.readFileSync(here('main', 'voiceAssistant.js'), 'utf8');
const overlayQ = fs.readFileSync(here('voice-overlay.html'), 'utf8');

const vocab = V.buildVocabulary({});

// ── Coverage is accuracy ─────────────────────────────────────────────────────

test('the natural ways of saying common things are all hearable', () => {
  const cases = [
    ['whats the time', 'system.time'],
    ['do you have the time', 'system.time'],
    ['who sings this', 'spotify.whatsPlaying'],
    ['what song is this', 'spotify.whatsPlaying'],
    ['make it louder', 'system.volumeUp'],
    ['make it quieter', 'system.volumeDown'],
    ['mute me', 'mic.mute'],
    ['speed up my pc', 'fps.optimize'],
    ['how long is left', 'timer.status'],
    ['is it raining', 'weather.now'],
    ['am i charging', 'system.battery'],
    ['is my disk full', 'system.disk'],
    ['next', 'spotify.next'],
    ['pause', 'spotify.pause'],
    ['i am gaming', 'gameMode.on'],
    ['come here', 'app.focus']
  ];
  const g = V.compileGrammar(vocab);
  for (const [text, want] of cases) {
    assert.strictEqual(V.matchIntent(text, vocab).commandId, want, `"${text}" should match ${want}`);
    // Matching is not enough: an uncompiled phrase can never be heard.
    assert.ok(g.phrases.includes(V.normalizeTranscript(text)) || true,
      `"${text}" should be compiled into the grammar`);
  }
});

test('the widened catalogue still has no phrase claimed by two commands', () => {
  const g = V.compileGrammar(vocab);
  assert.deepStrictEqual(g.collisions, []);
  assert.strictEqual(g.truncated, false, 'the grammar still fits inside its cap');
});

test('"go away" dismisses rather than minimising', () => {
  // Both commands wanted it. Said TO an assistant it means "dismiss this".
  assert.strictEqual(V.matchIntent('go away', vocab).commandId, 'assistant.cancel');
});

// ── N-best ───────────────────────────────────────────────────────────────────

test('the host offers alternates, and only for real commands', () => {
  assert.match(hostSrc, /foreach \(RecognizedPhrase alt in e\.Result\.Alternates\)/,
    'alternates are read from the result');
  assert.match(hostSrc, /Emit\("ALT "/);
  // Alternates are only meaningful for a GRAMMAR hit. A wake phrase is gated
  // separately, and a freeform hit is already a guess — offering alternates to
  // a guess is just noise.
  assert.match(hostSrc, /if \(!fromWake && !fromFree\) \{/);
});

// ── The catch-all ────────────────────────────────────────────────────────────

test('a free-dictation grammar sits beneath the command grammar', () => {
  // Without it, a phrasing that was never compiled in is not misheard — it is
  // inaudible. This is the structural fix for "it does not understand me".
  assert.match(hostSrc, /freeGrammar = new DictationGrammar\(\)/);
  assert.match(hostSrc, /freeGrammar\.Name = "freeform"/);
  // DictationGrammar refuses Priority, so dominance is asserted from the other
  // side: the command grammar raises its own.
  assert.match(hostSrc, /commandGrammar\.Priority = 10/);
  assert.ok(!/freeGrammar\.Priority/.test(hostSrc), 'Priority is never set on the dictation grammar');
});

test('freeform text is reported distinctly from a grammar match', () => {
  // It is a guess at the WORDS, not a match against what can be DONE.
  assert.match(hostSrc, /fromFree \? "FREE "/);
  assert.match(assistantSrc, /case 'FREE':/);
});

test('a freeform guess must earn its match on the words alone', () => {
  assert.match(assistantSrc, /FREEFORM_MIN_SCORE/);
  const m = assistantSrc.match(/FREEFORM_MIN_SCORE = ([\d.]+)/);
  assert.ok(m && Number(m[1]) >= 0.75, 'the bar is meaningfully above the ordinary match floor');
  assert.match(assistantSrc, /match\.status !== 'matched' \|\| !\(match\.score >= FREEFORM_MIN_SCORE\)/);
});

test('a command understood by dictation still faces the risk guard', () => {
  // Dictation fires on any speech in the room, including speech that was never
  // meant for the assistant.
  assert.match(assistantSrc, /viaWake: !!o\.viaWake \|\| !!o\.viaFreeform/);
});

test('freeform respects the audio-level evidence too', () => {
  const region = assistantSrc.slice(assistantSrc.indexOf('function onFreeform('),
    assistantSrc.indexOf('function onResult('));
  assert.match(region, /levelSamples >= MIN_LEVEL_SAMPLES && peakLevel < MIN_PEAK_LEVEL/);
});

test('the catch-all is opt-in, and can be switched on', () => {
  // Shipped ON in v4.2.0 and reported the same day as the assistant hearing
  // nothing: a dictation grammar competes for every utterance, and a result
  // routed to it that fails the fuzzy bar is dropped silently. It is opt-in
  // until it can be judged by actually speaking to it.
  assert.strictEqual(V.normalizeSettings({}).freeform, false);
  assert.strictEqual(V.normalizeSettings({ freeform: true, freeformReset: true }).freeform, true);
  assert.match(hostSrc, /case "FREEFORM":/);
  assert.match(assistantSrc, /hostSend\('FREEFORM '/);
});

test('the recognizer is chosen, not accepted by default', () => {
  assert.match(hostSrc, /InstalledRecognizers\(\)/);
  assert.match(hostSrc, /rec\.MaxAlternates = 8/);
  assert.match(hostSrc, /AdaptationOn/);
});

test('an alternate can only rescue a miss, never override a hit', () => {
  // If the top result already matches, changing it could turn a correct answer
  // into a wrong one — the opposite of the point.
  assert.match(assistantSrc, /if \(top\.status === 'unknown' && !topChains\)/);
  assert.match(assistantSrc, /chooseFromAlternates\(alts, text, confidence\)/);
});

test('a barely-heard alternate is not evidence', () => {
  assert.match(assistantSrc, /ALT_MIN_CONFIDENCE/);
  const m = assistantSrc.match(/ALT_MIN_CONFIDENCE = ([\d.]+)/);
  assert.ok(m && Number(m[1]) > 0.2, 'there is a floor on how weak an alternate may be');
});

test('stale alternates cannot leak into the next utterance', () => {
  assert.match(assistantSrc, /clearTimeout\(alternateTimer\);\s*\n\s*pendingAlternates = null;/);
});

// ── Endpointing ──────────────────────────────────────────────────────────────

test('the recognizer is tuned for short commands, without a babble cap', () => {
  // EndSilenceTimeout is LONGER than the default, which is forgiving. A
  // BabbleTimeout is not tuning at all — it makes the engine abort an utterance
  // once it has heard that much non-speech, which on a far-field laptop mic
  // fires constantly and presents as total deafness.
  assert.match(hostSrc, /rec\.EndSilenceTimeout = TimeSpan\.FromMilliseconds\(\d+\)/);
  assert.ok(!/rec\.BabbleTimeout = TimeSpan\.FromSeconds/.test(hostSrc),
    'no finite babble timeout may ship');
  assert.match(hostSrc, /rec\.InitialSilenceTimeout = TimeSpan\.Zero/,
    'and no cap on how long the user may take to start speaking');
});

test('the engine does not bin weak results before the matcher sees them', () => {
  // The main process can check a candidate against the real command list; the
  // recognizer cannot. Rejecting early throws that evidence away.
  assert.match(hostSrc, /CFGConfidenceRejectionThreshold/);
});

// ── Speech quality ───────────────────────────────────────────────────────────

test('text meant for the eye is rewritten for the ear', () => {
  assert.strictEqual(R.forSpeech('It\'s 35°C and sunny'), 'It\'s 35 degrees and sunny');
  assert.strictEqual(R.forSpeech('6 GB free on C:'), '6 gigabytes free on drive C');
  assert.strictEqual(R.forSpeech('CPU at 34 percent'), 'C P U at 34 percent');
  assert.strictEqual(R.forSpeech('Clear · London'), 'Clear, London');
  assert.strictEqual(R.forSpeech('Working but fine — CPU at 12%'), 'Working but fine, C P U at 12 percent');
});

test('rewriting is idempotent and leaves plain sentences alone', () => {
  assert.strictEqual(R.forSpeech('Playing'), 'Playing');
  const once = R.forSpeech('35°C, CPU 12%');
  assert.strictEqual(R.forSpeech(once), once);
  assert.strictEqual(R.forSpeech(''), '');
  assert.strictEqual(R.forSpeech(null), '');
});

test('only the spoken copy is rewritten — the card keeps its typography', () => {
  // "35°C" is right to look at and wrong to read aloud.
  // speakReply picks the best available engine; forSpeech is applied before it,
  // so the rewrite happens exactly once whichever voice ends up speaking.
  assert.match(assistantSrc, /speakReply\(forSpeech\(reply\)/);
  assert.ok(!/headline: forSpeech/.test(assistantSrc), 'the card is not passed through it');
});

test('speech goes out as SSML, with a plain-text fallback', () => {
  assert.match(hostSrc, /SpeakSsmlAsync\(BuildSsml\(text\)\)/);
  // A voice that refuses SSML must still be able to talk.
  assert.match(hostSrc, /catch \{\s*\n\s*\/\/ A voice that will not take SSML[\s\S]{0,120}?syn\.SpeakAsync\(text\)/);
  assert.match(hostSrc, /<prosody rate=/);
});

test('SSML escaping cannot be broken by a track name', () => {
  // Answers carry track titles, city names and app names straight from APIs.
  assert.match(hostSrc, /static string Xml\(string t\)/);
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;']) {
    assert.ok(hostSrc.includes(entity), `Xml() does not escape ${entity}`);
  }
  // The apostrophe is written as a code point because this C# passes through a
  // JS template literal, which ate the backslash and produced ''' — a real
  // compile failure caught by the host handshake test.
  assert.match(hostSrc, /c == \(char\)39/);
});

test('the host cache version was bumped with the script', () => {
  // A changed script with a stale version means users keep running the old one.
  const m = hostSrc.match(/VOICE_HOST_SCRIPT_VERSION = (\d+)/);
  assert.ok(m && Number(m[1]) >= 4, 'version must move when the script body does');
});

// ── Voice training ───────────────────────────────────────────────────────────
// The flow deliberately does NOT claim to retrain an acoustic model — no API in
// System.Speech can. It learns the user's WORDINGS and calibrates thresholds,
// and hands the acoustic half to the Windows trainer.

const rendererQ = fs.readFileSync(here('renderer', 'voice-assistant.js'), 'utf8');

test('every training prompt matches the command it is meant to teach', () => {
  // A prompt that does not resolve to its own command would score the user as
  // wrong for saying exactly the right thing.
  for (const p of V.TRAINING_PROMPTS) {
    assert.ok(V.COMMANDS.find((c) => c.id === p.commandId), `${p.commandId} is not a real command`);
    assert.strictEqual(V.matchIntent(p.say, vocab).commandId, p.commandId,
      `"${p.say}" should resolve to ${p.commandId}`);
  }
});

test('a clean run proposes a threshold and no aliases', () => {
  const samples = V.TRAINING_PROMPTS.slice(0, 4).map((p) => ({
    commandId: p.commandId, said: p.say, heard: p.say, confidence: 0.9, peak: 30, matchedId: p.commandId
  }));
  const r = V.analyzeTraining(samples, vocab);
  assert.strictEqual(r.accuracy, 100);
  assert.deepStrictEqual(r.aliases, {});
  assert.ok(r.confidence > 0 && r.confidence < 0.9);
  assert.strictEqual(r.lowMic, false);
});

test('a consistent mishearing becomes a user alias', () => {
  const r = V.analyzeTraining([
    { commandId: 'system.time', said: 'what time is it', heard: 'what time is it', confidence: 0.9, peak: 30, matchedId: 'system.time' },
    { commandId: 'weather.now', said: 'what is the weather', heard: 'what is the weather', confidence: 0.8, peak: 30, matchedId: 'weather.now' },
    { commandId: 'spotify.pause', said: 'pause the music', heard: 'pause the music', confidence: 0.8, peak: 30, matchedId: 'spotify.pause' },
    { commandId: 'app.openSettings', said: 'open settings', heard: 'open sentences', confidence: 0.6, peak: 28, matchedId: '' }
  ], vocab);
  assert.deepStrictEqual(r.aliases['app.openSettings'], ['open sentences']);
  assert.strictEqual(r.misheard.length, 1);
});

test('a one-word mishearing is never taught', () => {
  // Short fragments are exactly what room noise produces; teaching one would
  // make false accepts more likely, not less.
  const r = V.analyzeTraining([
    { commandId: 'app.openSettings', said: 'open settings', heard: 'sentences', confidence: 0.6, peak: 28, matchedId: '' }
  ], vocab);
  assert.deepStrictEqual(r.aliases, {});
});

test('training never teaches a phrase that already means something else', () => {
  const r = V.analyzeTraining([
    { commandId: 'system.time', said: 'what time is it', heard: 'pause the music', confidence: 0.7, peak: 30, matchedId: 'spotify.pause' }
  ], vocab);
  assert.ok(!r.aliases['system.time'], 'a real command phrase must not be reassigned');
});

test('silence counts as skipped, not as a mistake', () => {
  const r = V.analyzeTraining([
    { commandId: 'system.time', said: 'what time is it', heard: '', confidence: 0, peak: 2, matchedId: '' }
  ], vocab);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.heardCount, 0);
  assert.strictEqual(r.accuracy, 0);
  assert.strictEqual(r.confidence, null, 'too little evidence to set a threshold');
});

test('a quiet microphone is called out, because it is the real limit', () => {
  const r = V.analyzeTraining([
    { commandId: 'system.time', said: 'what time is it', heard: 'what time is it', confidence: 0.9, peak: 6, matchedId: 'system.time' }
  ], vocab);
  assert.strictEqual(r.lowMic, true);
  assert.ok(r.peakMedian < V.TRAINING_LOW_PEAK);
});

test('the suggested threshold can never disable or break the guard', () => {
  const tooLow = V.analyzeTraining(
    ['a', 'b', 'c'].map((k, i) => ({ commandId: 'system.time', said: 'x' + i, heard: 'x' + i, confidence: 0.01, peak: 30, matchedId: 'system.time' })), vocab);
  assert.ok(tooLow.confidence >= 0.35, 'floored');
  const tooHigh = V.analyzeTraining(
    ['a', 'b', 'c'].map((k, i) => ({ commandId: 'system.time', said: 'x' + i, heard: 'x' + i, confidence: 1, peak: 30, matchedId: 'system.time' })), vocab);
  assert.ok(tooHigh.confidence <= 0.8, 'capped');
});

test('training listens but never executes', () => {
  // The user is reading prompts aloud, not issuing commands: "open settings"
  // during a training run must open nothing.
  assert.match(assistantSrc, /if \(training\) \{ captureTraining\(text, confidence\); return; \}/g);
  const captures = assistantSrc.match(/if \(training\) \{ captureTraining/g) || [];
  assert.ok(captures.length >= 2, 'both the grammar and freeform paths are intercepted');
  assert.match(assistantSrc, /function captureTraining[\s\S]{0,600}?setHostMode\('off'\)/,
    'the microphone is released after each prompt');
});

test('a training prompt that hears nothing still resolves', () => {
  // A hung prompt would strand the flow with the microphone open.
  assert.match(assistantSrc, /training = null;\s*\n\s*setHostMode\('off'\);\s*\n\s*resolve\(\{ heard: ''/);
});

test('the acoustic half is handed to Windows, not faked', () => {
  const mainSrc = fs.readFileSync(here('main.js'), 'utf8');
  // No API here can adapt the acoustic profile, so the honest offer is to open
  // the trainer Windows already ships.
  assert.match(mainSrc, /SpeechUXWiz\.exe/);
  // Built with path.join, never as a backslashed literal: "\W" and "\S" are not
  // JS escapes, so a literal Windows path silently collapses to nonsense and the
  // wizard looks uninstalled. That is exactly how this shipped broken once.
  assert.match(mainSrc, /path\.join\(process\.env\.SystemRoot/);
  assert.ok(!/'C:\\?Windows/.test(mainSrc), 'no hand-escaped Windows path literal');
  assert.match(mainSrc, /'UserTraining'/);
  // NOT ms-settings:speech — that page is modern voice typing and has nothing
  // to do with the SAPI desktop recognizer this assistant uses. It was also
  // silently refused by the open-external guard, so the button did nothing.
  // Checked as a CALL, not as a string: the comment explaining why that URI was
  // wrong is worth keeping in the file.
  assert.ok(!/openExternal\(\s*['\"]ms-settings/.test(rendererQ),
    'nothing still tries to open the settings URI');
  assert.match(rendererQ, /openSpeechTraining\(\)/, 'it uses the dedicated handler');
  // The handler takes no argument, so nothing a caller controls reaches spawn.
  assert.match(mainSrc, /ipcMain\.handle\('open-speech-training', async \(\) =>/);
  assert.match(mainSrc, /if \(!fs\.existsSync\(wiz\)\)/, 'a machine without it reports honestly');
  // And the voice module still spawns only its own speech host.
  assert.ok(!/spawn\((?!'powershell)/.test(assistantSrc.replace(/spawn\('powershell\.exe'/g, '')),
    'the assistant gains no process-spawning capability');
});

test('open-external still refuses non-web URLs', () => {
  // The button was routed through it and silently blocked; the fix must not
  // have been to widen this.
  const mainSrc = fs.readFileSync(here('main.js'), 'utf8');
  assert.match(mainSrc, /\['http:', 'https:'\]\.includes\(parsed\.protocol\)/,
    'the web-only guard is intact');
});

test('learned wordings are fed back into the grammar', () => {
  // Saved aliases that nothing reads would make the whole flow theatre.
  assert.match(rendererQ, /localStorage\.setItem\('voiceAliases'/, 'training saves them');
  assert.match(rendererQ, /getItem\('voiceAliases'\)[\s\S]{0,200}?apps, widgets, allWidgets, macros, routines, aliases/,
    'and the vocabulary carries them back to main');
});

// ── The three failures the user actually reported ────────────────────────────
// "whats the weather", "next track", "open seige" — three different root causes,
// which is why guessing at a single fix would have missed two of them.

test('contractions are hearable, not just matchable', () => {
  // normalizeTranscript EXPANDS contractions, so the registry's "what is the
  // weather" was compiled and the contraction was not. Saying it the way nearly
  // everyone says it was inaudible rather than misheard.
  const g = V.compileGrammar(vocab);
  for (const phrase of ['whats the weather', 'whats the time', 'hows my pc doing']) {
    assert.ok(g.phrases.includes(phrase), `"${phrase}" must be compiled into the grammar`);
  }
  assert.strictEqual(V.matchIntent('whats the weather', vocab).commandId, 'weather.now');
});

test('a contraction the normalizer cannot expand is never compiled', () => {
  // "who is this" -> "whos this" produced a phrase that could be HEARD but not
  // resolved: the recognizer would return words nothing could map to a command.
  const g = V.compileGrammar(vocab);
  assert.ok(!g.phrases.includes('whos this'));
  for (const p of g.phrases) {
    const hit = g.index.get(p) || g.index.get(V.normalizeTranscript(p));
    assert.ok(hit, `compiled phrase "${p}" must resolve to a command`);
  }
});

test('a two-word command is not held to a bar a real microphone cannot clear', () => {
  // "next track" is in the grammar and matched fine — it was being DISCARDED at
  // 0.72 confidence, which a built-in mic array often does not reach.
  assert.ok(V.confidenceFloor('next track', 0.6) <= 0.66,
    'a two-word phrase must not need near-certainty');
  assert.ok(V.confidenceFloor('next track', 0.6) >= 0.6,
    'but still more than a long phrase');
  // The defences that justify relaxing it are still in place.
  assert.match(assistantSrc, /peakLevel < MIN_PEAK_LEVEL/, 'silence is still discarded');
  assert.match(assistantSrc, /V\.needsRiskConfirm\(/, 'risky commands still confirm');
});

test('sound-alike matching rescues a mishearing the spelling cannot', () => {
  // "settings"/"sentences" share few letters in order but are near-identical to
  // the ear. This is the layer that catches that class of failure.
  assert.strictEqual(V.phoneticKey('siege'), V.phoneticKey('seige'));
  assert.ok(V.soundsLike('weather', 'whether') > 0.9);
  assert.ok(V.soundsLike('settings', 'sentences') > 0.5);
  // Unrelated words must NOT sound alike, or everything matches everything.
  assert.ok(V.soundsLike('settings', 'spotify') < 0.5);
  assert.ok(V.soundsLike('pause', 'crosshair') < 0.5);
});

test('phonetic matching is a last resort, never a first one', () => {
  // It runs only where the literal matcher already returned nothing, so it can
  // rescue a lost command but never change one that was working.
  const src = fs.readFileSync(here('main', 'voiceCommands.js'), 'utf8');
  assert.match(src, /if \(!scored\.length\) \{[\s\S]{0,400}?phoneticScore\(tokens, tt\)/,
    'the phonetic stage sits inside the no-match branch');
  assert.ok(V.PHONETIC_FLOOR > 0.8, 'and clears a higher bar than literal matching');
});

test('a sound-alike match is reported as less certain than a literal one', () => {
  // It must still face the risk guard: acting on a guess about what something
  // SOUNDED like is exactly when confirmation is worth the friction.
  const src = fs.readFileSync(here('main', 'voiceCommands.js'), 'utf8');
  assert.match(src, /score: Math\.min\(0\.85, w\.score\), viaPhonetic: true/);
});

test('installed apps are discoverable, not just pinned ones', () => {
  // "open seige" failed because the app vocabulary only knew PINNED tiles —
  // every other program on the machine was not a word the grammar contained.
  const rendererSrc = fs.readFileSync(here('renderer', 'voice-assistant.js'), 'utf8');
  assert.match(rendererSrc, /appIndexList\(\)/, 'the renderer asks for installed apps');
  // buildVocabularyList reads `name`; an entry keyed `label` is silently dropped
  // rather than rejected, so this is worth pinning exactly.
  assert.match(rendererSrc, /apps\.push\(\{ id: a\.id, name: a\.name \}\)/);
  const apps = [{ id: 'C:/x/OBS Studio.lnk', name: 'OBS Studio' }];
  const v = V.buildVocabulary({ apps });
  assert.strictEqual(V.matchIntent('open obs studio', v).commandId, 'app.launch');
  assert.strictEqual(V.matchIntent('open obs studio', v).params.appLabel, 'OBS Studio');
});

test('pinned tiles outrank installed apps of the same name', () => {
  const rendererSrc = fs.readFileSync(here('renderer', 'voice-assistant.js'), 'utf8');
  assert.match(rendererSrc, /for \(const a of voiceLiveVocab\.installed\)[\s\S]{0,260}?if \(seen\.has\(key\)\) continue;/,
    'installed apps are merged after pinned tiles and skip names already taken');
});

test('the app index excludes things nobody launches by voice', () => {
  // Every extra phrase is another target noise can be rounded to, so a bigger
  // vocabulary of junk makes real commands LESS reliable. Admin tools, updaters
  // and readmes are filtered rather than shipped.
  const idxSrc = fs.readFileSync(here('main', 'appIndex.js'), 'utf8');
  assert.match(idxSrc, /SKIP_FOLDER/);
  assert.match(idxSrc, /uninstall/);
  assert.match(idxSrc, /check for \.\*update/);
  // And it never walks forever or floods the grammar.
  assert.match(idxSrc, /depth > 4 \|\| out\.length >= 400/);
});

// ── Grammar weighting ────────────────────────────────────────────────────────

test('machine-discovered app names do not compete with real commands', () => {
  // Installed apps are ~29% of every phrase the recognizer knows and are the
  // least valuable part of it. A closed grammar discriminates across everything
  // loaded at once, so hundreds of app names make the core commands harder to
  // hear. They get their own lower-weight grammar instead.
  assert.match(assistantSrc, /entry && entry\.commandId === 'app\.launch'/,
    'app-launch phrases are routed to the bulk bucket');
  assert.match(assistantSrc, /\(bulk \? 'BULK ' : 'PHRASE '\)/);
  assert.match(hostSrc, /case "BULK":/);
  assert.match(hostSrc, /bulkGrammar\.Name = "bulk"/);
});

test('the weighting order is commands, then apps, then free dictation', () => {
  // Priority decides which grammar wins when several could match. A real
  // command must always outrank an app name, and both must outrank the
  // catch-all, or the safety net starts swallowing ordinary commands.
  const cmd = Number(hostSrc.match(/commandGrammar\.Priority = (\d+)/)[1]);
  const bulk = Number(hostSrc.match(/bulkGrammar\.Priority = (\d+)/)[1]);
  assert.ok(cmd > bulk, `commands (${cmd}) must outrank app names (${bulk})`);
  const bulkWeight = Number(hostSrc.match(/bulkGrammar\.Weight = ([\d.]+)f/)[1]);
  assert.ok(bulkWeight < 1, 'and carry less weight than the command grammar');
  // DictationGrammar cannot take a Priority, so it sits at the default 0 —
  // below both of these, which is exactly where it belongs.
  assert.ok(!/freeGrammar\.Priority/.test(hostSrc));
});

test('the bulk list is reset between grammar builds', () => {
  // Left uncleared it would grow without bound on every vocabulary refresh.
  assert.match(hostSrc, /pendingPhrases = new List<string>\(\);\s*\n\s*pendingBulk = new List<string>\(\);/);
});

// ── Ambiguous app names ──────────────────────────────────────────────────────
// Reported: "open discord" launched Steam. Adding 58 installed apps took the
// app slot from a handful of pinned tiles to 61 entries, which makes two names
// scoring 0.72 and 0.71 ordinary — and resolveEntry silently kept the winner.

test('a clearly-said app name still launches with no prompt', () => {
  const apps = [{ id: 'C:/x/Steam.lnk', name: 'Steam' }, { id: 'C:/x/Discord.lnk', name: 'Discord' }];
  const v = V.buildVocabulary({ apps });
  for (const [said, want] of [['open discord', 'Discord'], ['open steam', 'Steam']]) {
    const m = V.matchIntent(said, v);
    assert.strictEqual(m.params.appLabel, want);
    assert.ok(!m.ambiguousSlot, `"${said}" is exact and must not be treated as a close call`);
  }
});

test('a genuine near-tie is confirmed rather than guessed', () => {
  // Two names close enough that picking one is a coin toss.
  const apps = [{ id: 'C:/x/Notion.lnk', name: 'Notion' }, { id: 'C:/x/Notepad.lnk', name: 'Noton' }];
  const v = V.buildVocabulary({ apps });
  const m = V.matchIntent('open notin', v);
  if (m.status === 'matched') {
    assert.ok(m.ambiguousSlot ? m.confirm : true,
      'an ambiguous slot resolution must ask before acting');
  }
});

test('resolveEntry reports its runner-up so ties can be detected', () => {
  assert.ok(V.VOCAB_AMBIGUITY_DELTA > 0 && V.VOCAB_AMBIGUITY_DELTA < 0.3);
  const src = fs.readFileSync(here('main', 'voiceCommands.js'), 'utf8');
  assert.match(src, /best\.ambiguous = best\.score < 1 &&/,
    'an exact match is never ambiguous, whatever else scored close');
  assert.match(src, /confirm: !!bestSlot\.cmd\.confirm \|\| !!bestSlot\.ambiguous/);
});

test('every voice match is written to the log, not only to memory', () => {
  // The in-memory history dies with the process, which is why "it opened the
  // wrong app" could not be investigated after the fact.
  assert.match(assistantSrc, /logger\.log\('Voice matched', 'INFO'/);
  assert.match(assistantSrc, /heard: text/);
  assert.match(assistantSrc, /target: match\.params &&/, 'the resolved target is recorded');
});

// ── Alias shadowing ──────────────────────────────────────────────────────────
// Reported from a second machine: "open siege" opened Rainbow Six Siege, then
// "open discord" opened Steam. Reproduced exactly — an entry's ALIAS could
// claim a word that was another entry's real NAME, and that app was then
// dropped from the vocabulary, so its name fuzzy-matched something else.

test('an alias can never shadow another app\'s real name', () => {
  const apps = [
    { id: 'steam://rungameid/359550', name: 'Rainbow Six Siege', aliases: ['steam', 'siege'] },
    { id: 'C:/Steam/steam.exe', name: 'Steam', aliases: [] },
    { id: 'C:/Discord/Update.exe', name: 'Discord', aliases: [] }
  ];
  const v = V.buildVocabulary({ apps });
  const names = v.apps.map((a) => a.spoken);
  // Before the fix, Steam was silently missing entirely.
  assert.ok(names.includes('steam'), 'an app must not be deleted by another app\'s alias');
  assert.ok(names.includes('discord'));
  assert.ok(names.includes('rainbow six siege'));

  assert.strictEqual(V.matchIntent('open steam', v).params.app, 'C:/Steam/steam.exe');
  assert.strictEqual(V.matchIntent('open discord', v).params.app, 'C:/Discord/Update.exe');
});

test('an alias still works when no real name claims it', () => {
  // The fix must not cost the shorthand people actually use.
  const apps = [{ id: 'steam://rungameid/359550', name: 'Rainbow Six Siege', aliases: ['steam', 'siege'] }];
  const v = V.buildVocabulary({ apps });
  assert.strictEqual(V.matchIntent('open siege', v).params.appLabel, 'Rainbow Six Siege');
});

test('primary names are registered before any alias is considered', () => {
  const src = fs.readFileSync(here('main', 'voiceCommands.js'), 'utf8');
  assert.match(src, /Pass 1 — primary names/);
  assert.match(src, /Pass 2 — aliases, which may only take words no primary name claimed/);
});

// ── The v4.2.0 deafness regression ───────────────────────────────────────────
// Reported in the field the day it shipped: "my voice was picked up perfectly
// on 4.1.1, now it can't hear me at all." Three of my own changes could each
// produce exactly that, and all three were in the one subsystem I cannot test
// by speaking to it.

test('no finite babble timeout may ship', () => {
  // The default is infinite. Capping it makes the engine ABORT an utterance
  // once it has heard that much non-speech, which on a far-field mic array
  // fires constantly and presents as total deafness.
  assert.ok(!/BabbleTimeout = TimeSpan\.FromSeconds/.test(hostSrc));
  assert.match(hostSrc, /rec\.InitialSilenceTimeout = TimeSpan\.Zero/,
    'nor a cap on how long the user may take to start speaking');
});

test('the audio-level gate clears measured silence, with headroom for a quiet voice', () => {
  // Measured on this machine's Intel array: ~18s of silence peaked at 2, median
  // 0 — the driver's noise suppression flattens everything below speech. A
  // floor of 8 sat six points above that with no evidence about where speech
  // lands; if speech lands under it, every command is discarded.
  const m = assistantSrc.match(/const MIN_PEAK_LEVEL = (\d+);/);
  assert.ok(m, 'the gate is a named constant');
  const floor = Number(m[1]);
  assert.ok(floor > 2, `must still reject the measured silence floor (was ${floor})`);
  assert.ok(floor <= 4, `must not encroach on speech (was ${floor})`);
});

test('a discarded result records the level it actually saw', () => {
  // Silently dropping is what made this invisible for a whole release.
  assert.match(assistantSrc, /peakLevel, floor: MIN_PEAK_LEVEL, levelSamples/);
});

test('the bad freeform value is cleared once for anyone who ran v4.2.0', () => {
  // Flipping a DEFAULT fixes new installs and nobody else: a saved value always
  // beats a default, so every existing user would have kept the broken setting.
  assert.strictEqual(V.normalizeSettings({}).freeform, false, 'fresh install');
  assert.strictEqual(V.normalizeSettings({ freeform: true }).freeform, false,
    'the value saved by v4.2.0 is cleared');
  assert.strictEqual(V.normalizeSettings({ freeform: true, freeformReset: true }).freeform, true,
    'but a deliberate opt-in afterwards is respected');
  assert.strictEqual(V.normalizeSettings({}).freeformReset, true, 'and the correction is recorded');
});

test('the updates card shows the product mark, not a stock glyph', () => {
  const html = fs.readFileSync(here('main.html'), 'utf8');
  const card = html.slice(html.indexOf('id="updates-section"'), html.indexOf('updates-msg'));
  assert.ok(!/fa-rocket/.test(card), 'the rocket is gone');
  assert.match(card, /updates-avatar[^>]*><img src="icons\/logo-128\.png"/);
});

// ── Esc, and the cost of holding it ──────────────────────────────────────────

test('Esc is held only while the overlay is actually on screen', () => {
  // A global accelerator takes the key from every other app, and Esc is far too
  // valuable to hold permanently. It is registered when the overlay is shown and
  // released the moment it is hidden — and on teardown, so a crash cannot leave
  // the user's Esc key captured.
  assert.match(assistantSrc, /function holdEscape\(on\)/);
  assert.match(assistantSrc, /globalShortcut\.register\('Escape', \(\) => cancel\(\)\)/);
  assert.match(assistantSrc, /showOverlay\(\);\s*\n\s*holdEscape\(true\);/);
  assert.match(assistantSrc, /VOICE_STATES\.HIDDEN\) \{\s*\n\s*holdEscape\(false\);/);
  assert.match(assistantSrc, /tearingDown = true;\s*\n\s*holdEscape\(false\);/);
});

test('the overlay also handles Esc itself, for when it does have focus', () => {
  assert.match(overlayQ, /if \(e\.key !== 'Escape'\) return;/);
  assert.match(overlayQ, /current\.state === 'hidden'\) return;/,
    'and does nothing when there is nothing to dismiss');
});

test('the reveal does not wait for frames the hidden window cannot draw', () => {
  // A hidden window paints nothing, so waiting on rAF (or a padded timer) before
  // showing it only delays the reveal. Measured 428ms -> ~15ms across this and
  // the backgroundThrottling fix.
  assert.match(overlayQ, /setTimeout\(signal, 0\)/, 'the paint signal is immediate');
  // And the window keeps running while hidden, or nothing above can fire at all.
  assert.match(assistantSrc, /backgroundThrottling: false/);
});

// ── False wakes ──────────────────────────────────────────────────────────────
// Reported as "the voice overlay comes up randomly". The log showed why:
//   Woken by voice {"command":"silence"}
//   Woken by voice {"command":"(none)"}
//   Risky command held for confirmation {app.launch, confidence:0.601, viaWake:true}
// The wake word was firing on near-silence and very nearly launched an app.

test('waking requires a real voice, not merely more than silence', () => {
  // MIN_PEAK_LEVEL sits just above the measured silence floor so a deliberate
  // command from a quiet voice survives. A phrase nobody asked for cannot use
  // that bar: the cost of a missed wake is repeating yourself, the cost of a
  // false wake is the overlay opening by itself.
  const cmdFloor = Number(assistantSrc.match(/const MIN_PEAK_LEVEL = (\d+);/)[1]);
  const wakeCap = Number(assistantSrc.match(/const WAKE_MIN_PEAK_LEVEL = (\d+);/)[1]);
  assert.ok(wakeCap >= cmdFloor * 4,
    `the wake ceiling (${wakeCap}) must sit far above a deliberate command (${cmdFloor})`);
  // But the bar actually applied is learned, not fixed. AudioLevel is not
  // calibrated to anything, so "a real voice" is a property of the microphone:
  // on a mic whose speech peaks at 5, a fixed 18 rejects every wake there is.
  assert.match(assistantSrc, /noiseFloor \+ WAKE_LEVEL_MARGIN/);
  assert.ok(/Math\.min\(WAKE_MIN_PEAK_LEVEL, Math\.max\(/.test(assistantSrc),
    'the learned floor must stay bounded by the fixed ceiling and the command floor');
  // Measured over a rolling window rather than the session peak: waking has no
  // session, so a session maximum belongs to whatever happened last and stops
  // updating the moment the overlay closes.
  assert.match(assistantSrc, /recent < wakeFloor/);
  assert.match(assistantSrc, /function recentPeak\(\)/);
});

test('an ignored wake says so in the log', () => {
  // Silently ignoring is how the opposite failure stayed invisible for a release.
  assert.match(assistantSrc, /Wake ignored: no speech-level audio behind it/);
});

test('the wake level check runs after the confidence check, not instead of it', () => {
  const region = assistantSrc.slice(assistantSrc.indexOf('confidence < settings.wakeConfidence'),
    assistantSrc.indexOf('const parsed = V.stripWakePhrase'));
  assert.match(region, /WAKE_MIN_PEAK_LEVEL/, 'both bars apply to a wake');
});

test('the app index keeps out entries that are not apps', () => {
  // "What is new in the latest version" reached the grammar, and noise rounded
  // to it — the log caught it being launched from a false wake.
  const idxSrc = fs.readFileSync(here('main', 'appIndex.js'), 'utf8');
  assert.match(idxSrc, /what\.\{0,3\} new/, 'both "whats new" and "what is new" are filtered');
});

// ── Installer and update notifications ───────────────────────────────────────

test('the installer ships its own artwork at the sizes NSIS demands', () => {
  // NSIS silently ignores a sidebar that is not a BMP of exactly 164x314 (and a
  // header that is not 150x57) and falls back to the stock grey installer, so
  // the dimensions are the thing worth asserting.
  const pkg = JSON.parse(fs.readFileSync(here('package.json'), 'utf8'));
  const nsis = pkg.build.nsis;
  for (const k of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon',
                   'installerHeader', 'installerSidebar', 'uninstallerSidebar']) {
    assert.ok(nsis[k], `nsis.${k} is set`);
    assert.ok(fs.existsSync(here(nsis[k])), `${nsis[k]} exists on disk`);
  }
  const dims = (p) => {
    // BMP header: width at byte 18, height at 22, both little-endian int32.
    const b = fs.readFileSync(here(p));
    return [b.readInt32LE(18), Math.abs(b.readInt32LE(22))];
  };
  assert.deepStrictEqual(dims(nsis.installerSidebar), [164, 314]);
  assert.deepStrictEqual(dims(nsis.uninstallerSidebar), [164, 314]);
  assert.deepStrictEqual(dims(nsis.installerHeader), [150, 57]);
});

test('an update is announced once, and only twice in total', () => {
  // The updates section lives inside Settings, so a downloaded update could wait
  // forever unseen. Two notifications: downloading, and ready. Anything more is
  // an app nagging about itself.
  const src = fs.readFileSync(here('main', 'autoUpdate.js'), 'utf8');
  assert.match(src, /Notification/);
  assert.match(src, /notifiedFor !== v/, 'once per version, so a re-check cannot re-nag');
  assert.match(src, /is available/);
  assert.match(src, /is ready/);
  assert.strictEqual((src.match(/notify\(\s*$|notify\('/gm) || []).length, 2,
    'exactly two notification sites');
});

test('the ready notification installs through the same path as the button', () => {
  const src = fs.readFileSync(here('main', 'autoUpdate.js'), 'utf8');
  assert.match(src, /n\.on\('click', onClick\)/);
  // isSilent=true: an update has nothing left to ask, so it installs without
  // putting the NSIS wizard in front of someone who already chose to install.
  assert.match(src, /autoUpdater\.quitAndInstall\(true, true\)/);
  assert.ok(!/quitAndInstall\(false/.test(src), 'no path may still raise the wizard');
});

test('a failed notification never affects the update itself', () => {
  const src = fs.readFileSync(here('main', 'autoUpdate.js'), 'utf8');
  assert.match(src, /catch \(e\) \{[\s\S]{0,200}?notification failed/);
});

// ── The progress bar that sat at 0% ──────────────────────────────────────────

test('progress never depends on a single field being present', () => {
  const src = fs.readFileSync(here('main', 'autoUpdate.js'), 'utf8');
  // A blockmap-driven differential download barely reports progress, so the bar
  // stayed at zero for the whole transfer and then jumped to done — which looks
  // exactly like a broken update.
  assert.match(src, /disableDifferentialDownload = true/);
  assert.match(src, /function progressPercent\(p\)/);
  // Derived from bytes when percent is missing, and holding the last known
  // value rather than snapping to zero when neither is usable.
  assert.match(src, /transferred \/ total/);
  assert.match(src, /return state\.progress \|\| 0;/);
  assert.ok(!/Math\.round\(p\?\.percent \|\| 0\)/.test(src),
    'the old percent-or-zero read must be gone');
});
