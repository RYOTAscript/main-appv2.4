const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

// ── Translucent Taskbar mini widget ──
// A TranslucentTB-style taskbar styler. There are two engines, chosen at runtime:
//
//  1. TranslucentTB engine (preferred when it's installed). Modern Windows 11
//     (24H2/25H2) draws the taskbar through a XAML/DirectComposition surface that
//     the old SetWindowCompositionAttribute accent API can no longer touch — the
//     accent applies but is painted over. TranslucentTB solves this by injecting
//     native hook DLLs (ExplorerTAP.dll) into explorer.exe, which is far outside
//     what a launcher widget should ship. So on machines that already have
//     TranslucentTB, we drive it: write its settings.json `desktop_appearance`
//     (which it live-reloads) and launch it. We back up the user's existing
//     appearance the first time we touch it and restore it when the widget is
//     turned off, so their own TranslucentTB setup isn't clobbered.
//
//  2. Built-in Win32 engine (fallback when TranslucentTB isn't installed). Uses
//     user32!SetWindowCompositionAttribute (WCA_ACCENT_POLICY) on Shell_TrayWnd +
//     every Shell_SecondaryTrayWnd, re-asserted on a short loop. This is the
//     classic technique — it works on Windows 10 and older Windows 11 builds, and
//     is a no-op on the newest builds (hence engine #1 being preferred there).
//
// The renderer speaks one vocabulary to both: an accent name
// (normal|clear|blur|acrylic|opaque) — which happens to match TranslucentTB's own
// `accent` values — plus an {r,g,b,a} colour. Each engine maps that as it needs.

// ── TranslucentTB identity (stable per publisher across machines) ──
const TTB_FAMILY = '28017CharlesMilette.TranslucentTB_v826wp6bftszj';
const TTB_AUMID = TTB_FAMILY + '!TranslucentTB';
const TTB_STORE_URL = 'ms-windows-store://pdp/?ProductId=9PF4KZ2VN4W9';
// winget serves the same publisher-signed package. Installing through winget (or
// the Store) means Microsoft distributes the GPL binary to the user, not us — so
// this stays a user-initiated install, never redistribution by this app.
const TTB_WINGET_ID = 'CharlesMilette.TranslucentTB';

// ── Built-in Win32 engine PowerShell (fallback) ──
const TASKBAR_SCRIPT_VERSION = 1;
const TASKBAR_SCRIPT_CONTENT = `Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TbAccent {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")]
    static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WindowCompositionAttributeData data);

    [StructLayout(LayoutKind.Sequential)]
    struct AccentPolicy {
        public int AccentState;
        public int AccentFlags;
        public uint GradientColor;
        public int AnimationId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WindowCompositionAttributeData {
        public int Attribute;
        public IntPtr Data;
        public int SizeOfData;
    }

    const int WCA_ACCENT_POLICY = 19;

    static void ApplyTo(IntPtr hwnd, int state, int flags, uint color) {
        if (hwnd == IntPtr.Zero) return;
        AccentPolicy accent = new AccentPolicy();
        accent.AccentState = state;
        accent.AccentFlags = flags;
        accent.GradientColor = color;
        accent.AnimationId = 0;

        int size = Marshal.SizeOf(accent);
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(accent, ptr, false);
            WindowCompositionAttributeData data = new WindowCompositionAttributeData();
            data.Attribute = WCA_ACCENT_POLICY;
            data.Data = ptr;
            data.SizeOfData = size;
            SetWindowCompositionAttribute(hwnd, ref data);
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
    }

    static List<IntPtr> _secondaries = new List<IntPtr>();
    static bool Collect(IntPtr hwnd, IntPtr lParam) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hwnd, sb, sb.Capacity);
        if (sb.ToString() == "Shell_SecondaryTrayWnd") _secondaries.Add(hwnd);
        return true;
    }

    public static int Apply(int state, int flags, uint color) {
        int count = 0;
        IntPtr primary = FindWindow("Shell_TrayWnd", null);
        if (primary != IntPtr.Zero) { ApplyTo(primary, state, flags, color); count++; }

        _secondaries.Clear();
        EnumWindows(Collect, IntPtr.Zero);
        foreach (IntPtr h in _secondaries) { ApplyTo(h, state, flags, color); count++; }
        return count;
    }
}
"@

$ErrorActionPreference = "Stop"
$state = [int]$args[0]
$flags = [int]$args[1]
$color = [Convert]::ToUInt32($args[2], 16)

$n = [TbAccent]::Apply($state, $flags, $color)
[pscustomobject]@{ ok = $true; windows = $n } | ConvertTo-Json -Compress
`;

