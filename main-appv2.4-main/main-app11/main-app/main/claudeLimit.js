const { ipcMain, clipboard } = require('electron');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

// ── Claude Limit Auto-Continue mini widget ──
// When a Claude session (claude.ai, Cursor, Nimbalyst, or any chat app) hits its
// usage limit, this waits for the limit to reset and then continues the
// conversation for you: at the reset time it focuses the chat window you picked
// and "pastes + Enter"s a prompt telling the assistant the limit is back.
//
// It resumes AFTER the limit resets — it doesn't bypass or evade any limit; it's a
// scheduler + one-shot keystroke, the same thing you'd do by hand a few hours later.
//
// Windows has no clean CLI for "focus this window and type into it", so — like the
// Bluetooth / Screen-Resolution widgets — this generates a small cached .ps1 that
// P/Invokes user32 to enumerate top-level windows and to steal focus reliably
// (AttachThreadInput), then uses SendKeys for Ctrl+V / Enter. The prompt text is
// delivered via the clipboard (set from the main process here, restored after), so
// arbitrary multi-line prompts need no shell escaping at all.
//
//   windows              -> { ok, windows:[{hwnd,pid,title,process}] }
//   send <hwnd> <0|1>    -> { ok }   (focus hwnd, Ctrl+V, then Enter if 1)
const CLAUDE_LIMIT_SCRIPT_VERSION = 1;

const CLAUDE_LIMIT_SCRIPT_CONTENT = `Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinCtl {
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    public static List<string> ListWindows() {
        var results = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            int ex = GetWindowLong(h, -20); // GWL_EXSTYLE
            if ((ex & 0x00000080) != 0) return true; // WS_EX_TOOLWINDOW — skip tray/tool popups
            var sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title.Trim())) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            results.Add(((long)h).ToString() + ((char)9) + pid.ToString() + ((char)9) + title);
            return true;
        }, IntPtr.Zero);
        return results;
    }

    // Reliable focus-steal from a background process: temporarily attach our input
    // queue to the current foreground window's thread so SetForegroundWindow is honored.
    public static void Focus(IntPtr hWnd) {
        if (IsIconic(hWnd)) ShowWindow(hWnd, 9); // SW_RESTORE
        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint thisThread = GetCurrentThreadId();
        if (fgThread != thisThread) AttachThreadInput(thisThread, fgThread, true);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        if (fgThread != thisThread) AttachThreadInput(thisThread, fgThread, false);
    }
}
"@

Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = "Stop"
$command = $args[0]

if ($command -eq "windows") {
    $rows = [WinCtl]::ListWindows()
    $list = @()
    foreach ($r in $rows) {
        $parts = $r.Split([char]9)
        if ($parts.Count -lt 3) { continue }
        $wpid = 0; [void][int]::TryParse($parts[1], [ref]$wpid)
        $pname = ""
        try { $pname = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
        $title = ($parts[2..($parts.Count - 1)] -join " ")
        $list += [pscustomobject]@{ hwnd = $parts[0]; pid = $wpid; title = $title; process = $pname }
    }
    [pscustomobject]@{ ok = $true; windows = @($list) } | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "send") {
    $hwnd = [long]$args[1]
    $enter = $args[2]
    [WinCtl]::Focus([IntPtr]$hwnd)
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 200
    if ($enter -eq "1") { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
    [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
}
else {
    [pscustomobject]@{ ok = $false; error = "unknown command" } | ConvertTo-Json -Compress
}
`;

