@echo off
rem Show scheduled task state, recent log lines and newest data file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" -Action status
echo.
pause
