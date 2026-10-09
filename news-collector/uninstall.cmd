@echo off
rem Remove the scheduled task (data and logs are kept).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -Action uninstall
echo.
pause
