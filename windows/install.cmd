@echo off
rem One-click install for the LY Dashboard on Windows: register the Task Scheduler jobs, then start the server.
rem Keep this file pure ASCII (see start.cmd). Registration may print a schtasks hint on managed PCs; startup continues anyway.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-tasks.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo.
  echo Startup failed. See the messages above.
  pause
)
