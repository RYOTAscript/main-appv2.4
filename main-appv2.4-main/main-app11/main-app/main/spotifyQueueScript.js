// PowerShell helper that removes a song from the queue through the Spotify DESKTOP
// app (Windows UI Automation — the OS accessibility API). Spotify's Web API can add
// to the queue but has no way to remove from it; the app's own queue panel can.
//
// Contract (kept in step with main/spotify.js):
//   powershell -File spotify-queue-remove.ps1 -Payload <base64 of JSON>
//     {"title":"...","occurrence":0}  remove that row
//     {"warm":true}                   only get the app's accessibility tree built
//   prints ONE JSON line: {"ok":true,...} or {"ok":false,"reason":"..."}
//   reasons: bad-request | not-running | no-window | no-queue | not-found |
//            not-visible | no-remove-item | not-removed | error
//
// Three Chromium/Spotify behaviours shape this script:
//  - Chromium only builds the accessibility tree for its web UI once a client asks,
//    and the first time after Spotify starts that takes a few seconds (only ~15 bare
//    elements exist meanwhile). So it keeps asking for a while, and main "warms" it as
//    soon as queue rows are on screen.
//  - A song's menu only RENDERS while Spotify's window is visible. Minimized (or fully
//    covered), the click is accepted but the menu stays pending — and pops open, taking
//    keyboard focus, the next time the window shows. So the window is restored WITHOUT
//    activating it and raised for the moment of the removal, then put back exactly as it
//    was found and focus handed back to the window that had it. If a menu still doesn't
//    appear the queue panel is closed and reopened, which unmounts the row and cancels
//    the pending menu.
//  - Invoking a menu item through accessibility closes Spotify's menu WITHOUT running
//    the action (verified live: "Remove from queue" invoked, menu closed, song stayed
//    queued), and keys POSTED to Spotify's render window are ignored too (verified
//    live). A real Enter on the FOCUSED item does run it. So the item gets accessibility
//    focus, Spotify is made the foreground window, and one Enter is pressed — guarded on
//    Spotify being foreground with focus still on that item, so the key cannot land in
//    another app. Success is only reported once the row is really gone from the panel;
//    otherwise the menu is cancelled and the result is "not-removed".
//
// The payload travels base64-encoded so no song name can be read as a PowerShell
// argument. Removal steps: open the queue panel if it's closed, find the row named
// "More options for <title>" (skipping the first row — the song playing now — and
// counting copies for a song queued twice), expand its menu, invoke
// "Remove from queue", confirm the row count dropped, then close the panel again if
// it was closed before.
//
// Keep the script text pure ASCII: scriptCache writes it without a BOM and Windows
// PowerShell 5.1 reads that as ANSI, where a dash or curly quote breaks parsing.
// Matches Spotify's English UI labels. Bump SPOTIFY_QUEUE_SCRIPT_VERSION whenever the
// script text changes, so scriptCache rewrites the cached .ps1.

const SPOTIFY_QUEUE_SCRIPT_VERSION = '7';

