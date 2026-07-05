const { app, BrowserWindow, shell, ipcMain, globalShortcut, dialog, Menu, Tray, session, desktopCapturer, crashReporter, safeStorage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');
const Logger = require('./logger');
const https = require('https');

function safeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(url);
      const headers = { ...options.headers };

      let bodyData = null;
      if (options.body) {
        if (typeof options.body === 'string') {
          bodyData = options.body;
        } else if (options.body instanceof URLSearchParams) {
          bodyData = options.body.toString();
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
          bodyData = JSON.stringify(options.body);
          headers['Content-Type'] = 'application/json';
        }
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: headers,
        timeout: 20000
      };

      const req = https.request(reqOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const textContent = buffer.toString('utf8');
          
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => res.headers[name.toLowerCase()] || null
            },
            json: async () => JSON.parse(textContent),
            text: async () => textContent
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          req.destroy();
          reject(new Error('Request aborted'));
        });
      }

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.setAppUserModelId('com.launcher.app');
const APP_VERSION = 'v2.8.0';

// ── Crash handling (this is what removes the Windows "System Error" dialog) ──
// The renderer very occasionally dies with STATUS_STACK_BUFFER_OVERRUN (0xC0000409)
// — an intermittent low-level Chromium/Windows fault (seen since v2.3.0, unaffected
// by GPU mode or JIT). The reason a *Windows* error dialog appeared for it is that
// the app never initialised Electron's own crash handler, so Windows Error Reporting
// took over the crash and showed its modal dialog. Starting the crashReporter installs
// Chromium's Crashpad handler (including its WER runtime-exception module, which
// specifically catches __fastfail/stack-protection crashes), so the crash is handled
// silently in-process instead of by Windows. Combined with the auto-reload in
// createWindow(), an occasional renderer blip becomes invisible and self-healing.
// uploadToServer:false keeps everything local — nothing is sent anywhere.
try {
  crashReporter.start({
    productName: 'Launcher',
    companyName: 'launcher',
    submitURL: '',
    uploadToServer: false,
    compress: true
  });
} catch (e) {
  // Never let crash-reporter setup itself prevent startup.
  console.error('crashReporter.start failed:', e && e.message);
}

// ── Windows renderer stability ──
// Keep RendererCodeIntegrity disabled (pre-existing) to avoid unsigned-DLL load
// conflicts in the renderer on some Windows setups. NOTE: earlier attempts to stop
// the intermittent STATUS_STACK_BUFFER_OVERRUN via GPU mode (v2.5.0) and V8 --jitless
// (v2.5.1) did NOT work — the crash happens with hardware acceleration on OR off and
// with the JIT on OR off, so it is neither the GPU nor V8's JIT. It is now handled at
// the crash-handler level instead (see crashReporter.start above + the render-process
// auto-reload in createWindow), which suppresses the Windows dialog and self-heals.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
}

const userDataPath = path.join(app.getPath('appData'), 'main-launcher');
app.setPath('userData', userDataPath);

// ── Graphics mode (optional override) ──
// Hardware acceleration is ON by default. The GPU was NOT the cause of the
// STATUS_STACK_BUFFER_OVERRUN crash (that's CET vs V8's JIT — fixed above with
// --jitless), and turning the GPU off only made the UI laggy without helping.
// This tiny graphics-config.json remains available so we can still switch modes
// WITHOUT editing code if a future GPU-specific issue ever appears:
//   { "mode": "gpu" }       -> full GPU acceleration      (default, smoothest)
//   { "mode": "angle-gl" }  -> keep the GPU, via ANGLE/OpenGL
//   { "mode": "no-accel" }  -> hardware acceleration OFF   (CPU rendering, laggier)
const GRAPHICS_CONFIG_PATH = path.join(userDataPath, 'graphics-config.json');
function getGraphicsMode() {
  try {
    if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
    if (fs.existsSync(GRAPHICS_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GRAPHICS_CONFIG_PATH, 'utf8'));
      if (['no-accel', 'angle-gl', 'gpu'].includes(raw.mode)) return raw.mode;
    } else {
      // Seed the file so the option is discoverable.
      fs.writeFileSync(GRAPHICS_CONFIG_PATH, JSON.stringify({ mode: 'gpu' }, null, 2), 'utf8');
    }
  } catch (e) { /* fall through to default */ }
  return 'gpu';
}
const graphicsMode = getGraphicsMode();
if (graphicsMode === 'no-accel') {
  app.disableHardwareAcceleration();
} else if (graphicsMode === 'angle-gl') {
  app.commandLine.appendSwitch('use-angle', 'gl');
}

const cachePath = path.join(userDataPath, 'Cache');
const gpuCachePath = path.join(userDataPath, 'GPUCache');
const logsPath = path.join(userDataPath, 'logs');
const CLOSE_WINDOWS_STARTUP_PATH = path.join(userDataPath, 'close-windows-startup.json');
const AUTOSTART_CONFIG_PATH = path.join(userDataPath, 'autostart-config.json');
const MINIMIZE_WINDOWS_SCRIPT = path.join(userDataPath, 'minimize-windows.ps1');

