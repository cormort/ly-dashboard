@echo off
rem Collect one round right now.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\collect.ps1"
echo.
pause
