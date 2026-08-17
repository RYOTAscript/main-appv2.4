const { ipcMain, clipboard, powerSaveBlocker, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
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
//   readtext <hwnd>      -> { ok, text }   (UI-Automation dump of the window's
//                          visible text, traversed bottom-first so a usage-limit
//                          banner near the composer is captured before older chat)
const CLAUDE_LIMIT_SCRIPT_VERSION = 2;

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
elseif ($command -eq "readtext") {
    $hwnd = [long]$args[1]
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    } catch {
        [pscustomobject]@{ ok = $false; error = "uia unavailable" } | ConvertTo-Json -Compress
        exit
    }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if ($root -eq $null) {
        [pscustomobject]@{ ok = $false; error = "no element" } | ConvertTo-Json -Compress
    } else {
        # Bottom-first DFS: push children in forward order onto a stack so the last
        # sibling's subtree pops first. A usage-limit banner sits just above the
        # composer (late in the tree), so it lands at the START of our buffer — which
        # lets the parser prefer it over any older "limit" chatter higher up the page.
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $sb = New-Object System.Text.StringBuilder
        $maxChars = 16000
        $maxNodes = 3000
        $count = 0
        $stack = New-Object System.Collections.Stack
        $stack.Push($root)
        while ($stack.Count -gt 0 -and $sb.Length -lt $maxChars -and $count -lt $maxNodes) {
            $node = $stack.Pop()
            $count++
            try {
                $ct = $node.Current.ControlType
                if ($ct -eq [System.Windows.Automation.ControlType]::Text -or
                    $ct -eq [System.Windows.Automation.ControlType]::Document -or
                    $ct -eq [System.Windows.Automation.ControlType]::Edit -or
                    $ct -eq [System.Windows.Automation.ControlType]::Button) {
                    $name = $node.Current.Name
                    if ($name -and $name.Trim().Length -gt 0) { [void]$sb.Append($name); [void]$sb.Append([char]10) }
                }
            } catch {}
            try {
                $child = $walker.GetFirstChild($node)
                while ($child -ne $null) {
                    $stack.Push($child)
                    $child = $walker.GetNextSibling($child)
                }
            } catch {}
        }
        $text = $sb.ToString()
        if ($text.Length -gt $maxChars) { $text = $text.Substring(0, $maxChars) }
        [pscustomobject]@{ ok = $true; text = $text } | ConvertTo-Json -Compress
    }
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

  // ── In-window detection ──
  // Reads the target chat window's visible text (UI Automation) and looks for a
  // usage-limit banner directly, so the user never has to copy anything. The
  // banner is only accepted when BOTH a "reached/hit … limit" phrase AND a
  // "reset/again … at/in" phrase are present, which keeps ordinary conversation
  // *about* limits from tripping it. We then send just the slice around the reset
  // phrase to the renderer, which parses the exact time.
  const BANNER_LIMIT_RE = /(reached|hit|exceeded|run out of|out of)[^.\n]{0,40}(usage|message|rate|free|daily|weekly|plan)?\s*(limit|messages|credits|quota)/i;
  const BANNER_RESET_RE = /(reset[s]?|available again|try again|comes? back|renew[s]?|resume[s]?)\b[^.\n]{0,24}\b(at|in|on|after)\b[^.\n]{0,40}/i;
  const ROLLING_RE = /\b\d+\s*-\s*hour\s+limit\b/i;

  async function resolveHwnd(process, title) {
    const { windows } = await listWindows();
    const p = (process || '').toLowerCase();
    const ttl = title || '';
    const key = ttl.slice(0, 24);
    const pick =
      windows.find((w) => (w.process || '').toLowerCase() === p && w.title === ttl) ||
      windows.find((w) => (w.process || '').toLowerCase() === p && key && w.title.includes(key)) ||
      windows.find((w) => ttl && w.title === ttl) ||
      windows.find((w) => (w.process || '').toLowerCase() === p) ||
      windows.find((w) => key && w.title.includes(key));
    return pick ? pick.hwnd : null;
  }

  // Pulls the window text and, if a limit banner is present, returns the focused
  // slice around it (so the renderer parses the banner's time, not older text).
  async function detectInWindow(hwnd) {
    const res = await run(`readtext ${hwnd}`, 13000);
    const text = (res && res.ok) ? String(res.text || '') : '';
    if (!text) return { found: false, text: '' };
    const hasLimit = BANNER_LIMIT_RE.test(text) || ROLLING_RE.test(text);
    if (!hasLimit) return { found: false, text: '' };
    const r = BANNER_RESET_RE.exec(text) || ROLLING_RE.exec(text);
    if (!r) return { found: false, text: '' };
    const start = Math.max(0, r.index - 90);
    const slice = text.slice(start, r.index + 160).replace(/[ \t]+/g, ' ').trim();
    return { found: true, text: slice };
  }

  async function readWindowText(process, title) {
    const hwnd = await resolveHwnd(process, title);
    if (!hwnd) return { ok: false, error: 'window not open', found: false, text: '' };
    try {
      const d = await detectInWindow(hwnd);
      return { ok: true, ...d };
    } catch (e) {
      logger.error('Claude-limit window read failed', e, { process });
      return { ok: false, error: 'read failed', found: false, text: '' };
    }
  }

  // Poller: while on, reads the configured window every few seconds and pushes a
  // 'window-hit' to the renderer when a *new* banner appears (deduped on the
  // banner slice so a persistent on-screen banner only arms once).
  let winWatchTimer = null;
  let winWatchTarget = null;
  let winPolling = false;
  let lastBannerSig = '';

  async function pollWindow() {
    if (winPolling || !winWatchTarget) return;
    winPolling = true;
    try {
      const hwnd = await resolveHwnd(winWatchTarget.process, winWatchTarget.title);
      if (!hwnd) return;
      const d = await detectInWindow(hwnd);
      if (!d.found) return;
      const sig = d.text.slice(0, 200);
      if (sig === lastBannerSig) return; // same banner still on screen — don't re-fire
      lastBannerSig = sig;
      const win = ctx.getMainWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send('claude-limit:window-hit', { text: d.text });
    } catch (e) { /* transient UIA failures are fine */ } finally {
      winPolling = false;
    }
  }

  function startWindowWatch(target) {
    stopWindowWatch();
    if (!target || !target.process && !target.title) return;
    winWatchTarget = target;
    lastBannerSig = '';
    winWatchTimer = setInterval(pollWindow, 8000);
    setTimeout(pollWindow, 1200); // quick first look
  }
  function stopWindowWatch() {
    if (winWatchTimer) { clearInterval(winWatchTimer); winWatchTimer = null; }
    winWatchTarget = null;
  }

  // ── Claude Code transcript detection (the reliable "Nimbalyst way") ──
  // Claude Code / Nimbalyst don't screen-scrape to know the limit: when the API
  // returns 429 they write a synthetic assistant message into the session's
  // transcript at ~/.claude/projects/<proj>/<session>.jsonl, tagged
  //   { error:"rate_limit", isApiErrorMessage:true, apiErrorStatus:429,
  //     message.content[0].text:"You've hit your session limit · resets 10:50pm (Tz)" }
  // Reading that gives an exact, focus-independent reset time — no OCR, no
  // clipboard. We tail the most-recently-touched transcripts and take the newest
  // rate_limit event.
  const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const CC_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

  // Read only the last `maxBytes` of a file — a fresh limit event is appended at
  // the end, and transcripts can be many MB, so never read the whole thing.
  function tailRead(file, maxBytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  function listTranscripts() {
    const out = [];
    let projects;
    try { projects = fs.readdirSync(CC_PROJECTS_DIR, { withFileTypes: true }); } catch (e) { return out; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(CC_PROJECTS_DIR, p.name);
      let files;
      try { files = fs.readdirSync(dir); } catch (e) { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try { const st = fs.statSync(path.join(dir, f)); out.push({ file: path.join(dir, f), mtime: st.mtimeMs }); } catch (e) {}
      }
    }
    return out;
  }

  // Newest rate_limit event across the most-recently-modified transcripts, or null.
  function scanCcLimit() {
    const files = listTranscripts().sort((a, b) => b.mtime - a.mtime).slice(0, 25);
    let best = null;
    for (const { file } of files) {
      let tail;
      try { tail = tailRead(file, 262144); } catch (e) { continue; }
      if (tail.indexOf('rate_limit') === -1) continue; // cheap pre-filter before JSON.parse
      const lines = tail.split('\n');
      for (const line of lines) {
        if (line.indexOf('rate_limit') === -1) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (!obj || obj.error !== 'rate_limit') continue;
        const ts = Date.parse(obj.timestamp || '') || 0;
        const text = (obj.message && obj.message.content && obj.message.content[0] && obj.message.content[0].text) || '';
        if (!text) continue;
        if (!best || ts > best.ts) best = { ts, uuid: obj.uuid || '', text, cwd: obj.cwd || '', sessionId: obj.sessionId || '' };
      }
    }
    return best;
  }

  function readCcLimit() {
    try {
      const ev = scanCcLimit();
      if (!ev || !ev.text) return { ok: true, found: false };
      return { ok: true, found: true, text: ev.text, at: ev.ts, cwd: ev.cwd };
    } catch (e) {
      logger.error('Claude-code limit scan failed', e);
      return { ok: false, found: false };
    }
  }

  // Poller: emits a 'cc-hit' when a *new*, *fresh* rate_limit event shows up.
  let ccWatchTimer = null;
  let ccPolling = false;
  let lastCcUuid = '';
  const CC_FRESH_MS = 15 * 60000; // ignore events older than this so we don't re-arm off history

  async function pollCc() {
    if (ccPolling) return;
    ccPolling = true;
    try {
      const ev = scanCcLimit();
      if (!ev || !ev.text || !ev.uuid) return;
      if (ev.uuid === lastCcUuid) return;             // already handled this event
      if (Date.now() - ev.ts > CC_FRESH_MS) { lastCcUuid = ev.uuid; return; } // stale — suppress
      lastCcUuid = ev.uuid;
      const win = ctx.getMainWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send('claude-limit:cc-hit', { text: ev.text, cwd: ev.cwd });
    } catch (e) { /* transient FS races are fine */ } finally {
      ccPolling = false;
    }
  }

  function startCcWatch() {
    stopCcWatch();
    // Seed against any *old* event so we don't fire on startup for history; a
    // genuinely fresh event (< CC_FRESH_MS) stays unseeded and fires on first poll.
    try { const ev = scanCcLimit(); if (ev && ev.uuid && Date.now() - ev.ts > CC_FRESH_MS) lastCcUuid = ev.uuid; } catch (e) {}
    ccWatchTimer = setInterval(pollCc, 5000);
    setTimeout(pollCc, 800);
  }
  function stopCcWatch() {
    if (ccWatchTimer) { clearInterval(ccWatchTimer); ccWatchTimer = null; }
  }

  // ── Keep-awake ──
  // Unattended is the whole point: if the machine sleeps before the reset time,
  // the countdown never fires. While a continue is armed the renderer asks us to
  // hold a power-save blocker so the box stays awake long enough to send. We use
  // 'prevent-app-suspension' (lets the display sleep, keeps the process running)
  // rather than the heavier 'prevent-display-sleep'.
  let keepAwakeId = null;
  function setKeepAwake(enabled) {
    try {
      if (enabled) {
        if (keepAwakeId === null || !powerSaveBlocker.isStarted(keepAwakeId)) {
          keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
          logger.info?.('Claude-limit keep-awake engaged', { id: keepAwakeId });
        }
      } else if (keepAwakeId !== null) {
        if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
        logger.info?.('Claude-limit keep-awake released');
      }
      return { ok: true, keepAwake: keepAwakeId !== null };
    } catch (e) {
      logger.error('Claude-limit keep-awake failed', e, { enabled });
      return { ok: false, keepAwake: false };
    }
  }

  // ── OS notification ──
  // The app usually lives in the tray, so an in-app toast isn't seen. A native
  // toast tells the user their overnight continue actually fired (or failed).
  function notify(title, body) {
    try {
      if (!Notification.isSupported()) return { ok: false };
      const icon = path.join(ctx.appRoot || __dirname, 'assets', 'icon.ico');
      const n = new Notification({ title: String(title || 'Claude Auto-Continue'), body: String(body || ''), icon, silent: false });
      n.on('click', () => { try { ctx.focusMainWindow?.(); } catch (e) {} });
      n.show();
      return { ok: true };
    } catch (e) {
      return { ok: false };
    }
  }

  ipcMain.handle('claude-limit:list-windows', () => listWindows());
  ipcMain.handle('claude-limit:send', (_e, hwnd, prompt, pressEnter) => sendToWindow(hwnd, prompt, pressEnter));
  ipcMain.handle('claude-limit:read-clipboard', () => readClipboard());
  ipcMain.handle('claude-limit:set-watch', (_e, enabled) => { if (enabled) startWatch(); else stopWatch(); return { ok: true, watching: !!enabled }; });
  ipcMain.handle('claude-limit:set-keep-awake', (_e, enabled) => setKeepAwake(!!enabled));
  ipcMain.handle('claude-limit:notify', (_e, title, body) => notify(title, body));
  ipcMain.handle('claude-limit:read-window-text', (_e, process, title) => readWindowText(process, title));
  ipcMain.handle('claude-limit:set-window-watch', (_e, enabled, process, title) => {
    if (enabled) startWindowWatch({ process, title }); else stopWindowWatch();
    return { ok: true, watching: !!enabled };
  });
  ipcMain.handle('claude-limit:read-cc-limit', () => readCcLimit());
  ipcMain.handle('claude-limit:set-cc-watch', (_e, enabled) => { if (enabled) startCcWatch(); else stopCcWatch(); return { ok: true, watching: !!enabled }; });

  function teardown() { stopWatch(); stopWindowWatch(); stopCcWatch(); setKeepAwake(false); }

  return { listWindows, sendToWindow, readWindowText, readCcLimit, setKeepAwake, notify, teardown };
}

module.exports = { init };
