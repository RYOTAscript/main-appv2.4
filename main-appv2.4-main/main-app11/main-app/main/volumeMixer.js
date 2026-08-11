const { app, ipcMain, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');

// ── Volume Mixer widget (backend) ──
// A per-application volume mixer, like the Windows tray mixer, plus master
// volume — driven through the Windows Core Audio API. Same persistent-helper
// pattern as main/controllerMacros.js: a generated .ps1 compiles a small C#
// class that speaks the Core Audio COM interfaces and runs as a background
// process over stdin/stdout:
//   LIST                 emit "LIST {json}" — master + every app audio session
//   SET <pid> <0-100>    set an app session's volume
//   MUTE <pid> <0|1>     mute / unmute an app session
//   MASTER <0-100>       set the default playback device volume
//   MASTERMUTE <0|1>     mute / unmute the default device
//   PING / EXIT          lifecycle
// Master volume up/down/mute can also be bound to global hotkeys. Disabled by
// default (no helper process runs until the widget is switched on).

const ENGINE_SCRIPT_VERSION = 2;

// The C# below defines just enough of the Core Audio COM surface to enumerate
// sessions and read/write scalar volume + mute on both sessions and the default
// endpoint. Vtable order in every interface is exact — Core Audio is
// unforgiving about it — so the placeholder methods (ones we never call) are
// still declared to keep later methods at the right slot.
const ENGINE_SCRIPT_CONTENT = `try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// [PreserveSig] on EVERY method so the raw HRESULT comes back as the int return
// and out-params marshal exactly as declared — without it, .NET's default
// HRESULT translation makes a no-argument method like IsSystemSoundsSession()
// silently return 0 (mislabelling real apps as system sounds).
namespace VolMix {
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice(string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out int state);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr ctl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr vol);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
    [PreserveSig] int RegisterSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterSessionNotification(IntPtr n);
    [PreserveSig] int RegisterDuckNotification(string s, IntPtr n);
    [PreserveSig] int UnregisterDuckNotification(IntPtr n);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(string name, IntPtr ctx);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(string path, IntPtr ctx);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid g, IntPtr ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid ctx);
    [PreserveSig] int GetMute(out bool mute);
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr n);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr n);
    [PreserveSig] int GetChannelCount(out int count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint ch, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
    [PreserveSig] int SetMute(bool mute, ref Guid ctx);
    [PreserveSig] int GetMute(out bool mute);
    [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
    [PreserveSig] int VolumeStepUp(ref Guid ctx);
    [PreserveSig] int VolumeStepDown(ref Guid ctx);
    [PreserveSig] int QueryHardwareSupport(out uint mask);
    [PreserveSig] int GetVolumeRange(out float min, out float max, out float inc);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

  public static class Mixer {
    static Guid IID_ASM2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static Guid IID_AEV  = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static Guid EMPTY = Guid.Empty;

    static IMMDevice DefaultDevice() {
      var enumr = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice dev;
      // dataFlow 0 = eRender, role 0 = eConsole
      if (enumr.GetDefaultAudioEndpoint(0, 0, out dev) != 0 || dev == null) return null;
      return dev;
    }

    static IAudioEndpointVolume Endpoint() {
      var dev = DefaultDevice();
      if (dev == null) return null;
      object o; if (dev.Activate(ref IID_AEV, 1, IntPtr.Zero, out o) != 0) return null;
      return (IAudioEndpointVolume)o;
    }

    static IAudioSessionEnumerator Sessions() {
      var dev = DefaultDevice();
      if (dev == null) return null;
      object o; if (dev.Activate(ref IID_ASM2, 1, IntPtr.Zero, out o) != 0) return null;
      var mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator e; if (mgr.GetSessionEnumerator(out e) != 0) return null;
      return e;
    }

    static string ProcName(uint pid) {
      if (pid == 0) return "System Sounds";
      try { var p = Process.GetProcessById((int)pid); return p.ProcessName; }
      catch { return "PID " + pid; }
    }

    static string Esc(string s) {
      if (s == null) return "";
      var sb = new StringBuilder();
      foreach (char c in s) {
        if (c == '"' || c == '\\\\') { sb.Append('\\\\'); sb.Append(c); }
        else if (c < 32) sb.Append(' ');
        else sb.Append(c);
      }
      return sb.ToString();
    }

    public static string List() {
      var sb = new StringBuilder();
      sb.Append("{");
      // Master
      float mv = 0; bool mm = false;
      try { var ep = Endpoint(); if (ep != null) { ep.GetMasterVolumeLevelScalar(out mv); ep.GetMute(out mm); } } catch {}
      sb.Append("\\"master\\":{\\"volume\\":" + (int)Math.Round(mv * 100) + ",\\"muted\\":" + (mm ? "true" : "false") + "},");
      sb.Append("\\"sessions\\":[");
      bool first = true;
      // Merge sessions by pid so one app with several sessions shows once.
      var seen = new Dictionary<uint, bool>();
      try {
        var e = Sessions();
        if (e != null) {
          int count; e.GetCount(out count);
          for (int i = 0; i < count; i++) {
            IAudioSessionControl2 ctl;
            if (e.GetSession(i, out ctl) != 0 || ctl == null) continue;
            uint pid = 0; ctl.GetProcessId(out pid);
            bool isSystem = ctl.IsSystemSoundsSession() == 0 || pid == 0;
            if (seen.ContainsKey(pid)) continue;
            seen[pid] = true;
            float v = 0; bool mu = false;
            try { var sav = (ISimpleAudioVolume)ctl; sav.GetMasterVolume(out v); sav.GetMute(out mu); } catch {}
            string name = isSystem ? "System Sounds" : ProcName(pid);
            if (!first) sb.Append(",");
            first = false;
            sb.Append("{\\"pid\\":" + pid + ",\\"name\\":\\"" + Esc(name) + "\\",\\"volume\\":" + (int)Math.Round(v * 100) + ",\\"muted\\":" + (mu ? "true" : "false") + ",\\"system\\":" + (isSystem ? "true" : "false") + "}");
          }
        }
      } catch {}
      sb.Append("]}");
      return sb.ToString();
    }

    public static void SetSession(uint pid, int vol) {
      try {
        var e = Sessions(); if (e == null) return;
        int count; e.GetCount(out count);
        float target = Math.Max(0, Math.Min(100, vol)) / 100f;
        for (int i = 0; i < count; i++) {
          IAudioSessionControl2 ctl;
          if (e.GetSession(i, out ctl) != 0 || ctl == null) continue;
          uint p = 0; ctl.GetProcessId(out p);
          if (p != pid) continue;
          try { var sav = (ISimpleAudioVolume)ctl; sav.SetMasterVolume(target, ref EMPTY); } catch {}
        }
      } catch {}
    }

    public static void MuteSession(uint pid, bool mute) {
      try {
        var e = Sessions(); if (e == null) return;
        int count; e.GetCount(out count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl2 ctl;
          if (e.GetSession(i, out ctl) != 0 || ctl == null) continue;
          uint p = 0; ctl.GetProcessId(out p);
          if (p != pid) continue;
          try { var sav = (ISimpleAudioVolume)ctl; sav.SetMute(mute, ref EMPTY); } catch {}
        }
      } catch {}
    }

    public static void SetMaster(int vol) {
      try { var ep = Endpoint(); if (ep != null) ep.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, vol)) / 100f, ref EMPTY); } catch {}
    }
    public static void MuteMaster(bool mute) {
      try { var ep = Endpoint(); if (ep != null) ep.SetMute(mute, ref EMPTY); } catch {}
    }
    public static int GetMaster() {
      try { var ep = Endpoint(); if (ep != null) { float v; ep.GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); } } catch {}
      return -1;
    }
    public static bool GetMasterMute() {
      try { var ep = Endpoint(); if (ep != null) { bool m; ep.GetMute(out m); return m; } } catch {}
      return false;
    }
  }
}
'@ -ReferencedAssemblies @('System.dll')
} catch {
  $msg = $_.Exception.Message -replace "[\\r\\n]+", ' '
  [Console]::Out.WriteLine('ENGINE-COMPILE-FAILED ' + $msg)
  exit 1
}

[Console]::Out.WriteLine('READY')
$line = $null
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  if ($line -eq 'EXIT') { break }
  if ($line -eq 'PING') { [Console]::Out.WriteLine('PONG'); continue }
  try {
    if ($line -eq 'LIST') {
      [Console]::Out.WriteLine('LIST ' + [VolMix.Mixer]::List())
    } elseif ($line.StartsWith('SET ')) {
      $p = $line.Substring(4).Split(' '); [VolMix.Mixer]::SetSession([uint32]$p[0], [int]$p[1]); [Console]::Out.WriteLine('OK')
    } elseif ($line.StartsWith('MUTE ')) {
      $p = $line.Substring(5).Split(' '); [VolMix.Mixer]::MuteSession([uint32]$p[0], ($p[1] -eq '1')); [Console]::Out.WriteLine('OK')
    } elseif ($line.StartsWith('MASTER ')) {
      [VolMix.Mixer]::SetMaster([int]$line.Substring(7).Trim()); [Console]::Out.WriteLine('OK')
    } elseif ($line.StartsWith('MASTERMUTE ')) {
      [VolMix.Mixer]::MuteMaster(($line.Substring(11).Trim() -eq '1')); [Console]::Out.WriteLine('OK')
    } else {
      [Console]::Out.WriteLine('ERR unknown')
    }
  } catch {
    $m = $_.Exception.Message -replace "[\\r\\n]+", ' '
    [Console]::Out.WriteLine('ERR ' + $m)
  }
}
`;

const DEFAULT_HOTKEYS = { volUp: '', volDown: '', volMute: '' };
const VOLUME_STEP = 4; // percent per hotkey press

function init(ctx) {
  const { logger, userDataPath, getMainWindow } = ctx;
  const CONFIG_PATH = path.join(userDataPath, 'volume-mixer-config.json');
  const ENGINE_SCRIPT = path.join(userDataPath, 'volume-mixer-engine.ps1');

  let config = loadConfig();
  let engineProc = null;
  let engineReady = false;
  let engineBuffer = '';
  let engineReadyWaiters = [];
  let listWaiters = [];              // resolvers awaiting the next LIST reply
  let lastMasterVolume = 50;         // cached for relative hotkey nudges
  let registeredHotkeys = [];        // accelerators we currently hold

  function loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
          enabled: raw.enabled === true,
          hotkeys: {
            volUp: typeof raw?.hotkeys?.volUp === 'string' ? raw.hotkeys.volUp : '',
            volDown: typeof raw?.hotkeys?.volDown === 'string' ? raw.hotkeys.volDown : '',
            volMute: typeof raw?.hotkeys?.volMute === 'string' ? raw.hotkeys.volMute : ''
          }
        };
      }
    } catch (e) {
      logger.error('Failed to read volume mixer config', e);
    }
    return { enabled: false, hotkeys: { ...DEFAULT_HOTKEYS } };
  }

  function saveConfig() {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to save volume mixer config', e);
    }
  }

  // ── Engine process ──
  function ensureEngine() {
    return new Promise((resolve, reject) => {
      if (engineProc && engineReady) { resolve(); return; }
      engineReadyWaiters.push({ resolve, reject });
      if (engineProc) return;
      ensureVersionedScript(ENGINE_SCRIPT, ENGINE_SCRIPT_VERSION, ENGINE_SCRIPT_CONTENT);
      try {
        engineProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ENGINE_SCRIPT], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (e) {
        engineProc = null;
        flushReadyWaiters(e);
        return;
      }
      const startTimeout = setTimeout(() => {
        if (!engineReady) {
          logger.error('Volume mixer engine did not become ready in time');
          killEngine();
          flushReadyWaiters(new Error('Volume mixer engine failed to start'));
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
            logger.success('Volume mixer engine started');
            flushReadyWaiters(null);
          } else {
            handleEngineLine(line);
          }
        }
      });
      engineProc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) logger.warn('Volume mixer engine stderr', new Error(msg));
      });
      engineProc.on('exit', (code) => {
        engineProc = null;
        engineReady = false;
        engineBuffer = '';
        clearTimeout(startTimeout);
        flushReadyWaiters(new Error('Volume mixer engine exited'));
        // Fail any pending LIST calls so the renderer doesn't hang.
        const waiters = listWaiters; listWaiters = [];
        for (const w of waiters) w(null);
        if (code !== 0) logger.warn('Volume mixer engine exited', new Error('code ' + code));
      });
    });
  }

  function flushReadyWaiters(err) {
    const waiters = engineReadyWaiters;
    engineReadyWaiters = [];
    for (const w of waiters) err ? w.reject(err) : w.resolve();
  }

  function engineSend(line) {
    if (engineProc && engineProc.stdin.writable) engineProc.stdin.write(line + '\n');
  }

  function killEngine() {
    if (!engineProc) return;
    try {
      engineSend('EXIT');
      const proc = engineProc;
      setTimeout(() => { try { proc.kill(); } catch (e) { /* gone */ } }, 1000);
    } catch (e) { /* ignore */ }
    engineProc = null;
    engineReady = false;
  }

  function handleEngineLine(line) {
    if (line.startsWith('LIST ')) {
      let data = null;
      try { data = JSON.parse(line.slice(5)); } catch (e) { data = null; }
      if (data && data.master && typeof data.master.volume === 'number' && data.master.volume >= 0) {
        lastMasterVolume = data.master.volume;
      }
      const waiters = listWaiters; listWaiters = [];
      for (const w of waiters) w(data);
    } else if (line.startsWith('ENGINE-COMPILE-FAILED')) {
      logger.error('Volume mixer engine failed to compile', new Error(line));
    } else if (line.startsWith('ERR')) {
      logger.warn('Volume mixer engine error', new Error(line));
    }
    // OK / PONG are acks.
  }

  // Requests a fresh session list; resolves null if the engine is unavailable.
  async function requestList() {
    try {
      await ensureEngine();
    } catch (e) {
      return null;
    }
    return new Promise((resolve) => {
      listWaiters.push(resolve);
      engineSend('LIST');
      // Don't let a wedged engine hang the renderer forever.
      setTimeout(() => {
        const idx = listWaiters.indexOf(resolve);
        if (idx >= 0) { listWaiters.splice(idx, 1); resolve(null); }
      }, 4000);
    });
  }

  // ── Hotkeys (master volume) ──
  function unregisterHotkeys() {
    for (const acc of registeredHotkeys) {
      try { globalShortcut.unregister(acc); } catch (e) { /* ignore */ }
    }
    registeredHotkeys = [];
  }

  function registerHotkeys() {
    unregisterHotkeys();
    if (!config.enabled) return;
    const map = [
      [config.hotkeys.volUp, () => nudgeMaster(VOLUME_STEP)],
      [config.hotkeys.volDown, () => nudgeMaster(-VOLUME_STEP)],
      [config.hotkeys.volMute, () => toggleMasterMute()]
    ];
    for (const [acc, fn] of map) {
      if (!acc) continue;
      try {
        if (globalShortcut.register(acc, fn)) registeredHotkeys.push(acc);
        else logger.warn('Volume mixer hotkey unavailable', { accelerator: acc });
      } catch (e) {
        logger.warn('Volume mixer hotkey registration failed', e);
      }
    }
  }

  async function nudgeMaster(delta) {
    try { await ensureEngine(); } catch (e) { return; }
    const next = Math.max(0, Math.min(100, lastMasterVolume + delta));
    lastMasterVolume = next;
    engineSend('MASTER ' + Math.round(next));
    engineSend('MASTERMUTE 0'); // any nudge implies audible
    notifyRenderer();
  }

  async function toggleMasterMute() {
    const data = await requestList();
    if (!data || !data.master) return;
    engineSend('MASTERMUTE ' + (data.master.muted ? '0' : '1'));
    notifyRenderer();
  }

  // Tells the renderer something changed so an open panel refreshes.
  function notifyRenderer() {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('volume-mixer-changed');
  }

  // ── IPC ──
  ipcMain.handle('volume-mixer-set-enabled', async (_event, enabled) => {
    config.enabled = !!enabled;
    saveConfig();
    if (config.enabled) {
      try { await ensureEngine(); } catch (e) { logger.warn('Volume mixer warm-up failed', e); }
    } else {
      killEngine();
    }
    registerHotkeys();
    logger.success('Volume Mixer widget toggled', { enabled: config.enabled });
    return { ok: true, enabled: config.enabled };
  });

  ipcMain.handle('volume-mixer-list', async () => {
    if (!config.enabled) return { ok: false, enabled: false };
    const data = await requestList();
    if (!data) return { ok: false, enabled: true, error: 'engine' };
    return { ok: true, enabled: true, master: data.master, sessions: data.sessions || [] };
  });

  ipcMain.handle('volume-mixer-set-app', async (_event, pid, volume) => {
    if (!config.enabled) return { ok: false };
    const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    try { await ensureEngine(); } catch (e) { return { ok: false }; }
    engineSend(`SET ${Math.round(Number(pid) || 0)} ${v}`);
    return { ok: true };
  });

  ipcMain.handle('volume-mixer-mute-app', async (_event, pid, muted) => {
    if (!config.enabled) return { ok: false };
    try { await ensureEngine(); } catch (e) { return { ok: false }; }
    engineSend(`MUTE ${Math.round(Number(pid) || 0)} ${muted ? 1 : 0}`);
    return { ok: true };
  });

  ipcMain.handle('volume-mixer-set-master', async (_event, volume) => {
    if (!config.enabled) return { ok: false };
    const v = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    lastMasterVolume = v;
    try { await ensureEngine(); } catch (e) { return { ok: false }; }
    engineSend('MASTER ' + v);
    return { ok: true };
  });

  ipcMain.handle('volume-mixer-mute-master', async (_event, muted) => {
    if (!config.enabled) return { ok: false };
    try { await ensureEngine(); } catch (e) { return { ok: false }; }
    engineSend('MASTERMUTE ' + (muted ? 1 : 0));
    return { ok: true };
  });

  ipcMain.handle('volume-mixer-get-hotkeys', () => ({ ...config.hotkeys }));

  ipcMain.handle('volume-mixer-set-hotkey', (_event, which, accelerator) => {
    if (!['volUp', 'volDown', 'volMute'].includes(which)) return { ok: false };
    const acc = typeof accelerator === 'string' ? accelerator : '';
    // Reject a binding another of our three hotkeys already owns.
    for (const key of ['volUp', 'volDown', 'volMute']) {
      if (key !== which && acc && config.hotkeys[key] === acc) return { ok: false, error: 'conflict' };
    }
    config.hotkeys[which] = acc;
    saveConfig();
    registerHotkeys();
    // Report whether the (non-empty) binding actually registered.
    const ok = !acc || registeredHotkeys.includes(acc);
    return { ok, hotkeys: { ...config.hotkeys } };
  });

  app.on('will-quit', () => { unregisterHotkeys(); killEngine(); });

  if (config.enabled) {
    registerHotkeys();
    ensureEngine().catch((e) => logger.warn('Volume mixer warm-up failed', e));
  }

  return {
    reapplyHotkeys: () => registerHotkeys(),
    teardown: () => { unregisterHotkeys(); killEngine(); }
  };
}

module.exports = { init };