for (const dir of [userDataPath, cachePath, gpuCachePath, logsPath]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
app.commandLine.appendSwitch('disk-cache-dir', cachePath);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {

  const logger = new Logger(logsPath, APP_VERSION);
  logger.attachProcessHandlers();
  logger.startupBanner();
  logger.system('Graphics mode', { graphicsMode, hint: 'change via graphics-config.json (no-accel | angle-gl | gpu)' });

  function verifyFeatures() {
    const iconsFolder = path.join(__dirname, 'icons');
    if (fs.existsSync(iconsFolder)) logger.success('Icons folder found', { path: iconsFolder });
    else logger.warn('Icons folder missing', { path: iconsFolder });
  }

  let mainWindow;
  let mainAppPID = null;
  let appTray = null;
  let focusHotkey = 'Control+Alt+M';

  function registerFocusHotkey(accelerator) {
    if (focusHotkey) globalShortcut.unregister(focusHotkey);
    if (!globalShortcut.register(accelerator, focusMainWindow)) {
      if (focusHotkey) globalShortcut.register(focusHotkey, focusMainWindow);
      return false;
    }
    focusHotkey = accelerator;
    return true;
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 920,
      height: 640,
      frame: false,
      transparent: true,
      center: true,
      resizable: false,
      roundedCorners: true,
      hasShadow: true,
      backgroundColor: '#00000000',
      icon: path.join(__dirname, 'icons', 'main.ico'),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    logger.attachWindow(mainWindow);

    // ── Self-healing renderer ──
    // The renderer can occasionally die (intermittent STATUS_STACK_BUFFER_OVERRUN —
    // a low-level Chromium/Windows fault we can't fully prevent). Instead of leaving
    // a dead/blank window, reload it automatically so the app recovers on its own.
    // A short-window rate limit prevents an infinite reload storm if it ever crashes
    // continuously.
    let rendererCrashTimes = [];
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      if (!details || details.reason === 'clean-exit' || details.reason === 'killed') return;
      const now = Date.now();
      rendererCrashTimes = rendererCrashTimes.filter((t) => now - t < 60000);
      rendererCrashTimes.push(now);
      // If the crash is persistent (e.g. the unresolved CET/shadow-stack fault),
      // reloading just re-crashes and spams the dialog — so stop after 2 tries in a
      // minute and leave the window as-is rather than looping.
      if (rendererCrashTimes.length > 2) {
        logger.error('Renderer crashed repeatedly in a short window — not auto-reloading again (apply the CET fix; see Fix-Crash.cmd)', null, details);
        return;
      }
      logger.warn('Renderer crashed — auto-reloading to recover', details);
      setTimeout(() => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('main.html');
        } catch (e) {
          logger.error('Renderer auto-reload failed', e);
        }
      }, 300);
    });

    // The mic-mute overlay is a second, always-alive BrowserWindow, so Electron's
    // 'window-all-closed' event never fires from closing just the main window --
    // it only fires once every window (including the hidden overlay) is gone. Quit
    // explicitly here so closing the main window always closes the whole app.
    mainWindow.on('closed', () => {
      mainWindow = null;
      app.quit();
    });

    mainWindow.loadFile('main.html');
    mainWindow.show();

    // Store main app PID for process protection
    mainAppPID = mainWindow.webContents.getOSProcessId();
    logger.success('Main window created', { mainAppPID });
  }

  function createTray() {
    if (appTray) return;

    const trayIcon = path.join(__dirname, 'icons', 'main.ico');
    appTray = new Tray(trayIcon);
    appTray.setToolTip('main launcher');
    appTray.setContextMenu(buildTrayMenu());
    appTray.on('double-click', () => focusMainWindow());
    logger.success('System tray icon created');
  }

  function sampleCpu() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) total += cpu.times[type];
      idle += cpu.times.idle;
    }
    return { idle, total };
  }

  function getCpuUsagePercent() {
    return new Promise((resolve) => {
      const start = sampleCpu();
      setTimeout(() => {
        const end = sampleCpu();
        const idleDiff = end.idle - start.idle;
        const totalDiff = end.total - start.total;
        const usage = totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
        resolve(Math.min(100, Math.max(0, usage)));
      }, 150);
    });
  }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    logger.log('Window focused via hotkey', 'INFO');
  }

  function getCloseWindowsStartup() {
    try {
      if (fs.existsSync(CLOSE_WINDOWS_STARTUP_PATH)) {
        return JSON.parse(fs.readFileSync(CLOSE_WINDOWS_STARTUP_PATH, 'utf8')).enabled === true;
      }
    } catch (e) {
      logger.error('Failed to read close-windows-startup config', e);
    }
    return false;
  }

  // Builds the exact { path, args } we register with the OS when autostart is enabled.
  // On Windows, getLoginItemSettings() only reports openAtLogin: true when queried with
  // the SAME path AND args that setLoginItemSettings() used — so apply and detect MUST
  // share this, otherwise the OS check always comes back false. This mismatch was the
  // original bug: registration used args ['--startup'] but the query passed no args.
  function getAutoStartLaunchOptions() {
    const exePath = app.getPath('exe');
    const args = [];
    const isDevElectron = /electron(?:\.exe)?$/i.test(path.basename(exePath));
    if (!app.isPackaged && isDevElectron) {
      args.push(app.getAppPath());
    }
    args.push('--startup');
    return { path: exePath, args };
  }

  // Our own record of whether the user wants autostart on, independent of whatever
  // the OS currently has registered. app.setLoginItemSettings() registers with the OS
  // (Windows Registry Run key / macOS Login Items / Linux autostart entry), which is
  // normally durable on its own — but that registration can still be lost without the
  // app's involvement (e.g. the install path changes after an update, or some other
  // startup-manager/cleanup tool clears it). Keeping our own config means the app can
  // re-assert the OS registration on every launch instead of just trusting it stuck.
  function getAutoStartConfig() {
    try {
      if (fs.existsSync(AUTOSTART_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(AUTOSTART_CONFIG_PATH, 'utf8')).enabled === true;
      }
    } catch (e) {
      logger.error('Failed to read autostart config', e);
    }
    // No config yet (first run after this update, or a fresh install) — fall back to
    // whatever the OS currently has registered instead of assuming "off". Otherwise a
    // user who already had autostart enabled under the old code (which never wrote
    // this file) would have it silently disabled the next time the app launches.
    // Query with the same path/args we register with so the OS match succeeds.
    try {
      return app.getLoginItemSettings(getAutoStartLaunchOptions()).openAtLogin;
    } catch (e) {
      return false;
    }
  }

  function saveAutoStartConfig(enabled) {
    try {
      fs.writeFileSync(AUTOSTART_CONFIG_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save autostart config', e);
    }
  }

  // Actually registers (or unregisters) with the OS. Safe to call repeatedly with the
  // same value — used both when the user toggles the setting and on every app startup
  // to re-assert it from the saved config.
  function applyAutoStartSetting(enabled) {
    try {
      const options = { openAtLogin: enabled, ...getAutoStartLaunchOptions() };
      app.setLoginItemSettings(options);
      logger.success('Auto start applied', { enabled, options });
      return true;
    } catch (e) {
      logger.error('applyAutoStartSetting failed', e, { enabled });
      return false;
    }
  }

  const MINIMIZE_SCRIPT_VERSION = 1;

  function ensureMinimizeWindowsScript() {
    const versionFile = `${MINIMIZE_WINDOWS_SCRIPT}.version`;
    const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
    if (fs.existsSync(MINIMIZE_WINDOWS_SCRIPT) && current === String(MINIMIZE_SCRIPT_VERSION)) return;

    const script = `(New-Object -ComObject Shell.Application).MinimizeAll()`;
    fs.writeFileSync(MINIMIZE_WINDOWS_SCRIPT, script, 'utf8');
    fs.writeFileSync(versionFile, String(MINIMIZE_SCRIPT_VERSION), 'utf8');
  }

  async function minimizeOtherWindowsOnStartup() {
    ensureMinimizeWindowsScript();
    try {
      setTimeout(() => {
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${MINIMIZE_WINDOWS_SCRIPT}"`, (err) => {
          if (err) logger.error('Minimize windows on startup failed', err);
          else {
            logger.success('Minimized other windows on startup');
            setTimeout(() => {
              if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
                logger.success('Main window focused after startup minimization');
              }
            }, 300);
          }
        });
      }, 3000);
    } catch (e) {
      logger.error('Minimize windows on startup failed', e);
    }
  }

  const MEDIA_PLAY_SCRIPT = path.join(userDataPath, 'media-play.ps1');
  const MEDIA_SCRIPT_VERSION = 2;

  function ensureMediaPlayScript() {
    const versionFile = `${MEDIA_PLAY_SCRIPT}.version`;
    const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
    if (fs.existsSync(MEDIA_PLAY_SCRIPT) && current === String(MEDIA_SCRIPT_VERSION)) return;

    const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static void Play() {
    const byte vk = 0xB0;
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
}
"@
$spotify = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($spotify) { [Win32]::SetForegroundWindow($spotify.MainWindowHandle) }
Start-Sleep -Milliseconds 300
[Win32]::Play()
`;
    fs.writeFileSync(MEDIA_PLAY_SCRIPT, script, 'utf8');
    fs.writeFileSync(versionFile, String(MEDIA_SCRIPT_VERSION), 'utf8');
  }

  function isSpotifyPath(fullPath) {
    return /spotify\.exe$/i.test(fullPath.replace(/\\/g, '/'));
  }

  function triggerSpotifyAutoPlay(delayMs = 2800) {
    ensureMediaPlayScript();
    setTimeout(() => {
      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${MEDIA_PLAY_SCRIPT}"`, (err) => {
        if (err) logger.error('Spotify auto-play failed', err, { delayMs });
        else logger.success('Spotify auto-play media key sent', { delayMs });
      });
    }, delayMs);
  }

  // ── FPS OPTIMIZER INTEGRATION ──
  const SYSTEM_PROCS = [
    'explorer', 'taskmgr', 'svchost', 'system', 'smss', 'csrss', 'wininit', 'winlogon',
    'services', 'lsass', 'dwm', 'fps_optimizer', 'python', 'pythonw', 'cmd', 'conhost',
    'ntoskrnl', 'registry', 'runtimebroker', 'sihost', 'fontdrvhost', 'audiodg',
    'ctfmon', 'textinputhost', 'startmenuexperiencehost', 'shellexperiencehost',
    'applicationframehost', 'spoolsv', 'wudfhost', 'msiexec', 'dllhost', 'taskhostw',
    'wmiprvse', 'securityhealthsystray', 'antimalware', 'defender', 'mbam', 'malwarebytes',
    'electron', 'fps-optimizer', 'fps optimizer', 'launcher', 'main-launcher', 'main', 'chrome', 'code', 'vscode'
  ];
  const USER_APPS = ['discord', 'spotify', 'nvidia', 'medal', 'claude', 'valorant', 'vgc', 'riotclient', 'riot', 'antigravity', 'steam', 'steamwebhelper', 'epicgameslauncher', 'origin', 'galaxyclient', 'battlenet', 'siege', 'rainbowsix', 'r6', 'battleye', 'ubisoft', 'code', 'vscode'];
  const WHITELIST_STD = [...SYSTEM_PROCS, ...USER_APPS];
  const WHITELIST_DC = [...SYSTEM_PROCS, 'discord', 'valorant', 'vgc', 'riotclient', 'riot', 'antigravity', 'steam', 'steamwebhelper', 'siege', 'rainbowsix', 'r6', 'battleye', 'ubisoft', 'code', 'vscode'];

  function runCmd(cmd) {
    return new Promise((resolve) => {
      exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
        const ok = !err;
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

  async function killProcesses(whitelist, protectedPIDs = []) {
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
        
        // PROTECTION LAYER 1: Never kill protected PIDs
        if (safePIDs.includes(pid)) continue;
        
        // PROTECTION LAYER 2: Check whitelist by process name
        if (whitelist.some(w => pname.includes(w))) continue;
        
        // PROTECTION LAYER 3: Additional safety checks for common app names
        const dangerousNames = ['launcher', 'main-app', 'main', 'electron'];
        if (dangerousNames.some(d => pname === d || pname === d + '.exe')) continue;
        
        // Safe to kill
        const kr = await runCmd(`taskkill /PID ${pid} /F`);
        if (kr.ok) killed.push(parts[0]);
      }
    } catch (e) { 
      logger.error('killProcesses error', e);
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
    { name: 'Closing apps (keeping Teams)', fn: async () => { await killProcesses([...SYSTEM_PROCS, 'teams'], mainAppPID ? [mainAppPID.toString()] : []); } }
  ];

  const SPOTIFY_SHORTCUTS = {
    spotifyPlay: 'CommandOrControl+Up',
    spotifyPause: 'CommandOrControl+Down',
    spotifyNext: 'CommandOrControl+Right',
    spotifyPrevious: 'CommandOrControl+Left',
    spotifyVolumeUp: 'CommandOrControl+PageUp',
    spotifyVolumeDown: 'CommandOrControl+PageDown'
  };

  let registeredSpotifyShortcuts = {};

  function unregisterAllSpotifyShortcuts() {
    for (const accel of Object.values(registeredSpotifyShortcuts)) {
      globalShortcut.unregister(accel);
    }
    registeredSpotifyShortcuts = {};
  }

  async function adjustSpotifyVolume(delta) {
    if (mainWindow) {
      mainWindow.webContents.send('spotify-volume-adjust', delta);
    }
  }

  function registerSpotifyShortcutsFromConfig(hotkeys) {
    unregisterAllSpotifyShortcuts();

    const map = {
      spotifyPlay: async () => { await spotifyApiRequest('/me/player/play', 'PUT'); },
      spotifyPause: async () => { await spotifyApiRequest('/me/player/pause', 'PUT'); },
      spotifyNext: async () => { await spotifyApiRequest('/me/player/next', 'POST'); },
      spotifyPrevious: async () => { await spotifyApiRequest('/me/player/previous', 'POST'); },
      spotifyVolumeUp: async () => { await adjustSpotifyVolume(10); },
      spotifyVolumeDown: async () => { await adjustSpotifyVolume(-10); }
    };

    for (const [key, action] of Object.entries(map)) {
      let accel = hotkeys?.[key] || SPOTIFY_SHORTCUTS[key];

      if (accel && globalShortcut.register(accel, action)) {
        registeredSpotifyShortcuts[key] = accel;
        logger.log('Spotify global shortcut registered', 'INFO', { key, accelerator: accel });
      } else if (accel) {
        logger.error('Spotify global shortcut registration failed', null, { key, accelerator: accel });
      }
    }
  }

  app.whenReady().then(() => {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (!sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (e) {
        logger.warn('System audio capture handler failed', e);
        callback({});
      }
    });

    verifyFeatures();
    createWindow();
    createTray();
    registerFocusHotkey(focusHotkey);
    logger.success('Focus hotkey registered', { accelerator: focusHotkey });
    // Register default Spotify shortcuts until renderer sends its config
    registerSpotifyShortcutsFromConfig(SPOTIFY_SHORTCUTS);
    // Register the default mic-mute hotkey until renderer sends its saved binding
    // (or unregisters it, if the Mic Mute mini-widget is disabled in Settings)
    registerMicMuteHotkey(DEFAULT_MIC_MUTE_HOTKEY);
    // Minimize other windows on startup if both autostart AND close-windows-startup
    // are enabled. The old approach checked process.argv.includes('--startup'), but
    // on Windows the registry Run key doesn't pass args reliably, so that check
    // silently never fired after the first launch. Now we check our own saved configs
    // directly — the session flag prevents this from re-running if the app reloads.
    if (!app.isSessionStartupMinimizeDone && getAutoStartConfig() && getCloseWindowsStartup()) {
      app.isSessionStartupMinimizeDone = true;
      minimizeOtherWindowsOnStartup();
    }

    // Re-assert autostart registration every launch from our own saved config, rather
    // than just trusting whatever the OS currently has — see applyAutoStartSetting/
    // getAutoStartConfig above for why this matters. getAutoStartConfig() falls back to
    // (and this then persists) the live OS state on the very first run after this
    // update, so existing users' prior choice carries over instead of being reset.
    const desiredAutoStart = getAutoStartConfig();
    saveAutoStartConfig(desiredAutoStart);
    applyAutoStartSetting(desiredAutoStart);
    
    // Load and verify Spotify configuration on startup
    loadSpotifyConfig();
    loadSpotifyTokens();
    if (spotifyConfig.clientId && spotifyTokens?.access_token) {
      logger.success('Spotify config loaded on startup', { hasClientId: !!spotifyConfig.clientId, hasToken: !!spotifyTokens?.access_token });
    }

    // Query the real mic-mute state so the tray checkbox and on-window badge don't
    // default to a wrong assumption on startup.
    queryMicMuteState().then((muted) => {
      if (appTray) appTray.setContextMenu(buildTrayMenu());
      logger.log('Mic mute state queried on startup', 'INFO', { muted });
    }).catch((e) => logger.error('Failed to query mic mute state on startup', e));
  });

  app.on('second-instance', () => focusMainWindow());

  app.on('web-contents-created', (event, contents) => {
    // Close any windows that aren't the main window (like the Electron welcome page)
    if (mainWindow && contents.id !== mainWindow.webContents.id) {
      const window = BrowserWindow.fromWebContents(contents);
      if (window) window.close();
    }
  });

  app.on('window-all-closed', () => {
    logger.system('All windows closed — quitting');
    if (process.platform !== 'darwin') app.quit();
  });

  // Leaving the mic muted or the overlay running after the app exits would strand
  // the user with a muted mic and no way to see/toggle it — so unmute and tear the
  // overlay down before the app is actually allowed to quit.
  let quitCleanupDone = false;
  app.on('before-quit', (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    (async () => {
      try {
        if (micMuted === true) {
          const result = await runMicMuteScript('toggle');
          if (result !== null) micMuted = result;
          logger.log('Mic unmuted on app quit', 'INFO', { muted: micMuted });
        }
      } catch (e) {
        logger.error('Failed to unmute mic on quit', e);
      }
      micMuteOverlayEnabled = false;
      if (micMuteOverlayWindow && !micMuteOverlayWindow.isDestroyed()) {
        micMuteOverlayWindow.destroy();
      }
      micMuteOverlayWindow = null;
      quitCleanupDone = true;
      app.quit();
    })();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (appTray) appTray.destroy();
    logger.system('Application quit');
  });

  ipcMain.on('window-minimize', () => mainWindow?.minimize());

  ipcMain.on('window-close', () => mainWindow?.close());

  ipcMain.on('renderer-log', (_event, payload) => {
    if (!payload?.message) return;
    logger.log(payload.message, payload.type || 'RENDERER', payload.meta || {});
  });

  ipcMain.handle('set-focus-hotkey', (_event, accelerator) => {
    if (!accelerator || typeof accelerator !== 'string') {
      return { success: false, error: 'Invalid hotkey' };
    }
    if (!registerFocusHotkey(accelerator)) {
      logger.error('Focus hotkey registration failed', null, { accelerator });
      return { success: false, error: 'Hotkey unavailable or already in use' };
    }
    logger.success('Focus hotkey updated', { accelerator });
    return { success: true };
  });

  ipcMain.handle('get-focus-hotkey', () => focusHotkey);

  // Report our own persisted intent, not a live OS query. The app re-asserts the OS
  // registration from this same config on every launch (see app.whenReady), so it's the
  // reliable source of truth — and it avoids the Windows getLoginItemSettings path/args
  // matching pitfall that made the toggle always read back as "off" after a restart.
  // getAutoStartConfig() still falls back to (and persists) the live OS state on first
  // run, so an existing "enabled" registration is detected rather than assumed off.
  ipcMain.handle('get-autostart', () => getAutoStartConfig());

  ipcMain.handle('get-close-windows-startup', () => getCloseWindowsStartup());

  ipcMain.handle('set-close-windows-startup', (_event, enabled) => {
    try {
      fs.writeFileSync(CLOSE_WINDOWS_STARTUP_PATH, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf8');
      logger.success('Close windows on startup updated', { enabled: !!enabled });
      return true;
    } catch (e) {
      logger.error('set-close-windows-startup failed', e);
      return false;
    }
  });

  ipcMain.on('set-autostart', (_event, enabled) => {
    saveAutoStartConfig(enabled);
    applyAutoStartSetting(enabled);
  });

  ipcMain.handle('get-system-stats', async () => {
    const cpu = await getCpuUsagePercent();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ram = Math.round(((totalMem - freeMem) / totalMem) * 100);
    return { cpu, ram };
  });

  ipcMain.handle('select-icon', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['ico', 'png', 'jpg', 'jpeg', 'webp'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;

    const src = result.filePaths[0];
    const destName = path.basename(src);
    const iconsFolder = path.join(__dirname, 'icons');
    if (!fs.existsSync(iconsFolder)) fs.mkdirSync(iconsFolder, { recursive: true });

    try {
      fs.copyFileSync(src, path.join(iconsFolder, destName));
      logger.success('Icon saved', { file: destName });
      return destName;
    } catch (error) {
      logger.error('Icon copy failed', error, { src });
      return null;
    }
  });

  ipcMain.handle('launch-app', async (_event, fullPath, options = {}) => {
    if (!fullPath || !fs.existsSync(fullPath)) {
      logger.error('Launch failed — file not found', null, { fullPath });
      return { success: false, error: 'File not found' };
    }

    const result = await shell.openPath(fullPath);
    if (result) {
      logger.error('Launch failed', null, { fullPath, result });
      return { success: false, error: result };
    }

    if (options.autoPlay && isSpotifyPath(fullPath)) {
      const delay = Number(options.autoPlayDelay) === 5000 ? 5000 : 2800;
      triggerSpotifyAutoPlay(delay);
    }

    logger.success('App launched', { fullPath, autoPlay: !!options.autoPlay });
    return { success: true };
  });

  // ── FPS OPTIMIZER IPC HANDLERS ──
  ipcMain.handle('fps-optimize-only', async () => {
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    for (let i = 0; i < OPT_STEPS.length; i++) {
      mainWindow.webContents.send('fps-progress', { pct: (i + 1) / OPT_STEPS.length, msg: OPT_STEPS[i].name });
      try { await OPT_STEPS[i].fn(); } catch (e) { }
    }
    mainWindow.webContents.send('fps-progress', { pct: 1, msg: 'Optimize complete!' });
    return { success: true };
  });

  ipcMain.handle('launch-fps-optimizer', async () => {
    const fpsOptimizerPath = path.join(__dirname, 'fps-optimizer-electron', 'fps-optimizer-electron', 'main.js');
    const fpsOptimizerExe = path.join(__dirname, 'fps-optimizer-electron', 'fps-optimizer-electron', 'dist', 'FPS Optimizer.exe');

    if (fs.existsSync(fpsOptimizerExe)) {
      await shell.openPath(fpsOptimizerExe);
    } else {
      await runCmd(`electron "${fpsOptimizerPath}"`);
    }
    logger.success('FPS Optimizer launched');
    return { success: true };
  });

  ipcMain.handle('fps-discord-only', async () => {
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    mainWindow.webContents.send('fps-progress', { pct: 0.3, msg: 'Scanning processes...' });
    const killed = await killProcesses(WHITELIST_DC, mainAppPID !== null ? [mainAppPID.toString()] : []);
    mainWindow.webContents.send('fps-progress', { pct: 1, msg: `Killed ${killed.length} processes` });
    return { success: true, killed };
  });

  ipcMain.handle('fps-nuke', async () => {
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    mainWindow.webContents.send('fps-progress', { pct: 0.3, msg: 'Nuclear purge initiating...' });
    const killed = await killProcesses(SYSTEM_PROCS, mainAppPID !== null ? [mainAppPID.toString()] : []);
    mainWindow.webContents.send('fps-progress', { pct: 1, msg: `Killed ${killed.length} processes` });
    return { success: true, killed };
  });

  ipcMain.handle('fps-battery', async () => {
    if (!mainWindow) return { success: false, error: 'Main window not available' };
    for (let i = 0; i < BATTERY_STEPS.length; i++) {
      mainWindow.webContents.send('fps-progress', { pct: (i + 1) / BATTERY_STEPS.length, msg: BATTERY_STEPS[i].name });
      try { await BATTERY_STEPS[i].fn(); } catch (e) { }
    }
    mainWindow.webContents.send('fps-progress', { pct: 1, msg: 'Battery Saver active!' });
    return { success: true };
  });

  ipcMain.handle('get-log-path', () => logsPath);

  ipcMain.handle('open-log-folder', async () => {
    await shell.openPath(logsPath);
    logger.log('Log folder opened', 'INFO');
    return { success: true };
  });

  // ── MINI WIDGETS: MIC MUTE ──
  // First widget in the "Mini Widgets" framework. Windows has no CLI for toggling the
  // default microphone's mute state, so this generates a .ps1 that uses COM interop
  // against the public Core Audio API (IMMDeviceEnumerator/IMMDevice/IAudioEndpointVolume,
  // documented in mmdeviceapi.h/endpointvolume.h) — the same technique many open-source
  // Windows audio-control tools use. Follows the same ensure/version-gated script pattern
  // as ensureMinimizeWindowsScript/ensureMediaPlayScript above.
  const MIC_MUTE_SCRIPT = path.join(userDataPath, 'mic-mute-toggle.ps1');
  const MIC_MUTE_SCRIPT_VERSION = 1;
  const DEFAULT_MIC_MUTE_HOTKEY = 'Control+Shift+M';
  let micMuted = null; // null = not yet queried from the OS
  let micMuteHotkeyAccel = null;
  let micMuteOverlayWindow = null;
  let micMuteOverlayEnabled = false;

  // A transparent, click-through window sized to the whole primary display so the
  // mic-mute badge (drawn in its top-left corner) stays visible above every other
  // window on the desktop -- not just while the app itself is focused or visible.
  function createMicMuteOverlayWindow() {
    if (micMuteOverlayWindow) return micMuteOverlayWindow;
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
    micMuteOverlayWindow = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'mic-mute-overlay-preload.js')
      }
    });
    micMuteOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
    micMuteOverlayWindow.setIgnoreMouseEvents(true);
    micMuteOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    micMuteOverlayWindow.loadFile(path.join(__dirname, 'mic-mute-overlay.html'));
    micMuteOverlayWindow.webContents.on('did-finish-load', () => {
      if (micMuteOverlayWindow) micMuteOverlayWindow.webContents.send('mic-mute-overlay-state', micMuted === true);
    });
    micMuteOverlayWindow.on('closed', () => { micMuteOverlayWindow = null; });
    return micMuteOverlayWindow;
  }

  // The overlay badge should only be visible on screen while the mic is actually
  // muted -- it stays hidden the rest of the time, even when the widget is enabled.
  function updateMicMuteOverlayState() {
    if (!micMuteOverlayEnabled || !micMuteOverlayWindow) return;
    const isMuted = micMuted === true;
    micMuteOverlayWindow.webContents.send('mic-mute-overlay-state', isMuted);
    if (isMuted) {
      micMuteOverlayWindow.showInactive();
    } else {
      micMuteOverlayWindow.hide();
    }
  }

  async function setMicMuteOverlayEnabled(enabled) {
    micMuteOverlayEnabled = !!enabled;
    if (micMuteOverlayEnabled) {
      if (micMuted === null) await queryMicMuteState();
      createMicMuteOverlayWindow();
      updateMicMuteOverlayState();
    } else if (micMuteOverlayWindow) {
      micMuteOverlayWindow.hide();
    }
    return micMuteOverlayEnabled;
  }

  function ensureMicMuteScript() {
    const versionFile = `${MIC_MUTE_SCRIPT}.version`;
    const current = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
    if (fs.existsSync(MIC_MUTE_SCRIPT) && current === String(MIC_MUTE_SCRIPT_VERSION)) return;

    const script = `Add-Type @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int NotImpl1();
    int NotImpl2();
    int GetChannelCount();
    int SetMasterVolumeLevel();
    int SetMasterVolumeLevelScalar();
    int GetMasterVolumeLevel();
    int GetMasterVolumeLevelScalar();
    int SetChannelVolumeLevel();
    int SetChannelVolumeLevelScalar();
    int GetChannelVolumeLevel();
    int GetChannelVolumeLevelScalar();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool isMuted, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool isMuted);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public static class MicMute {
    static IAudioEndpointVolume GetVolumeControl() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(1, 0, out device);
        Guid iidVol = typeof(IAudioEndpointVolume).GUID;
        object volObj;
        device.Activate(ref iidVol, 0, IntPtr.Zero, out volObj);
        return (IAudioEndpointVolume)volObj;
    }
    public static bool GetMuted() {
        bool muted;
        GetVolumeControl().GetMute(out muted);
        return muted;
    }
    public static bool ToggleMuted() {
        var vol = GetVolumeControl();
        bool muted;
        vol.GetMute(out muted);
        Guid ctx = Guid.Empty;
        vol.SetMute(!muted, ref ctx);
        return !muted;
    }
}
"@

$action = $args[0]
if ($action -eq "toggle") {
    $result = [MicMute]::ToggleMuted()
} else {
    $result = [MicMute]::GetMuted()
}
$result.ToString().ToLower()
`;
    fs.writeFileSync(MIC_MUTE_SCRIPT, script, 'utf8');
    fs.writeFileSync(versionFile, String(MIC_MUTE_SCRIPT_VERSION), 'utf8');
  }

  async function runMicMuteScript(action) {
    ensureMicMuteScript();
    const { ok, stdout, stderr } = await runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${MIC_MUTE_SCRIPT}" ${action}`);
    if (!ok) {
      logger.error('Mic mute script failed', new Error(stderr || 'unknown error'), { action });
      return null;
    }
    return stdout.trim().toLowerCase() === 'true';
  }

  async function queryMicMuteState() {
    const result = await runMicMuteScript('status');
    if (result !== null) micMuted = result;
    return micMuted;
  }

  function buildTrayMenu() {
    return Menu.buildFromTemplate([
      { label: 'Show main', type: 'normal', click: () => { focusMainWindow(); } },
      { label: 'Mute Microphone', type: 'checkbox', checked: micMuted === true, click: () => { toggleMicMute(); } },
      { label: 'Quit', type: 'normal', click: () => { app.quit(); } }
    ]);
  }

  async function toggleMicMute() {
    const result = await runMicMuteScript('toggle');
    if (result === null) return micMuted;
    micMuted = result;
    if (appTray) appTray.setContextMenu(buildTrayMenu());
    updateMicMuteOverlayState();
    logger.log('Mic mute toggled', 'INFO', { muted: micMuted });
    return micMuted;
  }

  function registerMicMuteHotkey(accelerator) {
    if (micMuteHotkeyAccel) globalShortcut.unregister(micMuteHotkeyAccel);
    if (!accelerator) {
      micMuteHotkeyAccel = null;
      return true;
    }
    if (!globalShortcut.register(accelerator, () => { toggleMicMute(); })) {
      if (micMuteHotkeyAccel) globalShortcut.register(micMuteHotkeyAccel, () => { toggleMicMute(); });
      logger.error('Mic mute hotkey registration failed', null, { accelerator });
      return false;
    }
    micMuteHotkeyAccel = accelerator;
    return true;
  }

  ipcMain.handle('mic-mute-toggle', () => toggleMicMute());

  ipcMain.handle('mic-mute-status', async () => {
    if (micMuted === null) await queryMicMuteState();
    return micMuted;
  });

  ipcMain.handle('register-mic-mute-hotkey', (_event, accelerator) => registerMicMuteHotkey(accelerator));

  ipcMain.handle('set-mic-mute-overlay-enabled', (_event, enabled) => setMicMuteOverlayEnabled(enabled));

  // ── SPOTIFY WEB API INTEGRATION ──
  const SPOTIFY_CONFIG_PATH = path.join(userDataPath, 'spotify-config.json');
  const SPOTIFY_TOKENS_PATH = path.join(userDataPath, 'spotify-tokens.json');
  const SPOTIFY_REDIRECT_URI_CUSTOM = 'main-launcher://spotify-callback';

  let spotifyTokens = null;
  let spotifyConfig = { clientId: '' };
  const spotifyAnalysisCache = new Map();
  const spotifyFeaturesCache = new Map();
  let lastRefreshAttemptTime = 0;
  const REFRESH_RETRY_COOLDOWN_MS = 15000; // Reduced from 30s to 15s for better responsiveness

  // The Spotify client ID and OAuth tokens used to be written to disk as plain
  // JSON, readable by anything with filesystem access to this machine. These
  // two helpers route every read/write through Electron's safeStorage, which
  // encrypts with the OS keychain (DPAPI on Windows) so the files are only
  // decryptable by this app on this machine.
  function encryptedWriteJSON(filePath, obj) {
    const json = JSON.stringify(obj, null, 2);
    if (app.isReady() && safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(filePath, safeStorage.encryptString(json));
    } else {
      // OS encryption isn't ready yet (called before the 'ready' event) or isn't
      // supported on this machine (no keychain/libsecret). Fall back to plaintext
      // so the feature keeps working rather than silently losing the save.
      logger.warn('safeStorage unavailable, writing Spotify data as plaintext', { path: filePath });
      fs.writeFileSync(filePath, json, 'utf8');
    }
  }

  function encryptedReadJSON(filePath) {
    const raw = fs.readFileSync(filePath);
    try {
      // Legacy pre-encryption files, and the plaintext fallback above, are plain
      // UTF-8 JSON — try that first so no separate migration path is needed.
      return { data: JSON.parse(raw.toString('utf8')), plaintext: true };
    } catch (e) {
      // Not valid JSON text, so it must be a safeStorage-encrypted buffer.
    }
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Spotify data on disk is encrypted but OS encryption is not ready yet');
    }
    return { data: JSON.parse(safeStorage.decryptString(raw)), plaintext: false };
  }

  function loadSpotifyConfig() {
    try {
      if (fs.existsSync(SPOTIFY_CONFIG_PATH)) {
        const { data, plaintext } = encryptedReadJSON(SPOTIFY_CONFIG_PATH);
        spotifyConfig = data;
        if (plaintext && app.isReady() && safeStorage.isEncryptionAvailable()) {
          logger.log('Migrating Spotify config to encrypted storage', 'INFO');
          saveSpotifyConfig();
        }
      }
    } catch (e) {
      logger.error('Failed to load Spotify config', e);
    }
  }

  function saveSpotifyConfig() {
    try {
      encryptedWriteJSON(SPOTIFY_CONFIG_PATH, spotifyConfig);
    } catch (e) {
      logger.error('Failed to save Spotify config', e);
    }
  }

  function loadSpotifyTokens() {
    try {
      if (fs.existsSync(SPOTIFY_TOKENS_PATH)) {
        const { data, plaintext } = encryptedReadJSON(SPOTIFY_TOKENS_PATH);
        spotifyTokens = data;
        logger.debug?.('Spotify tokens loaded from disk', { hasAccessToken: !!spotifyTokens?.access_token, expiresAt: spotifyTokens?.expires_at, now: Date.now() });
        if (plaintext && app.isReady() && safeStorage.isEncryptionAvailable()) {
          logger.log('Migrating Spotify tokens to encrypted storage', 'INFO');
          saveSpotifyTokens();
        }
        return true;
      } else {
        logger.debug?.('Spotify tokens file does not exist at', { path: SPOTIFY_TOKENS_PATH });
      }
    } catch (e) {
      logger.error('Failed to load Spotify tokens', e);
    }
    return false;
  }

  function saveSpotifyTokens() {
    try {
      if (spotifyTokens) {
        encryptedWriteJSON(SPOTIFY_TOKENS_PATH, spotifyTokens);
      }
    } catch (e) {
      logger.error('Failed to save Spotify tokens', e);
    }
  }

  async function refreshSpotifyToken() {
    if (!spotifyTokens?.refresh_token || !spotifyConfig.clientId) return false;
    lastRefreshAttemptTime = Date.now();
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifyTokens.refresh_token,
        client_id: spotifyConfig.clientId
      });
      const response = await safeFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json();
      if (data.access_token) {
        spotifyTokens.access_token = data.access_token;
        if (data.refresh_token) spotifyTokens.refresh_token = data.refresh_token;
        spotifyTokens.expires_at = Date.now() + (data.expires_in * 1000);
        saveSpotifyTokens();
        return true;
      } else {
        logger.error('Spotify token refresh API error', null, { status: response.status, data });
        if (response.status === 400 || data.error === 'invalid_grant') {
          logger.error('Spotify refresh token is invalid or revoked. Disconnecting Spotify.');
          spotifyTokens = null;
          try {
            if (fs.existsSync(SPOTIFY_TOKENS_PATH)) fs.unlinkSync(SPOTIFY_TOKENS_PATH);
          } catch (e) { }
        }
      }
    } catch (e) {
      logger.error('Spotify token refresh failed', e);
    }
    return false;
  }

  async function ensureSpotifyToken() {
    if (!spotifyTokens) {
      logger.debug?.('spotifyTokens is null, attempting to load from disk');
      if (!loadSpotifyTokens()) {
        logger.warn('Failed to load Spotify tokens from disk');
        return false;
      }
    }
    if (!spotifyTokens?.access_token) {
      logger.warn('Spotify token missing or invalid, attempting refresh', null);
      return await refreshSpotifyToken();
    }
    const expiresAt = spotifyTokens.expires_at;
    const now = Date.now();
    logger.debug?.('Checking Spotify token validity', { hasToken: !!spotifyTokens?.access_token, expiresAt, now, expiresIn: expiresAt - now });
    if (expiresAt === undefined || expiresAt === null || now >= expiresAt - 60000) {
      if (now - lastRefreshAttemptTime < REFRESH_RETRY_COOLDOWN_MS) {
        logger.debug?.('Spotify token refresh on cooldown, skipping', { timeSinceLastAttempt: now - lastRefreshAttemptTime, cooldownMs: REFRESH_RETRY_COOLDOWN_MS });
        return spotifyTokens?.access_token ? true : false;
      }
      logger.debug?.('Spotify token expired or expiring soon, refreshing');
      return await refreshSpotifyToken();
    }
    logger.debug?.('Spotify token is valid');
    return true;
  }

  async function fetchSpotifyProfile() {
    const data = await spotifyApiRequest('/me');
    if (data) {
      spotifyTokens.display_name = data.display_name || data.id;
      spotifyTokens.id = data.id;
      saveSpotifyTokens();
      return spotifyTokens.display_name;
    }
    return null;
  }

  async function spotifyApiRequest(endpoint, method = 'GET', body = null, retryCount = 0) {
    logger.debug?.('Spotify API request', { endpoint, method, retryCount });
    const ok = await ensureSpotifyToken();
    if (!ok) {
      logger.warn('Spotify API request failed - no valid token');
      return null;
    }
    try {
      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${spotifyTokens.access_token}`,
          'Content-Type': 'application/json'
        }
      };
      if (body) options.body = JSON.stringify(body);
      logger.debug?.('About to call safeFetch', { endpoint, method });
      const response = await safeFetch(`https://api.spotify.com/v1${endpoint}`, options);
      logger.debug?.('safeFetch returned', { endpoint, status: response.status });
      
      if (response.status === 401) {
        // Cap retries — if the refreshed token still gets a 401 (e.g. a scope
        // mismatch that refreshing can never fix), retrying unconditionally with
        // the same retryCount would recurse forever and hang the app.
        if (retryCount >= 1) {
          logger.error('Spotify API still returning 401 after token refresh — giving up', null, { endpoint });
          return { _error: true, status: 401 };
        }
        logger.warn('Spotify API returned 401, attempting token refresh', { endpoint });
        if (await refreshSpotifyToken()) {
          return await spotifyApiRequest(endpoint, method, body, retryCount + 1);
        }
        return null;
      }
      if (response.status === 204) {
        logger.debug?.('Spotify API returned 204 No Content', { endpoint });
        return { _noContent: true };
      }
      if (response.status === 404) {
        logger.debug?.('Spotify API returned 404 Not Found', { endpoint });
        return { _noContent: true };
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
        // If rate limited with excessive wait time, fail immediately instead of blocking
        if (retryAfter > 60) {
          logger.warn('Spotify API rate limited with excessive retry-after, failing request', { endpoint, retryAfter });
          return { _error: true, status: 429, retryAfter };
        }
        if (retryCount < 2) {
          logger.warn('Spotify API rate limited, retrying', { endpoint, retryAfter, retryCount });
          await new Promise((resolve) => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
          return await spotifyApiRequest(endpoint, method, body, retryCount + 1);
        }
        logger.warn('Spotify API rate limited, max retries exceeded', { endpoint, retryAfter });
        return { _error: true, status: 429, retryAfter };
      }
      if (!response.ok) {
        logger.error('Spotify API error', null, { status: response.status, endpoint, statusText: `HTTP ${response.status}` });
        return { _error: true, status: response.status };
      }
      logger.debug?.('Spotify API success', { endpoint, status: response.status });
      return await response.json();
    } catch (e) {
      logger.error('Spotify API request failed with exception', e, { endpoint, method });
      return null;
    }
  }

  function handleSpotifyCallback(url) {
    return new Promise((resolve, reject) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'main-launcher:' || parsed.hostname !== 'spotify-callback') {
          resolve(null);
          return;
        }
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        if (error) reject(new Error(error));
        else resolve(code);
      } catch (e) {
        reject(e);
      }
    });
  }

  async function exchangeSpotifyCode(code, codeVerifier) {
    try {
      const response = await safeFetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI_CUSTOM,
          client_id: spotifyConfig.clientId,
          code_verifier: codeVerifier
        }).toString()
      });

      const data = await response.json();
      if (data.access_token) {
        spotifyTokens = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in * 1000)
        };
        saveSpotifyTokens();
        await fetchSpotifyProfile();
        logger.success('Spotify authorized');
        return { success: true };
      } else {
        return { success: false, error: data.error_description || 'Token exchange failed' };
      }
    } catch (e) {
      logger.error('Spotify auth failed', e);
      return { success: false, error: e.message };
    }
  }

  function generateCodeVerifier() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    for (let i = 0; i < 128; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  function generateCodeChallenge(verifier) {
    const hash = crypto.createHash('sha256').update(verifier).digest();
    return hash.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  loadSpotifyConfig();
  loadSpotifyTokens();

  ipcMain.handle('spotify-get-config', () => spotifyConfig);

  ipcMain.handle('spotify-save-config', (_event, config) => {
    spotifyConfig = { ...spotifyConfig, ...config };
    saveSpotifyConfig();
    return true;
  });

  ipcMain.handle('spotify-auth-start', async () => {
    if (!spotifyConfig.clientId) {
      return { success: false, error: 'Client ID not configured. Add it in Settings first.' };
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    const scope = 'user-read-playback-state user-modify-playback-state user-read-private user-read-email';
    const authUrl = `https://accounts.spotify.com/authorize?` +
      `client_id=${encodeURIComponent(spotifyConfig.clientId)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI_CUSTOM)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&state=${encodeURIComponent(crypto.randomBytes(16).toString('hex'))}`

    logger.log('Starting Spotify auth flow', 'INFO', { clientId: spotifyConfig.clientId?.substring(0, 8) + '...', redirectUri: SPOTIFY_REDIRECT_URI_CUSTOM });

    return new Promise((resolve) => {
      let resolved = false;

      const authWindow = new BrowserWindow({
        width: 500,
        height: 700,
        center: true,
        show: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        parent: mainWindow,
        modal: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      authWindow.setMenuBarVisibility(false);

      // Log any errors
      authWindow.webContents.on('crashed', () => {
        logger.error('Spotify auth window crashed', null);
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: 'Auth window crashed' });
        }
      });

      authWindow.webContents.on('unresponsive', () => {
        logger.warn('Spotify auth window unresponsive', null);
      });

      // Intercept the redirect before it happens
      authWindow.webContents.on('will-redirect', (event, url) => {
        logger.log('Auth redirect detected', 'INFO', { url: url.substring(0, 100) });
        if (url.startsWith('main-launcher://')) {
          event.preventDefault();
          if (!resolved) {
            resolved = true;
            authWindow.close();
            handleSpotifyCallback(url).then((code) => {
              if (code) resolve(exchangeSpotifyCode(code, codeVerifier));
              else resolve({ success: false, error: 'Auth callback failed to parse code' });
            }).catch((err) => {
              logger.error('Auth callback error', err);
              resolve({ success: false, error: err.message });
            });
          }
        }
      });

      // Also catch if navigation somehow gets through
      authWindow.webContents.on('will-navigate', (event, url) => {
        logger.log('Auth navigation detected', 'INFO', { url: url.substring(0, 100) });
        if (url.startsWith('main-launcher://')) {
          event.preventDefault();
          if (!resolved) {
            resolved = true;
            authWindow.close();
            handleSpotifyCallback(url).then((code) => {
              if (code) resolve(exchangeSpotifyCode(code, codeVerifier));
              else resolve({ success: false, error: 'Auth callback failed to parse code' });
            }).catch((err) => {
              logger.error('Auth callback error', err);
              resolve({ success: false, error: err.message });
            });
          }
        }
      });

      authWindow.on('closed', () => {
        if (!resolved) {
          resolved = true;
          logger.log('Auth window closed by user', 'INFO');
          resolve({ success: false, error: 'Auth window closed' });
        }
      });

      authWindow.loadURL(authUrl).catch((err) => {
        if (!resolved) {
          resolved = true;
          logger.error('Failed to load Spotify auth URL', err);
          resolve({ success: false, error: `Failed to load auth page: ${err.message}` });
        }
      });
    });
  });

  ipcMain.handle('spotify-auth-status', () => {
    return {
      authenticated: !!spotifyTokens?.access_token,
      clientIdSet: !!spotifyConfig.clientId,
      displayName: spotifyTokens?.display_name || null
    };
  });

  ipcMain.handle('spotify-disconnect', () => {
    spotifyTokens = null;
    try {
      if (fs.existsSync(SPOTIFY_TOKENS_PATH)) fs.unlinkSync(SPOTIFY_TOKENS_PATH);
    } catch (e) { }
    logger.log('Spotify disconnected', 'INFO');
    return true;
  });

  ipcMain.handle('spotify-get-current-track', async () => {
    logger.debug?.('spotify-get-current-track: Checking token');
    const tokenOk = await ensureSpotifyToken();
    if (!tokenOk) {
      logger.warn('Spotify not connected - ensureSpotifyToken returned false');
      return { connected: false };
    }
    logger.debug?.('spotify-get-current-track: Token is valid, fetching player state');

    const data = await spotifyApiRequest('/me/player');
    if (data === null) {
      logger.warn('Spotify API returned null - treating as not connected');
      return { connected: false };
    }
    if (data._error) {
      logger.warn('Spotify API returned error - treating as not connected', { status: data.status });
      return { connected: false };
    }
    if (data._noContent) {
      return {
        connected: true,
        is_playing: false,
        track: null,
        device: null,
        volume_percent: undefined,
        playerError: false
      };
    }

    return {
      connected: true,
      is_playing: !!data.is_playing,
      track: data.item ? {
        id: data.item.id,
        name: data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
        album: data.item.album.name,
        image: data.item.album.images[0]?.url,
        duration_ms: data.item.duration_ms,
        progress_ms: data.progress_ms
      } : null,
      device: data.device?.name,
      volume_percent: data.device?.volume_percent
    };
  });

  ipcMain.handle('spotify-get-audio-analysis', async (_event, trackId) => {
    if (!trackId) return { ok: false, status: 400 };
    if (spotifyAnalysisCache.has(trackId)) {
      return { ok: true, data: spotifyAnalysisCache.get(trackId) };
    }
    const data = await spotifyApiRequest(`/audio-analysis/${trackId}`);
    if (data?._error) return { ok: false, status: data.status || 403 };
    if (data && !data._noContent) {
      spotifyAnalysisCache.set(trackId, data);
      return { ok: true, data };
    }
    return { ok: false, status: 404 };
  });

  ipcMain.handle('spotify-get-audio-features', async (_event, trackId) => {
    if (!trackId) return { ok: false, status: 400 };
    if (spotifyFeaturesCache.has(trackId)) {
      return { ok: true, data: spotifyFeaturesCache.get(trackId) };
    }
    const data = await spotifyApiRequest(`/audio-features/${trackId}`);
    if (data?._error) return { ok: false, status: data.status || 403 };
    if (data && !data._noContent) {
      spotifyFeaturesCache.set(trackId, data);
      return { ok: true, data };
    }
    return { ok: false, status: 404 };
  });

  // ── Spotify Extras: Sleep Timer ──
  let sleepTimerHandle = null;
  let sleepTimerEndsAt = null;

  function clearSleepTimerState() {
    if (sleepTimerHandle) clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
    sleepTimerEndsAt = null;
  }

  async function startSleepTimer(minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { active: false, endsAt: null };
    clearSleepTimerState();
    sleepTimerEndsAt = Date.now() + mins * 60000;
    sleepTimerHandle = setTimeout(async () => {
      try {
        await spotifyApiRequest('/me/player/pause', 'PUT');
        logger.log('Sleep timer elapsed — paused Spotify playback', 'INFO');
      } catch (e) {
        logger.error('Sleep timer pause failed', e);
      }
      sleepTimerHandle = null;
      sleepTimerEndsAt = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('spotify-sleep-timer-ended');
      }
    }, mins * 60000);
    logger.log('Sleep timer started', 'INFO', { minutes: mins });
    return { active: true, endsAt: sleepTimerEndsAt };
  }

  function cancelSleepTimer() {
    const wasActive = !!sleepTimerHandle;
    clearSleepTimerState();
    if (wasActive) logger.log('Sleep timer cancelled', 'INFO');
    return { active: false, endsAt: null };
  }

  function getSleepTimerStatus() {
    return { active: !!sleepTimerHandle, endsAt: sleepTimerEndsAt };
  }

  ipcMain.handle('spotify-sleep-timer-start', (_event, minutes) => startSleepTimer(minutes));
  ipcMain.handle('spotify-sleep-timer-cancel', () => cancelSleepTimer());
  ipcMain.handle('spotify-sleep-timer-status', () => getSleepTimerStatus());

  ipcMain.handle('spotify-control', async (_event, action) => {
    let endpoint;
    let method = 'PUT';
    switch (action) {
      case 'play': endpoint = '/me/player/play'; break;
      case 'pause': endpoint = '/me/player/pause'; break;
      case 'next': endpoint = '/me/player/next'; method = 'POST'; break;
      case 'previous': endpoint = '/me/player/previous'; method = 'POST'; break;
      default: return { success: false, error: 'Unknown action' };
    }
    const result = await spotifyApiRequest(endpoint, method);
    return { success: !!result };
  });

  ipcMain.handle('spotify-set-volume', async (_event, volume) => {
    const result = await spotifyApiRequest(`/me/player/volume?volume_percent=${volume}`, 'PUT');
    return { success: !!result };
  });

  ipcMain.handle('spotify-seek', async (_event, positionMs) => {
    const result = await spotifyApiRequest(`/me/player/seek?position_ms=${positionMs}`, 'PUT');
    return { success: !!result };
  });

  // ── LYRICS SERVICE (lrclib.net — free, no API key, returns real LRC-format timestamps) ──
  const lyricsCache = new Map();
  const LRCLIB_BASE = 'https://lrclib.net/api';
  const LRCLIB_USER_AGENT = `Launcher/${APP_VERSION} (https://github.com/ryota/launcher)`;

  // Parses an LRC string ("[mm:ss.xx] line text\n...") into
  // [{ time: <ms>, text: <string> }, ...] sorted by time.
  function parseSyncedLyrics(lrc) {
    if (!lrc) return [];
    const lineRe = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)/;
    const lines = [];
    for (const rawLine of lrc.split('\n')) {
      const match = rawLine.match(lineRe);
      if (!match) continue;
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const text = match[3].trim();
      if (!text) continue; // skip blank/instrumental-gap markers
      lines.push({ time: Math.round((minutes * 60 + seconds) * 1000), text });
    }
    return lines.sort((a, b) => a.time - b.time);
  }

  // Plain (untimed) lyrics fallback — used only when lrclib has no synced version.
  function parsePlainLyrics(plain) {
    if (!plain) return [];
    return plain.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && line.length < 200)
      .map(text => ({ time: null, text }));
  }

  async function lrclibRequest(pathName, params) {
    try {
      const query = new URLSearchParams(params).toString();
      const response = await safeFetch(`${LRCLIB_BASE}${pathName}?${query}`, {
        headers: { 'User-Agent': LRCLIB_USER_AGENT }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      logger.debug?.('LRCLIB request failed', e.message, { pathName });
      return null;
    }
  }

  async function fetchLrclibLyrics(trackName, artistName, albumName, durationMs) {
    const durationSec = durationMs ? Math.round(durationMs / 1000) : undefined;

    // 1. Exact match — most reliable, lrclib matches duration within ±2s.
    if (durationSec) {
      const exact = await lrclibRequest('/get', {
        track_name: trackName,
        artist_name: artistName,
        ...(albumName ? { album_name: albumName } : {}),
        duration: durationSec
      });
      if (exact && (exact.syncedLyrics || exact.plainLyrics)) return exact;
    }

    // 2. Fuzzy search fallback. Only accept a result whose duration actually matches
    // the real track — otherwise it's very likely a cover, remix, or different song
    // with a similar title, which would show completely wrong ("random") lyrics
    // instead of correctly reporting that no lyrics were found.
    const results = await lrclibRequest('/search', {
      track_name: trackName,
      artist_name: artistName
    });
    if (Array.isArray(results) && results.length > 0) {
      if (durationSec) {
        const closeMatches = results.filter(r => Math.abs((r.duration || 0) - durationSec) <= 3);
        if (closeMatches.length === 0) return null; // no real match — report "not found", don't guess
        return closeMatches.find(r => r.syncedLyrics) || closeMatches[0];
      }
      // No track duration to verify against (rare) — best effort, take the top hit.
      return results.find(r => r.syncedLyrics) || results[0];
    }
    return null;
  }

  async function getLyricsWithTimestamps(trackName, artistName, albumName, durationMs) {
    if (!trackName || !artistName) return { success: false, reason: 'missing_track_info' };

    const cacheKey = `${trackName}|${artistName}|${durationMs || ''}`;
    if (lyricsCache.has(cacheKey)) {
      return lyricsCache.get(cacheKey);
    }

    try {
      logger.debug?.('Fetching lyrics from lrclib.net for', { trackName, artistName });
      const data = await fetchLrclibLyrics(trackName, artistName, albumName, durationMs);

      if (!data) {
        const result = { success: false, reason: 'lyrics_not_found' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      if (data.instrumental) {
        const result = { success: false, reason: 'instrumental' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      const synced = parseSyncedLyrics(data.syncedLyrics);
      const lines = synced.length > 0 ? synced : parsePlainLyrics(data.plainLyrics);

      if (lines.length === 0) {
        const result = { success: false, reason: 'no_valid_lines' };
        lyricsCache.set(cacheKey, result);
        return result;
      }

      const result = {
        success: true,
        synced: synced.length > 0, // true => lines carry real per-line timestamps
        lyrics: lines,
        track: {
          name: data.trackName || trackName,
          artist: data.artistName || artistName,
          album: data.albumName || albumName || '',
          cover_url: null
        }
      };

      lyricsCache.set(cacheKey, result);
      return result;
    } catch (e) {
      logger.error('getLyricsWithTimestamps failed', e);
      return { success: false, reason: 'error', error: e.message };
    }
  }

  ipcMain.handle('get-lyrics', async (_event, trackName, artistName, albumName, durationMs) => {
    return await getLyricsWithTimestamps(trackName, artistName, albumName, durationMs);
  });

  ipcMain.handle('disable-all-hotkeys', () => {
    globalShortcut.unregisterAll();
    logger.log('All hotkeys disabled');
    return { success: true };
  });

  ipcMain.handle('enable-all-hotkeys', () => {
    registerFocusHotkey(focusHotkey);
    registerSpotifyShortcutsFromConfig(registeredSpotifyShortcuts);
    if (micMuteHotkeyAccel) registerMicMuteHotkey(micMuteHotkeyAccel);
    logger.log('All hotkeys re-enabled');
    return { success: true };
  });

  const handleShortcutRegistration = (_event, hotkeys) => {
    registerSpotifyShortcutsFromConfig(hotkeys);
  };

  ipcMain.on('spotify-register-shortcuts', handleShortcutRegistration);

  async function resolveCityFromCoordinates(lat, lon, fallback = 'Unknown') {
    const GEO_TIMEOUT_MS = 4000;

    // Primary: BigDataCloud — reliably maps suburbs/neighbourhoods to their parent city worldwide
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
      const bdcResponse = await safeFetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (bdcResponse.ok) {
        const bdcData = await bdcResponse.json();
        if (bdcData.city) return bdcData.city;
        const admin = bdcData.localityInfo?.administrative || [];
        const cityLevel = admin.find((entry) => entry.adminLevel >= 5 && entry.adminLevel <= 8 && entry.name);
        if (cityLevel?.name) return cityLevel.name;
      }
    } catch (e) {
      // fall through to Nominatim
    }

    // Fallback: Nominatim at city-level zoom with broad international address field coverage
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
      const geoResponse = await safeFetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`,
        {
          headers: { 'User-Agent': `main-launcher/${APP_VERSION}` },
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);
      if (geoResponse.ok) {
        const geoData = await geoResponse.json();
        const addr = geoData.address;
        if (addr) {
          const city =
            addr.city ||
            addr.city_district ||
            addr.town ||
            addr.municipality ||
            addr.county ||
            addr.state_district ||
            addr.village;
          if (city) return city;
        }
      }
    } catch (e) {
      // keep fallback
    }

    return fallback;
  }

  ipcMain.handle('get-weather', async () => {
    try {
      const response = await safeFetch('https://wttr.in?format=j1');
      const data = await response.json();
      const current = data.current_condition[0];

      const astronomy = data?.weather?.[0]?.astronomy?.[0] || {};
      const sunrise = astronomy.sunrise || null;
      const sunset = astronomy.sunset || null;

      function parseHMToMinutes(str) {
        if (!str) return null;
        const m = String(str).trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!m) return null;
        let h = Number(m[1]);
        const min = Number(m[2]);
        const ampm = m[3].toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + min;
      }

      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const sunsetMinutes = parseHMToMinutes(sunset);
      const sunriseMinutes = parseHMToMinutes(sunrise);

      // Consider "turning dark" to be within 30 minutes before/after sunset
      const isTurningDark = (typeof sunsetMinutes === 'number') && (nowMinutes >= (sunsetMinutes - 30));

      const nearestArea = data?.nearest_area?.[0];
      const suburbFallback = nearestArea?.areaName?.[0]?.value || 'Unknown';

      const lat = nearestArea?.latitude;
      const lon = nearestArea?.longitude;
      let city = suburbFallback;
      if (lat && lon) {
        city = await resolveCityFromCoordinates(lat, lon, suburbFallback);
      }

      return {
        temp_C: current.temp_C,
        temp_F: current.temp_F,
        condition: current.weatherDesc[0].value,
        humidity: current.humidity,
        wind: current.windspeedKmph,
        icon: current.weatherCode,
        sunrise,
        sunset,
        isTurningDark,
        city
      };
    } catch (e) {
      logger.error('Weather fetch failed', e);
      return null;
    }
  });

  ipcMain.handle('register-spotify-shortcuts', async (event, hotkeys) => {
    handleShortcutRegistration(event, hotkeys);
    return { success: true };
  });

  ipcMain.handle('open-external', async (_event, url) => {
    await shell.openExternal(url);
    return true;
  });

}