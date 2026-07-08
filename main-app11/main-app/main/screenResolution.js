const { ipcMain } = require('electron');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

const SCREEN_RES_SCRIPT_VERSION = 1;

// ── Screen Resolution Manager mini widget ──
// Windows exposes display-mode enumeration and switching only through the Win32
// GDI API (EnumDisplayDevices / EnumDisplaySettings / ChangeDisplaySettingsEx),
// which has no CLI. Like Mic Mute and Macros, this generates a small cached .ps1
// that P/Invokes those functions. The C# block only declares the signatures and
// the DEVMODE / DISPLAY_DEVICE structs; the enumeration/switching loops are done
// in PowerShell and the result is emitted as JSON on stdout.
//
//   list                              -> JSON { monitors: [...] } of every monitor
//                                        attached to the desktop, each with its
//                                        current mode and all supported modes.
//   set <device> <w> <h> <refresh>    -> tests the mode first (CDS_TEST); only
//                                        applies (CDS_UPDATEREGISTRY) if valid.
//                                        Prints JSON { ok, code }.
//
// The 15-second "keep these settings?" auto-revert is handled in the renderer
// (screen-resolution.js): after a successful switch it re-applies the previous
// mode unless the user confirms — mirroring Windows' own behaviour so an
// unsupported mode that blacks out the screen recovers on its own.
const SCREEN_RES_SCRIPT_CONTENT = `Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public ushort dmSpecVersion;
    public ushort dmDriverVersion;
    public ushort dmSize;
    public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public uint dmDisplayOrientation;
    public uint dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel;
    public uint dmPelsWidth;
    public uint dmPelsHeight;
    public uint dmDisplayFlags;
    public uint dmDisplayFrequency;
    public uint dmICMMethod;
    public uint dmICMIntent;
    public uint dmMediaType;
    public uint dmDitherType;
    public uint dmReserved1;
    public uint dmReserved2;
    public uint dmPanningWidth;
    public uint dmPanningHeight;
}

[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string DeviceKey;
}

public static class Disp {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern bool EnumDisplaySettings(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int ChangeDisplaySettingsEx(string lpszDeviceName, ref DEVMODE lpDevMode, IntPtr hwnd, uint dwflags, IntPtr lParam);
}
"@

$ErrorActionPreference = "Stop"
$ENUM_CURRENT = -1
$DM_FIELDS = 0x80000 -bor 0x100000 -bor 0x400000  # DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY
$STATE_ATTACHED = 0x1
$STATE_PRIMARY = 0x4
$CDS_UPDATEREGISTRY = 0x01
$CDS_TEST = 0x02
$devmodeSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DEVMODE')

function New-Devmode {
    $dm = New-Object DEVMODE
    $dm.dmSize = $devmodeSize
    return $dm
}

$command = $args[0]

if ($command -eq "set") {
    $device = $args[1]
    $w = [int]$args[2]
    $h = [int]$args[3]
    $r = [int]$args[4]
    $dm = New-Devmode
    [void][Disp]::EnumDisplaySettings($device, $ENUM_CURRENT, [ref]$dm)
    $dm.dmPelsWidth = $w
    $dm.dmPelsHeight = $h
    $dm.dmDisplayFrequency = $r
    $dm.dmFields = $DM_FIELDS
    $test = [Disp]::ChangeDisplaySettingsEx($device, [ref]$dm, [IntPtr]::Zero, $CDS_TEST, [IntPtr]::Zero)
    if ($test -ne 0) {
        [pscustomobject]@{ ok = $false; code = $test } | ConvertTo-Json -Compress
        return
    }
    $res = [Disp]::ChangeDisplaySettingsEx($device, [ref]$dm, [IntPtr]::Zero, $CDS_UPDATEREGISTRY, [IntPtr]::Zero)
    [pscustomobject]@{ ok = ($res -eq 0); code = $res } | ConvertTo-Json -Compress
    return
}

# Default: list all monitors and their modes.
$monitors = @()
$dd = New-Object DISPLAY_DEVICE
$dd.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DISPLAY_DEVICE')
$i = 0
while ([Disp]::EnumDisplayDevices([NullString]::Value, $i, [ref]$dd, 0)) {
    if (($dd.StateFlags -band $STATE_ATTACHED) -ne 0) {
        $device = $dd.DeviceName
        $primary = (($dd.StateFlags -band $STATE_PRIMARY) -ne 0)
        $friendly = $dd.DeviceString

        $mon = New-Object DISPLAY_DEVICE
        $mon.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DISPLAY_DEVICE')
        if ([Disp]::EnumDisplayDevices($device, 0, [ref]$mon, 0)) {
            if ($mon.DeviceString) { $friendly = $mon.DeviceString }
        }

        $cur = New-Devmode
        [void][Disp]::EnumDisplaySettings($device, $ENUM_CURRENT, [ref]$cur)

        $modeMap = @{}
        $j = 0
        $m = New-Devmode
        while ([Disp]::EnumDisplaySettings($device, $j, [ref]$m)) {
            if ($m.dmBitsPerPel -ge 32 -and $m.dmDisplayFrequency -ge 24) {
                $key = "$($m.dmPelsWidth)x$($m.dmPelsHeight)x$($m.dmDisplayFrequency)"
                if (-not $modeMap.ContainsKey($key)) {
                    $modeMap[$key] = [pscustomobject]@{
                        width = [int]$m.dmPelsWidth
                        height = [int]$m.dmPelsHeight
                        refresh = [int]$m.dmDisplayFrequency
                    }
                }
            }
            $j++
            $m = New-Devmode
        }

        $monitors += [pscustomobject]@{
            id = $device
            name = $friendly
            primary = $primary
            current = [pscustomobject]@{
                width = [int]$cur.dmPelsWidth
                height = [int]$cur.dmPelsHeight
                refresh = [int]$cur.dmDisplayFrequency
            }
            modes = @($modeMap.Values)
        }
    }
    $i++
    $dd = New-Object DISPLAY_DEVICE
    $dd.cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DISPLAY_DEVICE')
}

[pscustomobject]@{ monitors = @($monitors) } | ConvertTo-Json -Depth 6 -Compress
`;

