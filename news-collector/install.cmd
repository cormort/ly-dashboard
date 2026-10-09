@echo off
rem Install the hourly news collection task, then run one round to verify. Keep this file pure ASCII.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1"
echo.
pause