function init(ctx) {
  const { logger, userDataPath } = ctx;

  const SCRIPT = path.join(userDataPath, 'claude-limit.ps1');

  function ensureScript() {
    ensureVersionedScript(SCRIPT, CLAUDE_LIMIT_SCRIPT_VERSION, CLAUDE_LIMIT_SCRIPT_CONTENT);
  }

  async function run(args, timeoutMs = 15000) {
    ensureScript();
    // -Sta: SendKeys is happiest in a single-threaded apartment.
    const { ok, stdout, stderr } = await runCmd(
      `powershell -NoProfile -Sta -ExecutionPolicy Bypass -File "${SCRIPT}" ${args}`,
      timeoutMs
    );
    if (!ok) {
      logger.error('Claude-limit script failed', new Error(stderr || 'unknown error'), { args });
      return null;
    }
    try {
      return JSON.parse(stdout.trim());
    } catch (e) {
      logger.error('Claude-limit script parse failed', e, { args, stdout: stdout.slice(0, 300) });
      return null;
    }
  }

  async function listWindows() {
    const res = await run('windows', 12000);
    if (!res || !res.ok) return { ok: false, windows: [] };
    // Drop our own window so the user can't accidentally target the launcher itself.
    const own = new Set(['launcher']);
    const mainWin = ctx.getMainWindow?.();
    const ownTitle = (mainWin && !mainWin.isDestroyed()) ? (mainWin.getTitle() || '') : '';
    const windows = (res.windows || []).filter((w) =>
      !own.has((w.process || '').toLowerCase()) && w.title !== ownTitle
    );
    return { ok: true, windows };
  }

  function validHwnd(h) {
    return typeof h === 'string' && /^\d{1,19}$/.test(h);
  }

  // Sets the clipboard to `prompt`, focuses the target window, pastes + optionally
  // Enters, then restores the previous clipboard so the user doesn't lose it.
  async function sendToWindow(hwnd, prompt, pressEnter) {
    if (!validHwnd(String(hwnd))) return { ok: false, error: 'Invalid window' };
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'Empty prompt' };

    let previous = '';
    try { previous = clipboard.readText(); } catch (e) { previous = ''; }
    clipboard.writeText(prompt);

    const res = await run(`send ${hwnd} ${pressEnter ? 1 : 0}`, 15000);

    // Restore the user's clipboard shortly after the paste has landed.
    setTimeout(() => { try { clipboard.writeText(previous); } catch (e) {} }, 1500);

    if (!res) return { ok: false, error: 'Send failed' };
    if (res.ok) logger.success('Claude-limit continue prompt sent', { hwnd, pressEnter: !!pressEnter });
    return res;
  }

  // ── Clipboard detection ──
  // Reading the copied limit message is the reliable cross-app way to "auto-detect":
  // the user copies the message once (or leaves the watcher on) and we surface it to
  // the renderer, which parses the reset time out of it.
  let watchTimer = null;
  let lastSeenClip = '';

  // Phrases Claude / Cursor / similar chat apps use around a usage limit.
  const LIMIT_RE = /(usage limit|rate limit|message limit|reached your .{0,30}limit|limit reached|you.?ve (hit|reached)|out of (free )?(messages|usage|credits)|\b\d+\s*-\s*hour limit\b|limit will reset|resets? (at|in|on)\b|try again (later|after)|upgrade to continue)/i;

  function readClipboard() {
    try { return { ok: true, text: clipboard.readText() || '' }; } catch (e) { return { ok: false, text: '' }; }
  }

  function startWatch() {
    stopWatch();
    lastSeenClip = (() => { try { return clipboard.readText() || ''; } catch (e) { return ''; } })();
    watchTimer = setInterval(() => {
      let text = '';
      try { text = clipboard.readText() || ''; } catch (e) { return; }
      if (text === lastSeenClip) return;
      lastSeenClip = text;
      if (text && LIMIT_RE.test(text)) {
        const win = ctx.getMainWindow?.();
        if (win && !win.isDestroyed()) win.webContents.send('claude-limit:clipboard-hit', { text: text.slice(0, 2000) });
      }
    }, 1500);
  }

  function stopWatch() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  }

  ipcMain.handle('claude-limit:list-windows', () => listWindows());
  ipcMain.handle('claude-limit:send', (_e, hwnd, prompt, pressEnter) => sendToWindow(hwnd, prompt, pressEnter));
  ipcMain.handle('claude-limit:read-clipboard', () => readClipboard());
  ipcMain.handle('claude-limit:set-watch', (_e, enabled) => { if (enabled) startWatch(); else stopWatch(); return { ok: true, watching: !!enabled }; });

  function teardown() { stopWatch(); }

  return { listWindows, sendToWindow, teardown };
}

module.exports = { init };
