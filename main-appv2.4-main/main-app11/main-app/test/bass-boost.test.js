'use strict';

// Bass Boost: the pure engine (renderer/bass-engine.js), the wiring between
// registry / preload / main / panel, and — on Windows — the real C# audio host
// compiled and driven over its protocol, with its DSP measured against the
// engine's own response curve (the curve on screen must be the sound).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const E = require('../renderer/bass-engine');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

const sumDb = (prefs, f) => E.biquads(prefs).reduce((d, q) => d + E.magnitudeDb(q, f), 0);

// ── Engine ────────────────────────────────────────────────────────────────
test('defaults are sane and junk is coerced', () => {
  const d = E.sanitizePrefs(null);
  assert.equal(d.on, false);
  assert.equal(d.bands.length, 10);
  assert.equal(d.hotkey, 'CommandOrControl+Alt+B');
  const j = E.sanitizePrefs({ bass: 999, freq: -5, punch: 'x', bands: [100, -100, 'a'], guard: 37, device: 'C:\\evil', output: 99 });
  assert.equal(j.bass, 24);
  assert.equal(j.freq, 30);
  assert.equal(j.bands[0], 12);
  assert.equal(j.bands[1], -12);
  assert.equal(j.bands[2], E.DEFAULT_PREFS.bands[2]);
  assert.equal(j.guard, E.DEFAULT_PREFS.guard);
  assert.equal(j.device, '');
  assert.equal(j.output, 12);
});

test('every preset is inside the limits and loads exactly', () => {
  for (const p of E.PRESETS) {
    const loaded = E.applyPatch(E.sanitizePrefs({}), { preset: p.id });
    assert.equal(loaded.preset, p.id);
    assert.equal(loaded.bass, p.bass);
    assert.deepEqual(loaded.bands, p.bands);
    assert.ok(p.bass >= 0 && p.bass <= 24);
  }
  assert.ok(E.PRESETS.some((p) => p.bass === 24), 'one preset goes all the way');
});

test('touching a control turns the preset into custom; power does not', () => {
  const p = E.applyPatch(E.sanitizePrefs({}), { preset: 'heavy' });
  assert.equal(E.applyPatch(p, { on: true }).preset, 'heavy');
  assert.equal(E.applyPatch(p, { bass: 13 }).preset, 'custom');
  assert.equal(E.applyPatch(p, { band: { index: 3, value: 2 } }).preset, 'custom');
});

test('a peaking band is its gain at its centre; a shelf reaches its gain', () => {
  const pk = E.peaking(1000, 9, 1.414, 48000);
  assert.ok(Math.abs(E.magnitudeDb(pk, 1000) - 9) < 1e-6);
  const sh = E.lowShelf(80, 18, 48000);
  assert.ok(Math.abs(E.magnitudeDb(sh, 20) - 18) < 0.5, 'shelf at full gain well below its corner');
  assert.ok(Math.abs(E.magnitudeDb(sh, 5000)) < 0.05, 'and flat far above it');
  assert.ok(Math.abs(E.magnitudeDb(sh, 80) - 9) < 0.5, 'half the gain at the corner');
});

test('the speaker guard cuts the sub-bass it is set for', () => {
  const p = E.sanitizePrefs({ bass: 24, freq: 60, guard: 40, punch: 0, bands: new Array(10).fill(0) });
  assert.ok(sumDb(p, 15) < sumDb(p, 60) - 15, 'deep sub is far below the boost');
  const off = E.sanitizePrefs(Object.assign({}, p, { guard: 0 }));
  assert.ok(sumDb(off, 15) > sumDb(p, 15) + 10);
});

