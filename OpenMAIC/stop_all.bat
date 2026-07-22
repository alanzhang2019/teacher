@echo off
REM One-click stop OpenMAIC + VoxCPM dev stack
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_all.ps1"
pause
