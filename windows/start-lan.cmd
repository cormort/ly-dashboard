@echo off
rem One-click start for the LY Dashboard on Windows, LAN sharing mode.
rem Binds 0.0.0.0, so the sync API is disabled automatically (only this machine can write data)
rem and Windows Firewall must allow Node.js. Keep this file pure ASCII (see start.cmd).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Lan %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the messages above.
  pause
)
