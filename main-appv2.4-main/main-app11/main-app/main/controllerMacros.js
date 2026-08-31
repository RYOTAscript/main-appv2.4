const { app, ipcMain, globalShortcut, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { parseAccelerator, isMouseHotkey } = require('./macros');

const PAD_ENGINE_SCRIPT_VERSION = 1;
const DEFAULT_TOGGLE_HOTKEY = 'F10';
const TRIGGERS = ['pressed', 'hold', 'toggle', 'released'];
const PAD_TYPES = ['x360', 'ds4'];
// Direct download of the ViGEmBus installer (pinned to v1.22.0, the last stable
// release; the single-file installer carries x64 + x86 + arm64). Opening this in
// the browser starts the download immediately instead of dropping the user on a
// GitHub releases page to hunt for the right asset.
const DRIVER_PAGE_URL = 'https://github.com/nefarius/ViGEmBus/releases/download/v1.22.0/ViGEmBus_1.22.0_x64_x86_arm64.exe';
const VIGEM_DLL = path.join(__dirname, 'vendor', 'Nefarius.ViGEm.Client.dll');

// ⚠️ WINDOWS VERSION / DEPENDENCY NOTE
// This widget CANNOT emit gamepad input until the user installs the external
// ViGEmBus kernel driver — it is not bundled (kernel driver, must be installed
// with admin rights). Behaviour by OS:
//   • Windows 10 (1809+) and Windows 11 21H2–23H2: works once ViGEmBus is present.
//   • Windows 11 24H2 / 25H2: the pinned v1.22.0 installer (DRIVER_PAGE_URL)
//     installs cleanly on recent builds; the "Get the driver" button downloads it
//     directly.
//   • Windows on ARM (ARM64): the x64 build runs under emulation and ViGEmBus's
//     x64 kernel driver will not load — the virtual pad is effectively unavailable.
// When the driver is missing, PLUG fails and the renderer surfaces DRIVER_PAGE_URL;
// this is expected, not a bug.

// ── Virtual pad engine ──
// Games only see a gamepad that exists as a real device, so playback goes
// through the ViGEmBus kernel driver (the driver DS4Windows uses): the helper
// below plugs a virtual Xbox 360 or DualShock 4 pad and presses its buttons.
// Same helper-process pattern as main/macros.js — a generated .ps1 compiles the
// C# and runs as a persistent background process, driven over stdin/stdout:
//   PLUG X360|DS4         create + connect the virtual pad (switches type when
//                         one of the other type is already plugged)
//   UNPLUG                disconnect the virtual pad
//   SEQ <count> <file>    play the sequence in <file> <count> times (0 = forever)
//   STOP / PING / EXIT    same lifecycle protocol as the macro engine
// Sequence lines are "t kind a b" (integers): t = ms offset, kind:
//   0 button-down(id)  1 button-up(id)  2 trigger(which 0=L2/1=R2, value 0-255)
//   3 axis(which 0=LX/1=LY/2=RX/3=RY, value -32767..32767, XInput convention)
// Button ids (keep in sync with PAD_BUTTONS below): 0 cross 1 circle 2 square
// 3 triangle 4 L1 5 R1 6 L3 7 R3 8 share 9 options 10 guide/PS 11-14 dpad URDL.
// The C# references the vendored .NET ViGEm client (main/vendor/, see
// VENDOR.md); playback timing/speed is pre-baked into the sequence offsets by
// compileStepsToEvents, so the engine just follows the clock.
const PAD_ENGINE_SCRIPT_CONTENT = `param([string]$DllPath)
try {
  [void][System.Reflection.Assembly]::LoadFrom($DllPath)
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;
using Nefarius.ViGEm.Client.Targets.DualShock4;

public static class PadEngine {
    static ViGEmClient client = null;
    static IXbox360Controller x360 = null;
    static IDualShock4Controller ds4 = null;
    static string padType = "";
    static volatile bool stopFlag = false;
    static Thread worker = null;
    static object emitLock = new object();
    static object padLock = new object();
    // The DS4 D-pad is a single hat direction, not four buttons -- track each
    // canonical dpad button and recombine (up+left = northwest, etc).
    static bool dpU, dpD, dpL, dpR;

    static void Emit(string s) { lock (emitLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

    public static void RunHost() {
        Emit("READY");
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "EXIT") { stopFlag = true; if (worker != null && worker.IsAlive) worker.Join(2000); Unplug(); break; }
            if (line == "STOP") { stopFlag = true; continue; }
            if (line == "PING") { Emit("PONG"); continue; }
            bool busy = worker != null && worker.IsAlive;
            if (line.StartsWith("PLUG ")) {
                if (busy) { Emit("ERR busy"); continue; }
                Plug(line.Substring(5).Trim());
            } else if (line == "UNPLUG") {
                if (busy) { Emit("ERR busy"); continue; }
                Unplug();
                Emit("UNPLUGGED");
            } else if (line.StartsWith("SEQ ")) {
                if (busy) { Emit("ERR busy"); continue; }
                string rest = line.Substring(4);
                int sp = rest.IndexOf(' ');
                if (sp < 1) { Emit("ERR seq-args"); continue; }
                int count = 0;
                int.TryParse(rest.Substring(0, sp), out count);
                string file = rest.Substring(sp + 1);
                if (padType.Length == 0) { Emit("ERR not-plugged"); continue; }
                stopFlag = false;
                int c = count;
                worker = new Thread(delegate() { PlaySeq(file, c); });
                worker.IsBackground = true;
                worker.Start();
                Emit("SEQ-STARTED");
            } else {
                Emit("ERR unknown");
            }
        }
    }

    static void Plug(string type) {
        try {
            if (type != "X360" && type != "DS4") { Emit("ERR plug-type"); return; }
            if (padType == type) { Emit("PLUGGED " + type); return; }
            Unplug();
            if (client == null) client = new ViGEmClient();
            if (type == "X360") {
                x360 = client.CreateXbox360Controller();
                x360.Connect();
            } else {
                ds4 = client.CreateDualShock4Controller();
                ds4.Connect();
            }
            padType = type;
            Emit("PLUGGED " + type);
        } catch (Exception e) {
            // A failed client (bus not found) must not linger -- disposing lets a
            // retry succeed after the user installs the driver.
            x360 = null; ds4 = null; padType = "";
            try { if (client != null) { client.Dispose(); } } catch (Exception) {}
            client = null;
            Emit("ERR plug " + e.GetType().Name);
        }
    }

    static void Unplug() {
        lock (padLock) {
            try { if (x360 != null) { x360.ResetReport(); x360.SubmitReport(); x360.Disconnect(); } } catch (Exception) {}
            try { if (ds4 != null) { ds4.ResetReport(); ds4.SubmitReport(); ds4.Disconnect(); } } catch (Exception) {}
            x360 = null; ds4 = null; padType = "";
            dpU = dpD = dpL = dpR = false;
        }
    }

    static DualShock4DPadDirection HatDir() {
        if (dpU && dpL) return DualShock4DPadDirection.Northwest;
        if (dpU && dpR) return DualShock4DPadDirection.Northeast;
        if (dpD && dpL) return DualShock4DPadDirection.Southwest;
        if (dpD && dpR) return DualShock4DPadDirection.Southeast;
        if (dpU) return DualShock4DPadDirection.North;
        if (dpD) return DualShock4DPadDirection.South;
        if (dpL) return DualShock4DPadDirection.West;
        if (dpR) return DualShock4DPadDirection.East;
        return DualShock4DPadDirection.None;
    }

    static void SetBtn(int id, bool down) {
        lock (padLock) {
            if (x360 != null) {
                Xbox360Button b = null;
                switch (id) {
                    case 0: b = Xbox360Button.A; break;
                    case 1: b = Xbox360Button.B; break;
                    case 2: b = Xbox360Button.X; break;
                    case 3: b = Xbox360Button.Y; break;
                    case 4: b = Xbox360Button.LeftShoulder; break;
                    case 5: b = Xbox360Button.RightShoulder; break;
                    case 6: b = Xbox360Button.LeftThumb; break;
                    case 7: b = Xbox360Button.RightThumb; break;
                    case 8: b = Xbox360Button.Back; break;
                    case 9: b = Xbox360Button.Start; break;
                    case 10: b = Xbox360Button.Guide; break;
                    case 11: b = Xbox360Button.Up; break;
                    case 12: b = Xbox360Button.Down; break;
                    case 13: b = Xbox360Button.Left; break;
                    case 14: b = Xbox360Button.Right; break;
                }
                if (b != null) x360.SetButtonState(b, down);
            } else if (ds4 != null) {
                if (id >= 11 && id <= 14) {
                    if (id == 11) dpU = down; else if (id == 12) dpD = down;
                    else if (id == 13) dpL = down; else dpR = down;
                    ds4.SetDPadDirection(HatDir());
                    return;
                }
                DualShock4Button b = null;
                switch (id) {
                    case 0: b = DualShock4Button.Cross; break;
                    case 1: b = DualShock4Button.Circle; break;
                    case 2: b = DualShock4Button.Square; break;
                    case 3: b = DualShock4Button.Triangle; break;
                    case 4: b = DualShock4Button.ShoulderLeft; break;
                    case 5: b = DualShock4Button.ShoulderRight; break;
                    case 6: b = DualShock4Button.ThumbLeft; break;
                    case 7: b = DualShock4Button.ThumbRight; break;
                    case 8: b = DualShock4Button.Share; break;
                    case 9: b = DualShock4Button.Options; break;
                    case 10: b = DualShock4SpecialButton.Ps; break;
                }
                if (b != null) ds4.SetButtonState(b, down);
            }
        }
    }

    // A real DS4 reports L2/R2 both digitally and as an analog slider -- mirror
    // the analog value onto the digital bit so games see a consistent pull.
    static void SetTrigger(int which, int val) {
        byte v = (byte)(val < 0 ? 0 : (val > 255 ? 255 : val));
        lock (padLock) {
            if (x360 != null) {
                x360.SetSliderValue(which == 0 ? Xbox360Slider.LeftTrigger : Xbox360Slider.RightTrigger, v);
            } else if (ds4 != null) {
                ds4.SetSliderValue(which == 0 ? DualShock4Slider.LeftTrigger : DualShock4Slider.RightTrigger, v);
                ds4.SetButtonState(which == 0 ? DualShock4Button.TriggerLeft : DualShock4Button.TriggerRight, v > 0);
            }
        }
    }

    static void SetAxis(int which, int val) {
        short v = (short)(val < -32767 ? -32767 : (val > 32767 ? 32767 : val));
        lock (padLock) {
            if (x360 != null) {
                Xbox360Axis a = which == 0 ? Xbox360Axis.LeftThumbX : (which == 1 ? Xbox360Axis.LeftThumbY : (which == 2 ? Xbox360Axis.RightThumbX : Xbox360Axis.RightThumbY));
                x360.SetAxisValue(a, v);
            } else if (ds4 != null) {
                // DS4 axes are 0-255 with 128 centre and +Y pointing down;
                // sequences use the XInput convention (+Y up), so flip Y here.
                int scaled = (v + 32767) * 255 / 65534;
                if (which == 1 || which == 3) scaled = 255 - scaled;
                if (scaled < 0) scaled = 0; if (scaled > 255) scaled = 255;
                DualShock4Axis a = which == 0 ? DualShock4Axis.LeftThumbX : (which == 1 ? DualShock4Axis.LeftThumbY : (which == 2 ? DualShock4Axis.RightThumbX : DualShock4Axis.RightThumbY));
                ds4.SetAxisValue(a, (byte)scaled);
            }
        }
    }

    static void PlaySeq(string path, int count) {
        try {
            string[] lines = File.ReadAllLines(path);
            var evs = new List<int[]>();
            foreach (string ln in lines) {
                if (ln.Length == 0) continue;
                string[] q = ln.Split(' ');
                if (q.Length != 4) continue;
                evs.Add(new int[] { int.Parse(q[0]), int.Parse(q[1]), int.Parse(q[2]), int.Parse(q[3]) });
            }
            bool[] held = new bool[16];
            bool[] trigHeld = new bool[2];
            bool[] axisMoved = new bool[4];
            bool stopped = false;
            long done = 0;
            do {
                var sw = Stopwatch.StartNew();
                foreach (int[] ev in evs) {
                    while (!stopFlag && sw.ElapsedMilliseconds < ev[0]) {
                        long rem = ev[0] - sw.ElapsedMilliseconds;
                        Thread.Sleep(rem > 15 ? 10 : 1);
                    }
                    if (stopFlag) { stopped = true; break; }
                    switch (ev[1]) {
                        case 0: SetBtn(ev[2], true); if (ev[2] >= 0 && ev[2] < 16) held[ev[2]] = true; break;
                        case 1: SetBtn(ev[2], false); if (ev[2] >= 0 && ev[2] < 16) held[ev[2]] = false; break;
                        case 2: SetTrigger(ev[2], ev[3]); if (ev[2] >= 0 && ev[2] < 2) trigHeld[ev[2]] = ev[3] > 0; break;
                        case 3: SetAxis(ev[2], ev[3]); if (ev[2] >= 0 && ev[2] < 4) axisMoved[ev[2]] = ev[3] != 0; break;
                    }
                }
                done++;
            } while (!stopped && (count == 0 || done < count));
            // Never leave anything pressed on the virtual pad after a run.
            for (int i = 0; i < 16; i++) if (held[i]) SetBtn(i, false);
            for (int i = 0; i < 2; i++) if (trigHeld[i]) SetTrigger(i, 0);
            for (int i = 0; i < 4; i++) if (axisMoved[i]) SetAxis(i, 0);
            Emit((stopped ? "SEQ-STOPPED " : "SEQ-DONE ") + done);
        } catch (Exception e) {
            Emit("ERR seq " + e.GetType().Name + " " + e.Message.Replace('\\n', ' ').Replace('\\r', ' '));
        }
    }
}
'@ -ReferencedAssemblies @($DllPath, 'System.dll')
} catch {
  $msg = $_.Exception.Message -replace "[\\r\\n]+", ' '
  [Console]::Out.WriteLine('ENGINE-COMPILE-FAILED ' + $msg)
  exit 1
}
[PadEngine]::RunHost()
`;

// ── Canonical button/trigger/stick ids ──
// Steps store these names; the engine speaks the numeric ids. The UI (renderer/
// controller-macros.js) shows PlayStation labels first with Xbox equivalents.
const PAD_BUTTONS = {
  cross: 0, circle: 1, square: 2, triangle: 3,
  l1: 4, r1: 5, l3: 6, r3: 7,
  share: 8, options: 9, guide: 10,
  dpadUp: 11, dpadDown: 12, dpadLeft: 13, dpadRight: 14
};
const PAD_TRIGGERS = { l2: 0, r2: 1 };
const PAD_STICKS = { l: 0, r: 1 };

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function newMacroId() {
  return `padmacro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Macro sanitizing ──
// Step shapes (b = button or trigger name, percentages are 0-100):
//   {t:'delay', ms}                wait
//   {t:'tap',  b}                  press + release (L2/R2 = full pull + release)
//   {t:'bd',   b} / {t:'bu', b}    hold / release
//   {t:'trig', s:'l2'|'r2', v}     partial trigger pull, v percent (0 releases)
//   {t:'stick', s:'l'|'r', x, y}   move a stick, x/y percent (-100..100, +y up);
//                                  x:0 y:0 recentres it
function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    if (s.t === 'delay') {
      out.push({ t: 'delay', ms: clampInt(s.ms, 0, 600000, 0) });
    } else if (s.t === 'tap' || s.t === 'bd' || s.t === 'bu') {
      if (typeof s.b === 'string' && (s.b in PAD_BUTTONS || s.b in PAD_TRIGGERS)) {
        out.push({ t: s.t, b: s.b });
      }
    } else if (s.t === 'trig') {
      if (s.s in PAD_TRIGGERS) out.push({ t: 'trig', s: s.s, v: clampInt(s.v, 0, 100, 100) });
    } else if (s.t === 'stick') {
      if (s.s in PAD_STICKS) {
        out.push({ t: 'stick', s: s.s, x: clampInt(s.x, -100, 100, 0), y: clampInt(s.y, -100, 100, 0) });
      }
    }
  }
  return out;
}

function sanitizeMacro(macro) {
  const m = macro && typeof macro === 'object' ? macro : {};
  const speed = Number(m.speed);
  return {
    id: typeof m.id === 'string' && m.id ? m.id : newMacroId(),
    name: (typeof m.name === 'string' && m.name.trim()) || 'Controller macro',
    hotkey: typeof m.hotkey === 'string' && m.hotkey ? m.hotkey : null,
    trigger: TRIGGERS.includes(m.trigger) ? m.trigger : 'pressed',
    repeat: clampInt(m.repeat, 0, 9999, 1),
    speed: Number.isFinite(speed) ? Math.min(4, Math.max(0.25, speed)) : 1,
    on: m.on !== false,
    steps: sanitizeSteps(m.steps)
  };
}

// ── Steps -> raw engine events ──
// Mirrors compileStepsToEvents in main/macros.js: timing offsets are pre-scaled
// by playback speed so the engine just follows the clock. Taps hold the button
// for 60ms — comfortably over one frame even in a 30fps game.
function compileStepsToEvents(steps, speed) {
  const evs = [];
  let t = 0;
  for (const s of steps || []) {
    if (!s || typeof s !== 'object') continue;
    if (s.t === 'delay') {
      t += Math.max(0, Number(s.ms) || 0);
    } else if (s.t === 'tap') {
      if (s.b in PAD_TRIGGERS) {
        evs.push([t, 2, PAD_TRIGGERS[s.b], 255]);
        t += 60;
        evs.push([t, 2, PAD_TRIGGERS[s.b], 0]);
      } else if (s.b in PAD_BUTTONS) {
        evs.push([t, 0, PAD_BUTTONS[s.b], 0]);
        t += 60;
        evs.push([t, 1, PAD_BUTTONS[s.b], 0]);
      } else {
        continue;
      }
      t += 15;
    } else if (s.t === 'bd' || s.t === 'bu') {
      const down = s.t === 'bd';
      if (s.b in PAD_TRIGGERS) {
        evs.push([t, 2, PAD_TRIGGERS[s.b], down ? 255 : 0]);
      } else if (s.b in PAD_BUTTONS) {
        evs.push([t, down ? 0 : 1, PAD_BUTTONS[s.b], 0]);
      } else {
        continue;
      }
      t += 10;
    } else if (s.t === 'trig') {
      if (!(s.s in PAD_TRIGGERS)) continue;
      evs.push([t, 2, PAD_TRIGGERS[s.s], Math.round(clampInt(s.v, 0, 100, 100) * 2.55)]);
      t += 10;
    } else if (s.t === 'stick') {
      if (!(s.s in PAD_STICKS)) continue;
      const ax = PAD_STICKS[s.s] * 2;
      evs.push([t, 3, ax, Math.round(clampInt(s.x, -100, 100, 0) * 327.67)]);
      evs.push([t, 3, ax + 1, Math.round(clampInt(s.y, -100, 100, 0) * 327.67)]);
      t += 10;
    }
  }
  const spd = Number(speed) > 0 ? Math.min(4, Math.max(0.25, Number(speed))) : 1;
  return evs.map((e) => `${Math.round(e[0] / spd)} ${e[1]} ${e[2]} ${e[3]}`);
}

// ── ViGEmBus driver detection ──
// The bus is a kernel driver registered as a service; `sc query` sees it
// without needing admin rights. "not found" = not installed.
function queryDriverStatus() {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn('sc.exe', ['query', 'ViGEmBus'], { windowsHide: true });
    } catch (e) {
      resolve({ installed: false, running: false });
      return;
    }
    proc.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    proc.on('error', () => resolve({ installed: false, running: false }));
    proc.on('close', () => {
      const installed = /STATE\s*:/.test(out);
      const running = /\bRUNNING\b/.test(out);
      resolve({ installed, running });
    });
  });
}

function init(ctx, deps) {
  const { logger, userDataPath, getMainWindow } = ctx;
  // deps.keyWatch: macros.js setExternalWatch — shares its GetAsyncKeyState
  // watcher so both widgets' hotkeys ride one helper process.
  // deps.getKeyboardMacroHotkeys: hotkeys the Macros widget owns, so a binding
  // can't fire a keyboard macro and a controller macro at once.
  const keyWatch = deps && deps.keyWatch ? deps.keyWatch : () => {};
  const getKeyboardMacroHotkeys = deps && deps.getKeyboardMacroHotkeys ? deps.getKeyboardMacroHotkeys : () => [];

  const CONFIG_PATH = path.join(userDataPath, 'controller-macros-config.json');
  const ENGINE_SCRIPT = path.join(userDataPath, 'pad-engine.ps1');
  const PLAY_FILE = path.join(userDataPath, 'controller-macro-playback.tmp');

  let config = loadConfig();
  let engineProc = null;
  let engineReady = false;
  let engineBuffer = '';
  let engineReadyWaiters = [];
  let state = 'idle';            // 'idle' | 'playing'
  let activeMacroId = null;      // macro being played ('__preview__' = editor test)
  let plugged = null;            // 'x360' | 'ds4' | null — what the engine reports
  let driver = { installed: false, running: false }; // last sc query result
  let toggleHotkeyRegistered = false;
  // Hold / Released trigger bookkeeping (fed by the shared key watcher)
  let watchMap = new Map();      // vk -> [{ id, mods, trigger }]
  // Suspended while the renderer is capturing raw keys -- these triggers ride
  // the macros engine's watcher, which globalShortcut.unregisterAll() can't
  // reach (see suspendTriggers below).
  let triggersSuspended = false;
  let releasedArmed = new Set();
  // Engine crash watchdog: one automatic revive, re-armed by any successful start.
  let engineRevivePending = false;
  let engineReviveUsed = false;

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
          enabled: raw.enabled === true,
          armed: raw.armed !== false,
          toggleHotkey: typeof raw.toggleHotkey === 'string' && raw.toggleHotkey ? raw.toggleHotkey : DEFAULT_TOGGLE_HOTKEY,
          padType: PAD_TYPES.includes(raw.padType) ? raw.padType : 'x360',
          macros: Array.isArray(raw.macros)
            ? raw.macros.filter((m) => m && typeof m === 'object' && m.id).map(sanitizeMacro)
            : []
        };
      }
    } catch (e) {
      logger.error('Failed to read controller macros config', e);
    }
    return { enabled: false, armed: true, toggleHotkey: DEFAULT_TOGGLE_HOTKEY, padType: 'x360', macros: [] };
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save controller macros config', e);
    }
  }

  function pushStatus(extra) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('controller-macros-status', {
        enabled: config.enabled,
        armed: config.armed,
        state,
        activeMacroId,
        toggleHotkey: config.toggleHotkey,
        padType: config.padType,
        plugged,
        driver,
        ...(extra || {})
      });
    }
  }

  // ── Engine process ──
  function ensureEngineScript() {
    ensureVersionedScript(ENGINE_SCRIPT, PAD_ENGINE_SCRIPT_VERSION, PAD_ENGINE_SCRIPT_CONTENT);
  }

  function ensureEngine() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(VIGEM_DLL)) {
        reject(new Error('ViGEm client DLL missing from main/vendor'));
        return;
      }
      if (engineProc && engineReady) { resolve(); return; }
      engineReadyWaiters.push({ resolve, reject });
      if (engineProc) return; // already starting — READY resolves everyone
      ensureEngineScript();
      try {
        engineProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENGINE_SCRIPT, VIGEM_DLL], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) {
        engineProc = null;
        flushReadyWaiters(e);
        return;
      }
      const startTimeout = setTimeout(() => {
        if (!engineReady) {
          logger.error('Pad engine did not become ready in time', null, {});
          killEngine();
          flushReadyWaiters(new Error('Pad engine failed to start'));
        }
      }, 25000);
      engineProc.stdout.on('data', (chunk) => {
        engineBuffer += chunk.toString('utf8');
        let nl;
        while ((nl = engineBuffer.indexOf('\n')) !== -1) {
          const line = engineBuffer.slice(0, nl).trim();
          engineBuffer = engineBuffer.slice(nl + 1);
          if (!line) continue;
          if (line === 'READY') {
            engineReady = true;
            engineReviveUsed = false;
            clearTimeout(startTimeout);
            logger.success('Pad engine started');
            flushReadyWaiters(null);
          } else {
            handleEngineLine(line);
          }
        }
      });
      engineProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) logger.error('Pad engine stderr', new Error(msg));
      });
      engineProc.on('exit', (code) => {
        const wasActive = state !== 'idle';
        const wasPlugged = plugged !== null;
        engineProc = null;
        engineReady = false;
        engineBuffer = '';
        plugged = null;
        clearTimeout(startTimeout);
        flushReadyWaiters(new Error('Pad engine exited'));
        if (wasActive) finishActivity();
        if (code === 0 || (!wasActive && !wasPlugged)) {
          logger.log(`Pad engine exited (code ${code})`, 'INFO');
          return;
        }
        // Unexpected death while the pad was live: games just lost the
        // controller. Revive once; a second crash without a clean start in
        // between stays down until the user acts (avoids a crash loop).
        logger.error('Pad engine exited unexpectedly', null, { code });
        pushStatus({ event: 'engine-crashed' });
        if (config.enabled && !engineRevivePending && !engineReviveUsed) {
          engineRevivePending = true;
          engineReviveUsed = true;
          setTimeout(() => {
            engineRevivePending = false;
            if (!config.enabled) return;
            ensurePadPlugged().catch((e) => logger.error('Pad engine revive failed', e));
          }, 2000);
        }
      });
    });
  }

  function flushReadyWaiters(err) {
    const waiters = engineReadyWaiters;
    engineReadyWaiters = [];
    for (const w of waiters) err ? w.reject(err) : w.resolve();
  }

  function engineSend(line) {
    if (engineProc && engineProc.stdin.writable) engineProc.stdin.write(line + '\n');
  }

  function killEngine() {
    if (!engineProc) return;
    try {
      engineSend('EXIT'); // engine unplugs the pad before exiting
      const proc = engineProc;
      setTimeout(() => { try { proc.kill(); } catch (e) { /* already gone */ } }, 1500);
    } catch (e) { /* ignore */ }
    engineProc = null;
    engineReady = false;
    plugged = null;
  }

  function finishActivity() {
    state = 'idle';
    activeMacroId = null;
    pushStatus();
  }

  function handleEngineLine(line) {
    if (line.startsWith('PLUGGED ')) {
      plugged = line.slice(8).trim() === 'DS4' ? 'ds4' : 'x360';
      logger.success('Virtual pad plugged in', { type: plugged });
      pushStatus({ event: 'plugged' });
    } else if (line === 'UNPLUGGED') {
      plugged = null;
      pushStatus();
    } else if (line.startsWith('SEQ-DONE') || line.startsWith('SEQ-STOPPED')) {
      logger.log(`Controller macro playback finished (${line})`, 'INFO');
      finishActivity();
    } else if (line.startsWith('ERR plug')) {
      plugged = null;
      const busMissing = line.includes('VigemBusNotFoundException');
      logger.error('Virtual pad plug failed', new Error(line));
      if (busMissing) {
        driver = { installed: false, running: false };
        pushStatus({ event: 'driver-missing' });
      } else {
        pushStatus({ event: 'plug-failed' });
      }
      if (state !== 'idle') finishActivity();
    } else if (line.startsWith('ERR')) {
      logger.error('Pad engine error', new Error(line));
      if (state !== 'idle') finishActivity();
    }
    // SEQ-STARTED / PONG are acks — state was already set.
  }

  // Plug (or re-plug after a type switch/crash) the virtual pad. The engine
  // answers PLUG with PLUGGED/ERR on stdout; ordering on stdin guarantees a
  // SEQ sent right after lands on a plugged pad or gets a clean ERR.
  async function ensurePadPlugged() {
    await ensureEngine();
    engineSend(`PLUG ${config.padType === 'ds4' ? 'DS4' : 'X360'}`);
  }

  // ── Hotkeys & triggers ──
  // Same layering as the Macros widget: every per-macro trigger (all four
  // modes, mouse buttons included) goes through the shared passive key watcher
  // so the trigger key still reaches the focused game; only the enable/disable
  // toggle uses globalShortcut.
  function syncTriggers() {
    watchMap = new Map();
    releasedArmed.clear();
    if (config.enabled && config.armed && !triggersSuspended) {
      for (const m of config.macros) {
        if (!m.hotkey || m.on === false) continue;
        const parsed = parseAccelerator(m.hotkey);
        if (!parsed) {
          logger.warn('Controller macro hotkey not watchable', { macro: m.name, hotkey: m.hotkey });
          continue;
        }
        const list = watchMap.get(parsed.vk) || [];
        list.push({ id: m.id, mods: parsed.mods, trigger: m.trigger });
        watchMap.set(parsed.vk, list);
      }
    }
    keyWatch([...watchMap.keys()], onWatchedKey);
  }

  function onWatchedKey(vk, mods, isDown) {
    const entries = watchMap.get(vk);
    if (!entries) return;
    for (const ent of entries) {
      if (ent.trigger === 'pressed' || ent.trigger === 'toggle') {
        if (isDown && ent.mods === mods) onMacroHotkey(ent.id);
      } else if (ent.trigger === 'hold') {
        if (isDown) {
          if (ent.mods === mods && state === 'idle') {
            playMacro(ent.id, 0).catch((e) => logger.error('Hold controller macro failed to start', e, { id: ent.id }));
          }
        } else if (state === 'playing' && activeMacroId === ent.id) {
          stopEverything();
        }
      } else if (ent.trigger === 'released') {
        if (isDown) {
          if (state === 'playing' && activeMacroId === ent.id) {
            stopEverything();
          } else if (ent.mods === mods) {
            releasedArmed.add(ent.id);
          }
        } else if (releasedArmed.delete(ent.id) && state === 'idle') {
          playMacro(ent.id).catch((e) => logger.error('Release controller macro failed to start', e, { id: ent.id }));
        }
      }
    }
  }

  function onMacroHotkey(id) {
    if (state === 'playing' && activeMacroId === id) { stopEverything(); return; }
    if (state !== 'idle') return;
    playMacro(id).catch((e) => logger.error('Controller macro playback failed to start', e, { id }));
  }

  function registerToggleHotkey() {
    if (toggleHotkeyRegistered) return;
    try {
      const ok = globalShortcut.register(config.toggleHotkey, toggleArmed);
      if (ok) toggleHotkeyRegistered = true;
      else logger.warn('Controller macros toggle hotkey unavailable', { hotkey: config.toggleHotkey });
    } catch (e) {
      logger.error('Controller macros toggle hotkey registration failed', e, { hotkey: config.toggleHotkey });
    }
  }

  function unregisterToggleHotkey() {
    if (!toggleHotkeyRegistered) return;
    try { globalShortcut.unregister(config.toggleHotkey); } catch (e) { /* ignore */ }
    toggleHotkeyRegistered = false;
  }

  function registerAllHotkeys() {
    unregisterToggleHotkey();
    syncTriggers();
    if (config.enabled && !triggersSuspended) registerToggleHotkey();
  }

  function setArmed(armed) {
    const next = !!armed;
    if (config.armed === next) return;
    config.armed = next;
    saveConfig();
    if (!next && state !== 'idle') stopEverything();
    syncTriggers();
    logger.success('Controller macros toggled', { armed: config.armed });
    pushStatus({ event: 'armed-changed', armed: config.armed });
  }

  function toggleArmed() {
    if (!config.enabled) return;
    setArmed(!config.armed);
  }

  function stopEverything() {
    if (state === 'idle') return;
    engineSend('STOP');
    logger.log('Controller macro stop requested', 'INFO');
  }

  // ── Playback ──
  async function playCompiled(lines, id, count) {
    if (!lines.length) return { ok: false, error: 'empty' };
    await ensurePadPlugged();
    try {
      fs.writeFileSync(PLAY_FILE, lines.join('\n') + '\n', 'utf8');
    } catch (e) {
      logger.error('Failed to write controller macro playback file', e);
      return { ok: false, error: 'write-failed' };
    }
    state = 'playing';
    activeMacroId = id;
    engineSend(`SEQ ${count} ${PLAY_FILE}`);
    pushStatus();
    return { ok: true };
  }

  async function playMacro(id, overrideCount) {
    if (state !== 'idle') return { ok: false, error: 'busy' };
    const m = config.macros.find((x) => x.id === id);
    if (!m) return { ok: false, error: 'not-found' };
    const lines = compileStepsToEvents(m.steps || [], m.speed || 1);
    const count = overrideCount !== undefined
      ? overrideCount
      : (m.trigger === 'hold' ? 0 : (Number.isFinite(Number(m.repeat)) ? Number(m.repeat) : 1));
    const res = await playCompiled(lines, id, count);
    if (res.ok) logger.log(`Controller macro playback started: ${m.name} (x${count === 0 ? '∞' : count}, ${m.speed || 1}x speed)`, 'INFO');
    return res;
  }

  function macrosForRenderer() {
    return {
      enabled: config.enabled,
      armed: config.armed,
      toggleHotkey: config.toggleHotkey,
      padType: config.padType,
      plugged,
      driver,
      clientDll: fs.existsSync(VIGEM_DLL),
      state,
      activeMacroId,
      macros: config.macros.map((m) => ({
        id: m.id,
        name: m.name,
        hotkey: m.hotkey,
        trigger: m.trigger,
        repeat: m.repeat,
        speed: m.speed,
        on: m.on !== false,
        steps: m.steps || []
      }))
    };
  }

  async function refreshDriverStatus() {
    driver = await queryDriverStatus();
    return driver;
  }

  // ── IPC ──
  ipcMain.handle('controller-macros-get', async () => {
    await refreshDriverStatus();
    return macrosForRenderer();
  });

  ipcMain.handle('controller-macros-set-enabled', async (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    registerAllHotkeys();
    if (!config.enabled) {
      if (state !== 'idle') stopEverything();
      killEngine(); // also unplugs the virtual pad
    } else {
      await refreshDriverStatus();
      if (driver.running) {
        // Plug the pad right away (like DS4Windows) so games see it from the
        // moment the widget is on, not mid-session when a macro first fires.
        ensurePadPlugged().catch((e) => logger.error('Pad warm-up failed', e));
      }
    }
    logger.success('Controller Macros widget toggled', { enabled: config.enabled });
    return macrosForRenderer();
  });

  ipcMain.handle('controller-macros-save', (_event, macro) => {
    if (!macro || typeof macro !== 'object') return { ok: false, error: 'invalid' };
    const clean = sanitizeMacro(macro);
    let hotkeyConflict = false;
    if (clean.hotkey) {
      // Never the widget toggles, never a keyboard-macro hotkey (that would
      // fire both widgets at once), one owner within this widget.
      const foreign = new Set(getKeyboardMacroHotkeys());
      if (clean.hotkey === config.toggleHotkey || foreign.has(clean.hotkey)) {
        clean.hotkey = null;
        hotkeyConflict = true;
      } else {
        for (const m of config.macros) {
          if (m.id !== clean.id && m.hotkey === clean.hotkey) m.hotkey = null;
        }
      }
    }
    const idx = config.macros.findIndex((m) => m.id === clean.id);
    if (idx >= 0) config.macros[idx] = clean;
    else config.macros.push(clean);
    saveConfig();
    syncTriggers();
    const hotkeyOk = !clean.hotkey || parseAccelerator(clean.hotkey) !== null;
    return { ok: true, id: clean.id, hotkeyOk: hotkeyOk && !hotkeyConflict };
  });

  ipcMain.handle('controller-macros-delete', (_event, id) => {
    const before = config.macros.length;
    config.macros = config.macros.filter((m) => m.id !== id);
    if (config.macros.length !== before) {
      if (state === 'playing' && activeMacroId === id) stopEverything();
      saveConfig();
      syncTriggers();
      logger.success('Controller macro deleted', { id });
    }
    return { ok: true };
  });

  ipcMain.handle('controller-macros-play', async (_event, id) => {
    try {
      return await playMacro(id);
    } catch (e) {
      logger.error('Controller macro playback failed to start', e);
      finishActivity();
      return { ok: false, error: 'engine-failed' };
    }
  });

  // Live "Test" from the step editor: plays the given (possibly unsaved) steps
  // once, without touching stored macros.
  ipcMain.handle('controller-macros-play-steps', async (_event, steps, speed) => {
    if (state !== 'idle') return { ok: false, error: 'busy' };
    try {
      const lines = compileStepsToEvents(sanitizeSteps(steps), speed || 1);
      return await playCompiled(lines, '__preview__', 1);
    } catch (e) {
      logger.error('Controller macro test playback failed', e);
      finishActivity();
      return { ok: false, error: 'engine-failed' };
    }
  });

  ipcMain.handle('controller-macros-stop', () => {
    stopEverything();
    return { ok: true };
  });

  ipcMain.handle('controller-macros-set-armed', (_event, armed) => {
    setArmed(armed);
    return macrosForRenderer();
  });

  ipcMain.handle('controller-macros-set-toggle-hotkey', (_event, accelerator) => {
    if (typeof accelerator !== 'string' || !accelerator) return { ok: false };
    if (isMouseHotkey(accelerator)) return { ok: false, error: 'mouse-not-supported' };
    if (config.macros.some((m) => m.hotkey === accelerator) || getKeyboardMacroHotkeys().includes(accelerator)) {
      return { ok: false, error: 'conflict' };
    }
    unregisterToggleHotkey();
    config.toggleHotkey = accelerator;
    saveConfig();
    if (config.enabled) registerToggleHotkey();
    logger.success('Controller macros enable/disable hotkey updated', { accelerator });
    return { ok: true };
  });

  ipcMain.handle('controller-macros-set-pad-type', async (_event, type) => {
    if (!PAD_TYPES.includes(type)) return { ok: false, error: 'invalid' };
    if (config.padType !== type) {
      config.padType = type;
      saveConfig();
      logger.success('Virtual pad type changed', { type });
      if (config.enabled && plugged) {
        if (state !== 'idle') stopEverything();
        try {
          await ensurePadPlugged(); // engine swaps the pad type live
        } catch (e) {
          logger.error('Pad re-plug after type change failed', e);
        }
      }
    }
    return macrosForRenderer();
  });

  ipcMain.handle('controller-macros-driver-status', async () => {
    await refreshDriverStatus();
    // A fresh driver install doesn't need an app restart — plug the pad as
    // soon as a re-check sees the bus running.
    if (config.enabled && driver.running && !plugged && state === 'idle') {
      ensurePadPlugged().catch((e) => logger.error('Pad plug after driver re-check failed', e));
    }
    return { ...driver, clientDll: fs.existsSync(VIGEM_DLL) };
  });

  ipcMain.handle('controller-macros-open-driver-page', async () => {
    await shell.openExternal(DRIVER_PAGE_URL);
    logger.log('ViGEmBus v1.22.0 installer download started', 'INFO');
    return { ok: true };
  });

  app.on('will-quit', () => killEngine());

  registerAllHotkeys();
  if (config.enabled) {
    refreshDriverStatus().then(() => {
      if (driver.running) {
        ensurePadPlugged().catch((e) => logger.error('Pad engine warm-up failed', e));
      }
    });
  }

  return {
    reapplyHotkeys: () => { triggersSuspended = false; registerAllHotkeys(); },
    suspendTriggers: () => { triggersSuspended = true; registerAllHotkeys(); }
  };
}

module.exports = { init };
