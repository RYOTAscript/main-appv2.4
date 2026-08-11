const { ipcMain } = require('electron');
const path = require('path');
const { ensureVersionedScript } = require('./scriptCache');
const { runCmd } = require('./shellUtils');

// v2 — added WinRT radio power control (on/off/toggle/state), device class →
// human type mapping, last-seen / last-used timestamps, and a combined `status`
// command. Bump this whenever BLUETOOTH_SCRIPT_CONTENT changes so the cached
// .ps1 on disk is regenerated (see scriptCache.ensureVersionedScript).
const BLUETOOTH_SCRIPT_VERSION = 2;

// ── Bluetooth Manager mini widget ──
// Windows has no first-class CLI for Bluetooth, so — like Mic Mute / Macros /
// Screen Resolution — this generates a small cached .ps1 that mixes two proven
// Windows APIs:
//
//   • Win32 bthprops.cpl (BluetoothFindFirstDevice, SetServiceState, RemoveDevice,
//     AuthenticateDeviceEx, EnumerateInstalledServices) — the reliable source of a
//     device's true `fConnected` state (the PnP Status field lies: it reads "OK"
//     for paired-but-disconnected devices), plus its class-of-device and last
//     seen/used timestamps.
//   • WinRT Windows.Devices.Radios — the only supported way to actually turn the
//     Bluetooth *radio* on and off from code (RequestAccessAsync + SetStateAsync).
//     Loaded lazily, only for radio commands, so the frequent list/scan path stays
//     fast and never depends on WinRT being present.
//
// Battery % is layered on from the PnP DEVPKEY_Bluetooth_Battery property where
// the device reports it.
//
//   list                 -> { ok, devices:[{address,name,connected,...,type,battery,lastUsed}] }
//   status               -> { ok, radio:{present,state,name}, devices:[...] }  (list + radio)
//   scan                 -> { ok, devices:[...] }  (issues an inquiry, ~6s)
//   radio                -> { ok, radio:{present,state,name} }
//   radio-on|radio-off|radio-toggle -> { ok, radio:{...} }
//   connect <address>    -> { ok, code }  (enables the device's services)
//   disconnect <address> -> { ok, code }  (disables them)
//   remove <address>     -> { ok, code }  (unpairs / forgets the device)
//   pair <address>       -> { ok, code }  (best-effort "just works" pairing)
//
// Addresses are the 12-hex-digit MAC (e.g. "747786931B52"), matching the API's
// 48-bit BLUETOOTH_ADDRESS.
const BLUETOOTH_SCRIPT_CONTENT = `Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class Bt {
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEMTIME { public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds; }

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct BLUETOOTH_DEVICE_INFO {
        public uint dwSize;
        public ulong Address;
        public uint ulClassofDevice;
        [MarshalAs(UnmanagedType.Bool)] public bool fConnected;
        [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;
        [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;
        public SYSTEMTIME stLastSeen;
        public SYSTEMTIME stLastUsed;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=248)] public string szName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BLUETOOTH_DEVICE_SEARCH_PARAMS {
        public uint dwSize;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnRemembered;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnUnknown;
        [MarshalAs(UnmanagedType.Bool)] public bool fReturnConnected;
        [MarshalAs(UnmanagedType.Bool)] public bool fIssueInquiry;
        public byte cTimeoutMultiplier;
        public IntPtr hRadio;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BLUETOOTH_FIND_RADIO_PARAMS { public uint dwSize; }

    [DllImport("bthprops.cpl", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS pbtsp, ref BLUETOOTH_DEVICE_INFO pbtdi);
    [DllImport("bthprops.cpl", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool BluetoothFindNextDevice(IntPtr hFind, ref BLUETOOTH_DEVICE_INFO pbtdi);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern bool BluetoothFindDeviceClose(IntPtr hFind);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern IntPtr BluetoothFindFirstRadio(ref BLUETOOTH_FIND_RADIO_PARAMS pbtfrp, out IntPtr phRadio);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern bool BluetoothFindRadioClose(IntPtr hFind);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern uint BluetoothGetDeviceInfo(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO pbtdi);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern uint BluetoothEnumerateInstalledServices(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO pbtdi, ref uint pcServiceInout, Guid[] pGuidServices);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern uint BluetoothSetServiceState(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO pbtdi, ref Guid pGuidService, uint dwServiceFlags);
    [DllImport("bthprops.cpl", SetLastError=true)]
    public static extern uint BluetoothRemoveDevice(ref ulong pAddress);
    [DllImport("bthprops.cpl", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint BluetoothAuthenticateDeviceEx(IntPtr hwndParent, IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO pbtdiInout, IntPtr pbtOobData, int authReq);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool CloseHandle(IntPtr hObject);

    const uint SERVICE_DISABLE = 0;
    const uint SERVICE_ENABLE = 1;

    static IntPtr GetRadio(out IntPtr hFind) {
        BLUETOOTH_FIND_RADIO_PARAMS rp = new BLUETOOTH_FIND_RADIO_PARAMS();
        rp.dwSize = (uint)Marshal.SizeOf(typeof(BLUETOOTH_FIND_RADIO_PARAMS));
        IntPtr hRadio;
        hFind = BluetoothFindFirstRadio(ref rp, out hRadio);
        return hRadio;
    }

    static BLUETOOTH_DEVICE_INFO InfoFor(ulong address, IntPtr hRadio) {
        BLUETOOTH_DEVICE_INFO info = new BLUETOOTH_DEVICE_INFO();
        info.dwSize = (uint)Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_INFO));
        info.Address = address;
        BluetoothGetDeviceInfo(hRadio, ref info);
        info.Address = address; // keep even if GetDeviceInfo cleared it
        return info;
    }

    // Enables or disables all of a device's installed services — the practical way
    // to connect / disconnect a classic Bluetooth device from code.
    public static int SetServices(ulong address, bool enable) {
        IntPtr hFind;
        IntPtr hRadio = GetRadio(out hFind);
        if (hRadio == IntPtr.Zero) return -1;
        try {
            BLUETOOTH_DEVICE_INFO info = InfoFor(address, hRadio);
            uint count = 0;
            BluetoothEnumerateInstalledServices(hRadio, ref info, ref count, null);
            uint last = 0;
            if (count > 0) {
                Guid[] guids = new Guid[count];
                BluetoothEnumerateInstalledServices(hRadio, ref info, ref count, guids);
                for (uint i = 0; i < count; i++) {
                    last = BluetoothSetServiceState(hRadio, ref info, ref guids[i], enable ? SERVICE_ENABLE : SERVICE_DISABLE);
                }
            }
            return (int)last;
        } finally {
            CloseHandle(hRadio);
            if (hFind != IntPtr.Zero) BluetoothFindRadioClose(hFind);
        }
    }

    public static int Remove(ulong address) {
        return (int)BluetoothRemoveDevice(ref address);
    }

    // Best-effort "just works" (no-PIN) pairing — covers most modern audio devices.
    public static int Pair(ulong address) {
        IntPtr hFind;
        IntPtr hRadio = GetRadio(out hFind);
        try {
            BLUETOOTH_DEVICE_INFO info = new BLUETOOTH_DEVICE_INFO();
            info.dwSize = (uint)Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_INFO));
            info.Address = address;
            // Populate name/class from a fresh inquiry result if present.
            BluetoothGetDeviceInfo(hRadio, ref info);
            info.Address = address;
            return (int)BluetoothAuthenticateDeviceEx(IntPtr.Zero, hRadio, ref info, IntPtr.Zero, 0);
        } finally {
            if (hRadio != IntPtr.Zero) CloseHandle(hRadio);
            if (hFind != IntPtr.Zero) BluetoothFindRadioClose(hFind);
        }
    }
}
"@

$ErrorActionPreference = "Stop"
$command = $args[0]

# Coarse device family from the 24-bit Class of Device. We only need the major
# device class (bits 8-12) plus a couple of Audio/Video minor classes to label
# rows and group the list — the fine-grained icon still comes from the name in
# the renderer, this is the reliable fallback the name can't always give.
function Get-DevType([uint32]$cod) {
    if ($cod -eq 0) { return "unknown" }
    $major = ($cod -shr 8) -band 0x1F
    switch ($major) {
        1 { return "computer" }
        2 { return "phone" }
        3 { return "network" }
        4 {
            $minor = ($cod -shr 2) -band 0x3F
            switch ($minor) {
                1 { return "headset" }
                2 { return "headset" }
                4 { return "microphone" }
                5 { return "speaker" }
                6 { return "headphones" }
                8 { return "gamepad" }
                default { return "audio" }
            }
        }
        5 {
            $minor = ($cod -shr 6) -band 0x03
            $kb = ($cod -band 0x40) -ne 0
            $ms = ($cod -band 0x80) -ne 0
            if ($minor -eq 1 -or $kb) { return "keyboard" }
            if ($minor -eq 2 -or $ms) { return "mouse" }
            return "peripheral"
        }
        6 { return "imaging" }
        7 { return "wearable" }
        8 { return "toy" }
        9 { return "health" }
        default { return "unknown" }
    }
}

# SYSTEMTIME -> sortable ISO string, or $null when the API left it zeroed (never
# seen/used). Guard every field: a partially-populated struct must not throw.
function Convert-Time($st) {
    try {
        if (-not $st -or $st.Year -lt 1970 -or $st.Month -lt 1 -or $st.Month -gt 12 -or $st.Day -lt 1) { return $null }
        $dt = Get-Date -Year $st.Year -Month $st.Month -Day $st.Day -Hour $st.Hour -Minute $st.Minute -Second $st.Second -ErrorAction Stop
        return $dt.ToString("yyyy-MM-ddTHH:mm:ss")
    } catch { return $null }
}

function Enumerate([bool]$inquiry) {
    $search = New-Object Bt+BLUETOOTH_DEVICE_SEARCH_PARAMS
    $search.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Bt+BLUETOOTH_DEVICE_SEARCH_PARAMS')
    $search.fReturnAuthenticated = $true
    $search.fReturnRemembered = $true
    $search.fReturnConnected = $true
    $search.fReturnUnknown = $inquiry
    $search.fIssueInquiry = $inquiry
    $search.cTimeoutMultiplier = $(if ($inquiry) { 5 } else { 2 })
    $search.hRadio = [IntPtr]::Zero

    $info = New-Object Bt+BLUETOOTH_DEVICE_INFO
    $info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Bt+BLUETOOTH_DEVICE_INFO')

    $list = @()
    $h = [Bt]::BluetoothFindFirstDevice([ref]$search, [ref]$info)
    if ($h -eq [IntPtr]::Zero) { return $list }
    do {
        $list += [pscustomobject]@{
            address = ("{0:X12}" -f $info.Address)
            name = $info.szName
            connected = [bool]$info.fConnected
            paired = [bool]$info.fAuthenticated
            remembered = [bool]$info.fRemembered
            classOfDevice = [uint32]$info.ulClassofDevice
            type = (Get-DevType ([uint32]$info.ulClassofDevice))
            lastSeen = (Convert-Time $info.stLastSeen)
            lastUsed = (Convert-Time $info.stLastUsed)
        }
        $info = New-Object Bt+BLUETOOTH_DEVICE_INFO
        $info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Bt+BLUETOOTH_DEVICE_INFO')
    } while ([Bt]::BluetoothFindNextDevice($h, [ref]$info))
    [void][Bt]::BluetoothFindDeviceClose($h)
    return $list
}

function Get-Battery([string]$addr) {
    try {
        $pnp = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -like "*DEV_$addr*" -and $_.InstanceId -notlike "*_C0*" } | Select-Object -First 1
        if ($pnp) {
            $bp = Get-PnpDeviceProperty -InstanceId $pnp.InstanceId -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction SilentlyContinue
            if ($bp -and $null -ne $bp.Data -and $bp.Data -ge 0 -and $bp.Data -le 100) { return [int]$bp.Data }
        }
    } catch {}
    return $null
}

# ── WinRT radio power control (lazy) ──
# Loaded only when a radio command runs. WinRT async methods return
# IAsyncOperation<T>; the generic AsTask bridge below turns each into an awaitable
# .NET Task so we can block for the result inside the script.
function Get-AwaitBridge {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    return ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
}

function Await-WinRT($op, $resultType, $bridge) {
    $asTask = $bridge.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($op))
    [void]$task.Wait(-1)
    return $task.Result
}

function Get-BtRadio {
    $bridge = Get-AwaitBridge
    [void][Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
    [void](Await-WinRT ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]) $bridge)
    $radios = Await-WinRT ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]) $bridge
    $bt = $radios | Where-Object { $_.Kind -eq [Windows.Devices.Radios.RadioKind]::Bluetooth } | Select-Object -First 1
    return @{ Radio = $bt; Bridge = $bridge }
}

# Returns { present, state, name }. state is "on" | "off" | "unknown".
function Radio-Status {
    try {
        $r = Get-BtRadio
        if (-not $r.Radio) { return [pscustomobject]@{ present = $false; state = "unknown"; name = $null } }
        $state = switch ($r.Radio.State) {
            ([Windows.Devices.Radios.RadioState]::On) { "on" }
            ([Windows.Devices.Radios.RadioState]::Off) { "off" }
            default { "unknown" }
        }
        return [pscustomobject]@{ present = $true; state = $state; name = $r.Radio.Name }
    } catch {
        return [pscustomobject]@{ present = $false; state = "unknown"; name = $null; error = "$($_.Exception.Message)" }
    }
}

function Radio-Set([string]$want) {
    try {
        $r = Get-BtRadio
        if (-not $r.Radio) { return [pscustomobject]@{ ok = $false; error = "No Bluetooth radio"; radio = (Radio-Status) } }
        $target = if ($want -eq "on") { [Windows.Devices.Radios.RadioState]::On }
                  elseif ($want -eq "off") { [Windows.Devices.Radios.RadioState]::Off }
                  else { if ($r.Radio.State -eq [Windows.Devices.Radios.RadioState]::On) { [Windows.Devices.Radios.RadioState]::Off } else { [Windows.Devices.Radios.RadioState]::On } }
        $res = Await-WinRT ($r.Radio.SetStateAsync($target)) ([Windows.Devices.Radios.RadioAccessStatus]) $r.Bridge
        $ok = ($res -eq [Windows.Devices.Radios.RadioAccessStatus]::Allowed)
        Start-Sleep -Milliseconds 250
        return [pscustomobject]@{ ok = $ok; access = "$res"; radio = (Radio-Status) }
    } catch {
        return [pscustomobject]@{ ok = $false; error = "$($_.Exception.Message)"; radio = [pscustomobject]@{ present = $false; state = "unknown"; name = $null } }
    }
}

function List-Devices {
    $devices = @(Enumerate $false | Where-Object { $_.remembered -or $_.paired })
    foreach ($d in $devices) {
        Add-Member -InputObject $d -NotePropertyName battery -NotePropertyValue (Get-Battery $d.address) -Force
    }
    return @($devices)
}

if ($command -eq "list") {
    [pscustomobject]@{ ok = $true; devices = @(List-Devices) } | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "status") {
    [pscustomobject]@{ ok = $true; radio = (Radio-Status); devices = @(List-Devices) } | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "scan") {
    $devices = @(Enumerate $true)
    [pscustomobject]@{ ok = $true; devices = @($devices) } | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "radio") {
    [pscustomobject]@{ ok = $true; radio = (Radio-Status) } | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "radio-on") {
    Radio-Set "on" | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "radio-off") {
    Radio-Set "off" | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "radio-toggle") {
    Radio-Set "toggle" | ConvertTo-Json -Depth 4 -Compress
}
elseif ($command -eq "connect" -or $command -eq "disconnect") {
    $addr = [Convert]::ToUInt64($args[1], 16)
    $code = [Bt]::SetServices($addr, ($command -eq "connect"))
    [pscustomobject]@{ ok = ($code -eq 0); code = $code } | ConvertTo-Json -Compress
}
elseif ($command -eq "remove") {
    $addr = [Convert]::ToUInt64($args[1], 16)
    $code = [Bt]::Remove($addr)
    [pscustomobject]@{ ok = ($code -eq 0); code = $code } | ConvertTo-Json -Compress
}
elseif ($command -eq "pair") {
    $addr = [Convert]::ToUInt64($args[1], 16)
    $code = [Bt]::Pair($addr)
    [pscustomobject]@{ ok = ($code -eq 0); code = $code } | ConvertTo-Json -Compress
}
else {
    [pscustomobject]@{ ok = $false; error = "unknown command" } | ConvertTo-Json -Compress
}
`;