test('auto-protect: mids get a little headroom, the bass a bounded drive', () => {
  for (const speaker of Object.keys(E.SPEAKERS)) {
    for (const p of E.PRESETS) {
      const prefs = E.applyPatch(E.sanitizePrefs({ speaker }), { preset: p.id });
      const pre = E.preampDb(prefs);
      assert.ok(pre <= 0);
      const mids = E.peakGainDb(prefs, E.crossoverHz(prefs) * 1.8);
      assert.ok(mids + pre <= E.MID_HEADROOM_DB + 1e-9, `${speaker}/${p.id} mids ${mids + pre}`);
      assert.ok(E.peakGainDb(prefs) + pre <= E.BASS_DRIVE_DB + 1e-9, `${speaker}/${p.id} bass drive`);
    }
  }
  assert.equal(E.preampDb(E.applyPatch(E.sanitizePrefs({}), { preset: 'flat' })), -0);
});

test('the Eris E3.5 profile keeps the boost where a 3.5" woofer can play it', () => {
  const sp = E.SPEAKERS.eris35;
  const p = E.applyPatch(E.sanitizePrefs({ speaker: 'eris35', guard: 0 }), { preset: 'earthquake' });
  assert.equal(p.bass, sp.maxBass, 'BASS is capped for this speaker');
  assert.deepEqual(E.bassRange(p), [0, sp.maxBass]);
  assert.ok(E.effective(p).guard >= 60, 'the guard floor applies even with the guard switched off');
  assert.ok(E.effective(p).freq >= sp.minFreq);
  assert.ok(sumDb(p, 35) < sumDb(p, 75) - 18, 'nothing driven below the port');
  // the same prefs on full-range speakers keep the old behaviour
  const g = E.applyPatch(E.sanitizePrefs({ speaker: 'generic' }), { preset: 'earthquake' });
  assert.equal(g.bass, 24);
  // switching speakers is not a sound edit
  assert.equal(E.applyPatch(p, { speaker: 'generic' }).preset, 'earthquake');
  // Eris: the speaker's own ~100 Hz bump is pulled down in a flat setting
  const flat = E.applyPatch(E.sanitizePrefs({ speaker: 'eris35' }), { preset: 'flat' });
  assert.ok(sumDb(flat, 100) < -2);
});

test('CLARITY cuts the mud under a big boost', () => {
  const base = E.sanitizePrefs({ bass: 18, freq: 70, punch: 0, harmonics: 0, bands: new Array(10).fill(0) });
  const clear = E.applyPatch(base, { clarity: 100 });
  const muddy = E.applyPatch(base, { clarity: 0 });
  assert.ok(sumDb(clear, 190) < sumDb(muddy, 190) - 4);
  assert.ok(Math.abs(sumDb(clear, 60) - sumDb(muddy, 60)) < 1.5, 'the bass itself is left alone');
});

test('custom presets save, replace by name, cap and delete', () => {
  let p = E.sanitizePrefs({ bass: 11 });
  const r = E.saveCustom(p, '  Car  ');
  assert.ok(!r.error);
  p = r.prefs;
  assert.equal(p.custom.length, 1);
  assert.equal(p.custom[0].name, 'Car');
  assert.equal(p.preset, p.custom[0].id);
  p = E.saveCustom(p, 'car').prefs;
  assert.equal(p.custom.length, 1, 'same name replaces');
  for (let i = 0; i < E.MAX_CUSTOM + 3; i++) { const x = E.saveCustom(p, 'P' + i); if (!x.error) p = x.prefs; }
  assert.equal(p.custom.length, E.MAX_CUSTOM);
  assert.ok(E.saveCustom(p, 'one more').error);
  assert.equal(E.saveCustom(p, '   ').error, 'Give the preset a name');
  const id = p.custom[0].id;
  p = E.deleteCustom(p, id);
  assert.ok(!p.custom.some((c) => c.id === id));
  // round-trips through sanitize with its ids intact
  assert.deepEqual(E.sanitizePrefs(JSON.parse(JSON.stringify(p))).custom.map((c) => c.id), p.custom.map((c) => c.id));
});

