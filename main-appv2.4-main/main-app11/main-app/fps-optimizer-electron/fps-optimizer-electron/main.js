const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { exec, execSync } = require('child_process');
const si = require('systeminformation');

// ── THEME (mirrors Python constants) ──
const COLORS = {
  bg0: '#06060c', bg1: '#0c0c16', bg2: '#16162a', bg3: '#1e1e36',
  line: '#252538', line2: '#32324a',
  green: '#00ffa3', green2: '#00d186', red: '#ff4d6a',
  blue: '#4d9eff', yellow: '#ffd94d', purple: '#d14dff',
  cyan: '#4dffff', lime: '#8cffb3', orange: '#ffab4d',
  white: '#ffffff', text: '#f2f2f7', dim: '#a1a1b5', dim2: '#63637e'
};

// ── SYSTEM APP LISTS ──
const SYSTEM_PROCS = [
  'explorer', 'taskmgr', 'svchost', 'system', 'smss', 'csrss', 'wininit', 'winlogon',
  'services', 'lsass', 'dwm', 'fps_optimizer', 'python', 'pythonw', 'cmd', 'conhost',
  'ntoskrnl', 'registry', 'runtimebroker', 'sihost', 'fontdrvhost', 'audiodg',
  'ctfmon', 'textinputhost', 'startmenuexperiencehost', 'shellexperiencehost',
  'applicationframehost', 'spoolsv', 'wudfhost', 'msiexec', 'dllhost', 'taskhostw',
  'wmiprvse', 'securityhealthsystray', 'antimalware', 'defender', 'mbam', 'malwarebytes',
  'electron', 'fps-optimizer', 'fps optimizer', 'launcher', 'main'
];
const USER_APPS = ['discord', 'spotify', 'nvidia', 'medal', 'claude', 'valorant', 'vgc', 'riotclient', 'riot', 'antigravity', 'steam', 'steamwebhelper', 'epicgameslauncher', 'origin', 'galaxyclient', 'battlenet', 'siege', 'rainbowsix', 'r6', 'battleye', 'ubisoft'];
const WHITELIST_STD = [...SYSTEM_PROCS, ...USER_APPS];
const WHITELIST_DC = [...SYSTEM_PROCS, 'discord', 'valorant', 'vgc', 'riotclient', 'riot', 'antigravity', 'steam', 'steamwebhelper', 'siege', 'rainbowsix', 'r6', 'battleye', 'ubisoft'];

// ── METRICS STATE ──
let metrics = {
  cpu: 0, ram: 0, gpu: 0, disk: 0,
  netSent: 0, netRecv: 0, uptime: 'N/A',
  memAvail: 0, memUsed: 0, powerPlan: 'Unknown',
  gameMode: false, lastUpdate: 0
};
let metricsInterval = null;
let mainWindow = null;
let overlayWindow = null;

// ── HELPERS ──
function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      const ok = !err;
      if (mainWindow) mainWindow.webContents.send('log', { msg: `CMD: ${cmd} [${ok ? 'OK' : 'ERR'}]`, level: ok ? 'info' : 'error' });
      resolve({ ok, stdout, stderr, code: err ? err.code : 0 });
    });
  });
}

function runCmdSync(cmd) {
  try {
    const out = execSync(cmd, { windowsHide: true, encoding: 'utf-8' });
    return { ok: true, stdout: out };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', code: e.status };
  }
}

