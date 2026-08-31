const { app, ipcMain, globalShortcut, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { parseAccelerator, isMouseHotkey } = require('./macros');

// ── Auto Clicker mini widget (Windows) ──
// A full-featured auto clicker: fixed interval with jitter, any mouse button,
// single/double/triple clicks, click limits and time limits — plus the two
// things ordinary auto clickers don't do:
//   • Area spam — pick a region on screen and hammer random points inside it,
//     or sweep it in a serpentine grid so every part of the region gets clicked.
//   • Colour hunt — pick a region AND a colour; the engine screenshots the
//     region on a loop and clicks wherever that colour shows up.
//
// Like Macros, Windows gives no scriptable API for synthesizing input or for
// watching keys without swallowing them, so this generates a helper .ps1 that
// compiles a small C# engine (SendInput for clicks, GetAsyncKeyState for the
// trigger hotkey, System.Drawing CopyFromScreen + LockBits for colour scanning)
// and runs it as a persistent background process. Main talks to it over a line
// protocol on stdin/stdout:
//   START <cfgFile>     begin clicking with the run described by <cfgFile>
//   SCAN <cfgFile>      one-shot colour scan (the panel's "Test scan")
//   STOP                stop the current run
//   WATCH <vk,...>      passively watch these virtual keys for the trigger
//   EXIT                quit
// The engine emits READY / STARTED / PROGRESS / HUNT / DONE / STOPPED /
// SCANRES / KEY-DOWN / KEY-UP / ERR.
//
// The trigger hotkey is watched, never registered through globalShortcut, so
// the key still reaches the game underneath (same reasoning as main/macros.js).
//
// Coordinates: everything persisted and shown in the UI is in Electron DIP
// screen coordinates. They're converted to physical pixels right before they
// reach the engine (see toPhysicalPoint / toPhysicalRect) — the capture and
// SendInput both work in physical pixels, so on a scaled display the two would
// otherwise disagree.

const ENGINE_SCRIPT_VERSION = 3;
const DEFAULT_HOTKEY = 'F6';
const MAX_SCAN_PIXELS = 16 * 1024 * 1024; // area capture ceiling (~4096²)

const ENGINE_SCRIPT_CONTENT = `Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class AutoClickEngine {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);

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
    static volatile int[] watchVks = new int[0];
    static volatile bool watchRePrime = false;
    static Thread watchThread = null;
    static Random rng = new Random();

    static void Emit(string s) { lock (emitLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

    // ── Run configuration (a flat key=value file written by the main process) ──
    public class Cfg {
        public string mode = "cursor";     // cursor | point | area | color
        public int x = 0, y = 0;           // point mode target
        public int ax = 0, ay = 0, aw = 0, ah = 0;   // area / colour region
        public string pattern = "random";  // random | sweep | center  (area mode)
        public int stepx = 40, stepy = 40; // sweep spacing
        public int ex = 0, ey = 0, ew = 0, eh = 0;   // exclusion zone (0 size = off)
        public int button = 0;             // 0 L, 1 R, 2 M, 3 Mouse4, 4 Mouse5
        public int perclick = 1;           // 1 single, 2 double, 3 triple
        public int pressms = 22;           // how long each press is held
        public int gapms = 55;             // gap inside a double/triple click
        public int interval = 100;
        public int jitter = 0;
        public int limit = 0;              // 0 = unlimited clicks
        public int duration = 0;           // 0 = no time limit (ms)
        public int startdelay = 0;
        public int restore = 0;            // put the cursor back after each click
        public int spread = 0;             // random +/- px around the target
        public int cr = 255, cg = 0, cb = 0;
        public int cr2 = 0, cg2 = 0, cb2 = 0;
        public int use2 = 0;               // second colour active
        public int tol = 20;
        public int scanstep = 2;
        public string target = "first";    // first | center | centroid | all
        public int rescan = 120;
        public int mindist = 24;           // "all": min gap between click points
    }

    static int Int(string s, int fallback) {
        int v;
        if (int.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return v;
        return fallback;
    }

    static Cfg ParseCfg(string file) {
        Cfg c = new Cfg();
        foreach (string raw in File.ReadAllLines(file)) {
            string line = raw.Trim();
            int eq = line.IndexOf('=');
            if (eq < 1) continue;
            string k = line.Substring(0, eq).Trim();
            string v = line.Substring(eq + 1).Trim();
            switch (k) {
                case "mode": c.mode = v; break;
                case "x": c.x = Int(v, c.x); break;
                case "y": c.y = Int(v, c.y); break;
                case "ax": c.ax = Int(v, c.ax); break;
                case "ay": c.ay = Int(v, c.ay); break;
                case "aw": c.aw = Int(v, c.aw); break;
                case "ah": c.ah = Int(v, c.ah); break;
                case "pattern": c.pattern = v; break;
                case "stepx": c.stepx = Int(v, c.stepx); break;
                case "stepy": c.stepy = Int(v, c.stepy); break;
                case "ex": c.ex = Int(v, c.ex); break;
                case "ey": c.ey = Int(v, c.ey); break;
                case "ew": c.ew = Int(v, c.ew); break;
                case "eh": c.eh = Int(v, c.eh); break;
                case "button": c.button = Int(v, c.button); break;
                case "perclick": c.perclick = Int(v, c.perclick); break;
                case "pressms": c.pressms = Int(v, c.pressms); break;
                case "gapms": c.gapms = Int(v, c.gapms); break;
                case "interval": c.interval = Int(v, c.interval); break;
                case "jitter": c.jitter = Int(v, c.jitter); break;
                case "limit": c.limit = Int(v, c.limit); break;
                case "duration": c.duration = Int(v, c.duration); break;
                case "startdelay": c.startdelay = Int(v, c.startdelay); break;
                case "restore": c.restore = Int(v, c.restore); break;
                case "spread": c.spread = Int(v, c.spread); break;
                case "cr": c.cr = Int(v, c.cr); break;
                case "cg": c.cg = Int(v, c.cg); break;
                case "cb": c.cb = Int(v, c.cb); break;
                case "cr2": c.cr2 = Int(v, c.cr2); break;
                case "cg2": c.cg2 = Int(v, c.cg2); break;
                case "cb2": c.cb2 = Int(v, c.cb2); break;
                case "use2": c.use2 = Int(v, c.use2); break;
                case "tol": c.tol = Int(v, c.tol); break;
                case "scanstep": c.scanstep = Int(v, c.scanstep); break;
                case "target": c.target = v; break;
                case "rescan": c.rescan = Int(v, c.rescan); break;
                case "mindist": c.mindist = Int(v, c.mindist); break;
            }
        }
        return c;
    }

    public static void RunHost() {
        SetProcessDPIAware();
        // Without a 1 ms timer resolution, Thread.Sleep(1) can land near 15 ms,
        // which caps the click rate far below what the user asked for.
        try { timeBeginPeriod(1); } catch (Exception) { }
        Emit("READY");
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "EXIT") { stopFlag = true; if (worker != null && worker.IsAlive) worker.Join(2000); break; }
            if (line == "STOP") { stopFlag = true; continue; }
            if (line == "PING") { Emit("PONG"); continue; }
            if (line.StartsWith("WATCH")) {
                string rest = line.Length > 5 ? line.Substring(5).Trim() : "";
                var lst = new List<int>();
                if (rest.Length > 0) {
                    foreach (string part in rest.Split(',')) {
                        int v;
                        if (int.TryParse(part.Trim(), out v) && v > 0 && v < 256) lst.Add(v);
                    }
                }
                watchVks = lst.ToArray();
                watchRePrime = true;
                if (watchThread == null || !watchThread.IsAlive) {
                    watchThread = new Thread(WatchLoop);
                    watchThread.IsBackground = true;
                    watchThread.Start();
                }
                Emit("WATCH-OK " + lst.Count);
                continue;
            }
            if (line.StartsWith("SCAN ")) {
                string scanPath = line.Substring(5);
                try {
                    Cfg sc = ParseCfg(scanPath);
                    // Always a full scan here, whatever the run's targeting mode
                    // is: the panel is reporting "how much of this colour can you
                    // see", so an early-out after the first hit would always
                    // answer "1".
                    List<int[]> hits = ScanMatches(sc, false);
                    List<int[]> picked = ChooseTargets(sc, hits);
                    if (picked.Count > 0) Emit("SCANRES " + hits.Count + " " + picked[0][0] + " " + picked[0][1]);
                    else Emit("SCANRES 0 0 0");
                } catch (Exception e) {
                    Emit("ERR scan " + Flat(e.Message));
                }
                continue;
            }
            if (line.StartsWith("START ")) {
                if (worker != null && worker.IsAlive) { Emit("ERR busy"); continue; }
                string cfgPath = line.Substring(6);
                Cfg cfg;
                try { cfg = ParseCfg(cfgPath); } catch (Exception e) { Emit("ERR config " + Flat(e.Message)); continue; }
                stopFlag = false;
                worker = new Thread(delegate() { Run(cfg); });
                worker.IsBackground = true;
                worker.Start();
                Emit("STARTED");
                continue;
            }
            Emit("ERR unknown");
        }
    }

    static string Flat(string s) { return s.Replace('\\n', ' ').Replace('\\r', ' '); }

    // Passive trigger watcher — observes the hotkey without consuming it, so the
    // key still reaches whatever is focused.
    static void WatchLoop() {
        bool[] down = new bool[256];
        bool[] primed = new bool[256];
        while (true) {
            if (watchRePrime) { watchRePrime = false; for (int k = 0; k < 256; k++) primed[k] = false; }
            int[] vks = watchVks;
            if (vks.Length == 0) { Thread.Sleep(50); continue; }
            for (int i = 0; i < vks.Length; i++) {
                int vk = vks[i];
                if (vk < 1 || vk > 255) continue;
                bool isDown = (GetAsyncKeyState(vk) & 0x8000) != 0;
                if (!primed[vk]) { down[vk] = isDown; primed[vk] = true; continue; }
                if (isDown == down[vk]) continue;
                down[vk] = isDown;
                if (isDown) {
                    int mods = 0;
                    if ((GetAsyncKeyState(0x11) & 0x8000) != 0) mods |= 1;
                    if ((GetAsyncKeyState(0x10) & 0x8000) != 0) mods |= 2;
                    if ((GetAsyncKeyState(0x12) & 0x8000) != 0) mods |= 4;
                    if ((GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0) mods |= 8;
                    Emit("KEY-DOWN " + vk + " " + mods);
                } else {
                    Emit("KEY-UP " + vk);
                }
            }
            Thread.Sleep(10);
        }
    }

    // ── Input synthesis ──
    static void SendBtn(int btn, bool isDown) {
        var inp = new INPUT[1];
        inp[0].type = 0;
        uint flags;
        if (btn == 0) flags = isDown ? 0x0002u : 0x0004u;
        else if (btn == 1) flags = isDown ? 0x0008u : 0x0010u;
        else if (btn == 2) flags = isDown ? 0x0020u : 0x0040u;
        else {
            flags = isDown ? 0x0100u : 0x0200u;   // XBUTTONDOWN / XBUTTONUP
            inp[0].U.mi.mouseData = btn == 3 ? 1 : 2;
        }
        inp[0].U.mi.dwFlags = flags;
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

    // Sleep that stays responsive to STOP and stays accurate at small values:
    // Thread.Sleep is too coarse for the 1-15 ms waits a fast clicker needs.
    static bool Wait(int ms) {
        if (stopFlag) return false;
        if (ms <= 0) return true;
        var sw = Stopwatch.StartNew();
        while (!stopFlag) {
            long rem = ms - sw.ElapsedMilliseconds;
            if (rem <= 0) return true;
            if (rem > 25) Thread.Sleep(10);
            else if (rem > 2) Thread.Sleep(1);
            else Thread.SpinWait(150);
        }
        return false;
    }

    static void DoClick(Cfg c) {
        int n = c.perclick < 1 ? 1 : (c.perclick > 3 ? 3 : c.perclick);
        for (int i = 0; i < n; i++) {
            SendBtn(c.button, true);
            if (!Wait(c.pressms)) { SendBtn(c.button, false); return; }
            SendBtn(c.button, false);
            if (i < n - 1 && !Wait(c.gapms)) return;
        }
    }

    // A point inside the exclusion zone is never clicked. Zero width/height
    // means no zone is set.
    static bool Excluded(Cfg c, int x, int y) {
        if (c.ew < 1 || c.eh < 1) return false;
        return x >= c.ex && x < c.ex + c.ew && y >= c.ey && y < c.ey + c.eh;
    }

    // A pixel counts as a match if it is within tolerance of EITHER colour.
    // Both share one tolerance — that is what the single slider in the UI means.
    static bool ColorMatches(Cfg c, int r, int g, int b) {
        int tol = c.tol < 0 ? 0 : c.tol;
        if (Math.Abs(r - c.cr) <= tol && Math.Abs(g - c.cg) <= tol && Math.Abs(b - c.cb) <= tol) return true;
        if (c.use2 != 0 &&
            Math.Abs(r - c.cr2) <= tol && Math.Abs(g - c.cg2) <= tol && Math.Abs(b - c.cb2) <= tol) return true;
        return false;
    }

    // ── Colour scanning ──
    // One capture of the region, then a strided scan for pixels within the
    // per-channel tolerance. Per-channel (not Euclidean) because it's what the
    // tolerance slider in the UI visibly means.
    // The bitmap and pixel buffer are reused between scans. A colour hunt scans
    // on every click tick, so allocating a fresh full-region buffer each time
    // would churn tens of MB a second through the GC. The lock also serializes
    // the run loop against a "Test scan" fired from the panel mid-run, which is
    // the only way two threads could reach this at once.
    static object scanLock = new object();
    static Bitmap scanBmp = null;
    static byte[] scanBuf = null;

    static List<int[]> ScanMatches(Cfg c, bool stopAtFirst) {
        var res = new List<int[]>();
        int w = c.aw, h = c.ah;
        if (w < 1 || h < 1) return res;
        lock (scanLock) {
            if (scanBmp == null || scanBmp.Width != w || scanBmp.Height != h) {
                if (scanBmp != null) scanBmp.Dispose();
                scanBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            }
            using (Graphics g = Graphics.FromImage(scanBmp)) {
                g.CopyFromScreen(c.ax, c.ay, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            }
            BitmapData d = scanBmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            int stride = d.Stride;
            int needed = stride * h;
            if (scanBuf == null || scanBuf.Length < needed) scanBuf = new byte[needed];
            Marshal.Copy(d.Scan0, scanBuf, 0, needed);
            scanBmp.UnlockBits(d);
            byte[] buf = scanBuf;
            int step = c.scanstep < 1 ? 1 : c.scanstep;
            for (int yy = 0; yy < h; yy += step) {
                int row = yy * stride;
                for (int xx = 0; xx < w; xx += step) {
                    int i = row + xx * 4;
                    int b = buf[i], gg = buf[i + 1], r = buf[i + 2];
                    if (ColorMatches(c, r, gg, b)) {
                        res.Add(new int[] { c.ax + xx, c.ay + yy });
                        if (stopAtFirst) return res;
                        if (res.Count >= 40000) return res;
                    }
                }
            }
        }
        return res;
    }

    // Scan + choose, the pairing the run loop uses. "first" can stop at the
    // first matching pixel; every other mode needs the whole set.
    static List<int[]> PickTargets(Cfg c) {
        return ChooseTargets(c, ScanMatches(c, c.target == "first"));
    }

    // Turns raw matches into the ordered list of points to click.
    static List<int[]> ChooseTargets(Cfg c, List<int[]> hits) {
        var outp = new List<int[]>();
        if (hits.Count == 0) return outp;
        if (c.target == "first") { outp.Add(hits[0]); return outp; }

        if (c.target == "center") {
            int cx = c.ax + c.aw / 2, cy = c.ay + c.ah / 2;
            int bi = 0;
            long best = long.MaxValue;
            for (int i = 0; i < hits.Count; i++) {
                long dx = hits[i][0] - cx, dy = hits[i][1] - cy;
                long dist = dx * dx + dy * dy;
                if (dist < best) { best = dist; bi = i; }
            }
            outp.Add(hits[bi]);
            return outp;
        }

        if (c.target == "centroid") {
            long sx = 0, sy = 0;
            for (int i = 0; i < hits.Count; i++) { sx += hits[i][0]; sy += hits[i][1]; }
            outp.Add(new int[] { (int)(sx / hits.Count), (int)(sy / hits.Count) });
            return outp;
        }

        // "all": one click per blob. Greedy min-distance thinning is enough —
        // matches arrive in scan order, so the first pixel of each blob wins.
        int md = c.mindist < 1 ? 1 : c.mindist;
        long md2 = (long)md * md;
        for (int i = 0; i < hits.Count; i++) {
            bool near = false;
            for (int j = 0; j < outp.Count; j++) {
                long dx = hits[i][0] - outp[j][0], dy = hits[i][1] - outp[j][1];
                if (dx * dx + dy * dy < md2) { near = true; break; }
            }
            if (!near) outp.Add(hits[i]);
            if (outp.Count >= 200) break;
        }
        return outp;
    }

    // Serpentine grid over the region — every cell gets hit, and consecutive
    // points stay adjacent so the pointer doesn't teleport across the screen.
    static List<int[]> BuildSweep(Cfg c) {
        var pts = new List<int[]>();
        int sx = c.stepx < 1 ? 1 : c.stepx;
        int sy = c.stepy < 1 ? 1 : c.stepy;
        int rowIndex = 0;
        for (int y = c.ay + sy / 2; y < c.ay + c.ah; y += sy) {
            var row = new List<int[]>();
            for (int x = c.ax + sx / 2; x < c.ax + c.aw; x += sx) {
                if (Excluded(c, x, y)) continue;
                row.Add(new int[] { x, y });
            }
            if (rowIndex % 2 == 1) row.Reverse();
            pts.AddRange(row);
            rowIndex++;
            if (pts.Count > 20000) break;
        }
        // Everything excluded: leave the list empty rather than inventing a
        // point inside the zone the user told us to avoid. Run() treats an empty
        // sweep as "nothing to do" and ends.
        if (pts.Count == 0 && !Excluded(c, c.ax + c.aw / 2, c.ay + c.ah / 2)) {
            pts.Add(new int[] { c.ax + c.aw / 2, c.ay + c.ah / 2 });
        }
        return pts;
    }

    static void Run(Cfg c) {
        try {
            int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
            int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
            POINT origin; GetCursorPos(out origin);
            List<int[]> sweep = (c.mode == "area" && c.pattern == "sweep") ? BuildSweep(c) : null;
            int sweepIdx = 0;
            List<int[]> queue = new List<int[]>();
            int qi = 0;
            long clicks = 0;
            long lastProgress = -1000;
            bool stopped = false;
            var sw = Stopwatch.StartNew();

            if (c.startdelay > 0 && !Wait(c.startdelay)) stopped = true;

            while (!stopFlag && !stopped) {
                if (c.limit > 0 && clicks >= c.limit) break;
                if (c.duration > 0 && sw.ElapsedMilliseconds >= c.duration) break;

                int tx = 0, ty = 0;
                bool hasTarget = false;

                if (c.mode == "point") {
                    tx = c.x; ty = c.y; hasTarget = true;
                } else if (c.mode == "area") {
                    if (sweep != null) {
                        // Excluded cells were already dropped when the sweep was
                        // built; an empty list means the zone covers everything.
                        if (sweep.Count == 0) break;
                        int[] p = sweep[sweepIdx % sweep.Count];
                        sweepIdx++;
                        tx = p[0]; ty = p[1];
                        hasTarget = true;
                    } else if (c.pattern == "center") {
                        tx = c.ax + c.aw / 2; ty = c.ay + c.ah / 2;
                        if (Excluded(c, tx, ty)) break;   // the one target is excluded
                        hasTarget = true;
                    } else {
                        // Re-roll past the exclusion zone. Bounded so a zone that
                        // covers (almost) all of the region can't spin the CPU —
                        // if nothing lands outside it, wait a beat and try again
                        // rather than clicking somewhere the user excluded.
                        for (int attempt = 0; attempt < 40; attempt++) {
                            tx = c.ax + rng.Next(c.aw < 1 ? 1 : c.aw);
                            ty = c.ay + rng.Next(c.ah < 1 ? 1 : c.ah);
                            if (!Excluded(c, tx, ty)) { hasTarget = true; break; }
                        }
                        if (!hasTarget) {
                            if (!Wait(c.interval < 20 ? 20 : c.interval)) break;
                            continue;
                        }
                    }
                } else if (c.mode == "color") {
                    if (qi >= queue.Count) {
                        queue = PickTargets(c);
                        qi = 0;
                        if (queue.Count > 0) Emit("HUNT 1 " + queue[0][0] + " " + queue[0][1] + " " + queue.Count);
                        else Emit("HUNT 0 0 0 0");
                        if (queue.Count == 0) {
                            if (!Wait(c.rescan)) break;
                            continue;
                        }
                    }
                    int[] p = queue[qi++];
                    tx = p[0]; ty = p[1]; hasTarget = true;
                }

                if (hasTarget) {
                    if (c.spread > 0) {
                        int jx = tx + rng.Next(-c.spread, c.spread + 1);
                        int jy = ty + rng.Next(-c.spread, c.spread + 1);
                        // Scatter is a nicety; never let it move a click into the
                        // excluded zone. Keep the exact target if it would.
                        if (!Excluded(c, jx, jy)) { tx = jx; ty = jy; }
                    }
                    SendMove(tx, ty, vx, vy, vw, vh);
                    if (!Wait(6)) break;   // let the target window see the move first
                }

                DoClick(c);
                clicks++;
                if (hasTarget && c.restore != 0) SendMove(origin.X, origin.Y, vx, vy, vw, vh);

                long el = sw.ElapsedMilliseconds;
                if (el - lastProgress >= 220) {
                    lastProgress = el;
                    Emit("PROGRESS " + clicks + " " + el);
                }

                int wait = c.interval;
                if (c.jitter > 0) wait += rng.Next(-c.jitter, c.jitter + 1);
                if (wait < 1) wait = 1;
                if (!Wait(wait)) break;
            }

            SendBtn(c.button, false); // never leave a button stuck down
            Emit((stopFlag ? "STOPPED " : "DONE ") + clicks + " " + sw.ElapsedMilliseconds);
        } catch (Exception e) {
            Emit("ERR run " + Flat(e.Message));
        }
    }
}
'@

[AutoClickEngine]::RunHost()
`;

// ── Config ──
const MODES = ['cursor', 'point', 'area', 'color'];
const PATTERNS = ['random', 'sweep', 'center'];
const CLICK_TYPES = ['single', 'double', 'triple'];
const REPEAT_MODES = ['infinite', 'count', 'duration'];
const TARGET_MODES = ['first', 'center', 'centroid', 'all'];
const TRIGGERS = ['toggle', 'hold'];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function pick(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}

function sanitizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Math.round(Number(rect.x));
  const y = Math.round(Number(rect.y));
  const w = Math.round(Number(rect.w));
  const h = Math.round(Number(rect.h));
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) return null;
  return { x, y, w, h };
}