const SPOTIFY_QUEUE_SCRIPT = String.raw`param([string]$Payload)
$ErrorActionPreference = 'Stop'
$script:openedQueue = $false
$script:toggle = $null
$script:hwnd = [IntPtr]::Zero
$script:reminimize = $false
$script:userFg = [IntPtr]::Zero

function Finish($ok, $reason) {
  if ($script:openedQueue -and $script:toggle) {
    try { $script:toggle.Toggle() } catch {}
  }
  # Put Spotify back the way it was found, and hand focus back to whatever had it.
  if ($script:reminimize -and $script:hwnd -ne [IntPtr]::Zero) {
    try { [void][SpotifyQueueHelper.Win]::ShowWindow($script:hwnd, 7) } catch {}
  }
  if ($script:userFg -ne [IntPtr]::Zero) {
    try { [void][SpotifyQueueHelper.Win]::GiveForeground($script:userFg) } catch {}
  }
  $result = [ordered]@{ ok = [bool]$ok; reason = $reason }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  exit 0
}

function Norm([string]$s) {
  if ($null -eq $s) { return '' }
  return (($s.Trim()) -replace '\s+', ' ').ToLowerInvariant()
}

try {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
  } catch { Finish $false 'bad-request' }
  $warm = [bool]$json.warm
  $title = [string]$json.title
  $occurrence = [int]$json.occurrence
  if (-not $warm -and -not $title) { Finish $false 'bad-request' }

  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace SpotifyQueueHelper {
  public static class Win {
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    // Show the window without activating it, and lift it above the others so Chromium
    // stops treating it as covered - it will not draw the song's menu otherwise.
    public static void ShowNoActivate(IntPtr h) {
      ShowWindow(h, 4);   // SW_SHOWNOACTIVATE
      SetWindowPos(h, (IntPtr)0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }
    // Focus another window even though this process is not the foreground one.
    public static bool GiveForeground(IntPtr target) {
      IntPtr fg = GetForegroundWindow();
      if (fg == target) return true;
      uint pid;
      uint fgThread = GetWindowThreadProcessId(fg, out pid);
      uint me = GetCurrentThreadId();
      AttachThreadInput(me, fgThread, true);
      bool ok = SetForegroundWindow(target);
      AttachThreadInput(me, fgThread, false);
      return ok;
    }
    public static void PressEnter() {
      keybd_event(0x0D, 0x1C, 0, UIntPtr.Zero);
      keybd_event(0x0D, 0x1C, 2, UIntPtr.Zero);
    }
  }
}
'@
  $descendants = [System.Windows.Automation.TreeScope]::Descendants
  $children = [System.Windows.Automation.TreeScope]::Children
  $anything = [System.Windows.Automation.Condition]::TrueCondition
  $nameProp = [System.Windows.Automation.AutomationElement]::NameProperty
  $typeProp = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
  $idProp = [System.Windows.Automation.AutomationElement]::AutomationIdProperty

  $procs = @(Get-Process Spotify -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { Finish $false 'not-running' }
  $main = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $main) { Finish $false 'no-window' }
  $spotifyPids = @($procs | ForEach-Object { $_.Id })
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($main.MainWindowHandle)

  # 1. Find the queue toggle, waiting for Chromium to build the tree if it hasn't yet.
  $queueCond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($nameProp, 'Queue')),
    (New-Object System.Windows.Automation.PropertyCondition($typeProp, [System.Windows.Automation.ControlType]::Button)))
  $queueBtn = $null
  for ($w = 0; $w -lt 40 -and -not $queueBtn; $w++) {
    $queueBtn = $root.FindFirst($descendants, $queueCond)
    if (-not $queueBtn) {
      if ($w % 8 -eq 0) { [void]$root.FindAll($descendants, $anything) }  # a full walk nudges Chromium
      Start-Sleep -Milliseconds 250
    }
  }
  if ($warm) { Finish ([bool]$queueBtn) $(if ($queueBtn) { 'warm' } else { 'no-queue' }) }
  if (-not $queueBtn) { Finish $false 'no-queue' }

  # A minimized or covered window can't render the song's menu, so bring Spotify on
  # screen for the moment of the removal - without activating it - and remember that it
  # has to go back. Finish is the single exit, so it always gets restored.
  $script:hwnd = [IntPtr]$main.MainWindowHandle
  $script:userFg = [SpotifyQueueHelper.Win]::GetForegroundWindow()
  if ($script:userFg -eq $script:hwnd) { $script:userFg = [IntPtr]::Zero }
  $script:reminimize = [SpotifyQueueHelper.Win]::IsIconic($script:hwnd)
  [SpotifyQueueHelper.Win]::ShowNoActivate($script:hwnd)
  Start-Sleep -Milliseconds 700

  $script:toggle = $queueBtn.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  if ($script:toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
    $script:toggle.Toggle()
    $script:openedQueue = $true
  }

  # 2. Find the row. Row 0 of the panel is the song playing now.
  $panelCond = New-Object System.Windows.Automation.PropertyCondition($idProp, 'Desktop_PanelContainer_Id')
  $buttonCond = New-Object System.Windows.Automation.PropertyCondition($typeProp, [System.Windows.Automation.ControlType]::Button)
  $want = Norm $title
  $prefix = 'More options for '
  $target = $null
  $sawRows = $false
  $rows = @()
  for ($attempt = 0; $attempt -lt 12 -and -not $target; $attempt++) {
    if ($attempt -gt 0) { Start-Sleep -Milliseconds 250 }
    $panel = $root.FindFirst($descendants, $panelCond)
    if (-not $panel) { continue }
    $rows = @()
    foreach ($b in $panel.FindAll($descendants, $buttonCond)) {
      if ($b.Current.Name.StartsWith($prefix)) { $rows += $b }
    }
    if ($rows.Count -lt 2) { continue }
    $sawRows = $true
    $seen = 0
    for ($i = 1; $i -lt $rows.Count; $i++) {
      if ((Norm ($rows[$i].Current.Name.Substring($prefix.Length))) -eq $want) {
        if ($seen -eq $occurrence) { $target = $rows[$i]; break }
        $seen++
      }
    }
    if ($sawRows -and -not $target -and $attempt -ge 3) { break }
  }
  if (-not $target) { Finish $false $(if ($sawRows) { 'not-found' } else { 'no-queue' }) }
  # Verification counts the row by its exact accessibility name, with ONE name-matched
  # FindAll. Walking every button instead takes seconds on a long queue (measured on an
  # 81-row panel), so a removal that had already happened still read as "not removed".
  $targetName = $target.Current.Name
  $rowNameCond = New-Object System.Windows.Automation.PropertyCondition($nameProp, $targetName)
  function CountRows {
    $p = $root.FindFirst($descendants, $panelCond)
    if (-not $p) { return -1 }
    return @($p.FindAll($descendants, $rowNameCond)).Count
  }
  $matchesBefore = CountRows
  if ($matchesBefore -lt 1) { Finish $false 'not-found' }

  # 3. Open its menu and choose "Remove from queue".
  $expand = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  $expand.Expand()
  $menuCond = New-Object System.Windows.Automation.PropertyCondition($typeProp, [System.Windows.Automation.ControlType]::MenuItem)
  $removeItem = $null
  $menuCount = 0
  for ($t = 0; $t -lt 12 -and -not $removeItem; $t++) {
    Start-Sleep -Milliseconds 150
    $items = @($root.FindAll($descendants, $menuCond))
    if (-not $items.Count) {
      foreach ($win in [System.Windows.Automation.AutomationElement]::RootElement.FindAll($children, $anything)) {
        if ($spotifyPids -contains $win.Current.ProcessId -and $win.Current.NativeWindowHandle -ne [int]$main.MainWindowHandle) {
          $items += @($win.FindAll($descendants, $menuCond))
        }
      }
    }
    $menuCount = $items.Count
    foreach ($m in $items) { if ($m.Current.Name -eq 'Remove from queue') { $removeItem = $m; break } }
    if (-not $removeItem -and $menuCount -gt 0 -and $t -ge 4) { break }
  }
  if (-not $removeItem) {
    if ($menuCount -gt 0) {
      try { $expand.Expand() } catch {}  # an open menu closes on a second click
      Finish $false 'no-remove-item'
    }
    # The menu never rendered (window covered): it is pending and would pop open, with
    # focus, when Spotify next shows. Closing and reopening the queue panel unmounts
    # the row and cancels it.
    try {
      $script:toggle.Toggle()
      Start-Sleep -Milliseconds 500
      if ($script:openedQueue) { $script:openedQueue = $false } else { $script:toggle.Toggle() }
    } catch {}
    Finish $false 'not-visible'
  }
  # 4. Activate it with a real Enter on the focused item (accessibility "invoke" only
  #    closes the menu), and only report success once the row is really gone.
  function RowGone([int]$tries) {
    for ($v = 0; $v -lt $tries; $v++) {
      Start-Sleep -Milliseconds 300
      $now = CountRows
      if ($now -ge 0 -and $now -lt $script:matchesBefore) { return $true }
    }
    return $false
  }
  function FocusIsRemoveItem {
    try { return ([System.Windows.Automation.AutomationElement]::FocusedElement.Current.Name -eq 'Remove from queue') } catch { return $false }
  }

  # Spotify ignores keys posted into its window, and accessibility "invoke" only closes
  # the menu (both verified live), so the item is focused and a real Enter is pressed.
  # Spotify is made the foreground window first - the key then cannot reach anything else
  # - and focus is re-checked immediately before the press.
  try { $removeItem.SetFocus() } catch {}
  Start-Sleep -Milliseconds 150
  if ([SpotifyQueueHelper.Win]::GetForegroundWindow() -ne $script:hwnd) {
    [void][SpotifyQueueHelper.Win]::GiveForeground($script:hwnd)
    Start-Sleep -Milliseconds 200
    try { $removeItem.SetFocus() } catch {}
    Start-Sleep -Milliseconds 150
  }
  if ([SpotifyQueueHelper.Win]::GetForegroundWindow() -eq $script:hwnd -and (FocusIsRemoveItem)) {
    [SpotifyQueueHelper.Win]::PressEnter()
    if (RowGone 16) { Finish $true 'keypress' }
  }

  # Not removed. Cancel any menu still open so it can't linger (or pop up later).
  try {
    if (@($root.FindAll($descendants, $menuCond)).Count -gt 0) {
      $script:toggle.Toggle()
      Start-Sleep -Milliseconds 500
      if ($script:openedQueue) { $script:openedQueue = $false } else { $script:toggle.Toggle() }
    }
  } catch {}
  Finish $false 'not-removed'
} catch {
  Finish $false 'error'
}
`;

module.exports = { SPOTIFY_QUEUE_SCRIPT, SPOTIFY_QUEUE_SCRIPT_VERSION };
