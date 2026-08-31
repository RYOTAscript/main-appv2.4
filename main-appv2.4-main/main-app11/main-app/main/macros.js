const { app, ipcMain, globalShortcut, screen, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');

const MACRO_ENGINE_SCRIPT_VERSION = 6;
const DEFAULT_TOGGLE_HOTKEY = 'F9';
const CAPTURE_ACCELERATOR = 'Alt+X';
const CAPTURE_VK = 0x58;            // X
const CAPTURE_MODS = 4;             // Alt, in the engine's mods bitmask
const CAPTURE_TIMEOUT_MS = 60000;   // long enough to alt-tab somewhere and aim
const TRIGGERS = ['pressed', 'hold', 'toggle', 'released'];

// ── Macro engine (record + playback + key watching) ──
// Windows has no scriptable API for globally recording or synthesizing input, so
// like Mic Mute this generates a helper .ps1 whose only job is to compile the C#
// below (user32 GetAsyncKeyState/GetCursorPos for recording, SendInput for
// playback) and run it as a persistent background process. The Electron main
// process talks to it over a simple line protocol on stdin/stdout:
//   REC <file>            start recording raw events to <file>
//   PLAY <count> <file>   play the raw events in <file> <count> times (0 = forever)
//   WATCH <vk,vk,...>     passively watch these virtual keys (empty list = none);
//                         the engine emits "KEY-DOWN <vk> <mods>" / "KEY-UP <vk>"
//                         (mods bitmask: 1 Ctrl, 2 Shift, 4 Alt, 8 Win). Needed
//                         for the Hold / Released trigger modes, since Electron's
//                         globalShortcut can't see key releases.
//   CAPTURE <vk> <mods>   arm a one-shot cursor-position capture: when <vk> goes
//                         down with exactly <mods> held, emit "CAPTURED <x> <y>"
//                         and disarm. The engine reads the cursor itself, at the
//                         instant of the press, so it works while another app has
//                         focus. "CAPTURE" with no arguments disarms.
//   STOP                  stop the current recording or playback
//   EXIT                  quit the engine process
// Raw event lines are "t kind a b" (all integers): t = ms offset, kind:
//   0 move(x,y)  1 keydown(vk)  2 keyup(vk)  3 mousedown(btn)  4 mouseup(btn)
//   5 wheel(notches, +up/-down)  6 unicode char press+release(charCode)
// Keyboard playback sends hardware scan codes (not just virtual keys) so it
// works in games that read input through DirectInput.
const MACRO_ENGINE_SCRIPT_CONTENT = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class MacroEngine {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    static volatile bool stopFlag = false;
    static Thread worker = null;
    static object emitLock = new object();
    // The watch list and "this list is new" travel together as one immutable
    // object. A separate re-prime flag can be set in between the loop's flag
    // check and its list read, which lets the loop run a brand-new list against
    // stale key state -- and fire a macro for a key that was merely already held
    // when the list was re-sent (which happens on every enable, save and import).
    class WatchSet { public int[] vks; public WatchSet(int[] v) { vks = v; } }
    static volatile WatchSet watchSet = new WatchSet(new int[0]);
    static Thread watchThread = null;
    // One-shot position capture (the CAPTURE command). Polled by the same watcher
    // thread, so the press is seen no matter which app is in the foreground.
    static volatile int captureVk = 0;        // 0 = disarmed
    static volatile int captureMods = -1;     // required mod bitmask, -1 = any

    static void Emit(string s) { lock (emitLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

    // Modifier bitmask: 1 Ctrl, 2 Shift, 4 Alt, 8 Win.
    static int Mods() {
        int mods = 0;
        if ((GetAsyncKeyState(0x11) & 0x8000) != 0) mods |= 1;
        if ((GetAsyncKeyState(0x10) & 0x8000) != 0) mods |= 2;
        if ((GetAsyncKeyState(0x12) & 0x8000) != 0) mods |= 4;
        if ((GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0) mods |= 8;
        return mods;
    }

    static void EnsureWatchThread() {
        if (watchThread == null || !watchThread.IsAlive) {
            watchThread = new Thread(WatchLoop);
            watchThread.IsBackground = true;
            watchThread.Start();
        }
    }

    public static void RunHost() {
        SetProcessDPIAware();
        Emit("READY");
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "EXIT") { stopFlag = true; if (worker != null && worker.IsAlive) worker.Join(2000); break; }
            if (line == "STOP") { stopFlag = true; continue; }
            if (line == "PING") { Emit("PONG"); continue; }
            if (line.StartsWith("WATCH")) {
                string wrest = line.Length > 5 ? line.Substring(5).Trim() : "";
                var lst = new List<int>();
                if (wrest.Length > 0) {
                    foreach (string part in wrest.Split(',')) {
                        int v;
                        if (int.TryParse(part.Trim(), out v) && v > 0 && v < 256) lst.Add(v);
                    }
                }
                watchSet = new WatchSet(lst.ToArray());
                EnsureWatchThread();
                Emit("WATCH-OK " + lst.Count);
                continue;
            }
            if (line.StartsWith("CAPTURE")) {
                string crest = line.Length > 7 ? line.Substring(7).Trim() : "";
                int cvk = 0, cmods = -1;
                if (crest.Length > 0) {
                    string[] cp = crest.Split(' ');
                    int.TryParse(cp[0], out cvk);
                    if (cp.Length < 2 || !int.TryParse(cp[1], out cmods)) cmods = -1;
                }
                captureMods = cmods;               // written before captureVk:
                captureVk = (cvk > 0 && cvk < 256) ? cvk : 0;  // the loop gates on vk
                if (captureVk != 0) EnsureWatchThread();
                Emit("CAPTURE-OK " + captureVk);
                continue;
            }
            bool busy = worker != null && worker.IsAlive;
            if (line.StartsWith("REC ")) {
                if (busy) { Emit("ERR busy"); continue; }
                string recPath = line.Substring(4);
                stopFlag = false;
                worker = new Thread(delegate() { Record(recPath); });
                worker.IsBackground = true;
                worker.Start();
                Emit("REC-STARTED");
            } else if (line.StartsWith("PLAY ")) {
                if (busy) { Emit("ERR busy"); continue; }
                string rest = line.Substring(5);
                int sp = rest.IndexOf(' ');
                if (sp < 1) { Emit("ERR play-args"); continue; }
                int count = 0;
                int.TryParse(rest.Substring(0, sp), out count);
                string playPath = rest.Substring(sp + 1);
                stopFlag = false;
                worker = new Thread(delegate() { Play(playPath, count); });
                worker.IsBackground = true;
                worker.Start();
                Emit("PLAY-STARTED");
            } else {
                Emit("ERR unknown");
            }
        }
    }

    // Passive key watcher for Hold / Released macro triggers. Runs alongside
    // recording and playback on its own thread; only reports state changes.
    static void WatchLoop() {
        bool[] down = new bool[256];
        bool[] primed = new bool[256];
        bool capDown = false, capPrimed = false;
        int lastCvk = 0;
        WatchSet seen = null;
        while (true) {
            // On a fresh WATCH list, read current state without emitting so a key
            // that's already down (or a stale GetAsyncKeyState bit) doesn't fire a
            // phantom event -- only real presses after this point count. The one
            // volatile read is what makes that airtight: the list and its newness
            // cannot be observed apart, so no list is ever run un-primed.
            WatchSet ws = watchSet;
            if (!object.ReferenceEquals(ws, seen)) { seen = ws; for (int k = 0; k < 256; k++) primed[k] = false; }
            int cvk = captureVk;
            if (cvk != lastCvk) { lastCvk = cvk; capPrimed = false; }  // same, for the capture key
            if (cvk > 0) {
                bool capIsDown = (GetAsyncKeyState(cvk) & 0x8000) != 0;
                if (!capPrimed) { capDown = capIsDown; capPrimed = true; }
                else if (capIsDown != capDown) {
                    capDown = capIsDown;
                    // The cursor is read here, in the engine, at the moment of the
                    // press -- reading it back in the host would give whatever the
                    // cursor was doing by the time the host got around to looking.
                    if (capIsDown && (captureMods < 0 || captureMods == Mods())) {
                        POINT cpos; GetCursorPos(out cpos);
                        captureVk = 0; capPrimed = false;
                        Emit("CAPTURED " + cpos.X + " " + cpos.Y);
                    }
                }
            }
            int[] vks = ws.vks;
            if (vks.Length == 0) { Thread.Sleep(cvk > 0 ? 10 : 50); continue; }
            for (int i = 0; i < vks.Length; i++) {
                int vk = vks[i];
                if (vk < 1 || vk > 255) continue;
                bool isDown = (GetAsyncKeyState(vk) & 0x8000) != 0;
                if (!primed[vk]) { down[vk] = isDown; primed[vk] = true; continue; }
                if (isDown == down[vk]) continue;
                down[vk] = isDown;
                if (isDown) {
                    Emit("KEY-DOWN " + vk + " " + Mods());
                } else {
                    Emit("KEY-UP " + vk);
                }
            }
            Thread.Sleep(10);
        }
    }

    static void Record(string path) {
        try {
            var sb = new System.Text.StringBuilder();
            var sw = Stopwatch.StartNew();
            bool[] down = new bool[256];
            POINT last; GetCursorPos(out last);
            long lastMoveT = -1000;
            int count = 0;
            // Prime GetAsyncKeyState so stale "was pressed" bits don't fire immediately.
            for (int vk = 1; vk < 256; vk++) GetAsyncKeyState(vk);
            while (!stopFlag) {
                long t = sw.ElapsedMilliseconds;
                POINT p; GetCursorPos(out p);
                if ((p.X != last.X || p.Y != last.Y) && t - lastMoveT >= 8) {
                    sb.Append(t).Append(" 0 ").Append(p.X).Append(' ').Append(p.Y).Append('\\n');
                    last = p; lastMoveT = t; count++;
                }
                for (int vk = 1; vk < 255; vk++) {
                    // Skip the generic modifier VKs (0x10-0x12) -- the L/R variants
                    // (0xA0-0xA5) report the same presses and recording both would
                    // double every modifier event.
                    if (vk == 0x10 || vk == 0x11 || vk == 0x12) continue;
                    bool isDown = (GetAsyncKeyState(vk) & 0x8000) != 0;
                    if (isDown == down[vk]) continue;
                    down[vk] = isDown;
                    int kind; int a;
                    if (vk == 0x01 || vk == 0x02 || vk == 0x04 || vk == 0x05 || vk == 0x06) {
                        kind = isDown ? 3 : 4;
                        a = vk == 0x01 ? 0 : (vk == 0x02 ? 1 : (vk == 0x04 ? 2 : (vk == 0x05 ? 3 : 4)));
                    } else {
                        kind = isDown ? 1 : 2;
                        a = vk;
                    }
                    sb.Append(t).Append(' ').Append(kind).Append(' ').Append(a).Append(" 0\\n");
                    count++;
                }
                Thread.Sleep(4);
            }
            File.WriteAllText(path, sb.ToString());
            Emit("REC-DONE " + count);
        } catch (Exception e) {
            Emit("ERR record " + e.Message.Replace('\\n', ' ').Replace('\\r', ' '));
        }
    }

    static bool IsExtendedKey(int vk) {
        return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 ||
               vk == 0x27 || vk == 0x28 || vk == 0x2C || vk == 0x2D || vk == 0x2E ||
               vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 ||
               vk == 0xA3 || vk == 0xA5;
    }

    static void SendKey(int vk, bool isDown) {
        var inp = new INPUT[1];
        inp[0].type = 1;
        uint scan = MapVirtualKey((uint)vk, 0);
        uint flags = isDown ? 0u : 2u;
        if (scan != 0) {
            inp[0].U.ki.wVk = 0;
            inp[0].U.ki.wScan = (ushort)scan;
            flags |= 8u;
            if (IsExtendedKey(vk)) flags |= 1u;
        } else {
            inp[0].U.ki.wVk = (ushort)vk;
        }
        inp[0].U.ki.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void SendUnicode(int ch) {
        var inp = new INPUT[2];
        inp[0].type = 1;
        inp[0].U.ki.wScan = (ushort)ch;
        inp[0].U.ki.dwFlags = 4u;          // KEYEVENTF_UNICODE
        inp[1].type = 1;
        inp[1].U.ki.wScan = (ushort)ch;
        inp[1].U.ki.dwFlags = 4u | 2u;     // UNICODE | KEYUP
        SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void SendBtn(int btn, bool isDown) {
        var inp = new INPUT[1];
        inp[0].type = 0;
        uint flags;
        if (btn == 0) flags = isDown ? 0x0002u : 0x0004u;
        else if (btn == 1) flags = isDown ? 0x0008u : 0x0010u;
        else if (btn == 2) flags = isDown ? 0x0020u : 0x0040u;
        else {
            // Side buttons (X1/X2) go through MOUSEEVENTF_XDOWN/XUP with
            // mouseData naming which XBUTTON (1 = X1/Mouse4, 2 = X2/Mouse5).
            flags = isDown ? 0x0100u : 0x0200u;
            inp[0].U.mi.mouseData = btn == 3 ? 1 : 2;
        }
        inp[0].U.mi.dwFlags = flags;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void SendWheel(int notches) {
        var inp = new INPUT[1];
        inp[0].type = 0;
        inp[0].U.mi.mouseData = notches * 120;
        inp[0].U.mi.dwFlags = 0x0800u;     // MOUSEEVENTF_WHEEL
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void SendMove(int x, int y, int vx, int vy, int vw, int vh) {
        var inp = new INPUT[1];
        inp[0].type = 0;
        inp[0].U.mi.dx = (int)(((long)(x - vx) * 65535) / (vw > 1 ? vw - 1 : 1));
        inp[0].U.mi.dy = (int)(((long)(y - vy) * 65535) / (vh > 1 ? vh - 1 : 1));
        inp[0].U.mi.dwFlags = 0x0001u | 0x8000u | 0x4000u; // MOVE | ABSOLUTE | VIRTUALDESK
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Play(string path, int count) {
        try {
            string[] lines = File.ReadAllLines(path);
            var evs = new List<int[]>();
            foreach (string ln in lines) {
                if (ln.Length == 0) continue;
                string[] q = ln.Split(' ');
                evs.Add(new int[] { int.Parse(q[0]), int.Parse(q[1]), int.Parse(q[2]), int.Parse(q[3]) });
            }
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
            int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            bool[] heldKeys = new bool[256];
            bool[] heldBtns = new bool[5];
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
                        case 0: SendMove(ev[2], ev[3], vx, vy, vw, vh); break;
                        case 1: SendKey(ev[2], true); if (ev[2] < 256) heldKeys[ev[2]] = true; break;
                        case 2: SendKey(ev[2], false); if (ev[2] < 256) heldKeys[ev[2]] = false; break;
                        case 3: SendBtn(ev[2], true); if (ev[2] < 5) heldBtns[ev[2]] = true; break;
                        case 4: SendBtn(ev[2], false); if (ev[2] < 5) heldBtns[ev[2]] = false; break;
                        case 5: SendWheel(ev[2]); break;
                        case 6: SendUnicode(ev[2]); break;
                    }
                }
                done++;
            } while (!stopped && (count == 0 || done < count));
            // Never leave keys or buttons stuck down if stopped mid-macro.
            for (int vk = 0; vk < 256; vk++) if (heldKeys[vk]) SendKey(vk, false);
            for (int b = 0; b < 5; b++) if (heldBtns[b]) SendBtn(b, false);
            Emit((stopped ? "PLAY-STOPPED " : "PLAY-DONE ") + done);
        } catch (Exception e) {
            Emit("ERR play " + e.Message.Replace('\\n', ' ').Replace('\\r', ' '));
        }
    }
}
'@

[MacroEngine]::RunHost()
`;

// ── Key name <-> Windows virtual-key code mapping ──
// Steps store human-readable key names; the engine speaks raw VK codes.
const NAME_TO_VK = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m[String.fromCharCode(65 + i)] = 65 + i;
  for (let i = 0; i < 10; i++) m[String(i)] = 48 + i;
  for (let i = 1; i <= 24; i++) m[`F${i}`] = 111 + i;
  for (let i = 0; i < 10; i++) m[`Num${i}`] = 96 + i;
  Object.assign(m, {
    Space: 32, Enter: 13, Tab: 9, Escape: 27, Backspace: 8, CapsLock: 20,
    LShift: 160, RShift: 161, LCtrl: 162, RCtrl: 163, LAlt: 164, RAlt: 165,
    LWin: 91, RWin: 92, Menu: 93, Pause: 19, ScrollLock: 145, NumLock: 144,
    PrintScreen: 44, Insert: 45, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34,
    Up: 38, Down: 40, Left: 37, Right: 39,
    'Num+': 107, 'Num-': 109, 'Num*': 106, 'Num/': 111, 'Num.': 110,
    ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192,
    '[': 219, '\\': 220, ']': 221, "'": 222
  });
  return m;
})();
const VK_TO_NAME = (() => {
  const m = {};
  for (const [name, vk] of Object.entries(NAME_TO_VK)) if (!(vk in m)) m[vk] = name;
  return m;
})();

function keyNameToVk(name) {
  if (name in NAME_TO_VK) return NAME_TO_VK[name];
  const raw = /^#(\d+)$/.exec(name || '');
  return raw ? Number(raw[1]) : null;
}
function vkToKeyName(vk) {
  return VK_TO_NAME[vk] || `#${vk}`;
}

// Mouse buttons that can trigger a macro. Electron's globalShortcut is keyboard
// only, so mouse-button hotkeys are ALWAYS driven by the engine's key watcher
// (GetAsyncKeyState reads these VK codes just like keys), regardless of trigger
// mode.
const MOUSE_HOTKEY_VK = { MouseLeft: 1, MouseRight: 2, MouseMiddle: 4, Mouse4: 5, Mouse5: 6 };
function isMouseHotkey(accelerator) {
  return typeof accelerator === 'string' && Object.prototype.hasOwnProperty.call(MOUSE_HOTKEY_VK, accelerator);
}

// Splits an Electron accelerator into a modifier bitmask (matching the engine's
// KEY-DOWN mods: 1 Ctrl, 2 Shift, 4 Alt, 8 Win) and the final key's VK code.
// Used both to scrub the stop hotkey out of recordings and to drive the
// Hold / Released trigger modes (and all mouse-button triggers) through the
// engine's key watcher.
function parseAccelerator(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return null;
  if (isMouseHotkey(accelerator)) return { mods: 0, vk: MOUSE_HOTKEY_VK[accelerator], mouse: true };
  const parts = accelerator.split('+');
  let mods = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i].toLowerCase();
    if (p === 'ctrl' || p === 'control' || p === 'commandorcontrol' || p === 'cmdorctrl') mods |= 1;
    else if (p === 'shift') mods |= 2;
    else if (p === 'alt') mods |= 4;
    else if (p === 'super' || p === 'meta' || p === 'win') mods |= 8;
  }
  const vk = keyNameToVk(parts[parts.length - 1]);
  return vk === null ? null : { mods, vk, mouse: false };
}

// ── Macro sanitizing ──
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function newMacroId() {
  return `macro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    if (s.t === 'delay') {
      out.push({ t: 'delay', ms: clampInt(s.ms, 0, 600000, 0) });
    } else if (s.t === 'key' || s.t === 'kd' || s.t === 'ku') {
      if (typeof s.k === 'string' && s.k) out.push({ t: s.t, k: s.k });
    } else if (s.t === 'click' || s.t === 'move') {
      const st = { t: s.t };
      if (s.t === 'click') st.b = [0, 1, 2, 3, 4].includes(Number(s.b)) ? Number(s.b) : 0;
      if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
        st.x = Math.round(s.x);
        st.y = Math.round(s.y);
      }
      out.push(st);
    } else if (s.t === 'md' || s.t === 'mu') {
      out.push({ t: s.t, b: [0, 1, 2, 3, 4].includes(Number(s.b)) ? Number(s.b) : 0 });
    } else if (s.t === 'scroll') {
      const d = clampInt(s.d, -100, 100, 1);
      out.push({ t: 'scroll', d: d === 0 ? 1 : d });
    } else if (s.t === 'text') {
      if (typeof s.s === 'string') out.push({ t: 'text', s: s.s.slice(0, 2000) });
    } else if (s.t === 'path' && Array.isArray(s.pts)) {
      const pts = s.pts.filter((p) => Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n)));
      if (pts.length) out.push({ t: 'path', pts });
    }
  }
  return out;
}

// Also migrates the pre-3.4 `loop` boolean: loop meant "toggle on/off with the
// hotkey and repeat forever", non-loop meant "play once on press".
function sanitizeMacro(macro) {
  const m = macro && typeof macro === 'object' ? macro : {};
  const speed = Number(m.speed);
  return {
    id: typeof m.id === 'string' && m.id ? m.id : newMacroId(),
    name: (typeof m.name === 'string' && m.name.trim()) || 'Macro',
    hotkey: typeof m.hotkey === 'string' && m.hotkey ? m.hotkey : null,
    trigger: TRIGGERS.includes(m.trigger) ? m.trigger : (m.loop ? 'toggle' : 'pressed'),
    repeat: clampInt(m.repeat, 0, 9999, m.loop ? 0 : 1),
    speed: Number.isFinite(speed) ? Math.min(4, Math.max(0.25, speed)) : 1,
    on: m.on !== false,
    steps: sanitizeSteps(m.steps)
  };
}

// ── Steps <-> raw engine events ──
// Steps are what the user sees and edits:
//   {t:'delay', ms}                       wait
//   {t:'key',  k:'E'}                     press+release
//   {t:'kd',   k:'E'} / {t:'ku', k:'E'}   hold / release
//   {t:'click',b:0-4, x?, y?}              click (fixed position optional)
//   {t:'md',   b} / {t:'mu', b}           button hold / release
//   b: 0 Left, 1 Right, 2 Middle, 3 Mouse4 (X1/back), 4 Mouse5 (X2/forward)
//   {t:'move', x?, y?}                    move cursor to a fixed position
//   {t:'scroll', d}                       mouse wheel, d notches (+up / -down)
//   {t:'text', s}                         type a string (unicode, layout-proof)
//   {t:'path', pts:[[dt,x,y],...]}        recorded mouse movement
function compileStepsToEvents(steps, speed) {
  const evs = [];
  let t = 0;
  for (const s of steps || []) {
    if (!s || typeof s !== 'object') continue;
    if (s.t === 'delay') {
      t += Math.max(0, Number(s.ms) || 0);
    } else if (s.t === 'key') {
      const vk = keyNameToVk(s.k);
      if (vk === null) continue;
      evs.push([t, 1, vk, 0]);
      t += 35;
      evs.push([t, 2, vk, 0]);
      t += 15;
    } else if (s.t === 'kd' || s.t === 'ku') {
      const vk = keyNameToVk(s.k);
      if (vk === null) continue;
      evs.push([t, s.t === 'kd' ? 1 : 2, vk, 0]);
      t += 10;
    } else if (s.t === 'click') {
      const b = Number(s.b) || 0;
      if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
        evs.push([t, 0, Math.round(s.x), Math.round(s.y)]);
        t += 15;
      }
      evs.push([t, 3, b, 0]);
      t += 45;
      evs.push([t, 4, b, 0]);
      t += 15;
    } else if (s.t === 'md' || s.t === 'mu') {
      evs.push([t, s.t === 'md' ? 3 : 4, Number(s.b) || 0, 0]);
      t += 10;
    } else if (s.t === 'move') {
      if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
        evs.push([t, 0, Math.round(s.x), Math.round(s.y)]);
        t += 15;
      }
    } else if (s.t === 'scroll') {
      const d = Math.trunc(Number(s.d) || 0);
      if (d) {
        evs.push([t, 5, d, 0]);
        t += 20;
      }
    } else if (s.t === 'text') {
      const str = String(s.s || '');
      // charCodeAt (UTF-16 units) on purpose: surrogate halves sent as two
      // consecutive KEYEVENTF_UNICODE events reassemble correctly in Windows.
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 10) {
          evs.push([t, 1, 13, 0]);
          t += 25;
          evs.push([t, 2, 13, 0]);
          t += 10;
        } else if (code !== 13) {
          evs.push([t, 6, code, 0]);
          t += 25;
        }
      }
    } else if (s.t === 'path' && Array.isArray(s.pts)) {
      for (const p of s.pts) {
        t += Math.max(0, Number(p[0]) || 0);
        evs.push([t, 0, Math.round(p[1]), Math.round(p[2])]);
      }
    }
  }
  const spd = Number(speed) > 0 ? Math.min(4, Math.max(0.25, Number(speed))) : 1;
  return evs.map((e) => `${Math.round(e[0] / spd)} ${e[1]} ${e[2]} ${e[3]}`);
}

// What kinds of input a recording keeps. Any of these can be switched off from
// the "Record new" dropdown so a recording only captures what you care about.
function normalizeRecordFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  return {
    mouseMove: f.mouseMove !== false,
    delays: f.delays !== false,
    mouseButtons: f.mouseButtons !== false,
    keyboard: f.keyboard !== false
  };
}

// Turns a raw recording into editable steps: consecutive mouse moves collapse
// into one 'path' step, gaps become 'delay' steps, everything else maps 1:1.
// `filters` drops whole categories of events (mouse movement, mouse buttons,
// keyboard keys) and can suppress the inter-step 'delay' steps entirely.
// VK -> mods bit for the specific-side modifier keys the recorder captures
// (see Record(): generic 0x10-0x12 are skipped, L/R variants are recorded).
const MODIFIER_VK_BITS = { 160: 2, 161: 2, 162: 1, 163: 1, 164: 4, 165: 4, 91: 8, 92: 8 };

function eventsToSteps(rawLines, stripAccel, filters) {
  const f = normalizeRecordFilters(filters);
  const stripVk = stripAccel ? stripAccel.vk : null;
  const stripMods = stripAccel ? stripAccel.mods : 0;
  const events = [];
  // Tracks which modifiers are currently held as we scan the recording in order,
  // so a toggle hotkey like Ctrl+F9 only strips F9 while Ctrl is actually down --
  // an unrelated bare F9 press elsewhere in the recording is left alone.
  let curMods = 0;
  for (const ln of rawLines) {
    const q = ln.trim().split(' ');
    if (q.length !== 4) continue;
    const ev = q.map(Number);
    if (ev.some((n) => !Number.isFinite(n))) continue;
    const modBit = MODIFIER_VK_BITS[ev[2]];
    if (modBit && (ev[1] === 1 || ev[1] === 2)) {
      curMods = ev[1] === 1 ? (curMods | modBit) : (curMods & ~modBit);
    }
    if (stripVk !== null && (ev[1] === 1 || ev[1] === 2) && ev[2] === stripVk && curMods === stripMods) continue;
    if (ev[1] === 0 && !f.mouseMove) continue;
    if ((ev[1] === 1 || ev[1] === 2) && !f.keyboard) continue;
    if ((ev[1] === 3 || ev[1] === 4) && !f.mouseButtons) continue;
    events.push(ev);
  }
  const steps = [];
  let prevT = 0;
  let i = 0;
  while (i < events.length) {
    const [t, kind, a, b] = events[i];
    if (kind === 0) {
      const pts = [];
      let segPrev = prevT;
      let j = i;
      while (j < events.length && events[j][1] === 0) {
        pts.push([events[j][0] - segPrev, events[j][2], events[j][3]]);
        segPrev = events[j][0];
        j++;
      }
      steps.push({ t: 'path', pts });
      prevT = segPrev;
      i = j;
      continue;
    }
    const gap = t - prevT;
    if (gap > 30 && f.delays) steps.push({ t: 'delay', ms: gap });
    if (kind === 1) steps.push({ t: 'kd', k: vkToKeyName(a) });
    else if (kind === 2) steps.push({ t: 'ku', k: vkToKeyName(a) });
    else if (kind === 3) steps.push({ t: 'md', b: a });
    else if (kind === 4) steps.push({ t: 'mu', b: a });
    prevT = t;
    i++;
  }
  return steps;
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  const CONFIG_PATH = path.join(userDataPath, 'macros-config.json');
  const ENGINE_SCRIPT = path.join(userDataPath, 'macro-engine.ps1');
  const RECORD_FILE = path.join(userDataPath, 'macro-recording.tmp');
  const PLAY_FILE = path.join(userDataPath, 'macro-playback.tmp');

  let config = loadConfig();
  let engineProc = null;
  let engineReady = false;
  let engineBuffer = '';
  let engineReadyWaiters = [];
  // One activity at a time: 'idle' | 'recording' | 'playing'
  let state = 'idle';
  let activeMacroId = null;      // macro being played
  let recordTargetId = null;     // macro being (re-)recorded into, null = new macro
  let recordFilters = null;      // which input categories the active recording keeps
  let registeredAccels = [];     // every accelerator this module currently holds
  let toggleHotkeyRegistered = false;
  // Hold / Released trigger bookkeeping (fed by the engine's key watcher)
  let watchMap = new Map();      // vk -> [{ id, mods, trigger }]
  let releasedArmed = new Set(); // 'released' macros whose key is currently down
  // Second key-watch consumer (Controller Macros). It shares this module's
  // engine process instead of spawning its own GetAsyncKeyState poller: the
  // WATCH list sent to the engine is the union of both, and watched events are
  // dispatched to the external callback as well as to this module's own map.
  let externalWatch = { vks: new Set(), cb: null };
  // Set while the renderer is capturing raw keys (a hotkey bind, a "press a
  // key" step). Triggers are engine-watched, so globalShortcut.unregisterAll()
  // -- what disable-all-hotkeys used to be -- doesn't touch them: without this,
  // binding a key that a macro owns fires that macro while you're binding it.
  let triggersSuspended = false;
  // Alt+X position capture
  let capturePending = null;     // { resolve, timeout, viaShortcut, targetId, stepIndex }

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
          enabled: raw.enabled === true,
          armed: raw.armed !== false, // macros active by default; false = user disabled
          toggleHotkey: typeof raw.toggleHotkey === 'string' && raw.toggleHotkey
            ? raw.toggleHotkey
            : (typeof raw.stopHotkey === 'string' && raw.stopHotkey ? raw.stopHotkey : DEFAULT_TOGGLE_HOTKEY),
          macros: Array.isArray(raw.macros)
            ? raw.macros.filter((m) => m && typeof m === 'object' && m.id).map(sanitizeMacro)
            : []
        };
      }
    } catch (e) {
      logger.error('Failed to read macros config', e);
    }
    return { enabled: false, armed: true, toggleHotkey: DEFAULT_TOGGLE_HOTKEY, macros: [] };
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save macros config', e);
    }
  }

  function pushStatus(extra) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('macros-status', {
        enabled: config.enabled,
        armed: config.armed,
        state,
        activeMacroId,
        toggleHotkey: config.toggleHotkey,
        ...(extra || {})
      });
    }
  }

  // ── Engine process ──
  function ensureEngineScript() {
    ensureVersionedScript(ENGINE_SCRIPT, MACRO_ENGINE_SCRIPT_VERSION, MACRO_ENGINE_SCRIPT_CONTENT);
  }

  function ensureEngine() {
    return new Promise((resolve, reject) => {
      if (engineProc && engineReady) { resolve(); return; }
      engineReadyWaiters.push({ resolve, reject });
      if (engineProc) return; // already starting — the READY handler resolves everyone
      ensureEngineScript();
      try {
        engineProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENGINE_SCRIPT], {
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
          logger.error('Macro engine did not become ready in time', null, {});
          killEngine();
          flushReadyWaiters(new Error('Macro engine failed to start'));
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
            clearTimeout(startTimeout);
            logger.success('Macro engine started');
            sendWatchList();
            flushReadyWaiters(null);
          } else {
            handleEngineLine(line);
          }
        }
      });
      engineProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) logger.error('Macro engine stderr', new Error(msg));
      });
      engineProc.on('exit', (code) => {
        const wasActive = state !== 'idle';
        engineProc = null;
        engineReady = false;
        engineBuffer = '';
        clearTimeout(startTimeout);
        flushReadyWaiters(new Error('Macro engine exited'));
        settleCapture({ cancelled: true }); // a capture armed in the engine died with it
        if (wasActive) {
          logger.error('Macro engine exited unexpectedly', null, { code, state });
          finishActivity();
        } else {
          logger.log(`Macro engine exited (code ${code})`, 'INFO');
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
    settleCapture({ cancelled: true });
    try {
      engineSend('EXIT');
      const proc = engineProc;
      setTimeout(() => { try { proc.kill(); } catch (e) { /* already gone */ } }, 1500);
    } catch (e) { /* ignore */ }
    engineProc = null;
    engineReady = false;
  }

  function finishActivity() {
    state = 'idle';
    activeMacroId = null;
    recordTargetId = null;
    pushStatus();
  }

  function handleEngineLine(line) {
    if (line.startsWith('CAPTURED ')) {
      const parts = line.split(' ');
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      if (Number.isFinite(x) && Number.isFinite(y)) settleCapture({ x, y });
      return;
    }
    if (line.startsWith('KEY-DOWN ') || line.startsWith('KEY-UP ')) {
      const parts = line.split(' ');
      onWatchedKey(Number(parts[1]), Number(parts[2]) || 0, line.startsWith('KEY-DOWN '));
    } else if (line.startsWith('REC-DONE')) {
      const targetId = recordTargetId;
      let steps = [];
      try {
        const raw = fs.readFileSync(RECORD_FILE, 'utf8').split('\n');
        steps = eventsToSteps(raw, parseAccelerator(config.toggleHotkey), recordFilters);
        fs.unlinkSync(RECORD_FILE);
      } catch (e) {
        logger.error('Failed to read macro recording', e);
      }
      if (steps.length) {
        if (targetId) {
          const m = config.macros.find((x) => x.id === targetId);
          if (m) m.steps = steps;
        } else {
          config.macros.push(sanitizeMacro({ name: `Recorded macro ${config.macros.length + 1}`, steps }));
        }
        saveConfig();
        registerAllHotkeys();
        logger.success('Macro recording saved', { steps: steps.length, targetId });
      } else {
        logger.warn('Macro recording was empty — nothing saved');
      }
      finishActivity();
      pushStatus({ event: 'record-done', savedSteps: steps.length });
    } else if (line.startsWith('PLAY-DONE') || line.startsWith('PLAY-STOPPED')) {
      logger.log(`Macro playback finished (${line})`, 'INFO');
      finishActivity();
    } else if (line.startsWith('ERR')) {
      logger.error('Macro engine error', new Error(line));
      finishActivity();
    }
    // REC-STARTED / PLAY-STARTED / WATCH-OK / CAPTURE-OK / PONG are acks — state
    // was already set.
  }

  // ── Hotkeys & triggers ──
  // Every macro trigger — keyboard or mouse, in all four trigger modes — is
  // driven by the engine's passive key watcher (GetAsyncKeyState), NOT Electron's
  // globalShortcut. globalShortcut swallows the key so it never reaches the
  // focused app; the watcher only observes it, so the trigger key/button still
  // passes through to the game or app underneath (same as TG Macro). The watcher
  // is also the only way to see key releases (Hold/Released) and mouse buttons.
  // The single exception is the enable/disable toggle hotkey, which stays on
  // globalShortcut (it's a dedicated control key, so swallowing it is fine).
  function unregisterAllHotkeys() {
    for (const accel of registeredAccels) {
      try { globalShortcut.unregister(accel); } catch (e) { /* ignore */ }
    }
    registeredAccels = [];
    toggleHotkeyRegistered = false;
  }

  function registerAllHotkeys() {
    unregisterAllHotkeys();
    // All macro triggers are engine-watched (see syncWatch), so the trigger key
    // passes through to the focused app. globalShortcut is only used for the
    // enable/disable toggle hotkey, registered whenever the widget is enabled —
    // even while disarmed — so it can always flip macros back on.
    syncWatch();
    if (config.enabled && !triggersSuspended) registerToggleHotkey();
  }

  function syncWatch() {
    watchMap = new Map();
    releasedArmed.clear();
    // Watcher fires only when the widget is enabled (Settings master switch) AND
    // armed (the user's enable/disable toggle), and never while the renderer is
    // capturing keys.
    if (config.enabled && config.armed && !triggersSuspended) {
      for (const m of config.macros) {
        if (!m.hotkey || m.on === false) continue;
        const parsed = parseAccelerator(m.hotkey);
        if (!parsed) {
          logger.warn('Macro hotkey not watchable', { macro: m.name, hotkey: m.hotkey });
          continue;
        }
        const list = watchMap.get(parsed.vk) || [];
        list.push({ id: m.id, mods: parsed.mods, trigger: m.trigger });
        watchMap.set(parsed.vk, list);
      }
    }
    if (watchMap.size) {
      ensureEngine()
        .then(() => sendWatchList())
        .catch((e) => logger.error('Macro engine unavailable for hold/release triggers', e));
    } else if (engineProc && engineReady) {
      sendWatchList();
    }
  }

  function sendWatchList() {
    const vks = [...new Set([...watchMap.keys(), ...externalWatch.vks])];
    engineSend(vks.length ? `WATCH ${vks.join(',')}` : 'WATCH');
  }

  // Registers (or clears, with an empty list) the external consumer's watched
  // virtual keys. Starts the engine if it isn't running — the external consumer
  // may need key watching while the Macros widget itself is disabled.
  function setExternalWatch(vks, cb) {
    externalWatch.vks = new Set((Array.isArray(vks) ? vks : []).filter((v) => Number.isInteger(v) && v > 0 && v < 256));
    externalWatch.cb = typeof cb === 'function' ? cb : null;
    if (externalWatch.vks.size) {
      ensureEngine()
        .then(() => sendWatchList())
        .catch((e) => logger.error('Macro engine unavailable for external key watch', e));
    } else if (engineProc && engineReady) {
      sendWatchList();
      // Neither widget needs the engine any more — let it exit instead of
      // idling as a background process.
      if (!config.enabled && state === 'idle') killEngine();
    }
  }

  function onWatchedKey(vk, mods, isDown) {
    if (state === 'recording') return; // don't trigger macros mid-recording
    if (externalWatch.cb && externalWatch.vks.has(vk)) {
      try {
        externalWatch.cb(vk, mods, isDown);
      } catch (e) {
        logger.error('External key-watch callback failed', e, { vk });
      }
    }
    const entries = watchMap.get(vk);
    if (!entries) return;
    for (const ent of entries) {
      // 'pressed' / 'toggle' fire on press; pressing again stops a looping run
      // (onMacroHotkey handles that). Matching mods means a plain-key hotkey only
      // fires with no modifiers held, and a combo only fires with its combo.
      if (ent.trigger === 'pressed' || ent.trigger === 'toggle') {
        if (isDown && ent.mods === mods) onMacroHotkey(ent.id);
      } else if (ent.trigger === 'hold') {
        if (isDown) {
          if (ent.mods === mods && state === 'idle') {
            playMacro(ent.id, 0).catch((e) => logger.error('Hold macro failed to start', e, { id: ent.id }));
          }
        } else if (state === 'playing' && activeMacroId === ent.id) {
          stopEverything();
        }
      } else if (ent.trigger === 'released') {
        if (isDown) {
          if (state === 'playing' && activeMacroId === ent.id) {
            stopEverything(); // pressing the key again while it plays stops it
          } else if (ent.mods === mods) {
            releasedArmed.add(ent.id);
          }
        } else if (releasedArmed.delete(ent.id) && state === 'idle') {
          playMacro(ent.id).catch((e) => logger.error('Release macro failed to start', e, { id: ent.id }));
        }
      }
    }
  }

  function registerToggleHotkey() {
    if (toggleHotkeyRegistered) return;
    try {
      const ok = globalShortcut.register(config.toggleHotkey, toggleArmed);
      if (ok) {
        registeredAccels.push(config.toggleHotkey);
        toggleHotkeyRegistered = true;
      } else {
        logger.warn('Macro toggle hotkey unavailable', { hotkey: config.toggleHotkey });
      }
    } catch (e) {
      logger.error('Macro toggle hotkey registration failed', e, { hotkey: config.toggleHotkey });
    }
  }

  function unregisterToggleHotkey() {
    if (!toggleHotkeyRegistered) return;
    try { globalShortcut.unregister(config.toggleHotkey); } catch (e) { /* ignore */ }
    registeredAccels = registeredAccels.filter((a) => a !== config.toggleHotkey);
    toggleHotkeyRegistered = false;
  }

  // Enable/disable macros without touching the Settings master switch. Disarming
  // stops anything currently running; the toggle hotkey stays live so it can
  // re-arm. The engine is left warm so re-arming is instant.
  function setArmed(armed) {
    const next = !!armed;
    if (config.armed === next) return;
    config.armed = next;
    saveConfig();
    if (!next && state !== 'idle') stopEverything();
    registerAllHotkeys();
    logger.success('Macros toggled', { armed: config.armed });
    pushStatus({ event: 'armed-changed', armed: config.armed });
  }

  function toggleArmed() {
    if (!config.enabled) return;
    setArmed(!config.armed);
  }

  function onMacroHotkey(id) {
    if (state === 'playing' && activeMacroId === id) { stopEverything(); return; }
    if (state !== 'idle') return; // something else is running — ignore
    playMacro(id).catch((e) => logger.error('Macro playback failed to start', e, { id }));
  }

  function stopEverything() {
    if (state === 'idle') return;
    engineSend('STOP');
    logger.log('Macro stop requested', 'INFO');
  }

  // ── Actions ──
  async function startRecording(targetId, filters) {
    if (state !== 'idle') return { ok: false, error: 'busy' };
    await ensureEngine();
    state = 'recording';
    recordTargetId = targetId || null;
    recordFilters = normalizeRecordFilters(filters);
    engineSend(`REC ${RECORD_FILE}`);
    logger.log('Macro recording started', 'INFO', { filters: recordFilters });
    pushStatus();
    return { ok: true };
  }

  async function playMacro(id, overrideCount) {
    if (state !== 'idle') return { ok: false, error: 'busy' };
    const m = config.macros.find((x) => x.id === id);
    if (!m) return { ok: false, error: 'not-found' };
    const lines = compileStepsToEvents(m.steps || [], m.speed || 1);
    if (!lines.length) return { ok: false, error: 'empty' };
    await ensureEngine();
    try {
      fs.writeFileSync(PLAY_FILE, lines.join('\n') + '\n', 'utf8');
    } catch (e) {
      logger.error('Failed to write macro playback file', e);
      return { ok: false, error: 'write-failed' };
    }
    state = 'playing';
    activeMacroId = id;
    // 'hold' loops until the key comes up; everything else honors the macro's
    // repeat count (0 = until stopped).
    const count = overrideCount !== undefined
      ? overrideCount
      : (m.trigger === 'hold' ? 0 : (Number.isFinite(Number(m.repeat)) ? Number(m.repeat) : 1));
    engineSend(`PLAY ${count} ${PLAY_FILE}`);
    logger.log(`Macro playback started: ${m.name} (x${count === 0 ? '∞' : count}, ${m.speed || 1}x speed)`, 'INFO');
    pushStatus();
    return { ok: true };
  }

  function macrosForRenderer() {
    return {
      enabled: config.enabled,
      armed: config.armed,
      toggleHotkey: config.toggleHotkey,
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

  // ── Alt+X position capture ──
  // Lets the user point at a spot in any window and press Alt+X to give a
  // click/move step a fixed position; resolves with that position (or
  // {cancelled} on cancel/timeout).
  //
  // The press is seen by the engine's GetAsyncKeyState watcher, not by
  // globalShortcut, and the engine reads the cursor itself at the instant of the
  // press. That is the whole point of the feature: the user is aiming at
  // something in ANOTHER app, so a key that only lands once our window is back in
  // the foreground would store where the cursor was when they tabbed back, not
  // where they aimed. It also leaves Alt+X alone for the app underneath instead
  // of swallowing it -- same reasoning as the macro triggers above.
  // globalShortcut stays as a fallback for when the engine can't run at all.
  //
  // Coordinates are physical pixels -- what GetCursorPos, playback's SendInput
  // and a recording all speak -- not DIPs.
  //
  // The captured point is written into the step here rather than handed back for
  // the renderer to save: aiming at another app means our own window is in the
  // background, and a backgrounded renderer can sit on the reply until it's shown
  // again. Main is never throttled, so the step is set the moment the key lands.
  function applyCapturedPoint(targetId, stepIndex, x, y) {
    const m = config.macros.find((mm) => mm.id === targetId);
    const s = m && Array.isArray(m.steps) ? m.steps[stepIndex] : null;
    if (!s || (s.t !== 'click' && s.t !== 'move')) return false;
    s.x = Math.round(x);
    s.y = Math.round(y);
    // Only the step's position changed, so no registerAllHotkeys() -- re-sending
    // the watch list for this would be pure churn.
    saveConfig();
    logger.success('Macro step position captured', { macro: m.name, step: stepIndex, x: s.x, y: s.y });
    return true;
  }

  function settleCapture(result) {
    if (!capturePending) return;
    const { resolve, timeout, viaShortcut, targetId, stepIndex } = capturePending;
    capturePending = null;
    clearTimeout(timeout);
    if (viaShortcut) {
      try { globalShortcut.unregister(CAPTURE_ACCELERATOR); } catch (e) { /* ignore */ }
    } else if (engineProc && engineReady) {
      engineSend('CAPTURE'); // disarm
    }
    let applied = false;
    if (result && Number.isFinite(result.x) && Number.isFinite(result.y) && targetId) {
      applied = applyCapturedPoint(targetId, stepIndex, result.x, result.y);
      if (applied) pushStatus({ event: 'capture-done', id: targetId, index: stepIndex, x: Math.round(result.x), y: Math.round(result.y) });
    }
    resolve(applied ? { ...result, applied: true } : result);
  }

  // ── IPC ──
  ipcMain.handle('macros-get', () => macrosForRenderer());

  ipcMain.handle('macros-set-enabled', (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    registerAllHotkeys();
    if (!config.enabled) {
      if (state !== 'idle') stopEverything();
      // The engine also serves the external key-watch consumer (Controller
      // Macros) — only shut it down when nobody is watching keys through it.
      if (externalWatch.vks.size) sendWatchList();
      else killEngine();
    } else {
      // Warm the engine so the first record/play doesn't sit through the C#
      // compile, and so hold/release triggers are live immediately.
      ensureEngine().catch((e) => logger.error('Macro engine warm-up failed', e));
    }
    logger.success('Macros widget toggled', { enabled: config.enabled });
    return macrosForRenderer();
  });

  ipcMain.handle('macros-save', (_event, macro) => {
    if (!macro || typeof macro !== 'object') return { ok: false, error: 'invalid' };
    const clean = sanitizeMacro(macro);
    // A hotkey can only belong to one macro (and never the enable/disable hotkey).
    let hotkeyConflict = false;
    if (clean.hotkey) {
      if (clean.hotkey === config.toggleHotkey) { clean.hotkey = null; hotkeyConflict = true; }
      for (const m of config.macros) {
        if (m.id !== clean.id && m.hotkey === clean.hotkey) { m.hotkey = null; }
      }
    }
    const idx = config.macros.findIndex((m) => m.id === clean.id);
    if (idx >= 0) config.macros[idx] = clean;
    else config.macros.push(clean);
    saveConfig();
    registerAllHotkeys();
    // Every macro hotkey is engine-watched now, so the only way one "doesn't
    // take" is if it collided with the enable/disable hotkey (cleared above) or
    // couldn't be parsed into a watchable key.
    const hotkeyOk = !clean.hotkey || parseAccelerator(clean.hotkey) !== null;
    return { ok: true, id: clean.id, hotkeyOk: hotkeyOk && !hotkeyConflict };
  });

  ipcMain.handle('macros-delete', (_event, id) => {
    const before = config.macros.length;
    config.macros = config.macros.filter((m) => m.id !== id);
    if (config.macros.length !== before) {
      if (state === 'playing' && activeMacroId === id) stopEverything();
      saveConfig();
      registerAllHotkeys();
      logger.success('Macro deleted', { id });
    }
    return { ok: true };
  });

  ipcMain.handle('macros-record-start', async (_event, targetId, filters) => {
    try {
      return await startRecording(targetId, filters);
    } catch (e) {
      logger.error('Macro recording failed to start', e);
      finishActivity();
      return { ok: false, error: 'engine-failed' };
    }
  });

  ipcMain.handle('macros-play', async (_event, id) => {
    try {
      return await playMacro(id);
    } catch (e) {
      logger.error('Macro playback failed to start', e);
      finishActivity();
      return { ok: false, error: 'engine-failed' };
    }
  });

  ipcMain.handle('macros-stop', () => {
    stopEverything();
    return { ok: true };
  });

  ipcMain.handle('macros-set-toggle-hotkey', (_event, accelerator) => {
    if (typeof accelerator !== 'string' || !accelerator) return { ok: false };
    // The toggle hotkey is always registered via Electron's globalShortcut (see
    // registerToggleHotkey), which has no concept of mouse buttons -- only the
    // per-macro trigger hotkeys go through the engine's watcher. Reject
    // server-side too, not just in the renderer's picker UI.
    if (isMouseHotkey(accelerator)) return { ok: false, error: 'mouse-not-supported' };
    if (config.macros.some((m) => m.hotkey === accelerator)) return { ok: false, error: 'conflict' };
    config.toggleHotkey = accelerator;
    saveConfig();
    registerAllHotkeys();
    logger.success('Macro enable/disable hotkey updated', { accelerator });
    return { ok: true };
  });

  ipcMain.handle('macros-set-armed', (_event, armed) => {
    setArmed(armed);
    return macrosForRenderer();
  });

  ipcMain.handle('macros-capture-arm', async (_event, targetId, stepIndex) => {
    settleCapture({ cancelled: true }); // only one capture at a time
    const pending = {
      resolve: null,
      timeout: setTimeout(() => settleCapture({ cancelled: true }), CAPTURE_TIMEOUT_MS),
      viaShortcut: false,
      targetId: typeof targetId === 'string' && targetId ? targetId : null,
      stepIndex: Number.isInteger(stepIndex) ? stepIndex : -1
    };
    const result = new Promise((resolve) => { pending.resolve = resolve; });
    capturePending = pending;
    // Starting the engine can mean a cold PowerShell + C# compile, so the
    // renderer only tells the user to press Alt+X once 'capture-armed' lands.
    try {
      await ensureEngine();
      if (capturePending !== pending) return result; // cancelled while starting
      engineSend(`CAPTURE ${CAPTURE_VK} ${CAPTURE_MODS}`);
      pushStatus({ event: 'capture-armed' });
      return result;
    } catch (e) {
      logger.warn('Macro engine unavailable for Alt+X capture -- falling back to globalShortcut');
    }
    if (capturePending !== pending) return result;
    // Fallback only: registered here rather than always, so the two paths never
    // fight over the key. This one can't see the press while another app has
    // focus in every situation -- that's the limitation the engine path fixes.
    pending.viaShortcut = true;
    let ok = false;
    try {
      ok = globalShortcut.register(CAPTURE_ACCELERATOR, () => {
        const p = screen.getCursorScreenPoint();
        let phys = p;
        try { phys = screen.dipToScreenPoint(p); } catch (err) { /* no scaling info */ }
        settleCapture({ x: phys.x, y: phys.y });
      });
    } catch (e) {
      logger.error('Failed to arm Alt+X position capture', e);
    }
    if (!ok) {
      settleCapture({ error: 'unavailable' });
      return result;
    }
    pushStatus({ event: 'capture-armed' });
    return result;
  });

  ipcMain.handle('macros-capture-cancel', () => {
    settleCapture({ cancelled: true });
    return { ok: true };
  });

  ipcMain.handle('macros-export', async () => {
    const win = getMainWindow();
    const res = await dialog.showSaveDialog(win, {
      title: 'Export macros',
      defaultPath: 'macros.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    try {
      const payload = { app: 'main-launcher', kind: 'macros', version: 1, macros: config.macros };
      fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
      logger.success('Macros exported', { file: res.filePath, count: config.macros.length });
      return { ok: true, count: config.macros.length };
    } catch (e) {
      logger.error('Macro export failed', e);
      return { ok: false, error: 'write-failed' };
    }
  });

  ipcMain.handle('macros-import', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Import macros',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    try {
      const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.macros) ? raw.macros : null);
      if (!list) return { ok: false, error: 'invalid' };
      let added = 0;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const clean = sanitizeMacro(entry);
        clean.id = newMacroId(); // imported macros never replace existing ones
        if (clean.hotkey && (clean.hotkey === config.toggleHotkey || config.macros.some((m) => m.hotkey === clean.hotkey))) {
          clean.hotkey = null;
        }
        config.macros.push(clean);
        added++;
      }
      if (!added) return { ok: false, error: 'invalid' };
      saveConfig();
      registerAllHotkeys();
      logger.success('Macros imported', { file: res.filePaths[0], count: added });
      return { ok: true, count: added };
    } catch (e) {
      logger.error('Macro import failed', e);
      return { ok: false, error: 'read-failed' };
    }
  });

  app.on('will-quit', () => killEngine());

  registerAllHotkeys();
  if (config.enabled) {
    // Warm start: compile the C# once now instead of on the first record click.
    ensureEngine().catch((e) => logger.error('Macro engine warm-up failed', e));
  }

  return {
    reapplyHotkeys: () => { triggersSuspended = false; registerAllHotkeys(); },
    // Pair with reapplyHotkeys: drops the engine watch list (and the toggle
    // hotkey) so nothing fires while the renderer owns the keyboard.
    suspendTriggers: () => { triggersSuspended = true; registerAllHotkeys(); },
    setExternalWatch,
    // Hotkeys this widget currently owns, so other widgets (Controller Macros)
    // can refuse bindings that would fire a keyboard macro at the same time.
    getOwnedHotkeys: () => [config.toggleHotkey, ...config.macros.map((m) => m.hotkey)].filter(Boolean)
  };
}

module.exports = {
  init,
  parseAccelerator,
  isMouseHotkey,
  // Exported for test/macros.test.js — the engine script and the constants the
  // host speaks to it with have to stay in step.
  MACRO_ENGINE_SCRIPT_CONTENT,
  MACRO_ENGINE_SCRIPT_VERSION,
  CAPTURE_ACCELERATOR,
  CAPTURE_VK,
  CAPTURE_MODS
};