// ⚠️ WINDOWS VERSION NOTE (built-in Win32 engine)
// SetWindowCompositionAttribute(WCA_ACCENT_POLICY) styling below is:
//   • Windows 10 (all): fully works.
//   • Windows 11 21H2–23H2: works.
//   • Windows 11 24H2 / 25H2: NO-OP — the taskbar is painted by a XAML/
//     DirectComposition surface the accent API can no longer touch. status()
//     still reports engine:'winapi' and apply() returns ok:true, but nothing
//     visibly changes. On these builds the ONLY working path is TranslucentTB
//     (installed via winget / Store), which apply()/clear() auto-prefer when
//     present. If a user on 24H2+ reports "the taskbar widget does nothing",
//     that is this limitation — steer them to Install TranslucentTB.
// Accent name -> Win32 accent state + flags (built-in engine only).
const WINAPI_MODES = {
  normal:  { state: 150, flags: 0, usesColor: false },
  clear:   { state: 2,   flags: 2, usesColor: true  },
  blur:    { state: 3,   flags: 2, usesColor: true  },
  acrylic: { state: 4,   flags: 2, usesColor: true  },
  opaque:  { state: 1,   flags: 2, usesColor: true, forceOpaque: true },
};
const VALID_ACCENTS = ['normal', 'clear', 'blur', 'acrylic', 'opaque'];

