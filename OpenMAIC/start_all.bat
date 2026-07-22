@echo off
REM One-click start OpenMAIC + VoxCPM dev stack
REM Usage:  start_all.bat            (normal start)
REM         start_all.bat -clean     (stop, clear .next, then start)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1" %*
pause
