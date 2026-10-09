@echo off
rem Fallback when scheduled tasks are not allowed: keep this window open, collects every hour.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\run-loop.ps1"
pause