function init(ctx) {
  const { logger, userDataPath } = ctx;

  const TASKBAR_SCRIPT = path.join(userDataPath, 'taskbar-accent.ps1');
  const BACKUP_PATH = path.join(userDataPath, 'taskbar-ttb-backup.json');

  const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  const validAccent = (m) => (VALID_ACCENTS.includes(m) ? m : 'clear');

  // ────────────────────────────── TranslucentTB engine ──────────────────────
  // Locate <LocalAppData>\Packages\<TranslucentTB>\RoamingState\settings.json.
  // The package family folder is stable, but discover it defensively in case a
  // future package id differs.
  function ttbSettingsPath() {
    const base = process.env.LOCALAPPDATA;
    if (!base) return null;
    const direct = path.join(base, 'Packages', TTB_FAMILY, 'RoamingState', 'settings.json');
    if (fs.existsSync(direct)) return direct;
    try {
      const pkgRoot = path.join(base, 'Packages');
      for (const name of fs.readdirSync(pkgRoot)) {
        if (!/TranslucentTB/i.test(name)) continue;
        const p = path.join(pkgRoot, name, 'RoamingState', 'settings.json');
        if (fs.existsSync(p)) return p;
      }
    } catch (e) { /* Packages unreadable — treat as not installed */ }
    return null;
  }

  function ttbInstalled() { return !!ttbSettingsPath(); }

  // TranslucentTB's settings.json is JSONC — it carries whole-line `//` comments
  // (and string values that contain `https://`). Strip only lines that are
  // entirely a comment so a `$schema` URL inside quotes is never mangled.
  function readTtbSettings(p) {
    const raw = fs.readFileSync(p, 'utf8');
    const stripped = raw.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    return JSON.parse(stripped);
  }

  function writeTtbSettings(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  }

  function toHexRgba({ r, g, b, a }) {
    const h = (n) => clamp255(n).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${h(a)}`;
  }

  async function ttbRunning() {
    const { stdout } = await runCmd(
      'powershell -NoProfile -Command "(Get-Process TranslucentTB -ErrorAction SilentlyContinue | Measure-Object).Count"',
      8000
    );
    return parseInt(String(stdout || '').trim(), 10) > 0;
  }

  async function ttbLaunch() {
    // Launch the packaged app by its AppUserModelID via the shell apps folder.
    await runCmd(`explorer.exe "shell:appsFolder\\${TTB_AUMID}"`, 8000);
  }

  async function wingetAvailable() {
    const { ok } = await runCmd('where winget', 5000);
    return ok;
  }

  // User-initiated install of TranslucentTB. Tries winget first (silent, no Store
  // account needed); if winget is missing or the install doesn't land, opens the
  // Microsoft Store product page so the user installs it from Microsoft. This app
  // never ships or serves the binary itself.
  async function installTtb() {
    if (ttbInstalled()) return { ok: true, already: true, engine: 'translucenttb' };

    if (await wingetAvailable()) {
      logger.log('Installing TranslucentTB via winget', 'INFO');
      await runCmd(
        `winget install --id ${TTB_WINGET_ID} --source winget --exact --accept-package-agreements --accept-source-agreements --disable-interactivity`,
        300000
      );
      if (ttbInstalled()) {
        logger.success('TranslucentTB installed via winget');
        return { ok: true, method: 'winget', engine: 'translucenttb' };
      }
      logger.warn('winget install did not complete — falling back to the Store page');
    }

    await runCmd(`explorer.exe "${TTB_STORE_URL}"`, 8000);
    return { ok: true, method: 'store', pending: true };
  }

  async function applyViaTtb(mode, color) {
    const p = ttbSettingsPath();
    if (!p) return { ok: false, error: 'TranslucentTB not installed' };

    let settings;
    try {
      settings = readTtbSettings(p);
    } catch (e) {
      logger.warn('TranslucentTB settings parse failed — starting fresh', e);
      settings = {};
    }
    if (!settings.desktop_appearance || typeof settings.desktop_appearance !== 'object') {
      settings.desktop_appearance = { show_peek: false, show_line: false, blur_radius: 9.0 };
    }

    // Back up the user's own appearance the first time we override it, so turning
    // the widget off can hand their TranslucentTB setup back untouched.
    if (!fs.existsSync(BACKUP_PATH)) {
      try { fs.writeFileSync(BACKUP_PATH, JSON.stringify(settings.desktop_appearance), 'utf8'); }
      catch (e) { logger.warn('Could not back up TranslucentTB appearance', e); }
    }

    settings.desktop_appearance.accent = mode;
    settings.desktop_appearance.color = toHexRgba(color);
    writeTtbSettings(p, settings);

    if (!(await ttbRunning())) await ttbLaunch();
    logger.log(`Taskbar styled via TranslucentTB: ${mode}`, 'INFO');
    return { ok: true, engine: 'translucenttb' };
  }

  async function clearViaTtb() {
    const p = ttbSettingsPath();
    if (!p) return { ok: false, error: 'TranslucentTB not installed' };

    let settings;
    try { settings = readTtbSettings(p); } catch (e) { settings = {}; }
    if (!settings.desktop_appearance || typeof settings.desktop_appearance !== 'object') {
      settings.desktop_appearance = {};
    }

    // Restore the backed-up appearance if we have one, else just hand the taskbar
    // back to Windows (accent: normal).
    if (fs.existsSync(BACKUP_PATH)) {
      try {
        settings.desktop_appearance = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
        fs.unlinkSync(BACKUP_PATH);
      } catch (e) {
        settings.desktop_appearance.accent = 'normal';
      }
    } else {
      settings.desktop_appearance.accent = 'normal';
    }
    writeTtbSettings(p, settings);
    logger.log('Taskbar restored (TranslucentTB appearance reverted)', 'INFO');
    return { ok: true, engine: 'translucenttb' };
  }

  // ────────────────────────────── Built-in Win32 engine ─────────────────────
  function ensureScript() {
    ensureVersionedScript(TASKBAR_SCRIPT, TASKBAR_SCRIPT_VERSION, TASKBAR_SCRIPT_CONTENT);
  }

  let desired = null;      // {state, flags, abgrHex} being enforced, or null
  let enforceTimer = null;
  let running = false;     // guards overlapping PowerShell runs

  function toAbgrHex({ r, g, b, a }) {
    const R = clamp255(r), G = clamp255(g), B = clamp255(b), A = clamp255(a);
    const abgr = (((A << 24) | (B << 16) | (G << 8) | R) >>> 0);
    return abgr.toString(16).padStart(8, '0');
  }

  async function applyAccent(state, flags, abgrHex) {
    ensureScript();
    const { ok, stdout, stderr } = await runCmd(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${TASKBAR_SCRIPT}" ${state} ${flags} ${abgrHex}`,
      15000
    );
    if (!ok) {
      logger.error('Taskbar accent script failed', new Error(stderr || 'unknown error'), { state, flags, abgrHex });
      return { ok: false };
    }
    try { return JSON.parse(stdout.trim()); }
    catch (e) { logger.error('Taskbar accent parse failed', e, { stdout: String(stdout).slice(0, 200) }); return { ok: false }; }
  }

  async function enforce() {
    if (!desired || running) return;
    running = true;
    try { await applyAccent(desired.state, desired.flags, desired.abgrHex); }
    finally { running = false; }
  }

  function startLoop() { if (!enforceTimer) enforceTimer = setInterval(enforce, 2000); }
  function stopLoop() { if (enforceTimer) { clearInterval(enforceTimer); enforceTimer = null; } }

  async function applyViaWinapi(mode, color) {
    const m = WINAPI_MODES[mode] || WINAPI_MODES.clear;
    let abgrHex = '00000000';
    if (m.usesColor) {
      const c = color && typeof color === 'object' ? { ...color } : { r: 0, g: 0, b: 0, a: 0 };
      if (m.forceOpaque) c.a = 255;
      abgrHex = toAbgrHex(c);
    }
    desired = { state: m.state, flags: m.flags, abgrHex };
    startLoop();
    const res = await applyAccent(desired.state, desired.flags, desired.abgrHex);
    if (res.ok) logger.log(`Taskbar styled via built-in engine: ${mode}`, 'INFO');
    return { ok: !!res.ok, engine: 'winapi' };
  }

  async function clearViaWinapi() {
    stopLoop();
    desired = null;
    await applyAccent(150, 0, '00000000');
    return { ok: true, engine: 'winapi' };
  }

  // ────────────────────────────── Dispatch ──────────────────────────────────
  async function apply(mode, color) {
    const m = validAccent(mode);
    const c = color && typeof color === 'object' ? color : { r: 0, g: 0, b: 0, a: 0 };
    return ttbInstalled() ? applyViaTtb(m, c) : applyViaWinapi(m, c);
  }

  async function clear() {
    return ttbInstalled() ? clearViaTtb() : clearViaWinapi();
  }

  async function status() {
    const installed = ttbInstalled();
    return {
      installed,
      engine: installed ? 'translucenttb' : 'winapi',
      running: installed ? await ttbRunning() : false,
      storeUrl: TTB_STORE_URL,
    };
  }

  ipcMain.handle('taskbar-apply', (_event, mode, color) => apply(mode, color));
  ipcMain.handle('taskbar-clear', () => clear());
  ipcMain.handle('taskbar-status', () => status());
  ipcMain.handle('taskbar-install-ttb', () => installTtb());

  return { apply, clear, status, installTtb };
}

module.exports = { init };
