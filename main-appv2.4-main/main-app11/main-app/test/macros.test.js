// Macros: the Alt+X position-capture contract between the host and the engine.
//
// The capture itself needs a real cursor and a real PowerShell host, so it can't
// run here — it's covered by the on-device pass. What IS covered here is the
// thing that silently broke it before: the press has to be detected inside the
// engine (GetAsyncKeyState, focus-independent) and the cursor read there, at the
// moment of the press, rather than by a globalShortcut that only lands once our
// own window is back in the foreground.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../main/macros.js');

// ── The constants the host sends match how the module parses the same hotkey ──
test('CAPTURE_VK / CAPTURE_MODS agree with parseAccelerator(CAPTURE_ACCELERATOR)', () => {
  const parsed = M.parseAccelerator(M.CAPTURE_ACCELERATOR);
  assert.ok(parsed, 'the capture accelerator is parseable');
  assert.equal(parsed.vk, M.CAPTURE_VK, 'same virtual key');
  assert.equal(parsed.mods, M.CAPTURE_MODS, 'same modifier bitmask');
  assert.equal(parsed.mouse, false, 'a keyboard hotkey, not a mouse button');
});

test('CAPTURE_MODS is exactly Alt in the engine bitmask (1 Ctrl, 2 Shift, 4 Alt, 8 Win)', () => {
  assert.equal(M.CAPTURE_MODS, 4);
});

// ── Engine protocol ───────────────────────────────────────────────────────
test('the engine script still speaks the protocol main.js writes for it', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  for (const cmd of ['REC ', 'PLAY ', 'WATCH', 'CAPTURE', 'STOP', 'EXIT', 'PING']) {
    assert.ok(s.includes(`"${cmd}"`), `handles the ${cmd.trim()} command`);
  }
  for (const emit of ['READY', 'REC-STARTED', 'PLAY-STARTED', 'KEY-DOWN ', 'KEY-UP ',
    'WATCH-OK ', 'CAPTURE-OK ', 'CAPTURED ']) {
    assert.ok(s.includes(emit), `emits ${emit.trim()}`);
  }
});

test('CAPTURE is dispatched before the REC/PLAY branch, and after WATCH', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  const watch = s.indexOf('line.StartsWith("WATCH")');
  const capture = s.indexOf('line.StartsWith("CAPTURE")');
  const rec = s.indexOf('line.StartsWith("REC ")');
  assert.ok(watch !== -1 && capture !== -1 && rec !== -1, 'all three branches exist');
  assert.ok(watch < capture && capture < rec, 'no command shadows another');
});

test('the capture reads the cursor inside the engine, at the press', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  // GetCursorPos has to be called in the same block that emits CAPTURED —
  // sampling it anywhere later is the bug this replaced.
  const emitAt = s.indexOf('Emit("CAPTURED "');
  assert.ok(emitAt !== -1, 'the engine emits CAPTURED');
  const before = s.slice(0, emitAt);
  const block = before.slice(before.lastIndexOf('if (capIsDown'));
  assert.ok(block.includes('GetCursorPos(out cpos)'), 'the cursor is read right at the press');
  assert.ok(block.includes('captureVk = 0'), 'and the capture disarms itself, one-shot');
});

test('the capture is polled by the watcher thread, so focus never gates it', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  const loopAt = s.indexOf('static void WatchLoop()');
  assert.ok(loopAt !== -1, 'the watcher loop exists');
  const loop = s.slice(loopAt);
  assert.ok(loop.includes('GetAsyncKeyState(cvk)'), 'the capture key is polled, not hooked');
  // An armed capture must keep the loop hot even with an empty WATCH list.
  assert.ok(loop.includes('Thread.Sleep(cvk > 0 ? 10 : 50)'),
    'an armed capture keeps the idle loop responsive');
});

test('an armed capture starts the watcher thread even with nothing else watched', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  const at = s.indexOf('line.StartsWith("CAPTURE")');
  const branch = s.slice(at, s.indexOf('Emit("CAPTURE-OK "', at));
  assert.ok(branch.includes('EnsureWatchThread()'), 'the branch starts the watcher');
  // Re-priming is now implicit: the loop notices captureVk changed and clears
  // capPrimed itself, so a key already down when armed can't fire a phantom
  // capture — see the "re-arming the capture key re-primes it too" test.
  assert.ok(branch.includes('captureVk ='), 'the branch arms the capture key');
});

test('bumping the engine script means bumping its cache version', () => {
  // ensureVersionedScript only rewrites the .ps1 when this number changes, so a
  // stale engine would answer CAPTURE with "ERR unknown" forever.
  assert.ok(M.MACRO_ENGINE_SCRIPT_VERSION >= 5,
    'the CAPTURE command shipped at script version 5');
});

// ── Phantom triggers ───────────────────────────────────────────────
// The watch list is re-sent on every enable, save, delete and import. If the
// loop can ever run a fresh list against key state left over from the previous
// one, a key that merely happened to be held at that moment reads as a press —
// the macro starts on its own.
test('a re-sent watch list can never run against stale key state', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  assert.ok(!s.includes('watchRePrime'), 'no separate re-prime flag to race the list read');
  assert.ok(s.includes('watchSet = new WatchSet('), 'the list is swapped as one immutable object');
  assert.ok(s.includes('WatchSet ws = watchSet;'), 'and read once, atomically');
  assert.ok(/if \(!object\.ReferenceEquals\(ws, seen\)\)[\s\S]{0,140}primed\[k\] = false/.test(s),
    'an unseen set always re-primes before it is used');
  assert.ok(s.includes('int[] vks = ws.vks;'), 'and the loop reads the very set it primed');
});

test('re-arming the capture key re-primes it too', () => {
  const s = M.MACRO_ENGINE_SCRIPT_CONTENT;
  assert.ok(!s.includes('captureRePrime'), 'no separate flag to race captureVk');
  assert.ok(s.includes('if (cvk != lastCvk) { lastCvk = cvk; capPrimed = false; }'),
    'a change of armed key is itself the re-prime signal');
});

// ── The C# actually builds ───────────────────────────────────────
// The engine is only a string until PowerShell compiles it, so nothing else
// catches a syntax error — at runtime it just shows up as "engine failed to
// start". Driving the real host also proves the command dispatch works.
test('the engine compiles and answers the capture handshake', {
  skip: process.platform !== 'win32' ? 'needs Windows PowerShell' : false
}, () => {
  const file = path.join(os.tmpdir(), `macro-engine-test-${process.pid}.ps1`);
  fs.writeFileSync(file, M.MACRO_ENGINE_SCRIPT_CONTENT, 'utf8');
  try {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      input: `CAPTURE 88 4
PING
WATCH 112
WATCH
CAPTURE
EXIT
`,
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true
    });
    assert.equal(res.status, 0, `engine exited cleanly (stderr: ${res.stderr})`);
    const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    assert.equal(lines[0], 'READY', 'the C# compiled and the host started');
    assert.ok(lines.includes('CAPTURE-OK 88'), 'arms the capture on X');
    assert.ok(lines.includes('PONG'), 'still answers PING');
    assert.ok(lines.includes('WATCH-OK 1'), 'still takes a watch list');
    assert.ok(lines.includes('WATCH-OK 0'), 'and an empty one');
    assert.ok(lines.includes('CAPTURE-OK 0'), 'a bare CAPTURE disarms');
  } finally {
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
  }
});
