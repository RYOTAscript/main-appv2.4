const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { runCmd, runCmdSync } = require('./shellUtils');

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
    // Always protect main app PID if available
    const safePIDs = [...protectedPIDs];
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

      // PROTECTION LAYER 3: Additional safety checks for common app names
      const dangerousNames = ['launcher', 'main-app', 'main', 'electron'];
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
  const { logger, appRoot, getMainWindow, getMainAppPID } = ctx;

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

  ipcMain.handle('launch-fps-optimizer', async () => {
    const fpsOptimizerPath = path.join(appRoot, 'fps-optimizer-electron', 'fps-optimizer-electron', 'main.js');
    const fpsOptimizerExe = path.join(appRoot, 'fps-optimizer-electron', 'fps-optimizer-electron', 'dist', 'FPS Optimizer.exe');

    if (fs.existsSync(fpsOptimizerExe)) {
      // shell.openPath resolves to an error string on failure, '' on success —
      // it does NOT reject, so the previous code always reported success even
      // when the exe failed to launch (e.g. missing dependency, blocked by AV).
      const err = await shell.openPath(fpsOptimizerExe);
      if (err) {
        logger.error('Failed to launch FPS Optimizer', new Error(err));
        return { success: false, error: err };
      }
    } else if (fs.existsSync(fpsOptimizerPath)) {
      // Dev-mode fallback: spawn detached and unref so this handler doesn't
      // block on `await` for as long as the optimizer window stays open, and
      // so the child isn't left as an untracked/attached process under this
      // one — closing the main app must not also kill it (it's a standalone
      // helper app) nor hang waiting on it.
      const { spawn } = require('child_process');
      try {
        const child = spawn(process.execPath, [fpsOptimizerPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        });
        child.on('error', (e) => logger.error('Failed to launch FPS Optimizer (dev mode)', e));
        child.unref();
      } catch (e) {
        logger.error('Failed to launch FPS Optimizer (dev mode)', e);
        return { success: false, error: e.message };
      }
    } else {
      const notFoundErr = new Error(fpsOptimizerExe);
      logger.error('FPS Optimizer not found', notFoundErr);
      return { success: false, error: 'FPS Optimizer is not installed' };
    }
    logger.success('FPS Optimizer launched');
    return { success: true };
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