function init(ctx) {
  const { logger, userDataPath } = ctx;

  const SCREEN_RES_SCRIPT = path.join(userDataPath, 'screen-resolution.ps1');

  function ensureScript() {
    ensureVersionedScript(SCREEN_RES_SCRIPT, SCREEN_RES_SCRIPT_VERSION, SCREEN_RES_SCRIPT_CONTENT);
  }

  // Windows PowerShell (5.1) collapses single-element arrays in ConvertTo-Json to
  // the element itself, so a machine with one monitor / a mode list of one would
  // arrive here not wrapped in an array. Normalize so the renderer always gets
  // arrays.
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
  }

  async function listDisplays() {
    ensureScript();
    const { ok, stdout, stderr } = await runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -File "${SCREEN_RES_SCRIPT}" list`);
    if (!ok) {
      logger.error('Screen resolution list failed', new Error(stderr || 'unknown error'));
      return { ok: false, monitors: [] };
    }
    try {
      const parsed = JSON.parse(stdout.trim());
      const monitors = asArray(parsed.monitors).map((mon) => ({
        id: mon.id,
        name: mon.name || 'Display',
        primary: !!mon.primary,
        current: mon.current || null,
        modes: asArray(mon.modes)
          // Newest-first: biggest resolution, then highest refresh.
          .sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.refresh - a.refresh)
      }));
      return { ok: true, monitors };
    } catch (e) {
      logger.error('Screen resolution parse failed', e, { stdout: stdout.slice(0, 300) });
      return { ok: false, monitors: [] };
    }
  }

  async function setResolution(device, width, height, refresh) {
    ensureScript();
    if (!device || !width || !height || !refresh) return { ok: false, error: 'Invalid mode' };
    const { ok, stdout, stderr } = await runCmd(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCREEN_RES_SCRIPT}" set "${device}" ${width} ${height} ${refresh}`
    );
    if (!ok) {
      logger.error('Screen resolution set failed', new Error(stderr || 'unknown error'), { device, width, height, refresh });
      return { ok: false, error: 'Switch failed' };
    }
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.ok) {
        logger.success('Display resolution changed', { device, width, height, refresh });
      } else {
        logger.warn('Display resolution change rejected by driver', { device, width, height, refresh, code: parsed.code });
      }
      return { ok: !!parsed.ok, code: parsed.code };
    } catch (e) {
      logger.error('Screen resolution set parse failed', e, { stdout: stdout.slice(0, 300) });
      return { ok: false, error: 'Unexpected response' };
    }
  }

  ipcMain.handle('screen-resolution-list', () => listDisplays());
  ipcMain.handle('screen-resolution-set', (_event, device, width, height, refresh) =>
    setResolution(device, width, height, refresh));

  return { listDisplays, setResolution };
}

module.exports = { init };
