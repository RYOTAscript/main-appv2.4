const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const { lockNavigation } = require('./windowGuard');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');
const { isMac } = require('./platform');
const { runAppleScript, scripts } = require('./osascript');
const { inputMuteDecision } = require('./audioMac');

const MIC_MUTE_SCRIPT_VERSION = 1;
const DEFAULT_MIC_MUTE_HOTKEY = 'Control+Shift+M';

// First widget in the "Mini Widgets" framework. Windows has no CLI for toggling the
// default microphone's mute state, so this generates a .ps1 that uses COM interop
// against the public Core Audio API (IMMDeviceEnumerator/IMMDevice/IAudioEndpointVolume,
// documented in mmdeviceapi.h/endpointvolume.h) — the same technique many open-source
// Windows audio-control tools use.
const MIC_MUTE_SCRIPT_CONTENT = `Add-Type @"
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

function init(ctx) {
  const { logger, userDataPath, appRoot } = ctx;

  const MIC_MUTE_SCRIPT = path.join(userDataPath, 'mic-mute-toggle.ps1');

  let micMuted = null; // null = not yet queried from the OS
  let micMuteHotkeyAccel = null;
  let micMuteOverlayWindow = null;
  let micMuteOverlayEnabled = false;
  // macOS has no "input muted" flag — we mute by driving the input gain to 0, so
  // remember the level to restore when unmuting.
  let macSavedInputVolume = 50;

  function ensureMicMuteScript() {
    ensureVersionedScript(MIC_MUTE_SCRIPT, MIC_MUTE_SCRIPT_VERSION, MIC_MUTE_SCRIPT_CONTENT);
  }

  // macOS mic mute via osascript: read the input volume, then toggle it to 0 /
  // restore. Returns the resulting muted state, or null on failure. Matches
  // runMicMuteScript's contract.
  async function macRunMicMute(action) {
    const read = await runAppleScript(scripts.getInputVolume);
    const cur = read.ok ? parseInt(read.stdout, 10) : NaN;
    const decision = inputMuteDecision(action, Number.isFinite(cur) ? cur : null, macSavedInputVolume);
    if (decision.muted === null) {
      logger.error('Mic mute (macOS) could not read input volume', new Error(read.stderr || 'no volume'), { action });
      return null;
    }
    if (decision.setVolume !== null) {
      const set = await runAppleScript(scripts.setInputVolume(decision.setVolume));
      if (!set.ok) {
        logger.error('Mic mute (macOS) could not set input volume', new Error(set.stderr || 'set failed'), { action });
        return null;
      }
      if (typeof decision.remember === 'number') macSavedInputVolume = decision.remember;
    }
    return decision.muted;
  }

  async function runMicMuteScript(action) {
    if (isMac) return macRunMicMute(action);
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
        preload: path.join(appRoot, 'mic-mute-overlay-preload.js')
      }
    });
    lockNavigation(micMuteOverlayWindow, logger);
    micMuteOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
    micMuteOverlayWindow.setIgnoreMouseEvents(true);
    micMuteOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    micMuteOverlayWindow.loadFile(path.join(appRoot, 'mic-mute-overlay.html')).catch((e) => {
      logger.error('Failed to load mic-mute overlay HTML', e);
    });
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

  async function toggleMicMute() {
    const result = await runMicMuteScript('toggle');
    if (result === null) return micMuted;
    micMuted = result;
    ctx.refreshTrayMenu();
    updateMicMuteOverlayState();
    logger.log('Mic mute toggled', 'INFO', { muted: micMuted });
    return micMuted;
  }

  function registerMicMuteHotkey(accelerator) {
    if (micMuteHotkeyAccel) globalShortcut.unregister(micMuteHotkeyAccel);
    // '-' is the renderer's "unbound" sentinel — treat it as clearing the
    // hotkey, not as a request to bind the bare minus key system-wide.
    if (!accelerator || accelerator === '-') {
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

  registerMicMuteHotkey(DEFAULT_MIC_MUTE_HOTKEY);

  // Query the real mic-mute state so the tray checkbox and on-window badge don't
  // default to a wrong assumption on startup.
  queryMicMuteState().then((muted) => {
    ctx.refreshTrayMenu();
    logger.log('Mic mute state queried on startup', 'INFO', { muted });
  }).catch((e) => logger.error('Failed to query mic mute state on startup', e));

  return {
    isMuted: () => micMuted === true,
    toggle: toggleMicMute,
    reapplyHotkey: () => { if (micMuteHotkeyAccel) registerMicMuteHotkey(micMuteHotkeyAccel); },
    // Leaving the mic muted or the overlay running after the app exits would strand
    // the user with a muted mic and no way to see/toggle it — so unmute and tear the
    // overlay down before the app is actually allowed to quit.
    unmuteAndTeardown: async () => {
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
    }
  };
}

module.exports = { init };