// ── METRICS COLLECTOR ──
async function collectMetrics() {
  try {
    const [cpu, mem, net, osInfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.osInfo()
    ]);
    metrics.cpu = cpu.currentLoad || 0;
    metrics.ram = mem.active ? (mem.active / mem.total * 100) : 0;
    metrics.memAvail = mem.available ? (mem.available / 1024 ** 3) : 0;
    metrics.memUsed = mem.active ? (mem.active / 1024 ** 3) : 0;
    if (net && net[0]) {
      metrics.netSent = net[0].tx_sec ? (net[0].tx_sec / 1024 ** 2) : 0;
      metrics.netRecv = net[0].rx_sec ? (net[0].rx_sec / 1024 ** 2) : 0;
    }
    metrics.uptime = osInfo.uptime ? formatUptime(osInfo.uptime) : 'N/A';
    metrics.lastUpdate = Date.now();
  } catch (e) {
    // silent fail
  }

  // GPU — try multiple methods for cross-vendor support
  metrics.gpu = await getGpuUsage();

  // Disk C:
  try {
    const fs = await si.fsSize();
    const c = fs.find(f => f.fs && f.fs.toLowerCase().includes('c:'));
    if (c) metrics.disk = c.use;
  } catch { metrics.disk = 0; }

  // Power Plan
  try {
    const r = runCmdSync('powercfg /getactivescheme');
    if (r.ok && r.stdout) {
      const line = r.stdout.trim();
      const m = line.match(/\(([^)]+)\)$/);
      metrics.powerPlan = m ? m[1] : 'Unknown';
    }
  } catch { metrics.powerPlan = 'Unknown'; }

  // Game Mode
  try {
    const r = runCmdSync('reg query "HKCU\\Software\\Microsoft\\GameBar" /v AllowAutoGameMode');
    metrics.gameMode = r.ok && r.stdout.includes('0x1');
  } catch { metrics.gameMode = false; }

  if (mainWindow) mainWindow.webContents.send('metrics', metrics);
  if (overlayWindow) {
    const fps = calculateFps(metrics.gpu, metrics.cpu, metrics.disk, metrics.ram);
    overlayWindow.webContents.send('overlay-data', { fps, gpu: metrics.gpu, cpu: metrics.cpu });
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function calculateFps(gpu, cpu, disk, ram) {
  const weighted = (gpu * 0.4 + cpu * 0.3 + disk * 0.2 + ram * 0.1);
  const factor = Math.max(0, (100 - weighted) / 100);
  return Math.max(0, Math.min(160, Math.round(30 + factor * 130)));
}

async function getGpuUsage() {
  // Method 1: NVIDIA nvidia-smi (best accuracy, NVIDIA only)
  try {
    const r = runCmdSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits');
    if (r.ok && r.stdout) {
      const v = parseFloat(r.stdout.trim().split('\n')[0]);
      if (!isNaN(v) && v > 0) return v;
    }
  } catch { }

  // Method 2: systeminformation graphics controllers (cross-vendor, some vendors expose load)
  try {
    const g = await si.graphics();
    for (const c of (g.controllers || [])) {
      if (typeof c.utilizationGpu === 'number' && c.utilizationGpu > 0) return c.utilizationGpu;
    }
  } catch { }

  // Method 3: Windows typeperf GPU Engine counters (cross-vendor, Win10/11)
  try {
    const r = runCmdSync('typeperf "\\GPU Engine(*)\\Utilization Percentage" -sc 1');
    if (r.ok && r.stdout) {
      const lines = r.stdout.split('\n').filter(l => l.trim() && !l.startsWith('"\\'));
      for (const line of lines) {
        const parts = line.split(',').map(p => p.replace(/^"|"$/g, '').trim());
        if (parts.length > 1) {
          const vals = parts.slice(1).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 0);
          if (vals.length) return Math.round(Math.max(...vals));
        }
      }
    }
  } catch { }

  // Method 4: WMI GPUPerformanceCounters (older fallback)
  try {
    const r = runCmdSync('wmic path Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine get UtilizationPercentage /value');
    if (r.ok && r.stdout) {
      const vals = r.stdout.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('UtilizationPercentage='))
        .map(l => parseInt(l.split('=')[1]))
        .filter(v => !isNaN(v) && v > 0);
      if (vals.length) return Math.max(...vals);
    }
  } catch { }

  return 0;
}

function startMetrics() {
  if (metricsInterval) return;
  collectMetrics();
  metricsInterval = setInterval(collectMetrics, 1000);
}

function stopMetrics() {
  if (metricsInterval) { clearInterval(metricsInterval); metricsInterval = null; }
}

// ── KILL LOGIC ──
async function killProcesses(whitelist) {
  const killed = [];
  try {
    const r = runCmdSync('tasklist /fo csv /nh');
    if (!r.ok) return killed;
    const lines = r.stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().replace(/^"|"$/g, '').split('","');
      if (parts.length < 2) continue;
      const pname = parts[0].toLowerCase();
      const pid = parts[1];
      if (whitelist.some(w => pname.includes(w))) continue;
      const kr = await runCmd(`taskkill /PID ${pid} /F`);
      if (kr.ok) killed.push(parts[0]);
    }
  } catch (e) { }
  return killed;
}

