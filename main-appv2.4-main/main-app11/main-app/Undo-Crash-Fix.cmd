@echo off
setlocal
title Launcher - Undo Crash Fix (restore CET for electron.exe)

REM Reverses Fix-Crash.cmd: removes the electron.exe exemption so Hardware-enforced
REM Stack Protection (CET) returns to the Windows default for it.

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Requesting administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo Restoring Hardware-enforced Stack Protection (CET) default for electron.exe...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Set-ProcessMitigation -Name electron.exe -Remove -ErrorAction Stop; Write-Host '  Reverted - electron.exe is back to the Windows default.' -ForegroundColor Green } catch { Write-Host ('  FAILED: ' + $_.Exception.Message) -ForegroundColor Red }"

echo.
pause
