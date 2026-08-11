@echo off
setlocal
title Launcher - Crash Fix (CET exemption for electron.exe)

REM ============================================================================
REM  What this does
REM  ----------------
REM  Your CPU (11th-gen Intel) has "Hardware-enforced Stack Protection" (CET).
REM  On some Windows 10 machines CET clashes with the Chrome engine inside
REM  Electron and kills it with STATUS_STACK_BUFFER_OVERRUN (0xC0000409) -- the
REM  "System Error" dialog you keep seeing. This turns that protection OFF *only*
REM  for electron.exe (the launcher's engine), which is the standard, documented
REM  fix. Nothing else on your PC is affected. Reverse it any time by running
REM  Undo-Crash-Fix.cmd.
REM ============================================================================

REM --- Re-launch this script as Administrator if it isn't already ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo ============================================================
echo   Launcher crash fix
echo   Turning OFF Hardware-enforced Stack Protection (CET)
echo   for electron.exe only.
echo ============================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Set-ProcessMitigation -Name electron.exe -Disable UserShadowStack,UserShadowStackStrictMode -ErrorAction Stop; Write-Host '' ; Write-Host '  SUCCESS - CET disabled for electron.exe.' -ForegroundColor Green } catch { Write-Host '' ; Write-Host ('  FAILED: ' + $_.Exception.Message) -ForegroundColor Red }"

echo.
echo Next steps:
echo   1. Fully close the launcher (right-click its system-tray icon, choose Quit).
echo   2. Start it again ( npm start ).
echo   3. The "System Error" dialog should be gone.
echo.
echo (To undo this later, run Undo-Crash-Fix.cmd.)
echo.
pause