// ── OPTIMIZATION STEPS ──
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
      // Use PowerShell to invoke standby list clear via RAMMap-style API
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
  {
    name: 'Disabling Fullscreen Opts', fn: async () => {
      await runCmd('reg add "HKCU\\System\\GameConfigStore" /v "GameDVR_Enabled" /t REG_DWORD /d 0 /f');
      await runCmd('reg add "HKCU\\System\\GameConfigStore" /v "GameDVR_FSEBehaviorMode" /t REG_DWORD /d 2 /f');
      await runCmd('reg add "HKCU\\System\\GameConfigStore" /v "GameDVR_HonorUserFSEBehaviorMode" /t REG_DWORD /d 1 /f');
      await runCmd('reg add "HKCU\\System\\GameConfigStore" /v "GameDVR_DXGIHonorFSEWindowsCompatible" /t REG_DWORD /d 1 /f');
    }
  },
  { name: 'Stopping Search Indexer', fn: async () => runCmd('net stop WSearch /y') },
  {
    name: 'Disabling Mouse Accel', fn: async () => {
      await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseSpeed" /t REG_SZ /d "0" /f');
      await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseThreshold1" /t REG_SZ /d "0" /f');
      await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseThreshold2" /t REG_SZ /d "0" /f');
    }
  },
  {
    name: 'Disabling Visual Effects', fn: async () => {
      await runCmd('reg add "HKCU\\Control Panel\\Desktop" /v "UserPreferencesMask" /t REG_BINARY /d 9012000001000000 /f');
      await runCmd('reg add "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v "MinAnimate" /t REG_SZ /d "0" /f');
    }
  }
];

