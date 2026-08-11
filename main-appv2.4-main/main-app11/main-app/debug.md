# Controller Macros — Debug & Test Report

**Date:** 2026-07-20 · **App:** v3.38.1 · **Machine:** Windows 10 (19045), ViGEmBus driver installed
**Scope:** every feature of the Controller Macros mini widget, on both virtual pad types, verified *closed-loop* — macros were played and the pad's actual output was read back through independent APIs, not just log lines.

## How it was tested

Two independent read-back probes watched the virtual pad while macros played:

1. **Gamepad API probe** (DualShock 4 run) — the app's own renderer polls
   `navigator.getGamepads()` at ~60 Hz; Chromium sees the ViGEm pad exactly
   like a real controller.
2. **XInput probe** (Xbox 360 run) — a PowerShell script P/Invokes
   `XInputGetState` (xinput1_4.dll) at ~60 Hz and logs every state change.
   This is the same API games use, and it works regardless of window focus.

Macros were fired over the app's real IPC (`controllerMacrosPlaySteps`), so the
full production path ran: renderer → main process → sequence compiler →
pad-engine helper → ViGEmBus → Windows → probe.

## Results — everything passes

### Buttons (15/15) — both pad types

Played `hold → release` on every button in canonical order. Both probes saw
every press, in order, with clean releases:

| Step button | DS4 (Gamepad API index) | X360 (XInput bit) |
|---|---|---|
| ✕ Cross / ○ Circle / □ Square / △ Triangle | 0 / 1 / 2 / 3 ✔ | A `1000` / B `2000` / X `4000` / Y `8000` ✔ |
| L1 / R1 | 4 / 5 ✔ | LB `0100` / RB `0200` ✔ |
| L3 / R3 | 10 / 11 ✔ | `0040` / `0080` ✔ |
| Share / Options | 8 / 9 ✔ | Back `0020` / Start `0010` ✔ |
| D-Pad ↑ ↓ ← → | 12 / 13 / 14 / 15 ✔ | `0001` / `0002` / `0004` / `0008` ✔ |
| PS / Guide | 16 ✔ | seen via Chromium ✔ (hidden from plain `XInputGetState` by Windows — normal) |

### Trigger pulls (L2 / R2, partial %) — both pad types

| Step | DS4 read-back | X360 read-back (byte) |
|---|---|---|
| Pull L2 to 25% | 0.25 exactly | `64` (= 25% of 255) |
| Pull L2 to 100% | 1.00 | `255` |
| Pull L2 to 0% | 0 (released) | `0` |
| Pull R2 to 60% | 0.60 | `153` |

DS4 also mirrors the pull onto the digital L2/R2 button, like a real pad.

### Stick moves — the headline test — both pad types

Every target hit **exactly**, on both sticks, both pad types:

| Step | DS4 axes | X360 axes |
|---|---|---|
| Left stick x 100 / x −100 | +1.0 / −1.0 | +32767 / −32767 |
| Left stick y 100 (up) / y −100 (down) | −1.0 / +1.0 (API up = −1) ✔ | +32767 / −32767 (XInput up = +) ✔ |
| Left stick x 50, y 50 (diagonal) | +0.5 / −0.5 | +16384 / +16384 |
| Right stick x 100 / y 100 | +1.0 / −1.0 | +32767 / +32767 |
| Right stick x −50, y −50 (down-left) | −0.5 / +0.5 | −16383 / −16383 |
| Recentre (x 0, y 0) | 0 / 0 | 0 / 0 |

The `+y = up` convention in steps is translated correctly for **both** targets
(XInput is up-positive, DS4's raw byte axis is down-positive — the engine
flips it, and the probes confirm the flip is right).

### D-pad diagonals

Holding D-Pad ↑ then adding ← shows **both directions held at once** on both
pads — on DS4 this means the hat correctly reports North → North-West → West.
XInput trace: `0001` → `0005` → `0004` → `0000`.

### Stuck-input safety

A sequence that *ends* while ✕, L2 and a full stick deflection are still held
was released completely by the engine within ~15 ms of the run ending —
final probe state all zeros. Nothing is ever left pressed on the pad.

### Verified in earlier passes (2026-07-19/20)

- All four trigger modes fired from a real system-wide keypress:
  **Pressed** ✔ · **Toggle** (F6 starts ∞ loop, F6 stops, `SEQ-STOPPED`) ✔ ·
  **Hold** (loops only while key physically down) ✔ · **Released** (fires on
  key-up, not key-down) ✔
- Macros persist across app restarts; live PlayStation ↔ Xbox switching
  re-plugs the pad instantly; driver detection + "Get the driver" flow (used
  for the real install on this machine); graceful failure with no driver;
  keyboard Macros widget regression-checked after the shared-watcher change.

## Findings / known behaviours (not bugs)

1. **Recording needs the app window focused.** Chromium freezes
   `navigator.getGamepads()` data for unfocused windows, so the *Record from
   controller* button only captures while the launcher is the active window.
   Playback is unaffected (it doesn't use the browser API at all).
2. **A delay as the *last* step is trimmed** — the run ends at the final
   button/stick event (same behaviour as the keyboard Macros widget). Add the
   delay *before* the last action if the gap matters.
3. **PS/Guide on the Xbox 360 pad** is invisible to games that use plain
   `XInputGetState` (Windows reserves it); Steam/Chromium do see it. On the
   DS4 pad the PS button is fully visible.
4. Anti-cheat titles may ignore or dislike virtual controllers (noted in the
   widget panel).

## Re-running the XInput probe by hand

```powershell
# save as probe.ps1, run while playing a macro; prints every pad state change
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class XI {
  [StructLayout(LayoutKind.Sequential)] public struct GAMEPAD { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }
  [StructLayout(LayoutKind.Sequential)] public struct STATE { public uint dwPacketNumber; public GAMEPAD Gamepad; }
  [DllImport("xinput1_4.dll")] public static extern uint XInputGetState(uint idx, out STATE state);
}
'@
$prev = ''
while ($true) {
  $st = New-Object XI+STATE
  if ([XI]::XInputGetState(0, [ref]$st) -eq 0) {
    $g = $st.Gamepad
    $line = '{0:X4} LT={1} RT={2} LX={3} LY={4} RX={5} RY={6}' -f $g.wButtons,$g.bLeftTrigger,$g.bRightTrigger,$g.sThumbLX,$g.sThumbLY,$g.sThumbRX,$g.sThumbRY
    if ($line -ne $prev) { $prev = $line; Write-Host $line }
  }
  Start-Sleep -Milliseconds 8
}
```

(Requires the pad type set to **Xbox 360** in the widget; for PlayStation mode
use a gamepad tester website with the launcher window focused instead.)