function sanitizeHex(value, fallback) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value || ''));
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(String(hex || '').toLowerCase());
  if (!m) return { r: 255, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function defaultConfig() {
  return {
    enabled: false,
    armed: true,
    hotkey: DEFAULT_HOTKEY,
    trigger: 'toggle',
    mode: 'cursor',
    point: null,
    area: null,
    // A sub-region of `area` that never gets clicked. null = no zone set.
    exclude: null,
    pattern: 'random',
    spacingX: 40,
    spacingY: 40,
    button: 0,
    clickType: 'single',
    pressMs: 22,
    interval: 100,
    jitter: 0,
    repeatMode: 'infinite',
    repeatCount: 100,
    durationMs: 10000,
    startDelay: 0,
    restore: false,
    spread: 0,
    color: '#ff0000',
    // Optional second colour to hunt alongside the first. null = off.
    color2: null,
    tolerance: 20,
    scanStep: 2,
    targetMode: 'first',
    rescanMs: 120,
    minDist: 24
  };
}

function sanitizeConfig(raw) {
  const d = defaultConfig();
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled === true,
    armed: c.armed !== false,
    hotkey: typeof c.hotkey === 'string' && c.hotkey ? c.hotkey : d.hotkey,
    trigger: pick(TRIGGERS, c.trigger, d.trigger),
    mode: pick(MODES, c.mode, d.mode),
    point: sanitizeRect(c.point && { ...c.point, w: 1, h: 1 })
      ? { x: Math.round(c.point.x), y: Math.round(c.point.y) }
      : null,
    area: sanitizeRect(c.area),
    exclude: sanitizeRect(c.exclude),
    pattern: pick(PATTERNS, c.pattern, d.pattern),
    spacingX: clampInt(c.spacingX, 2, 2000, d.spacingX),
    spacingY: clampInt(c.spacingY, 2, 2000, d.spacingY),
    button: clampInt(c.button, 0, 4, d.button),
    clickType: pick(CLICK_TYPES, c.clickType, d.clickType),
    pressMs: clampInt(c.pressMs, 1, 2000, d.pressMs),
    interval: clampInt(c.interval, 1, 3600000, d.interval),
    jitter: clampInt(c.jitter, 0, 60000, d.jitter),
    repeatMode: pick(REPEAT_MODES, c.repeatMode, d.repeatMode),
    repeatCount: clampInt(c.repeatCount, 1, 10000000, d.repeatCount),
    durationMs: clampInt(c.durationMs, 100, 86400000, d.durationMs),
    startDelay: clampInt(c.startDelay, 0, 600000, d.startDelay),
    restore: c.restore === true,
    spread: clampInt(c.spread, 0, 400, d.spread),
    color: sanitizeHex(c.color, d.color),
    // Unlike `color`, this one is genuinely optional — anything unparseable
    // means "no second colour" rather than falling back to a default.
    color2: c.color2 ? sanitizeHex(c.color2, null) : null,
    tolerance: clampInt(c.tolerance, 0, 255, d.tolerance),
    scanStep: clampInt(c.scanStep, 1, 32, d.scanStep),
    targetMode: pick(TARGET_MODES, c.targetMode, d.targetMode),
    rescanMs: clampInt(c.rescanMs, 10, 60000, d.rescanMs),
    minDist: clampInt(c.minDist, 2, 500, d.minDist)
  };
}

