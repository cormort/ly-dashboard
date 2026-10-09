@echo off
rem One-click start for the LY Dashboard on Windows (same as start.command on macOS).
rem Arguments are passed through to windows\start.ps1, e.g. -Lan to let others on the LAN connect.
rem NOTE: keep this file pure ASCII. cmd.exe reads a .cmd as the system ANSI codepage (Big5 on zh-TW
rem Windows), so UTF-8 Chinese here shows up as mojibake. All Chinese lives in start.ps1, which is
rem UTF-8 with a BOM (PowerShell 5.1 needs that BOM to read non-ASCII correctly).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the messages above.
  pause
)