function init(ctx) {
  const { logger, userDataPath } = ctx;

  const BLUETOOTH_SCRIPT = path.join(userDataPath, 'bluetooth-manager.ps1');

  function ensureScript() {
    ensureVersionedScript(BLUETOOTH_SCRIPT, BLUETOOTH_SCRIPT_VERSION, BLUETOOTH_SCRIPT_CONTENT);
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v === null || v === undefined) return [];
    return [v];
  }

  // Scanning issues a live inquiry, so it needs a longer timeout than the default.
  async function run(args, timeoutMs = 30000) {
    ensureScript();
    const { ok, stdout, stderr } = await runCmd(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${BLUETOOTH_SCRIPT}" ${args}`,
      timeoutMs
    );
    if (!ok) {
      logger.error('Bluetooth script failed', new Error(stderr || 'unknown error'), { args });
      return null;
    }
    try {
      return JSON.parse(stdout.trim());
    } catch (e) {
      logger.error('Bluetooth script parse failed', e, { args, stdout: stdout.slice(0, 300) });
      return null;
    }
  }

  async function list() {
    const res = await run('list');
    if (!res || !res.ok) return { ok: false, devices: [] };
    return { ok: true, devices: asArray(res.devices) };
  }

  // Combined snapshot used for the full render / after a radio toggle — one
  // PowerShell round-trip instead of two.
  async function status() {
    const res = await run('status');
    if (!res || !res.ok) return { ok: false, radio: null, devices: [] };
    return { ok: true, radio: res.radio || null, devices: asArray(res.devices) };
  }

  async function scan() {
    const res = await run('scan', 45000);
    if (!res || !res.ok) return { ok: false, devices: [] };
    return { ok: true, devices: asArray(res.devices) };
  }

  async function radioGet() {
    const res = await run('radio', 20000);
    if (!res || !res.ok) return { ok: false, radio: null };
    return { ok: true, radio: res.radio || null };
  }

  async function radioSet(state) {
    const map = { on: 'radio-on', off: 'radio-off', toggle: 'radio-toggle' };
    const cmd = map[state];
    if (!cmd) return { ok: false, error: 'Invalid radio state' };
    const res = await run(cmd, 25000);
    if (!res) return { ok: false, error: 'Command failed' };
    if (res.ok) logger.success(`Bluetooth radio ${state} succeeded`, { radio: res.radio });
    else logger.warn(`Bluetooth radio ${state} failed`, { error: res.error, radio: res.radio });
    return res;
  }

  // Validates an address is exactly 12 hex digits before it's interpolated into
  // the PowerShell command line — never let arbitrary renderer input through.
  function validAddress(addr) {
    return typeof addr === 'string' && /^[0-9A-Fa-f]{12}$/.test(addr);
  }

  async function action(kind, address) {
    if (!validAddress(address)) return { ok: false, error: 'Invalid address' };
    const res = await run(`${kind} ${address}`, 25000);
    if (!res) return { ok: false, error: 'Command failed' };
    if (res.ok) logger.success(`Bluetooth ${kind} succeeded`, { address });
    else logger.warn(`Bluetooth ${kind} failed`, { address, code: res.code });
    return res;
  }

  ipcMain.handle('bluetooth-list', () => list());
  ipcMain.handle('bluetooth-status', () => status());
  ipcMain.handle('bluetooth-scan', () => scan());
  ipcMain.handle('bluetooth-radio-get', () => radioGet());
  ipcMain.handle('bluetooth-radio-set', (_event, state) => radioSet(state));
  ipcMain.handle('bluetooth-connect', (_event, address) => action('connect', address));
  ipcMain.handle('bluetooth-disconnect', (_event, address) => action('disconnect', address));
  ipcMain.handle('bluetooth-remove', (_event, address) => action('remove', address));
  ipcMain.handle('bluetooth-pair', (_event, address) => action('pair', address));

  return { list, status, scan, radioGet, radioSet };
}

module.exports = { init };