// True when the exclusion zone completely swallows the click region — the run
// would have nowhere left to click, so it's refused up front instead of looking
// like a silent no-op.
function coversArea(exclude, area) {
  if (!exclude || !area) return false;
  return exclude.x <= area.x && exclude.y <= area.y &&
    exclude.x + exclude.w >= area.x + area.w &&
    exclude.y + exclude.h >= area.y + area.h;
}

// Buttons a mouse hotkey maps to, so a trigger can't be the very button the
// run is clicking (the synthesized click would re-trigger it forever).
const MOUSE_HOTKEY_BUTTON = { MouseLeft: 0, MouseRight: 1, MouseMiddle: 2, Mouse4: 3, Mouse5: 4 };

function hotkeyConflictsWithButton(hotkey, button) {
  if (!isMouseHotkey(hotkey)) return false;
  return MOUSE_HOTKEY_BUTTON[hotkey] === Number(button);
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;

  // The on-screen picker (region / colour / point) lives in its own module; the
  // Auto Clicker is its only consumer today, so it owns its lifecycle.
  const areaSelect = require('./areaSelect').init(ctx);

  const CONFIG_PATH = path.join(userDataPath, 'autoclicker-config.json');
  const ENGINE_SCRIPT = path.join(userDataPath, 'autoclicker-engine.ps1');
  const RUN_FILE = path.join(userDataPath, 'autoclicker-run.cfg');
  const SCAN_FILE = path.join(userDataPath, 'autoclicker-scan.cfg');

  let config = loadConfig();
  let engineProc = null;
  let engineReady = false;
  let engineBuffer = '';
  let readyWaiters = [];
  let running = false;
  let bindingPaused = false;      // renderer is capturing a hotkey — don't trigger
  let holdArmed = false;          // 'hold' trigger: key is currently down
  let scanWaiters = [];
  let lastStats = { clicks: 0, elapsed: 0, found: null, matches: 0 };
  let lastHuntPush = 0;

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      }
    } catch (e) {
      logger.error('Failed to read auto clicker config', e);
    }
    return defaultConfig();
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save auto clicker config', e);
    }
  }

  function pushStatus(extra) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('autoclicker-status', {
        enabled: config.enabled,
        armed: config.armed,
        running,
        hotkey: config.hotkey,
        trigger: config.trigger,
        stats: lastStats,
        ...(extra || {})
      });
    }
  }

  // ── Engine process ──
  function ensureEngine() {
    return new Promise((resolve, reject) => {
      if (engineProc && engineReady) { resolve(); return; }
      readyWaiters.push({ resolve, reject });
      if (engineProc) return;
      ensureVersionedScript(ENGINE_SCRIPT, ENGINE_SCRIPT_VERSION, ENGINE_SCRIPT_CONTENT);
      try {
        engineProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENGINE_SCRIPT], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) {
        engineProc = null;
        flushWaiters(e);
        return;
      }
      const startTimeout = setTimeout(() => {
        if (!engineReady) {
          logger.error('Auto clicker engine did not become ready in time', null, {});
          killEngine();
          flushWaiters(new Error('Auto clicker engine failed to start'));
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
            logger.success('Auto clicker engine started');
            sendWatchList();
            flushWaiters(null);
          } else {
            handleEngineLine(line);
          }
        }
      });
      engineProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) logger.error('Auto clicker engine stderr', new Error(msg));
      });
      engineProc.on('exit', (code) => {
        const wasRunning = running;
        engineProc = null;
        engineReady = false;
        engineBuffer = '';
        clearTimeout(startTimeout);
        flushWaiters(new Error('Auto clicker engine exited'));
        settleScans({ ok: false, error: 'engine-exited' });
        if (wasRunning) {
          running = false;
          logger.error('Auto clicker engine exited mid-run', null, { code });
          pushStatus({ event: 'stopped' });
        } else {
          logger.log(`Auto clicker engine exited (code ${code})`, 'INFO');
        }
      });
    });
  }

  function flushWaiters(err) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) err ? w.reject(err) : w.resolve();
  }

  function settleScans(result) {
    const waiters = scanWaiters;
    scanWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(result);
    }
  }

  function engineSend(line) {
    if (engineProc && engineProc.stdin.writable) engineProc.stdin.write(line + '\n');
  }

  function killEngine() {
    if (!engineProc) return;
    try {
      engineSend('EXIT');
      const proc = engineProc;
      setTimeout(() => { try { proc.kill(); } catch (e) { /* already gone */ } }, 1500);
    } catch (e) { /* ignore */ }
    engineProc = null;
    engineReady = false;
  }

  function handleEngineLine(line) {
    if (line.startsWith('KEY-DOWN ') || line.startsWith('KEY-UP ')) {
      const parts = line.split(' ');
      onWatchedKey(Number(parts[1]), Number(parts[2]) || 0, line.startsWith('KEY-DOWN '));
      return;
    }
    if (line.startsWith('PROGRESS ')) {
      const parts = line.split(' ');
      lastStats = { ...lastStats, clicks: Number(parts[1]) || 0, elapsed: Number(parts[2]) || 0 };
      pushStatus({ event: 'progress' });
      return;
    }
    if (line.startsWith('HUNT ')) {
      const parts = line.split(' ');
      const found = parts[1] === '1';
      const matches = Number(parts[4]) || 0;
      const changed = lastStats.found !== found || lastStats.matches !== matches;
      lastStats = {
        ...lastStats,
        found,
        matches,
        huntX: Number(parts[2]) || 0,
        huntY: Number(parts[3]) || 0
      };
      // A scan happens on every click tick, so this can fire 100x a second.
      // The panel only shows found/not-found and a count — push when one of
      // those actually changes, and otherwise no more than 4x a second.
      const now = Date.now();
      if (changed || now - lastHuntPush >= 250) {
        lastHuntPush = now;
        pushStatus({ event: 'hunt' });
      }
      return;
    }
    if (line.startsWith('SCANRES ')) {
      const parts = line.split(' ');
      settleScans({ ok: true, matches: Number(parts[1]) || 0, x: Number(parts[2]) || 0, y: Number(parts[3]) || 0 });
      return;
    }
    if (line.startsWith('DONE ') || line.startsWith('STOPPED ')) {
      const parts = line.split(' ');
      running = false;
      holdArmed = false;
      lastStats = { ...lastStats, clicks: Number(parts[1]) || 0, elapsed: Number(parts[2]) || 0 };
      logger.log(`Auto clicker finished (${line})`, 'INFO');
      pushStatus({ event: line.startsWith('DONE ') ? 'done' : 'stopped' });
      return;
    }
    if (line.startsWith('ERR')) {
      logger.error('Auto clicker engine error', new Error(line));
      running = false;
      settleScans({ ok: false, error: 'engine-error' });
      pushStatus({ event: 'error', error: line.slice(4) });
    }
    // STARTED / WATCH-OK / PONG are acks — state was already set.
  }

  // ── Trigger hotkey ──
  // Suspended while the renderer is capturing raw keys -- the trigger is
  // engine-watched, so globalShortcut.unregisterAll() can't quiet it (see
  // suspendTriggers below).
  let triggersSuspended = false;

  function watchedVk() {
    if (!config.enabled || !config.armed || triggersSuspended) return null;
    const parsed = parseAccelerator(config.hotkey);
    return parsed ? parsed : null;
  }

  function sendWatchList() {
    const parsed = watchedVk();
    engineSend(parsed ? `WATCH ${parsed.vk}` : 'WATCH');
  }

  function syncWatch() {
    const parsed = watchedVk();
    if (parsed) {
      ensureEngine()
        .then(() => sendWatchList())
        .catch((e) => logger.error('Auto clicker engine unavailable for its trigger hotkey', e));
    } else if (engineProc && engineReady) {
      sendWatchList();
    }
  }

  function onWatchedKey(vk, mods, isDown) {
    if (bindingPaused) return;
    const parsed = watchedVk();
    if (!parsed || parsed.vk !== vk) return;
    if (config.trigger === 'hold') {
      if (isDown) {
        if (parsed.mods !== mods || running) return;
        holdArmed = true;
        start().catch((e) => logger.error('Auto clicker hold-trigger start failed', e));
      } else if (holdArmed) {
        holdArmed = false;
        stop();
      }
      return;
    }
    // 'toggle' — press starts, pressing again stops.
    if (!isDown) return;
    if (running) { stop(); return; }
    if (parsed.mods !== mods) return;
    start().catch((e) => logger.error('Auto clicker toggle-trigger start failed', e));
  }

  // ── DIP → physical pixels ──
  // Persisted/UI coordinates are Electron DIP; the engine captures and clicks in
  // physical pixels, so both sides must be converted with the owning display's
  // scale factor or a scaled monitor lands the clicks in the wrong place.
  function toPhysicalPoint(p) {
    try {
      return screen.dipToScreenPoint({ x: p.x, y: p.y });
    } catch (e) {
      return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  }

  function toPhysicalRect(rect) {
    const topLeft = toPhysicalPoint({ x: rect.x, y: rect.y });
    let sf = 1;
    try {
      const display = screen.getDisplayMatching({
        x: rect.x, y: rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h)
      });
      sf = display && display.scaleFactor ? display.scaleFactor : 1;
    } catch (e) { /* single-display fallback of 1 is fine */ }
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: Math.max(1, Math.round(rect.w * sf)),
      h: Math.max(1, Math.round(rect.h * sf)),
      sf
    };
  }

  // Serializes the run for the engine, in physical pixels.
  function buildRunConfig(cfg) {
    const rgb = hexToRgb(cfg.color);
    const lines = [];
    const put = (k, v) => lines.push(`${k}=${v}`);
    put('mode', cfg.mode);

    if (cfg.mode === 'point' && cfg.point) {
      const p = toPhysicalPoint(cfg.point);
      put('x', p.x);
      put('y', p.y);
    }
    if ((cfg.mode === 'area' || cfg.mode === 'color') && cfg.area) {
      const r = toPhysicalRect(cfg.area);
      put('ax', r.x);
      put('ay', r.y);
      put('aw', r.w);
      put('ah', r.h);
      // Spacings are authored in DIP too — scale them with the region.
      put('stepx', Math.max(1, Math.round(cfg.spacingX * r.sf)));
      put('stepy', Math.max(1, Math.round(cfg.spacingY * r.sf)));
      put('mindist', Math.max(1, Math.round(cfg.minDist * r.sf)));
    }
    // The exclusion zone is an area-mode idea; it is deliberately not applied to
    // Colour Hunt, where "don't click here" would fight the colour matching.
    if (cfg.mode === 'area' && cfg.exclude) {
      const e = toPhysicalRect(cfg.exclude);
      put('ex', e.x);
      put('ey', e.y);
      put('ew', e.w);
      put('eh', e.h);
    }
    put('pattern', cfg.pattern);
    put('button', cfg.button);
    put('perclick', cfg.clickType === 'triple' ? 3 : (cfg.clickType === 'double' ? 2 : 1));
    put('pressms', cfg.pressMs);
    put('gapms', 55);
    put('interval', cfg.interval);
    put('jitter', cfg.jitter);
    put('limit', cfg.repeatMode === 'count' ? cfg.repeatCount : 0);
    put('duration', cfg.repeatMode === 'duration' ? cfg.durationMs : 0);
    put('startdelay', cfg.startDelay);
    put('restore', cfg.restore ? 1 : 0);
    put('spread', cfg.spread);
    put('cr', rgb.r);
    put('cg', rgb.g);
    put('cb', rgb.b);
    if (cfg.color2) {
      const rgb2 = hexToRgb(cfg.color2);
      put('cr2', rgb2.r);
      put('cg2', rgb2.g);
      put('cb2', rgb2.b);
      put('use2', 1);
    }
    put('tol', cfg.tolerance);
    put('scanstep', cfg.scanStep);
    put('target', cfg.targetMode);
    put('rescan', cfg.rescanMs);
    return lines.join('\n') + '\n';
  }

  // What would stop this run from working, in the user's terms.
  function validate(cfg) {
    if (cfg.mode === 'point' && !cfg.point) return 'no-point';
    if ((cfg.mode === 'area' || cfg.mode === 'color') && !cfg.area) return 'no-area';
    if (cfg.mode === 'area' || cfg.mode === 'color') {
      const r = toPhysicalRect(cfg.area);
      if (r.w * r.h > MAX_SCAN_PIXELS) return 'area-too-large';
    }
    if (cfg.mode === 'area' && cfg.exclude && coversArea(cfg.exclude, cfg.area)) {
      return 'exclusion-covers-area';
    }
    if (hotkeyConflictsWithButton(cfg.hotkey, cfg.button)) return 'hotkey-is-click-button';
    return null;
  }

  async function start() {
    if (running) return { ok: false, error: 'busy' };
    const problem = validate(config);
    if (problem) return { ok: false, error: problem };
    try {
      fs.writeFileSync(RUN_FILE, buildRunConfig(config), 'utf8');
    } catch (e) {
      logger.error('Failed to write auto clicker run config', e);
      return { ok: false, error: 'write-failed' };
    }
    await ensureEngine();
    running = true;
    lastStats = { clicks: 0, elapsed: 0, found: null, matches: 0 };
    engineSend(`START ${RUN_FILE}`);
    logger.log(`Auto clicker started (${config.mode}, ${config.interval}ms, button ${config.button})`, 'INFO');
    pushStatus({ event: 'started' });
    return { ok: true };
  }

  function stop() {
    if (!running) return { ok: true };
    engineSend('STOP');
    logger.log('Auto clicker stop requested', 'INFO');
    return { ok: true };
  }

  function stateForRenderer() {
    return { ...config, running, stats: lastStats };
  }

  // ── IPC ──
  ipcMain.handle('autoclicker-get', () => stateForRenderer());

  ipcMain.handle('autoclicker-set-enabled', async (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    if (!config.enabled) {
      if (running) stop();
      syncWatch();
      // Nothing left to watch or run — don't idle a PowerShell host forever.
      setTimeout(() => { if (!config.enabled && !running) killEngine(); }, 400);
    } else {
      // Warm the engine so the first click (and the trigger hotkey) don't wait
      // on the one-time C# compile.
      ensureEngine().then(() => sendWatchList()).catch((e) => logger.error('Auto clicker warm-up failed', e));
    }
    logger.success('Auto clicker widget toggled', { enabled: config.enabled });
    return stateForRenderer();
  });

  ipcMain.handle('autoclicker-update', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return stateForRenderer();
    const merged = sanitizeConfig({ ...config, ...patch });
    // enabled/armed/hotkey have their own handlers — a settings patch never
    // silently flips them.
    merged.enabled = config.enabled;
    merged.armed = config.armed;
    merged.hotkey = config.hotkey;
    merged.trigger = config.trigger;
    config = merged;
    saveConfig();
    return stateForRenderer();
  });

  ipcMain.handle('autoclicker-start', async () => {
    try {
      return await start();
    } catch (e) {
      logger.error('Auto clicker failed to start', e);
      running = false;
      pushStatus({ event: 'error' });
      return { ok: false, error: 'engine-failed' };
    }
  });

  ipcMain.handle('autoclicker-stop', () => stop());

  ipcMain.handle('autoclicker-set-armed', (_event, armed) => {
    config.armed = !!armed;
    saveConfig();
    if (!config.armed && running) stop();
    syncWatch();
    logger.success('Auto clicker armed state changed', { armed: config.armed });
    pushStatus({ event: 'armed-changed' });
    return stateForRenderer();
  });

  ipcMain.handle('autoclicker-set-hotkey', (_event, accelerator, trigger) => {
    if (typeof accelerator !== 'string' || !accelerator) return { ok: false, error: 'invalid' };
    if (!parseAccelerator(accelerator)) return { ok: false, error: 'unparseable' };
    if (hotkeyConflictsWithButton(accelerator, config.button)) {
      return { ok: false, error: 'hotkey-is-click-button' };
    }
    config.hotkey = accelerator;
    if (TRIGGERS.includes(trigger)) config.trigger = trigger;
    saveConfig();
    syncWatch();
    logger.success('Auto clicker hotkey updated', { accelerator, trigger: config.trigger });
    pushStatus({ event: 'hotkey-changed' });
    return { ok: true };
  });

  ipcMain.handle('autoclicker-set-trigger', (_event, trigger) => {
    if (!TRIGGERS.includes(trigger)) return { ok: false };
    config.trigger = trigger;
    holdArmed = false;
    saveConfig();
    syncWatch();
    return { ok: true };
  });

  // The renderer captures hotkeys with a plain keydown listener, so the watcher
  // has to stand down for that moment — otherwise pressing the current trigger
  // key to rebind it would also fire a run.
  ipcMain.handle('autoclicker-set-binding', (_event, binding) => {
    bindingPaused = !!binding;
    if (bindingPaused) holdArmed = false;
    return { ok: true };
  });

  // ── On-screen pickers ──
  // Each opens the frozen-screenshot overlay, stores what came back, and returns
  // the fresh config so the panel can re-render from one round trip. A run in
  // progress is stopped first — the overlay would otherwise be clicked by it.
  ipcMain.handle('autoclicker-pick', async (_event, kind, accent) => {
    if (running) stop();
    const PICK_MODES = { color: 'color', color2: 'color', point: 'point', area: 'area', exclude: 'area' };
    const mode = PICK_MODES[kind] || 'area';
    // Everything except picking the region itself is chosen *relative* to the
    // region, so show it as context — most importantly when drawing the
    // exclusion zone, which only makes sense inside the click region.
    const ghost = kind === 'area' ? null : config.area;
    let result;
    try {
      result = await areaSelect.select({
        mode,
        accent,
        existingRect: ghost,
        ghostLabel: kind === 'exclude' ? 'click region' : 'current area'
      });
    } catch (e) {
      logger.error('Auto clicker picker failed', e, { mode });
      return { ok: false, error: 'picker-failed' };
    }
    if (!result) return { ok: false, cancelled: true, config: stateForRenderer() };
    if (result.error) return { ok: false, error: result.error, config: stateForRenderer() };

    if (result.rect) {
      if (kind === 'exclude') config.exclude = sanitizeRect(result.rect);
      else config.area = sanitizeRect(result.rect);
    } else if (result.point) config.point = { x: result.point.x, y: result.point.y };
    else if (result.color) {
      if (kind === 'color2') config.color2 = sanitizeHex(result.color, config.color2);
      else config.color = sanitizeHex(result.color, config.color);
    }
    saveConfig();
    logger.success('Auto clicker target picked', { mode });
    return { ok: true, config: stateForRenderer() };
  });

  // One-shot colour scan for the panel's "Test scan" button — live pixels, so
  // the user can verify the colour + tolerance actually match what's on screen.
  ipcMain.handle('autoclicker-test-scan', async () => {
    if (!config.area) return { ok: false, error: 'no-area' };
    const problem = validate({ ...config, mode: 'color' });
    if (problem && problem !== 'hotkey-is-click-button') return { ok: false, error: problem };
    try {
      fs.writeFileSync(SCAN_FILE, buildRunConfig({ ...config, mode: 'color' }), 'utf8');
      await ensureEngine();
    } catch (e) {
      logger.error('Auto clicker test scan failed to prepare', e);
      return { ok: false, error: 'engine-failed' };
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          scanWaiters = scanWaiters.filter((w) => w !== waiter);
          resolve({ ok: false, error: 'timeout' });
        }, 15000)
      };
      scanWaiters.push(waiter);
      engineSend(`SCAN ${SCAN_FILE}`);
    });
  });

  app.on('will-quit', () => {
    if (running) engineSend('STOP');
    killEngine();
  });

  if (config.enabled) {
    ensureEngine().then(() => sendWatchList()).catch((e) => logger.error('Auto clicker warm-up failed', e));
  }

  return {
    // The trigger is engine-watched, not a globalShortcut, so a global
    // disable/enable cycle only has to re-sync the watch list.
    reapplyHotkeys: () => { triggersSuspended = false; syncWatch(); },
    suspendTriggers: () => { triggersSuspended = true; syncWatch(); },
    getOwnedHotkeys: () => (config.enabled ? [config.hotkey].filter(Boolean) : []),
    teardown: () => {
      if (running) engineSend('STOP');
      areaSelect.teardown();
      killEngine();
    }
  };
}

module.exports = {
  init,
  sanitizeConfig,
  defaultConfig,
  hexToRgb,
  hotkeyConflictsWithButton,
  // Exported so the engine can be driven directly in tests: the C# only exists
  // as this string until PowerShell compiles it, so nothing else proves it
  // builds and speaks its protocol.
  ENGINE_SCRIPT_CONTENT,
  ENGINE_SCRIPT_VERSION
};
