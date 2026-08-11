---
name: re
description: Relaunch the Main/Launcher Electron app — kills only this app's running Electron processes, then starts a fresh instance detached. Invoke when the user runs /re or asks to relaunch/restart Main.
---

# Relaunch Main

Restart the Launcher (Main) Electron app during live testing: kill the currently
running instance, then start a fresh one.

App directory (where `npm start` / `electron .` runs):
`C:\Users\ivanq\Downloads\main-appv2.4-main\main-appv2.4-main\main-app11\main-app`

## Safety

- **Only kill this app's Electron processes.** Nimbalyst (the host GUI you run in)
  is *also* an Electron app, so never kill `electron.exe` broadly. Match on the
  app path so only Main's process tree is targeted.
- Launch **detached** so the app keeps running after the tool call returns — do
  not block the session or tail its logs.

## Steps

Run this single PowerShell block (kill-then-launch). It kills only Electron
processes whose command line references `main-app11\main-app` (plus their Electron
parent/main process), also handles a packaged `Launcher.exe`, then starts a fresh
detached instance:

```powershell
$appDir = 'C:\Users\ivanq\Downloads\main-appv2.4-main\main-appv2.4-main\main-app11\main-app'

# --- Kill only Main's Electron processes (dev run: electron .) ---
$all = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
$electronIds = @($all | ForEach-Object { $_.ProcessId })
$appProcs = $all | Where-Object { $_.CommandLine -like '*main-app11\main-app*' }
$kill = New-Object System.Collections.Generic.HashSet[int]
foreach ($p in $appProcs) {
  [void]$kill.Add([int]$p.ProcessId)
  if ($electronIds -contains $p.ParentProcessId) { [void]$kill.Add([int]$p.ParentProcessId) }
}
foreach ($id in $kill) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }

# --- Kill a packaged build too, if one is running (scoped to this app) ---
Get-CimInstance Win32_Process -Filter "Name='Launcher.exe'" |
  Where-Object { $_.CommandLine -like '*main-app*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$killedCount = $kill.Count
Write-Output "Killed $killedCount Main Electron process(es)."

# --- Launch a fresh detached instance ---
# Call electron.exe directly (a GUI-subsystem binary) rather than `npm start` /
# npm.cmd, so no cmd/console window appears.
$electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $appDir -WindowStyle Hidden
Write-Output "Launched Main from $appDir"
```

## After running

Report how many processes were killed and confirm the new instance was launched.
Do not poll logs or wait — the user tests the app live.