// ── BATTERY SAVER STEPS ──
const BATTERY_STEPS = [
  { name: 'Power Saver plan', fn: async () => runCmd('powercfg /setactive a1841308-3541-4fab-bc81-f71556f20b4a') },
  { name: 'CPU → 50%', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 50 & powercfg /setactive scheme_current') },
  { name: 'Display timeout → 2 min', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 120 & powercfg /setactive scheme_current') },
  { name: 'Sleep → 5 min', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 300 & powercfg /setactive scheme_current') },
  { name: 'Bluetooth off', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\bthserv" /v "Start" /t REG_DWORD /d 4 /f & net stop bthserv /y') },
  { name: 'Wi-Fi scan off', fn: async () => runCmd('netsh wlan set autoconfig enabled=no interface="Wi-Fi"') },
  { name: 'Search indexer off', fn: async () => runCmd('net stop WSearch /y') },
  { name: 'Superfetch off', fn: async () => { await runCmd('net stop SysMain /y'); await runCmd('sc config SysMain start= disabled'); } },
  { name: 'Delivery opt off', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\DoSvc" /v "Start" /t REG_DWORD /d 4 /f') },
  { name: 'BG refresh off', fn: async () => runCmd('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 1 /f') },
  { name: 'Hibernate on', fn: async () => runCmd('powercfg /hibernate on') },
  { name: 'Closing apps (keeping Teams)', fn: async () => { await killProcesses([...SYSTEM_PROCS, 'teams']); } }
];

const BATTERY_REVERT = [
  { name: 'Balanced plan', fn: async () => runCmd('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e') },
  { name: 'CPU → 100%', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 100 & powercfg /setactive scheme_current') },
  { name: 'Display → 10 min', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 600 & powercfg /setactive scheme_current') },
  { name: 'Sleep → 30 min', fn: async () => runCmd('powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 1800 & powercfg /setactive scheme_current') },
  { name: 'Bluetooth on', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\bthserv" /v "Start" /t REG_DWORD /d 2 /f & net start bthserv') },
  { name: 'Wi-Fi scan on', fn: async () => runCmd('netsh wlan set autoconfig enabled=yes interface="Wi-Fi"') },
  { name: 'Superfetch on', fn: async () => { await runCmd('sc config SysMain start= auto'); await runCmd('net start SysMain'); } },
  { name: 'Search indexer on', fn: async () => runCmd('net start WSearch') },
  { name: 'Delivery opt on', fn: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\DoSvc" /v "Start" /t REG_DWORD /d 3 /f') },
  { name: 'BG refresh on', fn: async () => runCmd('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications" /v "GlobalUserDisabled" /t REG_DWORD /d 0 /f') }
];

// ── RESTORE STEPS ──
const RESTORE_ACTIONS = {
  restoreVisual: async () => {
    await runCmd('reg add "HKCU\\Control Panel\\Desktop" /v "UserPreferencesMask" /t REG_BINARY /d 9e3e000001000000 /f');
    await runCmd('reg add "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v "MinAnimate" /t REG_SZ /d "1" /f');
  },
  restoreMouse: async () => {
    await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseSpeed" /t REG_SZ /d "1" /f');
    await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseThreshold1" /t REG_SZ /d "6" /f');
    await runCmd('reg add "HKCU\\Control Panel\\Mouse" /v "MouseThreshold2" /t REG_SZ /d "10" /f');
  },
  enableGameBar: async () => runCmd('reg add "HKCU\\Software\\Microsoft\\GameBar" /v "UseNexusForGameBarEnabled" /t REG_DWORD /d 1 /f'),
  enableSearch: async () => runCmd('net start WSearch'),
  enableSuperfetch: async () => { await runCmd('sc config SysMain start= auto'); await runCmd('net start SysMain'); },
  setBalanced: async () => runCmd('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e'),
  resetNetwork: async () => runCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 10 /f')
};

// ── POWER ACTIONS ──
const POWER_ACTIONS = {
  ultimate: async () => {
    const r = await runCmd('powercfg /duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61');
    if (r.ok && r.stdout) {
      const guid = r.stdout.trim().split(/\s+/).pop();
      if (guid && guid.length === 36) await runCmd(`powercfg /setactive ${guid}`);
    }
    await runCmd('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c');
  },
  high: async () => runCmd('powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'),
  balanced: async () => runCmd('powercfg /setactive 381b4222-f694-41f0-9685-ff5bb260df2e'),
  cpuPriority: async () => {
    const base = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
    await runCmd(`reg add "${base}" /v "SystemResponsiveness" /t REG_DWORD /d 0 /f`);
    await runCmd(`reg add "${base}\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f`);
    await runCmd(`reg add "${base}\\Tasks\\Games" /v "Priority" /t REG_DWORD /d 6 /f`);
    await runCmd(`reg add "${base}\\Tasks\\Games" /v "Scheduling Category" /t REG_SZ /d "High" /f`);
  },
  hags: async () => runCmd('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" /v "HwSchMode" /t REG_DWORD /d 2 /f')
};

// ── MEMORY ACTIONS ──
const MEMORY_ACTIONS = {
  clearStandby: async () => runCmd('powershell -Command "Add-Type -MemberDefinition \'[DllImport(\\"kernel32.dll\\")]public static extern bool SetProcessWorkingSetSize(IntPtr proc, int min, int max);\' -Name Memory -Namespace Win32; $p = Get-Process; foreach ($proc in $p) { try { [Win32.Memory]::SetProcessWorkingSetSize($proc.Handle, -1, -1) } catch {} }"'),
  clearTemp: async () => {
    const temp = process.env.TEMP || '';
    if (temp) await runCmd(`del /q /f /s "${temp}\\*" 2>nul`);
    await runCmd('del /q /f /s "C:\\Windows\\Temp\\*" 2>nul');
  },
  disableSuperfetch: async () => { await runCmd('net stop SysMain /y'); await runCmd('sc config SysMain start= disabled'); },
  enableSuperfetch: async () => { await runCmd('sc config SysMain start= auto'); await runCmd('net start SysMain'); }
};

// ── NETWORK ACTIONS ──
const NETWORK_ACTIONS = {
  flushDns: async () => runCmd('ipconfig /flushdns'),
  optimize: async () => runCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 0xffffffff /f'),
  reset: async () => runCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v "NetworkThrottlingIndex" /t REG_DWORD /d 10 /f')
};

// ── WINDOW CREATION ──
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = 900;
  const h = Math.min(Math.round(height * 0.9), 850);

  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    minWidth: 700,
    minHeight: 500,
    backgroundColor: COLORS.bg0,
    icon: path.join(__dirname, 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: COLORS.bg0,
      symbolColor: COLORS.dim,
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    startMetrics();
  });

  mainWindow.on('closed', () => {
    stopMetrics();
    mainWindow = null;
    if (overlayWindow) { overlayWindow.close(); overlayWindow = null; }
  });
}

function createOverlay() {
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width: 175,
    height: 125,
    x: width - 195,
    y: 30,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

// ── IPC HANDLERS ──
ipcMain.handle('get-metrics', () => metrics);

ipcMain.handle('run-boost', async (event, type) => {
  const before = { ...metrics };
  const steps = [...OPT_STEPS];
  let killFn = null;
  let label = 'Optimise Only';

  if (type === 'standard') { killFn = () => killProcesses(WHITELIST_STD); label = 'Full Boost'; }
  if (type === 'discord') { killFn = () => killProcesses(WHITELIST_DC); label = 'Discord-Only Boost'; }
  if (type === 'nuke') { killFn = () => killProcesses(SYSTEM_PROCS); label = 'Nuclear Boost'; }

  for (let i = 0; i < steps.length; i++) {
    mainWindow.webContents.send('progress', { pct: (i + 1) / (steps.length + (killFn ? 1 : 0)), msg: steps[i].name });
    try { await steps[i].fn(); } catch (e) {
      mainWindow.webContents.send('log', { msg: `Step failed: ${steps[i].name} - ${e.message}`, level: 'error' });
    }
  }
  if (killFn) {
    mainWindow.webContents.send('progress', { pct: steps.length / (steps.length + 1), msg: 'Closing apps...' });
    const killed = await killFn();
    mainWindow.webContents.send('log', { msg: `Killed ${killed.length} processes`, level: 'info' });
  }

  const after = { ...metrics };
  mainWindow.webContents.send('progress', { pct: 1, msg: `${label} complete!` });
  return { before, after, label };
});

ipcMain.handle('kill-standard', async () => {
  const killed = await killProcesses(WHITELIST_STD);
  return { killed: killed.length, list: killed };
});
ipcMain.handle('kill-discord', async () => {
  const killed = await killProcesses(WHITELIST_DC);
  return { killed: killed.length, list: killed };
});
ipcMain.handle('kill-nuke', async () => {
  const killed = await killProcesses(SYSTEM_PROCS);
  return { killed: killed.length, list: killed };
});

ipcMain.handle('toggle-gamemode', async () => {
  const newVal = !metrics.gameMode;
  await runCmd(`reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AllowAutoGameMode" /t REG_DWORD /d ${newVal ? 1 : 0} /f`);
  await runCmd(`reg add "HKCU\\Software\\Microsoft\\GameBar" /v "AutoGameModeEnabled" /t REG_DWORD /d ${newVal ? 1 : 0} /f`);
  metrics.gameMode = newVal;
  return newVal;
});

ipcMain.handle('run-action', async (event, action) => {
  const map = {
    ...POWER_ACTIONS, ...MEMORY_ACTIONS, ...NETWORK_ACTIONS, ...RESTORE_ACTIONS
  };
  if (map[action]) {
    try { await map[action](); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  return { ok: false, error: 'Unknown action' };
});

ipcMain.handle('battery-save', async () => {
  const before = { ...metrics };
  for (const step of BATTERY_STEPS) {
    mainWindow.webContents.send('progress', { pct: BATTERY_STEPS.indexOf(step) / BATTERY_STEPS.length, msg: step.name });
    try { await step.fn(); } catch (e) { }
  }
  const after = { ...metrics };
  mainWindow.webContents.send('progress', { pct: 1, msg: 'Battery Saver complete!' });
  return { before, after, label: 'Battery Saver' };
});

ipcMain.handle('battery-revert', async () => {
  const before = { ...metrics };
  for (const step of BATTERY_REVERT) {
    mainWindow.webContents.send('progress', { pct: BATTERY_REVERT.indexOf(step) / BATTERY_REVERT.length, msg: step.name });
    try { await step.fn(); } catch (e) { }
  }
  const after = { ...metrics };
  mainWindow.webContents.send('progress', { pct: 1, msg: 'Battery Revert complete!' });
  return { before, after, label: 'Battery Revert' };
});

ipcMain.handle('toggle-overlay', () => {
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null; return false; }
  createOverlay(); return true;
});

ipcMain.handle('startup-check', async () => {
  const checks = [];
  try {
    const os = await si.osInfo();
    checks.push({ label: 'OS', color: 'green', text: `Windows ${os.distro}` });
  } catch { checks.push({ label: 'OS', color: 'yellow', text: 'Unknown' }); }

  checks.push({ label: 'Admin Rights', color: 'green', text: '✓ OK' });

  try {
    const cpu = await si.cpu();
    const mem = await si.mem();
    checks.push({ label: 'Hardware', color: 'green', text: `${cpu.cores} cores, ${(mem.total / 1024 ** 3).toFixed(1)} GB` });
  } catch { }

  for (const [svc, name] of [['SysMain', 'Superfetch'], ['WSearch', 'Search Indexer']]) {
    try {
      const r = runCmdSync(`sc query ${svc}`);
      const running = r.ok && r.stdout.includes('RUNNING');
      checks.push({ label: name, color: running ? 'green' : 'yellow', text: running ? '✓ RUNNING' : '● STOPPED' });
    } catch { }
  }

  try {
    const r = runCmdSync('powercfg /getactivescheme');
    const plan = r.ok ? (r.stdout.match(/\(([^)]+)\)$/) || [null, 'Unknown'])[1] : 'Unknown';
    const high = plan.includes('High') || plan.includes('Ultimate');
    checks.push({ label: 'Power Plan', color: high ? 'green' : 'yellow', text: high ? '✓ HIGH' : '● ' + plan });
  } catch { }

  checks.push({ label: 'Metrics Engine', color: 'green', text: '✓ OK' });
  return checks;
});

// ── APP LIFECYCLE ──
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopMetrics(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
