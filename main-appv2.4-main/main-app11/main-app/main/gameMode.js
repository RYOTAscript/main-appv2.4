const { app, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');

// ── Game Mode (backend) ──
// Watches the foreground window and reports which process owns it and whether
// it's running borderless/exclusive fullscreen — the classic "a game is on"
// signal. A persistent PowerShell helper (same pattern as the other widgets)
// P/Invokes user32 every couple of seconds and emits a line only when the
// foreground process OR its fullscreen state changes:
//   FG <exe> <0|1>      foreground process (lowercased, no .exe) + fullscreen
//   FG - 0              no usable foreground window
// The main process matches that against the user's rules. A "process" rule
// fires for a named game whenever it's in front; a "fullscreen" rule fires for
// any fullscreen app. When the active rule changes, main tells the renderer to
// apply (or revert) that rule's actions — enabling widgets, muting the mic,
// showing the crosshair, running the FPS optimiser, etc. — since those live on
// the renderer side. Detection runs whenever Game Mode is enabled; actions are
// per-rule. Nothing here touches the OS beyond reading window state.

const WATCH_SCRIPT_VERSION = 1;

const WATCH_SCRIPT_CONTENT = `try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FgWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, int flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rc; public RECT work; public uint flags; }

  public static string Poll() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "- 0";
    if (h == GetDesktopWindow() || h == GetShellWindow()) return "- 0";
    uint pid = 0; GetWindowThreadProcessId(h, out pid);
    if (pid == 0) return "- 0";
    string name = "";
    try { var p = System.Diagnostics.Process.GetProcessById((int)pid); name = p.ProcessName; } catch { return "- 0"; }
    if (name.Length == 0) return "- 0";
    bool fs = false;
    try {
      RECT wr; MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
      IntPtr mon = MonitorFromWindow(h, 2); // MONITOR_DEFAULTTONEAREST
      if (GetWindowRect(h, out wr) && GetMonitorInfo(mon, ref mi)) {
        // Fullscreen = the window covers the whole monitor (borderless or exclusive).
        fs = wr.L <= mi.rc.L && wr.T <= mi.rc.T && wr.R >= mi.rc.R && wr.B >= mi.rc.B;
      }
    } catch {}
    return name.ToLowerInvariant() + " " + (fs ? "1" : "0");
  }
}
'@ -ReferencedAssemblies @('System.dll')
} catch {
  $msg = $_.Exception.Message -replace "[\\r\\n]+", ' '
  [Console]::Out.WriteLine('WATCH-COMPILE-FAILED ' + $msg)
  exit 1
}

[Console]::Out.WriteLine('READY')
$last = ''
$own = $PID
while ($true) {
  $line = $null
  if ([Console]::In.Peek() -ge 0) {
    $line = [Console]::In.ReadLine()
    if ($line -ne $null) {
      $line = $line.Trim()
      if ($line -eq 'EXIT') { break }
      if ($line -eq 'PING') { [Console]::Out.WriteLine('PONG') }
    }
  }
  try {
    $cur = [FgWatch]::Poll()
    if ($cur -ne $last) {
      $last = $cur
      [Console]::Out.WriteLine('FG ' + $cur)
    }
  } catch {}
  Start-Sleep -Milliseconds 1500
}
`;

const ACTION_KEYS = ['muteMic', 'crosshair', 'fpsOptimize', 'showToast'];

function newRuleId() {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeRule(rule) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const actions = r.actions && typeof r.actions === 'object' ? r.actions : {};
  const cleanActions = {};
  for (const k of ACTION_KEYS) cleanActions[k] = actions[k] === true;
  const enableWidgets = Array.isArray(actions.enableWidgets)
    ? actions.enableWidgets.filter((s) => typeof s === 'string').slice(0, 20)
    : [];
  cleanActions.enableWidgets = enableWidgets;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newRuleId(),
    name: (typeof r.name === 'string' && r.name.trim()) || 'Game profile',
    match: r.match === 'fullscreen' ? 'fullscreen' : 'process',
    processName: typeof r.processName === 'string' ? r.processName.toLowerCase().replace(/\.exe$/, '').trim() : '',
    revert: r.revert !== false, // default: undo the actions when the game closes
    actions: cleanActions
  };
}

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;
  const CONFIG_PATH = path.join(userDataPath, 'game-mode-config.json');
  const WATCH_SCRIPT = path.join(userDataPath, 'game-watch.ps1');

  let config = loadConfig();
  let proc = null;
  let ready = false;
  let buffer = '';
  let currentExe = '';        // foreground process name, lowercased
  let currentFullscreen = false;
  let activeRuleId = null;     // rule currently applied, or null

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
          enabled: raw.enabled === true,
          rules: Array.isArray(raw.rules) ? raw.rules.map(sanitizeRule) : []
        };
      }
    } catch (e) {
      logger.error('Failed to read game mode config', e);
    }
    return { enabled: false, rules: [] };
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save game mode config', e);
    }
  }

  function send(event, payload) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(event, payload);
  }

  function pushDetect() {
    send('game-mode-detect', {
      enabled: config.enabled,
      exe: currentExe,
      fullscreen: currentFullscreen,
      activeRuleId
    });
  }

  // ── Watcher process ──
  function startWatcher() {
    if (proc) return;
    ensureVersionedScript(WATCH_SCRIPT, WATCH_SCRIPT_VERSION, WATCH_SCRIPT_CONTENT);
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCH_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      logger.error('Game mode watcher failed to start', e);
      proc = null;
      return;
    }
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        handleLine(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString('utf8').trim();
      if (msg) logger.warn('Game mode watcher stderr', new Error(msg));
    });
    proc.on('exit', (code) => {
      proc = null;
      ready = false;
      buffer = '';
      if (config.enabled) {
        // Unexpected death while enabled — restart once after a short delay.
        logger.warn('Game mode watcher exited; restarting', new Error('code ' + code));
        setTimeout(() => { if (config.enabled && !proc) startWatcher(); }, 3000);
      }
    });
  }

  function stopWatcher() {
    if (!proc) return;
    try {
      if (proc.stdin.writable) proc.stdin.write('EXIT\n');
      const p = proc;
      setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, 800);
    } catch (e) { /* ignore */ }
    proc = null;
    ready = false;
  }

  function handleLine(line) {
    if (line === 'READY') { ready = true; logger.success('Game mode watcher started'); return; }
    if (line.startsWith('WATCH-COMPILE-FAILED')) { logger.error('Game mode watcher failed to compile', new Error(line)); return; }
    if (line.startsWith('FG ')) {
      const rest = line.slice(3).trim();
      const sp = rest.lastIndexOf(' ');
      const exe = sp > 0 ? rest.slice(0, sp) : rest;
      const fs = sp > 0 ? rest.slice(sp + 1) === '1' : false;
      currentExe = exe === '-' ? '' : exe;
      currentFullscreen = fs;
      evaluate();
    }
  }

  // Picks the rule (if any) that matches the current foreground state. Process
  // rules win over generic fullscreen rules; among fullscreen rules the first in
  // the list wins.
  function matchRule() {
    if (!config.enabled || !currentExe) return null;
    // Don't treat our own launcher window as a game.
    if (currentExe === 'launcher' || currentExe === 'electron') return null;
    let fullscreenRule = null;
    for (const r of config.rules) {
      if (r.match === 'process') {
        if (r.processName && currentExe === r.processName) return r;
      } else if (r.match === 'fullscreen' && !fullscreenRule) {
        if (currentFullscreen) fullscreenRule = r;
      }
    }
    return fullscreenRule;
  }

  function evaluate() {
    const matched = matchRule();
    const matchedId = matched ? matched.id : null;
    if (matchedId !== activeRuleId) {
      const prev = config.rules.find((r) => r.id === activeRuleId);
      if (prev) {
        send('game-mode-event', { type: 'stop', rule: prev, exe: currentExe });
        logger.log(`Game Mode: "${prev.name}" ended`, 'INFO');
      }
      activeRuleId = matchedId;
      if (matched) {
        send('game-mode-event', { type: 'start', rule: matched, exe: currentExe });
        logger.success('Game Mode activated', { rule: matched.name, exe: currentExe });
      }
    }
    pushDetect();
  }

  function statusForRenderer() {
    return {
      enabled: config.enabled,
      rules: config.rules,
      exe: currentExe,
      fullscreen: currentFullscreen,
      activeRuleId
    };
  }

  // ── IPC ──
  ipcMain.handle('game-mode-get', () => statusForRenderer());

  ipcMain.handle('game-mode-set-enabled', (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    if (config.enabled) {
      startWatcher();
    } else {
      // Turning Game Mode off should also lift any active profile.
      if (activeRuleId) {
        const prev = config.rules.find((r) => r.id === activeRuleId);
        if (prev) send('game-mode-event', { type: 'stop', rule: prev, exe: currentExe });
        activeRuleId = null;
      }
      stopWatcher();
      currentExe = '';
      currentFullscreen = false;
    }
    pushDetect();
    logger.success('Game Mode toggled', { enabled: config.enabled });
    return statusForRenderer();
  });

  ipcMain.handle('game-mode-save-rule', (_event, rule) => {
    const clean = sanitizeRule(rule);
    const idx = config.rules.findIndex((r) => r.id === clean.id);
    if (idx >= 0) config.rules[idx] = clean;
    else config.rules.push(clean);
    saveConfig();
    // Re-evaluate in case the edited rule now matches (or no longer matches).
    evaluate();
    return statusForRenderer();
  });

  ipcMain.handle('game-mode-delete-rule', (_event, id) => {
    const before = config.rules.length;
    config.rules = config.rules.filter((r) => r.id !== id);
    if (config.rules.length !== before) {
      if (activeRuleId === id) {
        // The active profile was deleted — no stop event (the rule is gone), just
        // clear it so a fresh match can take over.
        activeRuleId = null;
      }
      saveConfig();
      evaluate();
    }
    return statusForRenderer();
  });

  // One-shot: list processes that own a visible window, for the rule picker.
  ipcMain.handle('game-mode-list-processes', () => {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName -Unique"
        ], { windowsHide: true });
      } catch (e) {
        resolve([]);
        return;
      }
      child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.on('error', () => resolve([]));
      child.on('close', () => {
        const names = out.split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        // Drop our own launcher and obvious shell processes from the picker.
        const skip = new Set(['launcher', 'electron', 'explorer', 'applicationframehost', 'textinputhost', 'shellexperiencehost', 'searchhost', 'startmenuexperiencehost']);
        resolve([...new Set(names)].filter((n) => !skip.has(n)).sort());
      });
      setTimeout(() => { try { child.kill(); } catch (e) {} resolve([]); }, 5000);
    });
  });

  app.on('will-quit', () => stopWatcher());

  if (config.enabled) startWatcher();

  return {
    teardown: () => stopWatcher()
  };
}

module.exports = { init };