test('the CHAIN line has exactly the fields the host reads', () => {
  const chain = E.buildChain(E.applyPatch(E.sanitizePrefs({}), { preset: 'earthquake' }));
  const t = E.chainLine(chain).split(' ');
  assert.equal(t[0], 'CHAIN');
  const n = Number(t[30]);
  assert.equal(n, chain.biquads.length);
  assert.equal(n, E.N_BIQUADS, 'fixed structure: 2 guard + bass + punch + 2 clarity + 3 speaker + 10 bands');
  assert.equal(n, 19);
  assert.equal(t.length, 31 + 5 * n);
  for (const v of t.slice(2)) assert.ok(Number.isFinite(Number(v)), v);
  assert.ok(!/e/.test(t.slice(1).join(' ').replace(/e[-+]\d+/g, '')), 'plain numbers');
});

test('meter lines parse, and malformed ones are refused', () => {
  const m = E.parseMeter('LV ' + 'ff'.repeat(16) + '00'.repeat(16) + ' 128 255 27');
  assert.equal(m.bands.length, 32);
  assert.equal(m.bands[0], 1);
  assert.equal(m.bands[31], 0);
  assert.equal(m.peak, 1);
  assert.equal(m.latencyMs, 27);
  assert.ok(m.reductionDb > 11 && m.reductionDb < 13);
  assert.equal(m.bassReductionDb, 0, 'an older 4-field line still parses');
  assert.equal(E.parseMeter('LV ' + '00'.repeat(32) + ' 0 0 0 255').bassReductionDb, 24);
  assert.equal(E.parseMeter('LV zz 1 2 3'), null);
  assert.equal(E.parseMeter('STATUS {}'), null);
});

test('voice nudges stay inside the knob', () => {
  let p = E.sanitizePrefs({ bass: 22 });
  p = E.nudgeBass(p, 6);
  assert.equal(p.bass, 24);
  p = E.nudgeBass(E.sanitizePrefs({ bass: 1 }), -6);
  assert.equal(p.bass, 0);
});

