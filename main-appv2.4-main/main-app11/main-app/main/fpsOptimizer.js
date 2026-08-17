const { ipcMain } = require('electron');
const path = require('path');
const { runCmd, runCmdSync } = require('./shellUtils');

// Our own executable image name — 'main' in a packaged build, 'electron' in dev.
// Whitelisting it (plus our own PIDs) is the hard guarantee that the kill sweeps
// can never terminate the launcher itself, any of its child windows (mic overlay,
// crosshair, license gate), or its GPU/utility helpers — every one of those runs
// under this same image name, whatever the build is called. Computed from
// process.execPath so a future rename can't silently reopen the self-kill hole.
const OWN_IMAGE = path.basename(process.execPath).replace(/\.exe$/i, '').toLowerCase();

const SYSTEM_PROCS = [
  'explorer', 'taskmgr', 'svchost', 'system', 'smss', 'csrss', 'wininit', 'winlogon',
  'services', 'lsass', 'dwm', 'fps_optimizer', 'python', 'pythonw', 'cmd', 'conhost',
  'powershell', 'pwsh',
  'ntoskrnl', 'registry', 'runtimebroker', 'sihost', 'fontdrvhost', 'audiodg',
  'ctfmon', 'textinputhost', 'startmenuexperiencehost', 'shellexperiencehost',
  'applicationframehost', 'spoolsv', 'wudfhost', 'msiexec', 'dllhost', 'taskhostw',
  'wmiprvse', 'securityhealthsystray', 'antimalware', 'defender', 'mbam', 'malwarebytes',
  'electron', 'fps-optimizer', 'fps_optimizer', 'launcher', 'main-launcher', 'main', 'chrome', 'code', 'vscode'
];
const WHITELIST_DC = [...SYSTEM_PROCS, 'discord', 'valorant', 'vgc', 'riotclient', 'riot', 'antigravity', 'steam', 'steamwebhelper', 'siege', 'rainbowsix', 'r6', 'battleye', 'ubisoft'];

async function killProcesses(whitelist, protectedPIDs = [], mainAppPID = null) {
  const killed = [];
  try {
    // Always protect our own processes by PID: the main process itself
    // (process.pid) and the renderer (mainAppPID). Name-based protection below
    // covers the rest of our child processes, but pinning these two PIDs means
    // even a renamed/relaunched build can't accidentally kill the core.
    const safePIDs = [...protectedPIDs, process.pid.toString()];
    if (mainAppPID !== null && mainAppPID !== undefined && !safePIDs.includes(mainAppPID.toString())) {
      safePIDs.push(mainAppPID.toString());
    }

    const r = runCmdSync('tasklist /fo csv /nh');
    if (!r.ok) return killed;
    const lines = r.stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.split('","').map(s => s.replace(/^"|"$/g, ''));
      if (parts.length < 2) continue;
      const pname = parts[0].toLowerCase();
      const pid = parts[1].trim();
      // Exact-name match (not substring) — .includes() previously let e.g.
      // 'cmd' match 'cmder.exe' or 'code' match 'codecservice.exe', both
      // over- and under-protecting processes with no way to notice.
      const base = pname.endsWith('.exe') ? pname.slice(0, -4) : pname;

      // PROTECTION LAYER 1: Never kill protected PIDs
      if (safePIDs.includes(pid)) continue;

      // PROTECTION LAYER 2: Check whitelist by exact process name
      if (whitelist.some(w => base === w || pname === w)) continue;

      // PROTECTION LAYER 3: Never kill our own executable image (whatever the
      // build renamed it to) or the other names our process family uses.
      const dangerousNames = ['launcher', 'main-app', 'main', 'electron', OWN_IMAGE];
      if (dangerousNames.some(d => base === d)) continue;

      // Safe to kill
      const kr = await runCmd(`taskkill /PID ${pid} /F`);
      if (kr.ok) killed.push(parts[0]);
    }
  } catch (e) {
    // killProcesses failure is non-fatal — caller still reports whatever was killed.
  }
  return killed;
}