// ── Wiring ────────────────────────────────────────────────────────────────
test('registry entry is Windows-only and names a real panel renderer', () => {
  const core = read('renderer', 'core.js');
  const i = core.indexOf("id: 'bassBoost'");
  assert.ok(i > 0, 'registered');
  const entry = core.slice(i, core.indexOf('},', i));
  assert.match(entry, /platforms: \['win32'\]/);
  assert.match(entry, /panelId: 'bass-boost-panel'/);
  assert.match(entry, /panelRenderer: 'renderBassBoostPanel'/);
  const panel = read('renderer', 'bass-boost.js');
  assert.match(panel, /async function renderBassBoostPanel\(\)/);
  assert.match(panel, /async function applyBassBoostEnabled\(/);
  assert.match(read('renderer', 'widgets-settings.js'), /applyBassBoostEnabled\(!!prefs\.bassBoost\)/);
});

test('main.html loads the engine before the panel, and the stylesheet', () => {
  const html = read('main.html');
  const a = html.indexOf('renderer/bass-engine.js'), b = html.indexOf('renderer/bass-boost.js');
  assert.ok(a > 0 && b > a);
  assert.match(html, /href="styles\/bass-boost\.css"/);
});

test('every bass channel the preload invokes is handled in main', () => {
  const preload = read('preload.js');
  const mainSrc = read('main', 'bassBoost.js');
  const invoked = [...preload.matchAll(/invoke\('(bass:[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 9);
  for (const ch of invoked) assert.ok(mainSrc.includes(`handle('${ch}'`), ch);
  for (const ev of ['bass:changed', 'bass:meter']) {
    assert.ok(preload.includes(`'${ev}'`), ev);
    assert.ok(mainSrc.includes(`'${ev}'`), ev);
  }
  const mainJs = read('main.js');
  assert.match(mainJs, /bassBoostModule = bassBoost\.init\(ctx\)/);
  assert.match(mainJs, /bassBoostModule\.teardown\(\)/);
  assert.match(mainJs, /bassBoostModule\.reapplyHotkeys\(\)/);
});

test('the panel has no inline handlers and never puts device or preset names in HTML', () => {
  const src = stripComments(read('renderer', 'bass-boost.js'));
  assert.ok(!/\son[a-z]+="/.test(src), 'no inline on* handlers');
  const html = src.slice(src.indexOf('panel.innerHTML ='), src.indexOf("const root = panel.querySelector('.bb-root');"));
  assert.ok(html.length > 500);
  for (const banned of ['.name', 'status.', 'message']) assert.ok(!html.includes(banned), banned);
  assert.match(src, /o\.textContent = it\.label/);
  assert.match(src, /statusEl\.textContent = st\.text/);
});

test('every voice command for the boost has an executor', () => {
  const V = require('../main/voiceCommands');
  const exec = read('renderer', 'voice-assistant.js');
  const ids = V.COMMANDS.filter((c) => c.id.startsWith('bass.')).map((c) => c.id);
  assert.deepEqual(ids.sort(), ['bass.less', 'bass.max', 'bass.more', 'bass.off', 'bass.on']);
  for (const id of ids) assert.ok(exec.includes(`'${id}':`), id);
  const g = V.compileGrammar(V.buildVocabulary({ apps: [], widgets: [], macros: [] }));
  assert.ok(g.phrases.includes('more bass'));
  assert.ok(g.phrases.includes('bass boost on'));
});

test('the host script is versioned and speaks the protocol main expects', () => {
  const { BASS_HOST_SCRIPT_CONTENT, BASS_HOST_SCRIPT_VERSION } = require('../main/bassBoostHostScript');
  assert.ok(Number.isInteger(BASS_HOST_SCRIPT_VERSION));
  const mainSrc = read('main', 'bassBoost.js');
  for (const cmd of ['START ', "'STOP'", 'METER ', "'DEVICES'", 'EXIT']) assert.ok(mainSrc.includes(cmd), cmd);
  for (const op of ['"START"', '"STOP"', '"METER"', '"DEVICES"', '"CHAIN"', '"EXIT"']) assert.ok(BASS_HOST_SCRIPT_CONTENT.includes(op), op);
  for (const out of ['READY', 'STATUS ', 'DEVICES ', 'LV ', 'LOG ']) {
    assert.ok(BASS_HOST_SCRIPT_CONTENT.includes(out), out);
    assert.ok(mainSrc.includes(out), out);
  }
  assert.ok(!/`/.test(BASS_HOST_SCRIPT_CONTENT.slice(BASS_HOST_SCRIPT_CONTENT.indexOf('@\'') + 2, BASS_HOST_SCRIPT_CONTENT.lastIndexOf('\'@'))), 'no backticks leak into the C#');
});

// ── The real host (Windows) ───────────────────────────────────────────────
const onWindows = process.platform === 'win32';

function runHost(lines, restoreContent) {
  const { BASS_HOST_SCRIPT_CONTENT } = require('../main/bassBoostHostScript');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bass-host-'));
  const script = path.join(dir, 'host.ps1');
  const restore = path.join(dir, 'restore.txt');
  fs.writeFileSync(script, BASS_HOST_SCRIPT_CONTENT, 'utf8');
  if (restoreContent !== undefined) fs.writeFileSync(restore, restoreContent, 'utf8');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-RestoreFile', restore], {
    input: lines.join('\n') + '\nEXIT\n', encoding: 'utf8', timeout: 90000, windowsHide: true
  });
  const out = { stdout: res.stdout || '', stderr: res.stderr || '', restoreLeft: fs.existsSync(restore) };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('the host compiles, handshakes and lists outputs', { skip: !onWindows, timeout: 120000 }, () => {
  const r = runHost(['DEVICES']);
  assert.equal(r.stderr.trim(), '', r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  assert.ok(lines.includes('READY'), r.stdout);
  const dev = lines.find((l) => l.startsWith('DEVICES '));
  assert.ok(dev, 'answered DEVICES');
  const list = JSON.parse(dev.slice(8));
  assert.ok(Array.isArray(list));
  for (const d of list) assert.ok(typeof d.id === 'string' && typeof d.name === 'string');
});

test('the C# DSP matches the curve the panel draws', { skip: !onWindows, timeout: 120000 }, () => {
  const freqs = [25, 45, 60, 90, 150, 400, 1000, 4000, 12000];
  const cases = [
    E.sanitizePrefs(Object.assign({}, E.PRESETS.find((p) => p.id === 'earthquake'), { harmonics: 0, guard: 40 })),
    E.sanitizePrefs(Object.assign({}, E.PRESETS.find((p) => p.id === 'vshape'), { harmonics: 0, guard: 0, output: -3 })),
    E.sanitizePrefs(Object.assign({}, E.PRESETS.find((p) => p.id === 'eris'), { harmonics: 0, speaker: 'eris35' }))
  ];
  for (const prefs of cases) {
    const chain = E.buildChain(prefs);
    const r = runHost([E.chainLine(chain)].concat(freqs.map((f) => 'TESTDSP ' + f)));
    assert.match(r.stdout, /CHAIN-OK 19/, r.stdout + r.stderr);
    for (const f of freqs) {
      const m = new RegExp('^TESTDSP ' + f + ' (-?[0-9.]+)', 'm').exec(r.stdout);
      assert.ok(m, 'measured ' + f);
      const want = sumDb(prefs, f) + chain.preampDb + prefs.output;
      assert.ok(Math.abs(Number(m[1]) - want) < 0.05, `${f} Hz: host ${m[1]} vs engine ${want.toFixed(3)}`);
    }
  }
});

test('a loud bass note never ducks the vocals', { skip: !onWindows, timeout: 120000 }, () => {
  // Two tones at once: a bass note driving the bass limiter hard, and a quiet
  // 1 kHz tone. The 1 kHz tone must come out at its small-signal gain.
  for (const speaker of ['eris35', 'generic']) {
    const prefs = E.sanitizePrefs(Object.assign({}, E.PRESETS.find((p) => p.id === 'earthquake'), { harmonics: 0, speaker }));
    const chain = E.buildChain(prefs);
    const small = sumDb(prefs, 1000) + chain.preampDb;
    const r = runHost([E.chainLine(chain), 'TESTMIX 75 0.9 1000 0.05', 'TESTMIX 60 0.6 1000 0.05']);
    const mixes = [...r.stdout.matchAll(/^TESTMIX (-?[0-9.]+) (-?[0-9.]+)/gm)];
    assert.equal(mixes.length, 2, r.stdout + r.stderr);
    for (const m of mixes) {
      assert.ok(Math.abs(Number(m[2]) - small) < 0.5, `${speaker}: 1 kHz ${m[2]} dB vs ${small.toFixed(2)} dB alone`);
      assert.ok(Number(m[1]) < sumDb(prefs, 75) + chain.preampDb - 3, `${speaker}: the bass was limited`);
    }
  }
});

test('the host refuses a malformed chain without dying', { skip: !onWindows, timeout: 120000 }, () => {
  const r = runHost(['CHAIN 0 1 1 0.9 60 0 NaN', 'CHAIN 0 1 1 0.9', 'DEVICES']);
  assert.ok(!/CHAIN-OK/.test(r.stdout));
  assert.match(r.stdout, /^DEVICES /m, 'still answering afterwards');
});

test('a restore file with nothing left to undo is cleaned up on boot', { skip: !onWindows, timeout: 120000 }, () => {
  const r = runHost([], 'sink\t\nsinkMute\t0\nmuted\t0\nrouted\t0\nroute\t\n');
  assert.match(r.stdout, /READY/);
  assert.equal(r.restoreLeft, false);
});

// ── Leftover mutes and Spotify's main process (reflection into the real host) ──
// Runs PowerShell against the compiled C# without changing the machine's
// audio: mutes are only read, or "restored" to the value they already have.
function runReflect(body) {
  const { BASS_HOST_SCRIPT_CONTENT } = require('../main/bassBoostHostScript');
  const cs = BASS_HOST_SCRIPT_CONTENT.slice(BASS_HOST_SCRIPT_CONTENT.indexOf("@'") + 2, BASS_HOST_SCRIPT_CONTENT.lastIndexOf("'@"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bass-reflect-'));
  fs.writeFileSync(path.join(dir, 'host.cs'), cs, 'utf8');
  const script = path.join(dir, 'probe.ps1');
  fs.writeFileSync(script, [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -Path "$PSScriptRoot/host.cs"',
    '$t = [MainBassBoost.Host]',
    "$bf = [Reflection.BindingFlags]'NonPublic,Static,Public'",
    'function M($n) { $t.GetMethod($n, $bf) }',
    "$t.GetField('restorePath', $bf).SetValue($null, (Join-Path $PSScriptRoot 'restore.txt'))",
    body
  ].join('\n'), 'utf8');
  const res = spawnSync('powershell.exe', ['-NoProfile', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return (res.stdout || '') + (res.stderr || '');
}

test('a mute in the ledger is never mistaken for the user\'s own', { skip: !onWindows, timeout: 120000 }, () => {
  // Ledger says "this output was UNmuted before we muted it" for a real
  // output: OriginalMute must answer 0 whatever the output reads now, and
  // the sweep puts it back to its ledger value (here: its current value, so
  // nothing on this machine changes) and strikes it off.
  const out = runReflect([
    "$dev = (M 'ActiveOutputs').Invoke($null, @())[0]",
    "if ($null -eq $dev) { 'NODEVICE'; exit }",
    "$now = (M 'GetMute').Invoke($null, @($dev.Id))",
    "$ledger = (Join-Path $PSScriptRoot 'restore.txt.mutes')",
    "Set-Content -Path $ledger -Value ($dev.Id + \"`t\" + (1 - $now)) -NoNewline",
    "'ORIG ' + (M 'OriginalMute').Invoke($null, @($dev.Id)) + ' NOW ' + $now",
    "Set-Content -Path $ledger -Value ($dev.Id + \"`t\" + $now) -NoNewline",
    "Set-Content -Path $ledger -Value (\"{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}`t0`n\" + $dev.Id + \"`t\" + $now)",
    "(M 'SweepLedger').Invoke($null, @()) | Out-Null",
    "'AFTER ' + (M 'GetMute').Invoke($null, @($dev.Id))",
    "'LEFT ' + ((Get-Content $ledger -ErrorAction SilentlyContinue) -join '|')"
  ].join('\n'));
  if (/NODEVICE/.test(out)) return;
  const m = /ORIG (\d) NOW (\d)/.exec(out);
  assert.ok(m, out);
  assert.equal(Number(m[1]), 1 - Number(m[2]), 'the ledger value wins over what the output reads now');
  assert.match(out, new RegExp('AFTER ' + m[2]), 'mute put back to its original value');
  const left = /LEFT (.*)/.exec(out)[1];
  assert.match(left, /00000000-0000-0000-0000-000000000000/, 'an output that is not connected stays listed for later');
  assert.equal(left.split('|').length, 1, 'the restored output is struck off');
});

test('Spotify\'s main process is the one whose parent is not Spotify', { skip: !onWindows, timeout: 120000 }, () => {
  const out = runReflect([
    "$root = (M 'SpotifyRoot').Invoke($null, @())",
    "'ROOT ' + $root",
    "if ($root -ne 0) { $par = (Get-CimInstance Win32_Process -Filter \"ProcessId=$root\").ParentProcessId; 'PARENT ' + (Get-CimInstance Win32_Process -Filter \"ProcessId=$par\").Name; 'ROUTE ' + $(try { (M 'GetRoute').Invoke($null, @([uint32]$root)); 'ok' } catch { 'fail ' + $_.Exception.InnerException.Message }) }"
  ].join('\n'));
  const root = Number((/ROOT (\d+)/.exec(out) || [])[1]);
  if (!root) return;   // Spotify isn't running here
  assert.doesNotMatch(out, /PARENT Spotify\.exe/i, out);
  assert.match(out, /ROUTE\s+ok/, 'the route API accepts it: ' + out);
  assert.doesNotMatch(out, /ROUTE fail/);
});