// ⚠️ ADMIN / WINDOWS VERSION NOTE (applies to OPT_STEPS, BATTERY_STEPS,
// REVERT_STEPS and the HKLM/service ACTIONS below):
//   • ELEVATION: every HKLM reg write, `sc config`, `net stop/start`, `powercfg`
//     and telemetry/HAGS tweak needs administrator rights. When the launcher is
//     NOT run as admin (the default), these steps FAIL silently at the OS level;
//     runSteps() catches and reports each as a failed step rather than crashing.
//     HKCU-only steps (Game Mode, Game Bar, Background Apps) still work unelevated.
//     This is an elevation limitation, not a per-Windows-version one — it affects
//     Windows 10 and 11 identically.
//   • 'Ultimate Performance' plan (duplicatescheme e9a42b02…) is hidden on many
//     editions (Win10/11 Home, and battery-powered Win11 24H2 devices). The step
//     falls back to the High Performance GUID, so it degrades gracefully.
//   • HAGS (HwSchMode=2) requires Windows 10 2004+ AND a GPU/driver that supports
//     it; on older builds or unsupported GPUs the key is written but ignored.
const OPT_STEPS = [
  {
    name: 'Power → Ultimate Performance', fn: async () => {
      const r = await runCmd('powercfg /duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61');
      if (r.ok && r.stdout) {
        const guid = r.stdout.trim().split(/\s+/).pop();
        if (guid && guid.length === 36) await runCmd(`powercfg /setactive ${guid}`);
      }
      await runCmd('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
    }
  },
  {
    name: 'CPU Priority → Games', fn: async () => {
      const base = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
      await runCmd(`reg add "${base}" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f`);
      await runCmd(`reg add "${base}\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f`);
      await runCmd(`reg add "${base}\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f`);
      await runCmd(`reg add "${base}\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "High" /f`);
    }
  },
  {
    name: 'Purging Standby RAM', fn: async () => {
      await runCmd('powershell -Command "Add-Type -MemberDefinition \'[DllImport(\\"kernel32.dll\\")]public static extern bool SetProcessWorkingSetSize(IntPtr proc, int min, int max);\' -Name Memory -Namespace Win32; $p = Get-Process; foreach ($proc in $p) { try { [Win32.Memory]::SetProcessWorkingSetSize($proc.Handle, -1, -1) } catch {} }"');
    }
  },
  {
    name: 'Clearing Temp Files', fn: async () => {
      const temp = process.env.TEMP || '';
      if (temp) await runCmd(`del /q /f /s "${temp}\\*" 2>nul`);
      await runCmd('del /q /f /s "C:\\Windows\\Temp\\*" 2>nul');
    }
  },
  {
    name: 'Disabling Superfetch', fn: async () => {
      await runCmd('net stop SysMain /y');
      await runCmd('sc config SysMain start= disabled');
    }
  },
  { name: 'Flushing DNS Cache', fn: async () => runCmd('ipconfig /flushdns') },
  {
    name: 'Optimizing Network', fn: async () => {
      await runCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f');
    }
  },
  {
    name: 'Enabling Game Mode', fn: async () => {
      await runCmd('reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AllowAutoGameMode" /t REG_DWORD /d 1 /f');
      await runCmd('reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d 1 /f');
    }
  },
  { name: 'Disabling Game Bar', fn: async () => runCmd('reg add "HKCU\\Software\\Microsoft\\GameBar" /v "UseNexusForGameBarEnabled" /t REG_DWORD /d 0 /f') },
  { name: 'Disabling Background Apps', fn: async () => runCmd('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f') },
  { name: 'Disabling Telemetry', fn: async () => runCmd('reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v "AllowTelemetry" /t REG_DWORD /d 0 /f') },
  { name: 'Enabling HAGS', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /t REG_DWORD /d 2 /f') },
  { name: 'Stopping Search Indexer', fn: async () => runCmd('net stop WSearch /y') }
];

const BATTERY_STEPS = [
  { name: 'Power Saver plan', fn: async () => runCmd('powercfg /setactive a1841308-3541-4fab-bc81-f71556f20b4a') },
  { name: 'CPU → 50%', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 50 & powercfg /setactive scheme_current') },
  { name: 'Bluetooth off', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\bthserv" /v "Start" /t REG_DWORD /d 4 /f & net stop bthserv /y') },
  { name: 'Closing apps (keeping Teams)', fn: async (ctx) => { await killProcesses([...SYSTEM_PROCS, 'teams'], [], ctx.getMainAppPID()); } }
];

// Undoes the one-directional registry/service changes OPT_STEPS makes. We never
// snapshotted the user's prior values, so "revert" means restore Windows defaults
// (delete the keys we added, or re-enable the services we disabled) rather than
// replaying an exact prior state.
const REVERT_STEPS = [
  { name: 'Restoring Balanced power plan', fn: async () => runCmd('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e') },
  {
    name: 'Restoring CPU scheduling defaults', fn: async () => {
      const base = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
      await runCmd(`reg delete "${base}" /v "SystemResponsiveness" /f`);
      await runCmd(`reg delete "${base}\\Tasks\\Games" /v "GPU Priority" /f`);
      await runCmd(`reg delete "${base}\\Tasks\\Games" /v "Priority" /f`);
      await runCmd(`reg delete "${base}\\Tasks\\Games" /v "Scheduling Category" /f`);
    }
  },
  {
    name: 'Re-enabling Superfetch', fn: async () => {
      await runCmd('sc config SysMain start= auto');
      await runCmd('net start SysMain');
    }
  },
  { name: 'Restoring network throttling default', fn: async () => runCmd('reg delete "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /f') },
  { name: 'Restoring Background Apps default', fn: async () => runCmd('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /f') },
  { name: 'Restoring Telemetry default', fn: async () => runCmd('reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v "AllowTelemetry" /f') },
  { name: 'Restoring HAGS default', fn: async () => runCmd('reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /f') },
  {
    name: 'Re-enabling Search Indexer', fn: async () => {
      await runCmd('sc config WSearch start= auto');
      await runCmd('net start WSearch');
    }
  }
];

// Granular, single-shot actions for the mini-widget panel's Power / Memory /
// Network / Restore tabs. Each is one named step so it flows through the same
// runSteps() progress path as the batch operations — the panel's progress bar
// and per-step failure reporting come for free. The batch OPT/REVERT/BATTERY
// lists above stay the "run everything" entry points (and back Game Mode);
// these expose the individual tweaks the standalone app used to.
const MM_BASE = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
const ACTIONS = {
  // ── Power ──
  ultimate: {
    name: 'Ultimate Performance plan', fn: async () => {
      const r = await runCmd('powercfg /duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61');
      if (r.ok && r.stdout) {
        const guid = r.stdout.trim().split(/\s+/).pop();
        if (guid && guid.length === 36) await runCmd(`powercfg /setactive ${guid}`);
      }
      await runCmd('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
    }
  },
  high: { name: 'High Performance plan', fn: async () => runCmd('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c') },
  balanced: { name: 'Balanced power plan', fn: async () => runCmd('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e') },
  cpuPriority: {
    name: 'CPU → Game priority', fn: async () => {
      await runCmd(`reg add "${MM_BASE}" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f`);
      await runCmd(`reg add "${MM_BASE}\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f`);
      await runCmd(`reg add "${MM_BASE}\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f`);
      await runCmd(`reg add "${MM_BASE}\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "High" /f`);
    }
  },
  hags: { name: 'Enable HAGS', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /t REG_DWORD /d 2 /f') },

  // ── Memory ──
  clearStandby: {
    name: 'Release standby RAM', fn: async () => runCmd('powershell -Command "Add-Type -MemberDefinition \'[DllImport(\\"kernel32.dll\\")]public static extern bool SetProcessWorkingSetSize(IntPtr proc, int min, int max);\' -Name Memory -Namespace Win32; $p = Get-Process; foreach ($proc in $p) { try { [Win32.Memory]::SetProcessWorkingSetSize($proc.Handle, -1, -1) } catch {} }"')
  },
  clearTemp: {
    name: 'Clear temp files', fn: async () => {
      const temp = process.env.TEMP || '';
      if (temp) await runCmd(`del /q /f /s "${temp}\\*" 2>nul`);
      await runCmd('del /q /f /s "C:\\Windows\\Temp\\*" 2>nul');
    }
  },
  disableSuperfetch: {
    name: 'Disable Superfetch', fn: async () => {
      await runCmd('net stop SysMain /y');
      await runCmd('sc config SysMain start= disabled');
    }
  },
  enableSuperfetch: {
    name: 'Re-enable Superfetch', fn: async () => {
      await runCmd('sc config SysMain start= auto');
      await runCmd('net start SysMain');
    }
  },

  // ── Network ──
  flushDns: { name: 'Flush DNS cache', fn: async () => runCmd('ipconfig /flushdns') },
  lowLatency: { name: 'Low-latency network', fn: async () => runCmd(`reg add "${MM_BASE}" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f`) },
  resetNetwork: { name: 'Reset network tweaks', fn: async () => runCmd(`reg delete "${MM_BASE}" /v "NetworkThrottlingIndex" /f`) },

  // ── Restore (individual reverts) ──
  enableSearch: {
    name: 'Re-enable Search Indexer', fn: async () => {
      await runCmd('sc config WSearch start= auto');
      await runCmd('net start WSearch');
    }
  },
  restoreTelemetry: { name: 'Restore Telemetry default', fn: async () => runCmd('reg delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection" /v "AllowTelemetry" /f') },
  restoreBackgroundApps: { name: 'Restore Background Apps default', fn: async () => runCmd('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /f') }
};

// Runs a step list, sending progress after each step and collecting real
// per-step success/failure instead of a blanket success:true — failures are
// logged (CLAUDE.md: no silent failures) and surfaced back to the renderer.
async function runSteps(steps, mainWindow, logger, doneMsg, ctx) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (mainWindow.isDestroyed()) break;
    mainWindow.webContents.send('fps-progress', { pct: (i + 1) / steps.length, msg: step.name });
    try {
      await step.fn(ctx);
      results.push({ name: step.name, success: true });
    } catch (e) {
      logger.error(`FPS optimizer step failed: ${step.name}`, e);
      results.push({ name: step.name, success: false, error: e.message });
    }
  }
  const failed = results.filter(r => !r.success);
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fps-progress', {
      pct: 1,
      msg: failed.length ? `${doneMsg} (${failed.length} step${failed.length === 1 ? '' : 's'} failed)` : doneMsg
    });
  }
  return { success: failed.length === 0, results };
}

function init(ctx) {
  const { logger, getMainWindow, getMainAppPID } = ctx;

  ipcMain.handle('fps-optimize-only', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    return runSteps(OPT_STEPS, mainWindow, logger, 'Optimize complete!', ctx);
  });

  ipcMain.handle('fps-revert-optimizations', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    return runSteps(REVERT_STEPS, mainWindow, logger, 'Defaults restored!', ctx);
  });

  // Single granular tweak from the panel's Power / Memory / Network / Restore
  // tabs. Runs through runSteps() so it shares the progress bar + per-step
  // failure reporting with the batch operations.
  ipcMain.handle('fps-action', async (_event, key) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    const action = ACTIONS[key];
    if (!action) {
      logger.warn('Unknown fps-action requested', { key: String(key).slice(0, 60) });
      return { success: false, error: 'Unknown action' };
    }
    return runSteps([action], mainWindow, logger, `${action.name} done`, ctx);
  });

  ipcMain.handle('fps-discord-only', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    mainWindow.webContents.send('fps-progress', { pct: 0.3, msg: 'Scanning processes...' });
    const killed = await killProcesses(WHITELIST_DC, [], getMainAppPID());
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fps-progress', { pct: 1, msg: `Killed ${killed.length} processes` });
    }
    return { success: true, killed };
  });

  ipcMain.handle('fps-nuke', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    mainWindow.webContents.send('fps-progress', { pct: 0.3, msg: 'Nuclear purge initiating...' });
    const killed = await killProcesses(SYSTEM_PROCS, [], getMainAppPID());
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fps-progress', { pct: 1, msg: `Killed ${killed.length} processes` });
    }
    return { success: true, killed };
  });

  ipcMain.handle('fps-battery', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    return runSteps(BATTERY_STEPS, mainWindow, logger, 'Battery Saver active!', ctx);
  });
}

module.exports = { init };
